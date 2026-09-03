/**
 * The MCP proxy: sits between the agent (Claude) and the official Playwright MCP
 * server, so that recording a step is forced through a live-page uniqueness check
 * the agent cannot skip or fake.
 *
 * Why this exists: verify.md asks the agent to count every locator candidate to
 * exactly one before recording it, but the agent can — and did — skip that, and
 * the plain-Node record-step could not re-count (it has no browser). A non-unique
 * locator then reached the trace and only failed at replay. Here the count is the
 * tool's, on the real page, at record time: the agent records through `record_step`
 * (the only way to append), the proxy issues a browser_evaluate per candidate on
 * the official server's live page, and refuses the step if any candidate matches
 * other than exactly one — naming the offender so the agent rewrites it.
 *
 * Almost everything is relayed verbatim to the official server. The proxy only
 * owns two things: it appends `record_step` to tools/list, and it handles a
 * record_step call itself (count, then append). Its own browser_evaluate calls use
 * a private negative id space so their replies are told apart from the agent's.
 *
 * The wiring is split from the glue: `ProxyCore` is the pure-ish decision engine
 * (given a parsed message, it emits sends and appends through injected sinks), and
 * `main()` is the stdio transport + spawn. ProxyCore is unit-tested with a fake
 * upstream; the real spawn is verified end-to-end.
 */

import { spawn } from 'child_process';
import { connect as netConnect } from 'net';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { appendFileSync, mkdirSync } from 'fs';
import { appendTrace, readTrace, truncateTrace } from './trace.mjs';
import { reportPaths } from './diagnose.mjs';
import { invokeJudger } from './judger.mjs';
import { judgeRound, priorVerdicts, scoutCount, appendJudgeLog } from './judge-log.mjs';
import {
  isToolsList, isRecordStepCall, injectRecordStep,
  evaluateRequest, toolResult, isRefAction, refActionRejection,
  isMutatingEvaluate, mutatingEvaluateRejection,
  isActionCall, actionNeedsEditable,
} from './mcp-routing.mjs';
import {
  candidateLocatorExpr, interpretEvaluateReply,
  editabilityCheckExpr, interpretEditabilityReply,
} from './locator-count.mjs';

/** Line-delimited JSON reader: feed chunks, get back complete parsed messages. */
export class ReadBuffer {
  constructor() { this._buf = ''; }
  append(chunk) {
    this._buf += chunk;
    const out = [];
    let i;
    while ((i = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, i).replace(/\r$/, '');
      this._buf = this._buf.slice(i + 1);
      if (line.trim()) {
        try { out.push(JSON.parse(line)); }
        catch { /* a partial or non-JSON line — skip; MCP is one JSON per line */ }
      }
    }
    return out;
  }
}

/** Serialise a JSON-RPC message as one line for stdio. */
export function serialize(msg) {
  return JSON.stringify(msg) + '\n';
}

/**
 * Format one activity line for the shadow's mechanical replay of a step. Pure, so
 * the wording is unit-testable. The activity log is the single place a human (or a
 * later debugger) reads to see what every role did — the writer's tool calls are
 * already there; this adds what the SHADOW did, in the same readable form.
 *   ok        → `[shadow] step "…" → ok`
 *   failure   → `[shadow] step "…" → FAIL (phase: error)`
 */
export function shadowActivityLine(step, verdict) {
  const s = String(step ?? '').slice(0, 40);
  if (verdict?.ok !== false) return `[shadow] step "${s}" → ok`;
  const phase = verdict.phase ?? 'step';
  const err = String(verdict.error ?? '').replace(/\s+/g, ' ').slice(0, 80);
  return `[shadow] step "${s}" → FAIL (${phase}${err ? ': ' + err : ''})`;
}

/** Format one activity line for a Judger outcome on a step. Pure/testable. */
export function judgeActivityLine(step, outcome, { round = null, note = null } = {}) {
  const s = String(step ?? '').slice(0, 40);
  const r = round != null ? `  (round ${round})` : '';
  const n = note ? ` — ${String(note).replace(/\s+/g, ' ').slice(0, 100)}` : '';
  return `[judge] step "${s}" → ${outcome}${r}${n}`;
}

/**
 * The activity log path for a feature — the SAME file recorder.mjs writes the
 * writer's activity to (recorder computes it identically). The proxy holds the
 * featurePath on every record_step, so it can append the shadow/judge activity to
 * that one file, giving a single readable stream of what all three roles did.
 */
function activityLogPath(featurePath) {
  const base = basename(featurePath).replace(/\.feature$/, '');
  return join(reportPaths(featurePath).dir, `${base}.activity.log`);
}

/**
 * Append one timestamped activity line, mirroring recorder.mjs's format. Strictly
 * best-effort: the activity log is observability, never worth failing a recording
 * over, so any write error is swallowed. The recorder creates/truncates the file at
 * the start of each run; the proxy only appends, so ordering interleaves naturally.
 */
export function appendActivity(featurePath, line, { append = appendFileSync } = {}) {
  if (!featurePath) return;
  try {
    const path = activityLogPath(featurePath);
    try { mkdirSync(reportPaths(featurePath).dir, { recursive: true }); } catch { /* exists */ }
    append(path, `${new Date().toISOString()}  ${line}\n`);
  } catch { /* best-effort */ }
}

/**
 * The proxy's decision engine.
 *
 * @param sendToAgent     write a message back to the agent (Claude)
 * @param sendToUpstream  write a message to the official MCP server
 * @param appendRecord    (featurePath, record) => tracePath, defaults to appendTrace
 * @param countRecords    (featurePath) => number of records now on disk, for the
 *                        "recorded step N" message; defaults to readTrace().length
 */
export class ProxyCore {
  constructor({ sendToAgent, sendToUpstream, appendRecord = appendTrace, countRecords, evalTimeoutMs = 15000,
                replayStep = null, truncate = truncateTrace, judgeStep = null,
                scout = null, appendVerdict = null, judgeRound: judgeRound_ = null, priorVerdicts: priorVerdicts_ = null,
                scoutCount: scoutCount_ = null, scoutLimit = 2, resetShadow = null, readPrefix = null,
                appendActivity: appendActivity_ = null } = {}) {
    this._toAgent = sendToAgent;
    this._toUpstream = sendToUpstream;
    this._append = appendRecord;
    this._count = countRecords ?? (f => readTrace(f).length);
    this._evalTimeoutMs = evalTimeoutMs;
    this._pendingToolsList = new Set();   // agent ids whose tools/list result we must inject into
    this._pendingEvals = new Map();       // proxy eval id -> resolve fn
    this._nextEvalId = -1;                // private negative id space
    // Locators verified (counted to one, editable if a fill/type) at the moment an
    // action was driven, on the page the element was on. record_step later checks
    // its candidates against this, instead of re-counting on the final page — which
    // is what let a cross-page step (login form → submit → new page) record its
    // login-form locators, uncountable once the submit navigated away.
    this._verifiedLocators = new Set();
    // Step-wise shadow replay, now a FACT SOURCE, not a gate. `replayStep(record) =>
    // { ok, error?, phase?, index?, before, after }` runs the just-appended record on
    // the resident shadow, on the state every prior step left, and reports what
    // happened — did every locator resolve and every assertion hold, and the page's
    // fingerprint before vs after. A mechanical failure is NOT a verdict here: it is
    // handed to the Judger, which alone decides whether it means a broken step, a
    // legitimate terminal navigation, or a non-step cause. Left null (no shadow, or
    // STEPWISE off) → no facts; a step that only needs judging still gets it, one
    // that needs neither is accepted as before.
    this._replayStep = replayStep;
    this._truncate = truncate;
    // The Judger hook — the FINAL arbiter. `judgeStep(record, featurePath, stillHolds,
    // replayFacts, attribution) => { outcome:'accept'|'reject'|'attribution', report[],
    // rebuttal?, attribution?:{class} } | { inconclusive } | { atLimit }`. Summoned
    // on EVERY recorded step (it rules on business effect AND on the record's
    // replayability — see judger.md), not only on a mechanical failure. The mechanical
    // layer never fails a step on its own; the Judger rules on the facts. Null → no Judger
    // (STEPWISE-only or JUDGER=0): a mechanically-clean step is accepted, and there is
    // no arbiter for a mechanical failure so it is accepted too (the full replay gate
    // stays the backstop).
    this._judgeStep = judgeStep;
    // Scout escalation. `scout(record, featurePath) => { resolved, report[],
    // unresolvable? } | { inconclusive }`. Summoned by _rejectStep on EVERY reject
    // (D4: no longer gated on a rejection count — a real failure means the Writer is
    // already stuck, so scout at once), bounded only by scoutLimit. The scout drives
    // the shadow (shadow_try unlocked) to find HOW to make the step work and reports
    // it, or declares it a non-click problem for a human. Null → no escalation (the
    // step is refused plainly and the Writer re-records).
    this._scout = scout;
    // The single writer of a verdict line to the judge log. Injected for tests;
    // defaults to appendJudgeLog. The Judger no longer writes its own log — one
    // ruling is one line, written here, so the round/reject counters do not
    // double-count (the old two-path double-write is gone).
    this._appendVerdict = appendVerdict ?? ((fp, entry) => appendJudgeLog(fp, entry));
    // Count of prior REJECTIONS is no longer a scout threshold (D4: a real reject
    // scouts at once), so it is not read here. The judge round number for a step
    // (for the verdict line's `round`) is read from the log; injected for tests.
    this._judgeRound = judgeRound_;
    // Prior verdict detail for a step, for the "already tried, don't repeat" history
    // in a refusal. Injected for tests; defaults to the judge log.
    this._priorVerdicts = priorVerdicts_;
    // Scout bound: how many times a step may be scouted before it goes to a human.
    // _scoutCount (injected for tests) reads how many scout lines the step has.
    this._scoutCount = scoutCount_;
    this._scoutLimit = scoutLimit;
    // Shadow prefix alignment for a RESUME (Mode B) run. On the FIRST step this proxy
    // replays, the shadow browser is a blank page — but a resume starts recording at
    // step K with K-1 steps already on disk, and those K-1 steps ran on the Writer's
    // browser (via generator_setup_page) yet NEVER on the shadow. So the shadow's
    // first replayStep would run step K on a blank page and fail — and the Judger
    // would then rule on the wrong page. `resetShadow(prefixRecords)` rebuilds the
    // shadow to that prefix once, so both browsers reach step K's real starting state
    // before it is judged. Null → no alignment (a fresh Mode A run starts at step 1
    // with no prefix, so the shadow accumulates from blank naturally — nothing to
    // align). `readPrefix` reads the records already on disk (defaults to readTrace).
    this._resetShadow = resetShadow;
    // Append one activity line (shadow/judge) to the shared activity log. Injectable
    // so tests can capture lines without touching the filesystem; defaults to the
    // module-level appendActivity which writes the same file recorder.mjs uses.
    this._activity = (featurePath, line) => (appendActivity_ ?? appendActivity)(featurePath, line);
    this._readPrefix = readPrefix ?? (f => readTrace(f));
    this._shadowAligned = false;   // one-shot: resume alignment before the first replay only
    // Whether the LAST shadow step left the shadow's accumulated state possibly
    // diverged from the trace (a step whose action/assertion failed, leaving the page
    // mid-step). When set, the next step is judged only AFTER rebuilding the shadow to
    // the on-disk prefix — otherwise a step that "replayed but didn't land" (a dynamic
    // search that matched nothing, a navigation that didn't fire) leaves every later
    // step judged on the wrong page, and the Judger rejects good steps on it.
    this._shadowDirty = false;
  }

  /** A message arrived from the agent. */
  onAgentMessage(msg) {
    // _handleRecordStep / _handleAction are async and fire-and-forget (the agent
    // is unblocked by the tool result they send, not by this returning). They each
    // carry a full try-catch and their awaited callbacks return error objects
    // rather than throwing — but a `.catch` here is a cheap backstop so a future
    // change that does throw fails the ONE step (the agent still gets no result and
    // times out) instead of crashing the whole proxy with an unhandledRejection.
    const guard = (p, where) => { if (p && typeof p.catch === 'function') p.catch(e => process.stderr.write(`[proxy] unhandled in ${where}: ${e?.message ?? e}\n`)); };
    if (isRecordStepCall(msg)) { guard(this._handleRecordStep(msg), '_handleRecordStep'); return; }
    if (isRefAction(msg)) {
      // An action driven by a snapshot ref: refuse it, so the agent drives (and
      // records) by the same persistent locator instead. Not relayed upstream.
      this._toAgent(toolResult(msg.id, refActionRejection(msg.params.name, msg.params.arguments.target), true));
      return;
    }
    if (isMutatingEvaluate(msg)) {
      // browser_evaluate used to DRIVE the page (click/value=/dispatchEvent/…): an
      // evaluate interaction cannot be recorded and drifts on replay. Refuse it, so
      // the agent performs the interaction with a persistent-locator action that
      // reaches the spec. Read-only evaluates (state checks) are relayed normally.
      this._toAgent(toolResult(msg.id, mutatingEvaluateRejection(), true));
      return;
    }
    if (isActionCall(msg)) { guard(this._handleAction(msg), '_handleAction'); return; }
    if (isToolsList(msg)) this._pendingToolsList.add(msg.id);
    this._toUpstream(msg);   // relay everything else (and tools/list, whose result we intercept)
  }

  /**
   * A persistent-locator action (click/type/…): verify its target on the CURRENT
   * page BEFORE relaying it upstream to execute. Counting here — while the element
   * is still on the page, before a submit/click may navigate away — is the fix for
   * a cross-page step: each action is verified on the page it happens on, not
   * re-counted later on the final page where earlier-page locators are gone.
   *
   * Verified (count 1, and editable for a fill/type) → remember the locator and
   * relay the action to execute. Not → refuse; the action does not run and nothing
   * is recorded, so the agent re-locates rather than deleting the action to slip a
   * step past a later check.
   */
  async _handleAction(msg) {
    const target = msg.params.arguments.target;
    const toolName = msg.params.name;
    try {
      const count = await this._evalOnCandidate(target, '() => 1', interpretEvaluateReply);
      if (count !== 1) {
        this._toAgent(toolResult(msg.id,
          `${toolName} target ${JSON.stringify(target)} is not unique on the page: it matched `
          + `${count == null ? 'a number that could not be read' : count} element(s), not exactly one. `
          + `Drive (and record) the action by a locator that resolves to one element — scope it by a `
          + `name, a container, or a row's own text; do not fall back to a ref or delete the action.`, true));
        return;
      }
      if (actionNeedsEditable(toolName)) {
        const editable = await this._evalOnCandidate(target, editabilityCheckExpr(), interpretEditabilityReply);
        if (editable !== true) {
          this._toAgent(toolResult(msg.id,
            `${toolName} target ${JSON.stringify(target)} is not editable — it resolves to a wrapper, not the `
            + `native input. Chain to the inner field (e.g. \`.locator('#inner')\`) so the fill lands on a real `
            + `editable element, as the UI5 interaction convention describes.`, true));
          return;
        }
      }
      // Verified on this page, at this moment: the locator is unique and (for a
      // fill/type) editable — which is what record_step needs proven. Marked before
      // the upstream executes it, so a locator that is well-formed but whose action
      // then fails to run (e.g. click intercepted by an overlay) is still counted as
      // verified. That is deliberate: the check owns locator QUALITY (resolves to one
      // editable element), not runtime success — a genuinely stuck action surfaces as
      // the upstream's own error to the agent, and a step that never really happened
      // is caught downstream by the replay gate, not by withholding this mark.
      this._verifiedLocators.add(target);
      this._toUpstream(msg);   // relay to execute
    } catch (e) {
      this._toAgent(toolResult(msg.id, `${toolName}: ${e.message}`, true));
    }
  }

  /** A message arrived from the official upstream server. */
  onUpstreamMessage(msg) {
    // A reply to one of our own browser_evaluate calls: consume it, never relay.
    if (msg && 'id' in msg && this._pendingEvals.has(msg.id)) {
      const resolve = this._pendingEvals.get(msg.id);
      this._pendingEvals.delete(msg.id);
      resolve(msg.result);
      return;
    }
    // A tools/list result the agent is waiting for: inject record_step first.
    if (msg && 'id' in msg && this._pendingToolsList.has(msg.id) && msg.result) {
      this._pendingToolsList.delete(msg.id);
      this._toAgent({ ...msg, result: injectRecordStep(msg.result) });
      return;
    }
    this._toAgent(msg);   // everything else (tool replies, notifications) relayed as-is
  }

  /**
   * Resolve one candidate's Playwright locator expression on the upstream page,
   * run `fn` on the element it resolves to, and return `interpret(reply)`.
   *
   * Shared by the uniqueness count (fn `() => 1`, interpret = interpretEvaluateReply)
   * and the editability check (fn editabilityCheckExpr, interpret =
   * interpretEditabilityReply). A timeout guards against an upstream that never
   * replies (a hung page): the proxy would otherwise leave record_step awaiting
   * forever, hanging the agent. On timeout the pending eval is dropped and the
   * result resolves to null, which every interpret treats as "cannot trust →
   * refuse" — the step is refused, not hung.
   */
  _evalOnCandidate(locatorExpr, fn, interpret) {
    const id = this._nextEvalId--;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this._pendingEvals.has(id)) { this._pendingEvals.delete(id); resolve(null); }
      }, this._evalTimeoutMs);
      timer.unref?.();
      this._pendingEvals.set(id, result => { clearTimeout(timer); resolve(interpret(result)); });
      this._toUpstream(evaluateRequest(id, locatorExpr, fn));
    });
  }

  /**
   * Handle a record_step tool call: check its action locators were verified when
   * the actions ran, then append or refuse.
   *
   * Verification happened at action time (in _handleAction, on the page each action
   * occurred on) — NOT here. Re-counting here would fail a cross-page step: a login
   * form filled on the login page cannot be counted once the submit has navigated to
   * the next page. So record_step instead checks the driving locator of each action
   * (locators[0], the one the action was performed with) is one this proxy verified
   * as it was driven. A record whose action locator was never a verified action is
   * refused — that is a step the agent hand-assembled or altered after the fact,
   * exactly what would drift on replay.
   *
   * `goto` has no locator to verify; `.or()` fallback candidates (locators[1..]) are
   * not driven, so they are not required to be verified — validateRecord still
   * guarantees their shape at append.
   */
  async _handleRecordStep(msg) {
    const args = msg.params?.arguments ?? {};
    const featurePath = args.feature ?? args.featurePath;
    if (!featurePath) {
      this._toAgent(toolResult(msg.id, 'record_step: missing "feature" (the .feature path this step belongs to)', true));
      return;
    }
    // The record is the arguments minus the routing-only fields. `stillHolds` is
    // the Writer's optional push-back on a prior Judger refusal (why the effect DID
    // happen); `attribution` is the Writer's optional claim that a failure is a
    // NON-step cause ({ class, evidence, suggestedChange }) the Judger should review.
    // Both are routing only — handed to the Judger, never written to the trace.
    const record = { ...args };
    const stillHolds = record.stillHolds ?? null;
    const attribution = record.attribution ?? null;
    delete record.feature; delete record.featurePath; delete record.stillHolds; delete record.attribution;

    try {
      // Each action's DRIVING locator (its first candidate) must be one verified as
      // the action was performed. Actions with no locator (goto) contribute none.
      const unverified = [];
      (record.actions ?? []).forEach((action, actionIndex) => {
        const driving = action.locators?.[0];
        if (!driving) return;   // goto / no-locator action
        const expr = candidateLocatorExpr(driving);
        if (!this._verifiedLocators.has(expr)) {
          unverified.push({ actionIndex, method: action.method, expr });
        }
      });
      if (unverified.length) {
        const lines = unverified.map(u =>
          `  action[${u.actionIndex}] (${u.method}) locator ${JSON.stringify(u.expr)}`);
        process.stderr.write(`[record_step] REFUSED (unverified locator) step ${JSON.stringify(record.step)}: `
          + `${unverified.length} action(s) not driven by the recorded locator\n`);
        this._toAgent(toolResult(msg.id,
          `step ${JSON.stringify(record.step)}: ${unverified.length} action(s) name a locator that was not the `
          + `one you drove:\n${lines.join('\n')}\n\nDrive each action with the SAME persistent locator you `
          + `record — the proxy verifies a locator (unique, editable) as you click/type it, on the page it is `
          + `on, and record_step accepts exactly those. Do not hand-write, alter, or drop an action's locator `
          + `after driving it; re-drive it with the locator you intend to record.`, true));
        return;
      }
      this._append(featurePath, record);   // appendTrace runs validateRecord and throws on a bad shape
      const n = this._count(featurePath);

      // Step-wise shadow replay is now a FACT SOURCE, not a gate: run the record on
      // the resident shadow and collect what happened, but do NOT judge it here. A
      // mechanical failure — a locator that no longer resolves, an assertion that
      // does not hold — may be a genuinely broken step OR a legitimate terminal
      // action that navigated to a new page (its own locators are naturally gone
      // there). Only the Judger can tell those apart, by reading before/after and
      // the live page. So the failure becomes a fact handed to the Judger, never a
      // verdict on its own.
      let replayFacts = null;
      if (this._replayStep) {
        // Resume alignment (once): before the FIRST replay, if steps already exist on
        // disk before this one (a Mode B resume starting at step K), rebuild the
        // shadow to that K-1 prefix so it reaches the same starting state the Writer's
        // browser did — otherwise the shadow would replay step K on a blank page and
        // the Judger would rule on the wrong page. A fresh Mode A run has no prefix
        // here (this is step 1), so this is a no-op and the shadow accumulates from
        // blank. Alignment failure is not the agent's fault: log and carry on (the
        // shadow will still replay this step, just from a possibly-wrong state — the
        // full replay gate stays the backstop), rather than block recording.
        if (!this._shadowAligned) {
          this._shadowAligned = true;
          if (this._resetShadow && n > 1) {
            let prefix = [];
            try { prefix = this._readPrefix(featurePath).slice(0, n - 1); } catch { /* no readable prefix */ }
            if (prefix.length) {
              try {
                process.stderr.write(`[record_step] resume: aligning shadow to the ${prefix.length}-step prefix before step ${n}\n`);
                await this._resetShadow(prefix);
                this._activity(featurePath, `[shadow] rebuild → replayed ${prefix.length}-step prefix (resume alignment before step ${n})`);
              } catch (e) {
                process.stderr.write(`[record_step] resume: shadow prefix alignment failed (${e?.message ?? e}); replaying this step from the shadow's current state\n`);
              }
            }
          }
        } else if (this._shadowDirty && this._resetShadow && n > 1) {
          // The previous step left the shadow diverged (its action/assertion failed,
          // so the page was not where the trace implies). Judging THIS step on that
          // stale page is exactly how a good step gets rejected on the wrong view.
          // Rebuild the shadow to the on-disk prefix (steps 1..n-1) first, so this
          // step replays and is judged on the state it should actually start from.
          // Best-effort: a rebuild that fails does not block recording (the full
          // replay gate stays the backstop) — carry on from the current state.
          let prefix = [];
          try { prefix = this._readPrefix(featurePath).slice(0, n - 1); } catch { /* no readable prefix */ }
          if (prefix.length) {
            try {
              process.stderr.write(`[record_step] shadow diverged after a failed step — rebuilding to the ${prefix.length}-step prefix before judging step ${n}\n`);
              await this._resetShadow(prefix);
              this._shadowDirty = false;
              this._activity(featurePath, `[shadow] rebuild → replayed ${prefix.length}-step prefix (prior step diverged, before step ${n})`);
            } catch (e) {
              process.stderr.write(`[record_step] shadow rebuild failed (${e?.message ?? e}); judging step ${n} from the current state\n`);
            }
          }
        }
        let verdict;
        try {
          verdict = await this._replayStep(record);
        } catch (e) {
          // The shadow itself errored (transport, launch). Do NOT fail the step on
          // infrastructure. Accept, logging the shadow miss; the full replay gate
          // remains the backstop.
          process.stderr.write(`[record_step] shadow replay unavailable for step ${n} (${e?.message ?? e}); accepting without step-wise check\n`);
          this._toAgent(toolResult(msg.id, `recorded step ${n} (shadow unavailable)`));
          return;
        }
        // Carry the shadow's divergence forward: a failed step (dirty) means the next
        // step must rebuild to prefix (above) before it is judged.
        this._shadowDirty = verdict?.dirty === true;
        // Record what the shadow's mechanical replay of this step did, into the shared
        // activity log — so a reader sees the shadow's verdict step by step (single
        // step, ok or FAIL) alongside the writer's own actions, in one place.
        this._activity(featurePath, shadowActivityLine(record.step, verdict));
        replayFacts = {
          mechOk: verdict?.ok !== false,
          error: verdict?.error, phase: verdict?.phase, index: verdict?.index,
          before: verdict?.before, after: verdict?.after,
        };
        // D6 — a CERTAIN mechanical failure, offered to the Judger as a stronger
        // fact (not a verdict): a pure assertion phase matched nothing AND the page
        // did not move (same URL before and after), so there is no terminal-nav
        // reading to weigh — the assertion simply did not hold. The Judger still has
        // the final say; this only sharpens the fact.
        if (verdict?.ok === false && verdict.phase === 'assertion'
            && verdict.before?.url != null && verdict.before.url === verdict.after?.url) {
          replayFacts.certainMechFail = true;
        }
      }

      // Every recorded step goes to the Judger. The Judger rules not just on
      // business effect but on the record's REPLAYABILITY (generic / dynamic /
      // dependency-free — see judger.md): a step can replay clean today yet be
      // unreplayable next run (a dynamic value frozen into a literal, an env value
      // hardcoded, a dependency on left-over data). Only a mechanical layer would
      // miss that, so the Judger must see every step, not only the failing or
      // state-changing ones. No Judger wired → nothing to rule; accept.
      const mustJudge = !!this._judgeStep;
      if (!mustJudge) {
        process.stderr.write(`[record_step] recorded step ${n}: ${JSON.stringify(record.step)}\n`);
        this._toAgent(toolResult(msg.id, `recorded step ${n}`));
        return;
      }

      let judged;
      try {
        judged = await this._judgeStep(record, featurePath, stillHolds, replayFacts, attribution);
      } catch (e) {
        // A tooling failure (spawn, crash) is never the Writer's fault. Accept the
        // step; the full replay gate stays the backstop.
        process.stderr.write(`[record_step] judger unavailable for step ${n} (${e?.message ?? e}); accepting without business-effect check\n`);
        this._toAgent(toolResult(msg.id, `recorded step ${n} (judger unavailable)`));
        return;
      }
      if (judged && judged.atLimit) {
        // Writer and Judger reached the duel limit without agreeing. Stop the thrash:
        // accept as-is and flag for a human, rather than loop forever. The full
        // replay gate still runs over the finished feature.
        process.stderr.write(`[record_step] judger duel limit reached for step ${n} ${JSON.stringify(record.step)}; accepting current record, flag for human review\n`);
        this._toAgent(toolResult(msg.id, `recorded step ${n} (judger unresolved after repeated rounds — accepted as-is; a human should review this step)`));
        return;
      }
      if (judged && judged.inconclusive) {
        // The Judger could not produce a trustworthy verdict (crash, no file, or it
        // ruled the shadow was on the wrong page). Accept rather than blame the agent
        // — same discipline as an inconclusive replay.
        process.stderr.write(`[record_step] judger inconclusive for step ${n}: ${judged.inconclusive}; accepting\n`);
        this._activity(featurePath, judgeActivityLine(record.step, 'inconclusive', { note: judged.inconclusive }));
        this._toAgent(toolResult(msg.id, `recorded step ${n}`));
        return;
      }

      const round = this._judgeRoundFor(featurePath, record) + 1;
      switch (judged?.outcome) {
        case 'accept':
          // The Judger ruled the step held — including a terminal action it CONFIRMED
          // on the new page (D3: it may not accept a transition without verifying the
          // step's effect there). The step stays in the trace, NOT truncated. One
          // verdict line records the ruling.
          this._logVerdict(featurePath, { record, round, outcome: 'accept', report: judged.report, rebuttal: judged.rebuttal });
          this._activity(featurePath, judgeActivityLine(record.step, 'accept', { round }));
          process.stderr.write(`[record_step] step ${n} ${JSON.stringify(record.step)} accepted by judger${replayFacts?.mechOk === false ? ' (terminal transition, verified on the new page)' : ''}\n`);
          this._toAgent(toolResult(msg.id,
            replayFacts?.mechOk === false
              ? `recorded step ${n} (a terminal action; the judger verified its effect on the page it navigated to)`
              : `recorded step ${n}`));
          return;
        case 'reject':
          // A real failure. Roll the step back and refuse; _rejectStep logs the reject
          // verdict, then immediately scouts (D4). The Writer re-records THIS step.
          // replayFacts travels so the scout can tell a terminal-transition failure
          // (the page navigated away — a full prefix replay IS needed to get back)
          // from a same-page failure (the shadow is still at this step — no replay
          // needed, the scout explores in place).
          await this._rejectStep(msg.id, featurePath, record, n, round, { report: judged.report, rebuttal: judged.rebuttal, replayFacts });
          return;
        case 'attribution': {
          // A non-step cause the Judger confirmed (feature/environment/backend/data/
          // component). Not a reject — re-recording cannot fix it. Keep the prior
          // clean steps, stop on this one, hand it to a human. One attribution
          // verdict line records the ruling and its class.
          this._logVerdict(featurePath, { record, round, outcome: 'attribution', attribution: judged.attribution, report: judged.report });
          this._truncate(featurePath, n - 1);   // this step did not really succeed; drop it
          const cls = judged.attribution?.class ?? 'non-step';
          this._activity(featurePath, judgeActivityLine(record.step, `attribution(${cls})`, { round, note: judged.report?.[0]?.problem }));
          const report = (judged.report ?? [])
            .map(r => `  - ${r.where ? `[${r.where}] ` : ''}${r.problem}\n    → ${r.suggestion}`)
            .join('\n');
          process.stderr.write(`[record_step] step ${n} ${JSON.stringify(record.step)} attributed to ${cls} — handing to a human\n`);
          this._toAgent(toolResult(msg.id,
            `step ${JSON.stringify(record.step)} is a ${cls} problem, not something re-recording can fix — an independent `
            + `judge attributed it to a non-step cause:\n${report}\n\nStop on this step; a human needs to act on it. `
            + `Do not skip it, do not run Bash, do not proceed to the next step.`, true));
          return;
        }
        default:
          // A verdict shape the judgeStep hook should have normalised to inconclusive.
          // Treat it as inconclusive here too rather than crash the step.
          process.stderr.write(`[record_step] judger returned an unexpected verdict for step ${n}; accepting\n`);
          this._toAgent(toolResult(msg.id, `recorded step ${n}`));
          return;
      }
    } catch (e) {
      process.stderr.write(`[record_step] REFUSED (invalid record) step ${JSON.stringify(record.step)}: ${e.message}\n`);
      this._toAgent(toolResult(msg.id, `record_step: ${e.message}`, true));
    }
  }

  /**
   * The judge round number for a step (0 if never judged) — one more than this is
   * the round the current verdict belongs to. Injected `_judgeRound` for tests.
   */
  _judgeRoundFor(featurePath, record) {
    try { return this._judgeRound ? this._judgeRound(featurePath, record.scenario, record.step) : judgeRound(featurePath, record.scenario, record.step); }
    catch { return 0; }
  }

  /** Write one verdict line — the single writer, so one ruling is one line. */
  _logVerdict(featurePath, { record, round, outcome, report, rebuttal, attribution }) {
    try {
      this._appendVerdict(featurePath, {
        kind: 'verdict', scenario: record.scenario, step: record.step, round, outcome,
        ...(report ? { report } : {}), ...(rebuttal ? { rebuttal } : {}), ...(attribution ? { attribution } : {}),
      });
    } catch { /* logging must not break the ruling */ }
  }

  /**
   * A step the Judger ruled `reject` (a real failure). Log the reject verdict, roll
   * the record back to the clean N-1 prefix, then — because a real failure means the
   * Writer is already stuck (D4: no rejection-count threshold) — send the scout in
   * at once, bounded only by scoutLimit. The scout either hands back the working
   * interaction (the refusal TELLS the Writer exactly how to drive it) or declares
   * the step a non-click problem for a human. If no scout is wired, or it is
   * inconclusive, fall back to a plain refusal with the reason and the tried-and-
   * failed history so the Writer does not repeat a dead end.
   */
  async _rejectStep(msgId, featurePath, record, n, round, { report, rebuttal, replayFacts = null }) {
    this._logVerdict(featurePath, { record, round, outcome: 'reject', report, rebuttal });
    this._activity(featurePath, judgeActivityLine(record.step, 'reject', { round, note: rebuttal ?? report?.[0]?.problem }));

    const kept = this._truncate(featurePath, n - 1);   // backs up to .bak, drops step n
    process.stderr.write(`[record_step] REFUSED (reject) step ${n} ${JSON.stringify(record.step)}\n`);

    // The Judger's report is the "why it failed / how to fix" for the refusal.
    const reportText = (report ?? [])
      .map(r => `  - ${r.where ? `[${r.where}] ` : ''}${r.problem}\n    → ${r.suggestion}`)
      .join('\n');
    const reason =
      `was recorded but an independent judge ruled its business effect did NOT happen`
      + `${rebuttal ? `:\n  ${rebuttal}` : '.'}\n\n${reportText}`;

    // How many times the scout has already investigated this step. A step scouted
    // scoutLimit times and still failing will not be solved by another scout — hand
    // it to a human instead of scouting forever.
    const scoutsSoFar = (() => {
      try { return this._scoutCount ? this._scoutCount(featurePath, record.scenario, record.step) : scoutCount(featurePath, record.scenario, record.step); }
      catch { return 0; }
    })();

    // No scout wired, or the scout budget is spent → a plain refusal with the
    // dead-end history so a fresh Writer instance does not repeat a tried path.
    if (!this._scout || scoutsSoFar >= this._scoutLimit) {
      if (this._scout && scoutsSoFar >= this._scoutLimit) {
        process.stderr.write(`[record_step] step ${n} ${JSON.stringify(record.step)} scouted ${scoutsSoFar}x already and still failing — handing to a human\n`);
        this._toAgent(toolResult(msgId,
          `step ${JSON.stringify(record.step)} has been investigated by an independent scout ${scoutsSoFar} times and `
          + `still cannot be made to pass. This is beyond automatic recording — stop on this step; a human needs to `
          + `look at whether the feature step is achievable on this page/environment.`, true));
        return;
      }
      this._toAgent(toolResult(msgId,
        `step ${JSON.stringify(record.step)} ${reason}${this._rejectHistory(featurePath, record)}\n\n`
        + `This step has been rolled back (the ${kept} steps before it are kept). Re-drive and re-record ONLY this `
        + `step so its business logic actually happens, with a DIFFERENT approach than the ones above — do not skip `
        + `it, do not run Bash, do not proceed to the next step.`, true));
      return;
    }

    // Send the scout in. The step was rolled back before this runs, so the trace on
    // disk is the clean prefix; the scout闭包 resets the shadow to it, explores with
    // shadow_try, then resets again.
    process.stderr.write(`[record_step] step ${n} rejected — escalating to SCOUT (scout ${scoutsSoFar + 1}/${this._scoutLimit})\n`);
    let scouted;
    try {
      scouted = await this._scout(record, featurePath, replayFacts);
    } catch (e) {
      process.stderr.write(`[record_step] scout unavailable (${e?.message ?? e}); plain refusal\n`);
      this._toAgent(toolResult(msgId,
        `step ${JSON.stringify(record.step)} ${reason}\n\nRolled back. Re-record this step.`, true));
      return;
    }

    // Record the scout's outcome as one scout line (resolved / unresolvable /
    // inconclusive alike), so scoutCount bounds re-scouting even on an inconclusive
    // scout that would otherwise write nothing and re-scout forever.
    this._logScout(featurePath, record, round, scouted);
    this._activity(featurePath, `[judge] scout "${String(record.step ?? '').slice(0, 40)}" → ${
      scouted?.inconclusive ? 'inconclusive' : scouted?.resolved ? 'resolved' : scouted?.unresolvable ? 'unresolvable' : 'done'}`);

    if (scouted && scouted.inconclusive) {
      process.stderr.write(`[record_step] scout inconclusive for step ${n}: ${scouted.inconclusive}\n`);
      this._toAgent(toolResult(msgId,
        `step ${JSON.stringify(record.step)} ${reason}\n\n`
        + `(An independent scout was attempted but could not complete: ${scouted.inconclusive}.)\n\n`
        + `Rolled back (the ${kept} steps before it are kept). Re-record this step with a different approach.`, true));
      return;
    }

    if (scouted && scouted.resolved) {
      const scoutReport = (scouted.report ?? [])
        .map(r => `  - ${r.where ? `[${r.where}] ` : ''}${r.problem}\n    -> ${r.suggestion}`)
        .join('\n');
      this._toAgent(toolResult(msgId,
        `step ${JSON.stringify(record.step)} was rejected. An independent scout drove the page and found how to make `
        + `it work. Re-record this step using EXACTLY this interaction:\n\n${scoutReport}\n\n`
        + `The step was rolled back (the ${kept} steps before it are kept). Drive it the way the scout describes, `
        + `then record_step — do not skip it, do not run Bash.`, true));
      return;
    }

    if (scouted && scouted.resolved === false && scouted.unresolvable) {
      const u = scouted.unresolvable;
      const scoutReport = (scouted.report ?? []).map(r => `  - ${r.problem}\n    -> ${r.suggestion}`).join('\n');
      process.stderr.write(`[record_step] step ${n} unresolvable (${u.category}): ${u.summary}\n`);
      this._toAgent(toolResult(msgId,
        `step ${JSON.stringify(record.step)} cannot be made to work by clicking — a scout determined this is a `
        + `${u.category} problem: ${u.summary}\n\n${scoutReport}\n\n`
        + `This is not something re-recording can fix; a human must act on it. Stop on this step.`, true));
      return;
    }

    // Scout returned an unexpected shape → plain refusal, let the Writer try once more.
    this._toAgent(toolResult(msgId,
      `step ${JSON.stringify(record.step)} ${reason}\n\nRolled back. Re-record this step with a different approach.`, true));
  }

  /** Write one scout line to the judge log (memory, not a rejection). */
  _logScout(featurePath, record, round, scouted) {
    try {
      this._appendVerdict(featurePath, {
        kind: 'scout', scenario: record.scenario, step: record.step, round,
        ...(scouted?.resolved != null ? { resolved: scouted.resolved } : {}),
        ...(scouted?.unresolvable ? { unresolvable: scouted.unresolvable } : {}),
        ...(scouted?.inconclusive ? { inconclusive: scouted.inconclusive } : {}),
        ...(scouted?.report?.[0]?.suggestion ? { scoutFinding: scouted.report[0].suggestion } : {}),
      });
    } catch { /* logging must not break the scout path */ }
  }

  /**
   * The "already tried on this step and rejected" history for a refusal, so a fresh
   * Writer instance does not walk into the same wall (mte's "avoid dead ends"). Reads
   * the prior reject verdicts for the step.
   */
  _rejectHistory(featurePath, record) {
    try {
      const priors = (this._priorVerdicts ? this._priorVerdicts(featurePath, record.scenario, record.step) : priorVerdicts(featurePath, record.scenario, record.step))
        .filter(p => p.kind === 'verdict' && p.outcome === 'reject');
      if (!priors.length) return '';
      return `\n\nAlready tried on this step and rejected (do NOT repeat these):\n`
        + priors.map((p, i) => {
          const fix = p.report?.[0]?.suggestion ? ` — tried: ${p.report[0].suggestion}` : '';
          return `  ${i + 1}. ${p.rebuttal ? p.rebuttal : 'business effect not confirmed'}${fix}`;
        }).join('\n');
    } catch { return ''; /* history is best-effort */ }
  }
}

/**
 * A client to a resident shadow-runner child process.
 *
 * The shadow (src/shadow-runner.mjs) is a second browser holding accumulated
 * state. It listens on a unix socket (not stdin/stdout) precisely because TWO
 * clients share it: this proxy, which drives each `step`, and the Judger's
 * read-only MCP shim, which `probe`s the same accumulated page to judge the
 * step's business effect. Both connect to the one socket; the shadow serialises
 * them onto one browser. The socket path is returned so the Judger's shim
 * (spawned per step by recorder.mjs) can be pointed at the same shadow.
 *
 * This side pairs each request with its reply by a monotonically increasing id.
 * `setup` is lazy — sent on the first replayStep — so the browser only launches
 * once a recording actually produces a step.
 *
 * Kept split from main() so it can be swapped for a fake in ProxyCore tests, and
 * so a shadow crash is contained here (the promise rejects; ProxyCore treats a
 * throw as "shadow unavailable" and accepts the step rather than blaming the agent).
 */
export function spawnShadow() {
  const socketPath = join(tmpdir(), `shadow-${process.pid}-${nextShadowSeq()}.sock`);
  const child = spawn('node', ['src/shadow-runner.mjs'],
    { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, SHADOW_SOCK: socketPath } });

  const fromShadow = new ReadBuffer();
  const pending = new Map();   // id -> { resolve, reject }
  let nextId = 1;
  let setupDone = null;
  let conn = null;
  let connReady = null;        // promise resolving once the socket is connected

  // The child needs a moment to bind the socket; connect with a few retries.
  const connect = () => new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      const c = netConnect(socketPath);
      c.once('connect', () => {
        conn = c;
        c.on('data', chunk => {
          for (const m of fromShadow.append(chunk.toString('utf8'))) {
            const p = pending.get(m.id);
            if (p) { pending.delete(m.id); p.resolve(m); }
          }
        });
        c.on('close', () => { for (const [, p] of pending) p.reject(new Error('shadow-runner connection closed')); pending.clear(); });
        resolve(c);
      });
      c.once('error', () => {
        c.destroy();
        if (++tries > 50) return reject(new Error('could not connect to shadow socket'));
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
  child.on('exit', () => { for (const [, p] of pending) p.reject(new Error('shadow-runner exited')); pending.clear(); });

  const send = (cmd, extra = {}) => new Promise(async (resolve, reject) => {
    try {
      if (!connReady) connReady = connect();
      await connReady;
    } catch (e) { return reject(e); }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    conn.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
  });

  return {
    socketPath,
    async replayStep(record) {
      if (!setupDone) setupDone = send('setup');
      const setup = await setupDone;
      if (setup && setup.ok === false) throw new Error(`shadow setup failed: ${setup.error}`);
      const res = await send('step', { record });
      return res;   // { id, ok, error?, phase?, index?, before, after }
    },
    async snapshot(opts) { return send('snapshot', { opts }); },
    async armReset(records) { return send('armReset', { records }); },
    async resetTo(records) {
      // resetTo brings the shadow up on a fresh context and replays `records` (the
      // shadow-runner self-launches the browser if setup never ran). So AFTER a
      // resetTo the browser is up and holds those records' state — mark setup done
      // so a following replayStep does NOT send another `setup`, which would launch a
      // second browser/context and throw away exactly the prefix we just rebuilt.
      const res = await send('resetTo', { records });
      if (res && res.ok !== false) setupDone = Promise.resolve({ ok: true });
      return res;
    },
    kill() { try { child.kill(); } catch { /* already gone */ } },
  };
}

// A per-process counter so two shadows in one proxy (should not happen, but a
// test might) get distinct socket paths. Not Date.now()/random (unavailable in
// some sandboxes and needless here) — a simple monotonic sequence.
let _shadowSeq = 0;
function nextShadowSeq() { return ++_shadowSeq; }

/**
 * The stdio transport + spawn. Reads the agent on process.stdin, spawns the
 * official server, wires the two directions through a ProxyCore.
 *
 * The official server command mirrors .mcp.json's previous entry, so the proxy is
 * a drop-in: the only change to .mcp.json is to launch this file instead.
 *
 * Step-wise shadow replay is on by default; `STEPWISE=0` turns it off, so the
 * proxy behaves exactly as it did before (append→accept, full replay gate as the
 * only backstop) — the降级 safety net the plan calls for.
 */
export function main() {
  const upstream = spawn('npx', ['playwright', 'run-test-mcp-server', '-c', 'playwright.record.config.ts'],
    { stdio: ['pipe', 'pipe', 'inherit'] });

  const stepwise = process.env.STEPWISE !== '0';
  const shadow = stepwise ? spawnShadow() : null;
  // The Judger runs on top of the shadow (it probes the same socket), so it needs
  // stepwise on. JUDGER=0 turns just the business-effect check off while keeping
  // the mechanical shadow replay — the降级 rung between full Judger and STEPWISE=0.
  const judgerOn = stepwise && shadow && process.env.JUDGER !== '0';
  let judgeSeq = 0;

  const core = new ProxyCore({
    sendToAgent: msg => process.stdout.write(serialize(msg)),
    sendToUpstream: msg => upstream.stdin.write(serialize(msg)),
    replayStep: shadow ? (record => shadow.replayStep(record)) : null,
    // Resume alignment: on the first replay of a Mode B run, bring the shadow to the
    // K-1 prefix already on disk (see ProxyCore._handleRecordStep). resetTo replays
    // that prefix from a fresh page, so the shadow reaches step K's real starting
    // state — the same one generator_setup_page put the Writer's browser at.
    resetShadow: shadow ? (prefix => shadow.resetTo(prefix)) : null,
    judgeStep: judgerOn ? ((record, featurePath, stillHolds, replayFacts, attribution) => {
      // Stop the Writer↔Judger duel after JUDGE_DUEL_LIMIT rounds on one step: if
      // they have not agreed by then, accept as-is and flag for a human rather than
      // loop. The round count is the judge log's memory of this step.
      const JUDGE_DUEL_LIMIT = Number(process.env.JUDGE_DUEL_LIMIT ?? 2);
      let round = 0;
      try { round = judgeRound(featurePath, record.scenario, record.step); } catch { /* fresh log */ }
      if (round >= JUDGE_DUEL_LIMIT) return Promise.resolve({ atLimit: true });

      // The steps already on disk before this one, in the same scenario — the
      // context the Judger reads for "what state should exist now". This record is
      // the last line on disk at this point, so drop it.
      let priorSteps = [];
      try {
        priorSteps = readTrace(featurePath)
          .filter(r => r.scenario === record.scenario)
          .map(r => r.step)
          .slice(0, -1);
      } catch { /* a trace read hiccup is not worth failing the judge over */ }
      return invokeJudger({
        featureStep: record.step,
        scenario: record.scenario,
        record,
        priorSteps,
        socketPath: shadow.socketPath,
        seq: ++judgeSeq,
        featurePath,
        stillHolds,
        replayFacts,
        attribution,
      });
    }) : null,
    scout: judgerOn ? (async (record, featurePath, replayFacts = null) => {
      // The step was rolled back before this runs, so the trace on disk is exactly
      // the clean prefix that led up to it. ARM that prefix on the shadow (store it,
      // do NOT replay it): the scout decides for itself whether it needs a clean
      // start (calling shadow_reset), instead of the proxy replaying the whole prefix
      // around every scout. A full prefix replay (login + every prior step) is the
      // heavy fallback; most rejects are same-page failures where the shadow is still
      // at the step and the scout can explore in place. The scout's agent definition
      // and prompt tell it when to reset.
      let prefix = [];
      try { prefix = readTrace(featurePath); } catch { /* empty prefix */ }
      try { await shadow.armReset(prefix); } catch (e) { return { inconclusive: `scout arm failed: ${e?.message ?? e}` }; }

      let priorSteps = [];
      try { priorSteps = prefix.filter(r => r.scenario === record.scenario).map(r => r.step); } catch { /* ignore */ }

      const scouted = await invokeJudger({
        featureStep: record.step,
        scenario: record.scenario,
        record,
        priorSteps,
        socketPath: shadow.socketPath,
        seq: ++judgeSeq,
        featurePath,
        mode: 'scout',
        replayFacts,
      });

      // The scout resets on its own judgement (shadow_reset) when it dirtied the page
      // or needs a clean start — the proxy no longer replays the prefix here. But
      // guarantee the next real step starts clean regardless of what the scout did:
      // if the scout drove the page and did NOT reset, the Writer's re-record would
      // otherwise start dirty. The scout reports whether it left the page dirty; only
      // then does the proxy replay as a backstop.
      if (scouted && scouted.leftPageDirty) {
        try { await shadow.resetTo(prefix); } catch { /* the next real step's own alignment is the final backstop */ }
      }
      return scouted;
    }) : null,
  });

  const fromAgent = new ReadBuffer();
  const fromUpstream = new ReadBuffer();
  process.stdin.on('data', chunk => { for (const m of fromAgent.append(chunk.toString('utf8'))) core.onAgentMessage(m); });
  upstream.stdout.on('data', chunk => { for (const m of fromUpstream.append(chunk.toString('utf8'))) core.onUpstreamMessage(m); });

  const bye = () => {
    try { upstream.kill(); } catch { /* already gone */ }
    try { shadow?.kill(); } catch { /* already gone */ }
  };
  process.stdin.on('end', bye);
  upstream.on('exit', () => process.exit(0));
  process.on('SIGINT', () => { bye(); process.exit(0); });
  process.on('SIGTERM', () => { bye(); process.exit(0); });
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('mcp-proxy.mjs')) main();
