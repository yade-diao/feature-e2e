/**
 * Summoning the Judger: the second LLM that gives the FINAL ruling on a
 * just-recorded step.
 *
 * The proxy calls this for a step that either failed the mechanical shadow replay
 * OR passed it but changes state / asserts nothing. The mechanical layer only
 * reports facts (which locator/assertion failed, the page before and after);
 * whether that means the step is broken, or is a legitimate terminal action that
 * navigated the page, or is a non-step problem for a human — that is the Judger's
 * call, not code's. It spawns `claude -p --agent judger`, wired to a read-only MCP
 * server (judger-mcp.mjs) that probes the SAME resident shadow the proxy just drove
 * the step on, so the Judger looks at the exact accumulated state the step
 * produced. The Judger writes a structured verdict to a file; this reads it back.
 *
 * The split mirrors recorder.mjs/invokeAgent: the orchestration (mcp-proxy) decides
 * WHEN to summon, what to do with the verdict, and is the SINGLE writer of the
 * judge log (so one ruling is one line — the old double-write that doubled the duel
 * count is gone). This owns only the spawn + the read.
 *
 * There is deliberately NO overall timeout on the child (a feature can take an
 * unknown amount of time to record, and a false timeout would blame the Writer for
 * a slow-but-fine judge). On any failure to get a clean verdict (the agent crashed,
 * wrote nothing, wrote malformed JSON), this returns `{ inconclusive: <reason> }` —
 * never a false rejection. A tooling failure must not be attributed to the Writer;
 * the caller treats inconclusive as "accept the step, the full replay gate remains
 * the backstop", exactly as gates.mjs treats an inconclusive replay.
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { priorVerdicts, digestVerdict } from './judge-log.mjs';

const JUDGER_AGENT = 'judger';

/** A per-summon scratch dir under tmp: the MCP config + the verdict file. */
function scratch(seq) {
  const dir = join(tmpdir(), `judger-${process.pid}-${seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Render the cross-round memory for one step, "near-detailed, far-summarized"
 * (mte's discipline): the MOST RECENT prior round in full (its report and
 * rebuttal), every OLDER round compressed to a one-line digest. This keeps the
 * prompt from carrying every round's full report while still letting the Judger see
 * what it already ruled and what the Writer answered, so it does not thrash.
 */
function renderMemory(priors) {
  if (!priors?.length) return '';
  const older = priors.slice(0, -1);
  const latest = priors[priors.length - 1];
  const lines = [];
  if (older.length) {
    lines.push('Earlier rounds on THIS step (summarized — do not repeat a path already tried):');
    for (const p of older) lines.push(`  ${digestVerdict(p)}`);
  }
  lines.push('Your most recent round on THIS step (in full — re-check it against the page, do not just repeat it):');
  if (latest.kind === 'scout') {
    lines.push(`  ${digestVerdict(latest)}`);
  } else {
    lines.push(`  round ${latest.round ?? '?'}: outcome=${latest.outcome ?? '?'}${latest.rebuttal ? ` — ${latest.rebuttal}` : ''}`);
    for (const r of (latest.report ?? [])) {
      lines.push(`    - [${r.where ?? ''}] ${r.problem ?? ''} → ${r.suggestion ?? ''}`);
    }
    if (latest.stillHolds) lines.push(`    Writer pushed back: ${latest.stillHolds}`);
  }
  return '\n\n## ' + lines.join('\n');
}

/** Render the mechanical replay facts (or note the step replayed clean). */
function renderReplayFacts(replayFacts) {
  if (!replayFacts) return '\n\n## Mechanical replay\n(not run — accept-without-shadow path)';
  if (replayFacts.mechOk) {
    return '\n\n## Mechanical replay\nThe step replayed CLEAN mechanically (its locators resolved and its assertions passed). '
      + 'You are summoned to judge business effect / assertion adequacy, not a mechanical failure.';
  }
  const where = replayFacts.phase ? `${replayFacts.phase}${replayFacts.index != null ? `[${replayFacts.index}]` : ''}` : 'unknown phase';
  const certain = replayFacts.certainMechFail
    ? '\nThis is a CERTAIN mechanical fact (the assertion matched zero elements and the URL did not change) — but YOU have the final decision on what it means and what to do.'
    : '';
  const state = (label, s) => s
    ? `\n  ${label}: url=${JSON.stringify(s.url)} title=${JSON.stringify(s.title)} heading=${JSON.stringify(s.heading)}`
    : `\n  ${label}: (not captured)`;
  return `\n\n## Mechanical replay FAILED (a fact, not a verdict)\n`
    + `phase: ${where}\n`
    + `error: ${replayFacts.error}\n`
    + `Page state before this step ran vs after it ran (compare them to spot a legitimate page transition):`
    + state('before', replayFacts.before)
    + state('after', replayFacts.after)
    + certain
    + `\nDecide what this failure MEANS: a real broken step (outcome:reject), a legitimate terminal action that navigated to a new page — which you must CONFIRM on the new page before accepting (outcome:accept), or a non-step problem for a human (outcome:attribution).`;
}

/**
 * Build the judging prompt. The Judger's agent definition holds HOW to judge and
 * the exact JSON shapes; this names the one step, its record, the context, the
 * mechanical facts, the before/after page state, the Writer's attribution (if any),
 * the cross-round memory, and where to write the verdict.
 */
function buildJudgerPrompt({ featureStep, scenario, record, priorSteps, reportPath, priors, stillHolds, replayFacts, attribution }) {
  const priorSteps_ = priorSteps?.length
    ? priorSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
    : '  (none — this is the first step)';

  const pushback = stillHolds
    ? `\n\n## The Writer insists this step's effect DID happen\nThe Writer re-recorded and pushed back: "${stillHolds}"\n`
      + `Weigh it on the evidence. If the page confirms the Writer is right, set outcome:accept and say so in the report `
      + `(the earlier refusal was yours to correct). If the page still shows the effect did not happen, hold outcome:reject `
      + `and address the Writer's specific point — do not just repeat the earlier verdict.`
    : '';

  const attributionBlock = attribution
    ? `\n\n## The Writer attributes this to a NON-step cause\nThe Writer says this is not something re-recording can fix:\n`
      + `  class: ${attribution.class}\n  evidence: ${attribution.evidence ?? '(none given)'}\n  what a human should change: ${attribution.suggestedChange ?? '(none given)'}\n`
      + `Review it. If you AGREE it is a non-step cause (feature/environment/backend/data/component), return outcome:attribution `
      + `with attribution.agrees:true and your own report. If you DISAGREE — the element is on the page and can be clicked, this `
      + `IS a step problem — return outcome:reject with attribution.agrees:false and a report telling the Writer how to drive it. `
      + `A step-class problem NEVER goes to a human; only a genuine non-step cause does.`
    : '';

  return `Give the FINAL ruling on ONE feature step.

Scenario: ${scenario}
Step to judge (verbatim): ${featureStep}

Steps already accepted before it (the state that should exist now):
${priorSteps_}

The trace record just appended for this step:
${JSON.stringify(record, null, 2)}${renderReplayFacts(replayFacts)}${attributionBlock}${pushback}${renderMemory(priors)}

The shadow browser holds the accumulated state through this step. Look at it with
the read-only shadow_* tools and decide the step's outcome. Follow your agent
definition for the three outcomes (accept / reject / attribution), what each
requires, and the exact JSON shape.

Write your verdict as one JSON object to exactly this path (use the Write tool):
  ${reportPath}
The run reads that file, not your reply.`;
}

/**
 * Summon the Judger for one step.
 *
 * @param socketPath  the resident shadow's unix socket (spawnShadow().socketPath)
 * @param replayFacts { mechOk, error?, phase?, index?, before?, after?, certainMechFail? }
 *                    — the mechanical replay's facts (or null if not run)
 * @param attribution the Writer's optional non-step attribution { class, evidence, suggestedChange }
 * @returns a verdict:
 *   judge mode: { outcome:'accept'|'reject'|'attribution', report:[...], rebuttal?, attribution?:{class,agrees} }
 *   scout mode: { scout:true, resolved:boolean, report:[...], unresolvable? }
 *   or { inconclusive: string } when no trustworthy verdict was produced.
 */
export function invokeJudger({ featureStep, scenario, record, priorSteps = [], socketPath, seq = 0, featurePath = null, stillHolds = null, mode = 'judge', replayFacts = null, attribution = null }, { spawnFn = spawn } = {}) {
  return new Promise((resolvePromise) => {
    const dir = scratch(seq);
    const reportPath = join(dir, 'verdict.json');
    const mcpConfigPath = join(dir, 'judger-mcp.json');
    const priors = featurePath ? priorVerdicts(featurePath, scenario, featureStep) : [];
    const scouting = mode === 'scout';

    // The shadow MCP server, pointed at the resident shadow socket via env. In
    // scout mode JUDGER_SCOUT=1 unlocks the one write tool (shadow_try) so the
    // Judger can find out HOW to click; otherwise the server stays strictly
    // read-only — the fake-green boundary (an arbiter that could change the page it
    // observes proves nothing) is kept by NOT unlocking shadow_try in judge mode.
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        'judger-shadow': {
          command: 'node',
          args: [resolve('src/judger-mcp.mjs')],
          env: { ...process.env, SHADOW_SOCK: socketPath, ...(scouting ? { JUDGER_SCOUT: '1' } : {}) },
        },
      },
    }));

    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
    const done = (verdict) => {
      // The Judger no longer writes the judge log itself — the proxy is the single
      // writer of a verdict line, so one ruling is one line (the old design wrote a
      // refusal twice, doubling the duel count). This only returns the verdict.
      cleanup();
      resolvePromise(verdict);
    };

    const child = spawnFn('claude', [
      '-p',
      '--mcp-config', mcpConfigPath,
      '--agent', JUDGER_AGENT,
      '--permission-mode', 'acceptEdits',
      // Only the shadow tools + Write (for the verdict). No Bash: the Judger has no
      // reason to shell out, and withholding it removes a drift path.
      '--allowed-tools', 'mcp__judger-shadow,Write',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });

    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => done({ inconclusive: `judger spawn failed: ${e.message}` }));
    child.on('close', () => {
      if (!existsSync(reportPath)) {
        return done({ inconclusive: `judger wrote no verdict${err ? ` (stderr: ${err.trim().slice(0, 200)})` : ''}` });
      }
      let verdict;
      try { verdict = JSON.parse(readFileSync(reportPath, 'utf8')); }
      catch (e) { return done({ inconclusive: `judger verdict was not valid JSON: ${e.message}` }); }
      if (scouting) {
        // Scout verdict: { resolved, report[], unresolvable? }. `resolved` = the
        // scout found a working interaction (its report tells the Writer how);
        // `unresolvable` (with a category) = this is NOT a clickable problem
        // (environment / feature / data) — hand it to a human.
        if (typeof verdict.resolved !== 'boolean' || !Array.isArray(verdict.report)) {
          return done({ inconclusive: 'scout verdict missing resolved:boolean or report:array' });
        }
        return done({ scout: true, ...verdict });
      }
      // Judge verdict: { outcome, report[], rebuttal?, attribution? }.
      // The Judger may also declare the step un-judgeable because the shadow was not
      // on the page this step needs (an earlier navigation stranded it): outcome
      // 'inconclusive' with a reason. The run treats that like any other inconclusive
      // (does not blame the Writer); the proxy rebuilds the shadow before the next step.
      if (verdict.outcome === 'inconclusive') {
        return done({ inconclusive: (Array.isArray(verdict.report) && verdict.report[0]?.problem)
          ? `judger: ${verdict.report[0].problem}`
          : 'judger ruled the step inconclusive (shadow state not aligned)' });
      }
      if (!['accept', 'reject', 'attribution'].includes(verdict.outcome) || !Array.isArray(verdict.report)) {
        return done({ inconclusive: 'judger verdict missing a valid outcome (accept|reject|attribution) or report:array' });
      }
      if (verdict.outcome === 'attribution' && (!verdict.attribution || typeof verdict.attribution.class !== 'string')) {
        return done({ inconclusive: 'judger attribution verdict missing attribution.class' });
      }
      done(verdict);
    });
    child.stdin.write(
      scouting
        ? buildScoutPrompt({ featureStep, scenario, record, priorSteps, reportPath, priors, replayFacts })
        : buildJudgerPrompt({ featureStep, scenario, record, priorSteps, reportPath, priors, stillHolds, replayFacts, attribution }),
    );
    child.stdin.end();
  });
}

/**
 * The scout prompt: the Judger stops grading and goes in to find HOW to make the
 * step work — trying interactions on the throwaway shadow with shadow_try, then
 * reporting the working one to the Writer, OR declaring it unresolvable (a non-click
 * cause) for a human. The proxy resets the shadow to the clean pre-step prefix
 * around scouting, so nothing the scout does reaches a recorded step.
 */
function buildScoutPrompt({ featureStep, scenario, record, priorSteps, reportPath, priors, replayFacts = null }) {
  const priorStepsList = priorSteps?.length ? priorSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n') : '  (none)';
  const memory = priors?.length
    ? '\n\nWhat has already been tried on this step (do not repeat):\n' + priors.map(p => `  ${digestVerdict(p)}`).join('\n')
    : '';
  const facts = replayFacts
    ? `\n\nHow the step failed (mechanical facts):\n  phase: ${replayFacts.phase ?? '?'}\n  error: ${replayFacts.error ?? '?'}\n`
      + `  page before it ran: url=${JSON.stringify(replayFacts.before?.url)}\n  page after it ran:  url=${JSON.stringify(replayFacts.after?.url)}\n`
      + `  (If before and after differ, the failing action NAVIGATED the page — the shadow is no longer at this step's start, so you must shadow_reset before exploring.)`
    : '';
  return `SCOUT MODE. The Writer keeps failing this ONE step. Stop grading — go find out HOW to make it work.

Scenario: ${scenario}
Stuck step (verbatim): ${featureStep}

Steps that succeeded before it:
${priorStepsList}

The record the Writer keeps trying:
${JSON.stringify(record, null, 2)}${facts}${memory}

## First: check where the shadow is, and reset ONLY if you must

The shadow is a resident browser. The failing step just ran on it, so it is usually
still at this step's starting state and you can explore in place. FIRST look
(shadow_url / shadow_snapshot). Decide:
- If the page is at this step's starting state → explore in place. Do NOT reset;
  a full prefix replay is slow and unnecessary here.
- If the page navigated away (a terminal action moved it — see the facts above) or
  is otherwise not where this step should start → call \`shadow_reset\` ONCE to
  replay the clean prefix back to this step's start, THEN explore.

## Then: find the working interaction

Use \`shadow_try\` to try real interactions and find the one that makes the step's
business effect happen — e.g. if clicking the data cell selects nothing, try the
row's leading checkbox cell, a double-click, a different scope. Use \`probeAfter\`
(a count/eval) to confirm the effect.

## Before you finish: leave the page clean, or say you didn't

Your shadow_try interactions change the page. The Writer re-records this step next
and needs a clean starting state. So either:
- call \`shadow_reset\` yourself to restore the clean start (preferred if you drove
  the page), and report "leftPageDirty": false; or
- report "leftPageDirty": true so the proxy restores it for you.
If you only READ (never called shadow_try), the page is untouched → "leftPageDirty": false.

## Write your verdict as JSON to ${reportPath} (use Write):

1. You found a working interaction →
   { "resolved": true, "leftPageDirty": <bool>,
     "report": [ { "where": "...", "problem": "why the Writer's way failed",
                   "suggestion": "the EXACT interaction that worked — locator + method, e.g. 'click getByRole(row, {name:PD100046}).getByRole(checkbox)'" } ] }

2. It is NOT a clickable problem — the data/environment/feature makes this step
   impossible however you click →
   { "resolved": false, "leftPageDirty": <bool>,
     "unresolvable": { "category": "environment" | "feature" | "backend" | "data", "summary": "one sentence" },
     "report": [ { "where": "...", "problem": "the evidence it is not a click problem", "suggestion": "what a human must change" } ] }

Only choose (2) when you have evidence no interaction can work — a step that CAN
be clicked correctly must get outcome (1). The run reads the file, not your reply.`;
}

/**
 * Whether a record is a state-changing step. A pure navigation or a pure assertion
 * step has its business effect already covered by the mechanical replay; a step
 * that drives a mutation (fill/select/check/click) is where "ran but changed
 * nothing" hides. Used only to decide whether a MECHANICALLY-PASSING step still
 * warrants a business-effect judge — a mechanically-FAILING step always goes to the
 * Judger regardless.
 */
const STATE_CHANGING = new Set(['fill', 'selectOption', 'check', 'uncheck', 'click', 'dblclick', 'press', 'setInputFiles', 'dragTo']);
export function isStateChangingStep(record) {
  return (record.actions ?? []).some(a => STATE_CHANGING.has(a.method));
}

/**
 * Whether a MECHANICALLY-PASSING record should still be handed to the Judger. Two
 * cases: a state-changing step ("ran but changed nothing" hides here), and a step
 * that asserts nothing and is not pure navigation (the hollow-step case — a step
 * that only acts and never verifies replays green forever while proving nothing;
 * whether that missing assertion is fine or a real gap is a judgement about the
 * feature's intent, so the Judger decides). A pure-navigation step is exempt.
 *
 * A mechanically-FAILING step does NOT go through this — it goes to the Judger
 * unconditionally (the mechanical layer only reports; the Judger rules).
 */
export function needsJudging(record) {
  if (isStateChangingStep(record)) return true;
  const actions = record.actions ?? [];
  const assertions = record.assertions ?? [];
  const onlyNavigation = actions.length > 0 && actions.every(a => a.method === 'goto');
  return assertions.length === 0 && !onlyNavigation;
}

/** Whether a step asserts nothing (used to tell the Judger to weigh assertion adequacy). */
export function hasNoAssertions(record) {
  return (record.assertions ?? []).length === 0;
}

/**
 * Summon the Judger to rule on a STALLED recording — the progress watchdog.
 *
 * A recording can hang with no way for code to know if it is a slow-but-fine step
 * (a SAML login, a heavy UI5 view) or a genuinely stuck run (the network is down,
 * the environment cannot open the page, the feature asks for something impossible).
 * The user's decision: do NOT hard-kill on a timer — a timer cannot tell those
 * apart. When the run makes no progress for a while, summon the Judger to look at
 * the FACTS of the stall and decide.
 *
 * Unlike the step Judger, this has no shadow page to probe: a stall (especially in
 * the setup phase, before any step is recorded) often means the shadow never even
 * launched. So this rules on META-FACTS only — how long there has been no progress,
 * which phase the run is in (still in setup vs recording step N), and the tail of
 * the agent's own output — and returns one of:
 *   { decision: 'wait' }                      — probably just slow; keep waiting
 *   { decision: 'abandon', class, summary, report? } — genuinely stuck; the caller
 *       writes a diagnosis, stops the agent, and stops the feature (a human acts).
 * `class` ∈ environment|feature|backend|data (a step-class stall never reaches here
 * — the watchdog is about the whole run not progressing, not one step's locator).
 * A malformed/absent verdict resolves to `{ decision: 'wait', inconclusive }` — the
 * safe side is to keep waiting, never to abandon a fine run on a tooling hiccup.
 */
export function invokeProgressJudge({ featurePath, scenario = null, stalledForMs, phase, stepsRecorded, agentTail = '', seq = 0 }, { spawnFn = spawn } = {}) {
  return new Promise((resolvePromise) => {
    const dir = scratch(seq);
    const reportPath = join(dir, 'progress-verdict.json');
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
    const done = (v) => { cleanup(); resolvePromise(v); };

    const mins = Math.round(stalledForMs / 60000);
    const prompt = `PROGRESS CHECK. A recording of a feature has made NO progress for about ${mins} minute(s).
Decide whether it is just slow (keep waiting) or genuinely stuck (abandon, for a human).

Feature: ${featurePath}${scenario ? `\nScenario: ${scenario}` : ''}
Phase: ${phase === 'setup' ? 'STILL IN SETUP — not one step has been recorded yet (the browser has not reached the first step to record; a resume prefix may still be replaying, or login/navigation is hung)' : `recording — ${stepsRecorded} step(s) recorded so far, then progress stopped`}
No new trace record and no agent output for ~${mins} minute(s).

The agent's most recent output (may be empty if it is blocked waiting on a tool):
--- AGENT TAIL ---
${agentTail ? agentTail.slice(-2000) : '(no output captured)'}
--- END ---

You have NO page to look at here (a stalled run often never launched the shadow).
Rule on these facts alone. Weigh the innocent explanation first: a real login/SAML
redirect, a heavy UI5 view, or a genuinely slow step can take minutes — if the tail
shows the agent actively working (recent tool calls, reasoning), prefer to WAIT.
Abandon only when the facts say no amount of waiting will help: the environment
cannot open the page (network/cert/login down), the feature asks for something the
page cannot do, a backend is erroring. A slow step is NOT a reason to abandon.

Write ONE JSON object to exactly this path (use Write):
  ${reportPath}
Shape:
  { "decision": "wait" }                       // probably just slow — keep waiting
  or
  { "decision": "abandon",
    "class": "environment" | "feature" | "backend" | "data",
    "summary": "one sentence on why no waiting will help",
    "report": [ { "problem": "the evidence", "suggestion": "what a human must change" } ] }
The run reads the file, not your reply.`;

    const child = spawnFn('claude', [
      '-p', '--agent', JUDGER_AGENT, '--permission-mode', 'acceptEdits', '--allowed-tools', 'Write',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });

    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => done({ decision: 'wait', inconclusive: `progress judge spawn failed: ${e.message}` }));
    child.on('close', () => {
      if (!existsSync(reportPath)) return done({ decision: 'wait', inconclusive: `progress judge wrote no verdict${err ? ` (stderr: ${err.trim().slice(0, 200)})` : ''}` });
      let v;
      try { v = JSON.parse(readFileSync(reportPath, 'utf8')); }
      catch (e) { return done({ decision: 'wait', inconclusive: `progress verdict not valid JSON: ${e.message}` }); }
      if (v.decision === 'abandon') {
        if (typeof v.class !== 'string') return done({ decision: 'wait', inconclusive: 'abandon verdict missing class' });
        return done({ decision: 'abandon', class: v.class, summary: v.summary ?? '', report: Array.isArray(v.report) ? v.report : [] });
      }
      // Anything not a well-formed abandon is treated as wait (the safe side).
      return done({ decision: 'wait' });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
