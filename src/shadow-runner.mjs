/**
 * The shadow runner: a resident browser that replays a recording one step at a
 * time, on accumulated state.
 *
 * Why it exists: the recording path verifies a locator is unique and editable
 * the instant an action is driven (mcp-proxy.mjs), and re-checks locator
 * uniqueness for the whole feature once it is recorded (gates.mjs
 * uniquenessReplayGate). Neither answers the question a stable spec actually
 * turns on: after this step ran, did the step's *business effect* happen — did
 * the product get selected, did the page navigate, did the value stick? A click
 * that resolves to one element, runs without error, and selects nothing is green
 * to every mechanical check and wrong to the feature.
 *
 * This process is the independent second party that makes that question
 * answerable at the moment the step is recorded, not 73 minutes later when the
 * whole feature finally replays. It holds one browser + context + page and, when
 * the proxy hands it a freshly-appended record, replays THAT record on the page
 * as it now stands — the accumulated state of every step before it, not a fresh
 * context. So a login recorded as step 1 leaves the runner logged in for step 2,
 * exactly as the final spec's single `test()` shares one context across all its
 * steps (render-spec.mjs renders the whole feature as one test for this reason).
 *
 * ## Why a separate process, not ProxyCore
 *
 * ProxyCore (mcp-proxy.mjs) is a single-session engine: one `_verifiedLocators`,
 * one `_pendingEvals`, one upstream MCP server. It drives the Writer's browser.
 * The shadow is a SECOND browser with its own accumulating state; making one
 * ProxyCore straddle two sessions would tangle the two `_verifiedLocators` sets
 * and the negative-id eval space. A separate process keeps each a clean
 * single-session assumption and talks to the proxy over a line-delimited JSON
 * protocol on stdin/stdout.
 *
 * ## Protocol (one JSON object per line, request/response by `id`)
 *
 *   → { id, cmd: 'setup' }                         open browser, context, page
 *   ← { id, ok: true }                        | { id, ok: false, error }
 *   → { id, cmd: 'step', record }                  replay one record on the page
 *   ← { id, ok: true } | { id, ok: false, error, phase }   phase: 'action'|'assertion'
 *   → { id, cmd: 'snapshot', opts? }               a11y snapshot of the page now
 *   ← { id, ok: true, snapshot }
 *   → { id, cmd: 'close' }                          tear down; process exits after
 *   ← { id, ok: true }
 *
 * A 'step' that throws does NOT crash the runner — it answers ok:false with the
 * error and which phase failed, and the page is left as the failed step left it
 * (the proxy reads a snapshot to attribute, then decides truncate/refuse). Only
 * an unrecoverable transport error exits the process.
 *
 * ## Config equivalence (the reason a shadow-green step is a spec-green step)
 *
 * The final spec replays under playwright.record.config.ts during recording and
 * playwright.config.ts in CI. The shadow uses the programmatic API, so it must
 * reproduce the recording config's `use`/launchOptions by hand or "shadow green,
 * spec red" creeps in through a config gap, not a real drift. The values here are
 * copied from playwright.record.config.ts (channel 'chrome', the
 * auto-select-certificate arg for the client-cert environment, locale, viewport,
 * baseURL origin from BASE_URL via target.mjs, the 120s/15s timeouts). Kept in
 * sync deliberately; the equivalence regression gate (the plan's verification §3)
 * is what proves it stayed in sync.
 *
 * The per-record executor is the shared record-interpret layer
 * (record-interpret.mjs), the same dispatch render-spec.mjs derives spec text
 * from — so "same source" is literally true, and a test pins the candidate→
 * locator equivalence.
 */

import { chromium, expect as baseExpect } from '@playwright/test';
import { createServer } from 'net';
import { target } from './target.mjs';
import { runAction, runAssertion, resolveValues, buildLocator } from './record-interpret.mjs';
import { isMutatingEvaluateFn } from './mcp-routing.mjs';

/** Line-delimited JSON reader: feed chunks, get back complete parsed messages. */
class ReadBuffer {
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
        catch { /* partial or non-JSON — MCP-style one JSON per line, skip */ }
      }
    }
    return out;
  }
}

/**
 * The resident browser and its single accumulating page.
 *
 * One context, one page, held for the whole feature so state carries across
 * steps. Split from the transport (main) so it can be unit-tested by driving
 * handle() directly with fake records and asserting page state, no stdio.
 */
export class ShadowRunner {
  constructor({ baseURL = null, headless = true } = {}) {
    // The origin the spec's paths resolve against — same split target.mjs gives
    // the recording config, so a `goto('/x')` here lands where the spec's would.
    // `?? undefined` so a null argument still lets target() fall back to
    // process.env.BASE_URL (its default parameter only fires on undefined).
    this._origin = target(baseURL ?? undefined).origin;
    this._headless = headless;
    this._browser = null;
    this._context = null;
    this._page = null;
    // Named values accumulate across the feature's records, matching the
    // renderer's file-level const block: a value Create declares (PROMOTION_NAME)
    // stays in scope for a later Edit record's ref. resolveValues merges each
    // record's own values onto this.
    this._values = {};
    // The clean prefix the proxy "arms" before a scout, so the scout can reset to it
    // on its own judgement (shadow_reset → cmd 'reset') without the proxy replaying
    // it around every scout. Null until armed.
    this._armedPrefix = null;
    // "The accumulated state may have diverged from what the trace implies." Set when
    // a `_step` fails (an action that did not land, or an assertion that did not hold)
    // — the page is left wherever the failure stopped, not rolled back, so every later
    // step would replay on that possibly-wrong page. The proxy reads this to decide
    // whether to rebuild the shadow to the on-disk prefix before judging the next step,
    // instead of judging it on a page an earlier step never actually reached. Cleared
    // on a clean step and on a full reset (the state is trustworthy again).
    this._dirty = false;
    // expect with the recording config's 15s expect timeout, not the 120s action
    // default the context carries.
    this._expect = baseExpect.configure({ timeout: 15_000 });
  }

  /** Dispatch one protocol request to its handler; never throws — errors become ok:false. */
  async handle(msg) {
    const { id, cmd } = msg;
    try {
      switch (cmd) {
        case 'setup':    return { id, ...(await this._setup()) };
        case 'step':     return { id, ...(await this._step(msg.record)) };
        case 'snapshot': return { id, ...(await this._snapshot(msg.opts)) };
        case 'probe':    return { id, ...(await this._probe(msg)) };
        case 'tryClick': return { id, ...(await this._tryClick(msg)) };
        case 'resetTo':  return { id, ...(await this._resetTo(msg.records)) };
        // armReset stores the clean prefix; reset replays it. Split so the SCOUT can
        // decide FOR ITSELF whether it needs a clean start (calling `reset` via its
        // shadow_reset tool), instead of the proxy replaying the whole prefix around
        // every scout unconditionally. The proxy arms the prefix before scouting; the
        // scout resets only if it judges it necessary (a full prefix replay is the
        // heavy fallback, not the default).
        case 'armReset': this._armedPrefix = msg.records ?? []; return { id, ok: true, armed: (msg.records ?? []).length };
        case 'reset':    return { id, ...(await this._resetTo(this._armedPrefix ?? [])) };
        case 'close':    return { id, ...(await this._close()) };
        default:         return { id, ok: false, error: `unknown cmd: ${cmd}` };
      }
    } catch (e) {
      return { id, ok: false, error: e?.message ?? String(e) };
    }
  }

  /**
   * Open the resident browser exactly as the recording config would.
   *
   * channel 'chrome' + auto-select-certificate: the environment under test needs
   * a client certificate the bundled Chromium cannot read from the macOS
   * Keychain (it blocks every navigation on a cert dialog). Real Chrome reads the
   * Keychain and the arg answers the prompt — copied from
   * playwright.record.config.ts, which documents the same reason.
   */
  async _setup() {
    this._browser = await chromium.launch({
      headless: this._headless,
      channel: 'chrome',
      args: ['--auto-select-certificate-for-urls=[{"pattern":"*","filter":{}}]'],
    });
    this._context = await this._browser.newContext({
      baseURL: this._origin,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 900 },
    });
    // Match the recording config's timeouts: 120s action, 15s expect. A resident
    // login flow (SAML redirects) can be slow; the generous action timeout is why
    // the login step is not mistaken for a recording error.
    this._context.setDefaultTimeout(120_000);
    this._context.setDefaultNavigationTimeout(120_000);
    this._page = await this._context.newPage();
    return { ok: true };
  }

  /**
   * Replay one record on the current page, in the same order the spec would run
   * it: every action, then every assertion.
   *
   * The per-action/assertion execution is the shared record-interpret layer
   * (record-interpret.mjs) — the SAME dispatch render-spec.mjs derives its spec
   * text from, so a record that runs here runs the way the rendered spec would.
   *
   * On failure it returns which phase failed and the error, and leaves the page
   * as-is (the proxy snapshots it to attribute before deciding).
   *
   * Every result carries `before` and `after` — a lightweight state fingerprint of
   * the page as this step STARTED (the state the prior step left) and as it ENDED
   * (however it ended, pass or fail). This is what lets the Judger decide, without
   * a second replay, whether a mechanical failure is really a legitimate page
   * transition: a terminal action (a save/submit that navigates to a new page)
   * runs, then the step's own locators no longer resolve on the new page and the
   * mechanical replay "fails" — but before→after shows the page legitimately moved
   * on. The Judger reads before/after (and the live `after` page through its
   * read-only tools) and rules; the mechanical layer only reports. `before` MUST be
   * captured here, before the actions run, because once they navigate the starting
   * page is gone and cannot be looked at after the fact.
   */
  async _step(record) {
    if (!this._page) return { ok: false, error: 'step before setup', phase: 'setup' };
    // Merge this record's values onto the accumulated map (dynamic exprs eval'd
    // once here, exactly as the renderer's const would). A later record's ref to
    // an earlier record's value resolves against the accumulated map.
    this._values = resolveValues(record, this._values);

    const before = await this._captureState();
    // Run actions then assertions; on the first failure, capture `after` on the
    // page as it stands (the failed step's own state) and return the fact — the
    // proxy hands it, plus before/after, to the Judger to rule on. A failure also
    // marks the shadow dirty: the page was left mid-step, not rolled back, so the
    // next step must not be judged on it blindly (the proxy rebuilds to prefix first).
    for (const [i, action] of (record.actions ?? []).entries()) {
      try {
        await runAction(this._page, action, this._values);
      } catch (e) {
        this._dirty = true;
        return { ok: false, dirty: true, error: e?.message ?? String(e), phase: 'action', index: i, before, after: await this._captureState() };
      }
    }
    for (const [i, as] of (record.assertions ?? []).entries()) {
      try {
        await runAssertion(this._page, this._expect, as, this._values);
      } catch (e) {
        this._dirty = true;
        return { ok: false, dirty: true, error: e?.message ?? String(e), phase: 'assertion', index: i, before, after: await this._captureState() };
      }
    }
    // A clean step: the accumulated state matches the trace again.
    this._dirty = false;
    return { ok: true, before, after: await this._captureState() };
  }

  /**
   * A lightweight fingerprint of the page right now — { url, title, heading, marker }
   * — for the before/after comparison the Judger uses to spot a legitimate page
   * transition. Deliberately NOT a full `ariaSnapshot()`: that runs 80–150 KB on a
   * dense UI5 page (the reason _snapshot is scoped), and this is captured on EVERY
   * step, so it must be cheap. `heading` is the first visible h1/h2's text; `marker`
   * is a short signature of the main content region — together enough to distinguish
   * a same-URL SPA view change (UI5 hash routing keeps the URL and swaps the content)
   * that `url` alone would miss, e.g. a list page vs the detail page it navigates to.
   * Every field is best-effort: whatever cannot be read comes back null rather than
   * throwing, because a state fingerprint must never fail the step it is only observing.
   */
  async _captureState() {
    const p = this._page;
    if (!p) return { url: null, title: null, heading: null, marker: null };
    // Every read is wrapped so a fingerprint that is only observing never fails the
    // step, and stays safe on any page-like object (one missing title()/locator()
    // comes back null, not a thrown "not a function"). try/catch, not just .catch():
    // the locator chain can throw synchronously while it is being built, which a
    // promise .catch() would not intercept. Real Playwright pages read all three.
    const read = async (fn) => { try { return (await fn()) ?? null; } catch { return null; } };
    const url = await read(() => (typeof p.url === 'function' ? p.url() : null));
    const title = await read(() => (typeof p.title === 'function' ? p.title() : null));
    const heading = await read(() => (typeof p.locator === 'function'
      ? p.locator('h1, h2').first().innerText({ timeout: 1000 })
      : null));
    // A short signature of the main content region. UI5 hash routing swaps the whole
    // main view without touching the URL, so a list page and the detail page it opens
    // share url/title and often heading too; the leading text of `main` (or `body`)
    // differs and lets before/after see that a navigation step did — or did NOT —
    // actually change the view. Capped so it stays a cheap fingerprint, not a snapshot.
    const marker = await read(() => (typeof p.locator === 'function'
      ? p.locator('main, [role="main"], body').first().innerText({ timeout: 1000 })
        .then(t => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, 200) : null))
      : null));
    return { url, title, heading, marker };
  }

  /**
   * An accessibility snapshot of the page now — what the Judger reads to attribute.
   *
   * `ariaSnapshot()` yields the same YAML aria tree the Playwright MCP
   * `browser_snapshot` tool returns, so the Judger reads the shadow in exactly the
   * form the Writer's agent definition already speaks — same source, no second
   * dialect. Scoped to `body` by default; an `opts.selector` narrows a dense UI5
   * page (a full snapshot can run 80–150 KB, which has stalled a recording).
   */
  async _snapshot(opts = {}) {
    if (!this._page) return { ok: false, error: 'snapshot before setup' };
    const root = opts.selector ? this._page.locator(opts.selector) : this._page.locator('body');
    const snapshot = await root.ariaSnapshot();
    return { ok: true, snapshot };
  }

  /**
   * A READ-ONLY probe of the page, for the Judger to check a step's business
   * effect against the live shadow — never to drive it.
   *
   * The Judger is a second LLM that decides whether the step's business intent
   * actually happened (a click that selected nothing is the case that motivates
   * the whole design). To decide well it must look, the way a person would: read
   * the current URL, count how many rows a table now has, find whether a chip
   * appeared. Those are all reads. This is the one door it looks through, and the
   * door only opens outward for reads:
   *
   *   { cmd:'probe', kind:'url' }                      → { ok, url }
   *   { cmd:'probe', kind:'find', text|regex }         → { ok, matches:[texts] }
   *   { cmd:'probe', kind:'count', candidate }         → { ok, count }
   *   { cmd:'probe', kind:'eval', fn:'() => …' }        → { ok, value }   (read-only)
   *
   * An `eval` fn is checked against the SAME mutation patterns the proxy refuses
   * for the Writer (isMutatingEvaluate) — `.click()`, `.value =`, `dispatchEvent`,
   * etc. — so the Judger cannot arrange the state it is meant to observe. A
   * mutating probe is refused, not run: an arbiter that can change the page can
   * make any step look held, which is exactly the fake-green the recording rules
   * exist to prevent.
   */
  async _probe(msg) {
    if (!this._page) return { ok: false, error: 'probe before setup' };
    const kind = msg.kind;
    switch (kind) {
      case 'url':
        return { ok: true, url: this._page.url() };
      case 'find': {
        const loc = msg.regex
          ? this._page.getByText(new RegExp(msg.regex))
          : this._page.getByText(msg.text ?? '');
        const matches = await loc.allInnerTexts().catch(() => []);
        return { ok: true, matches: matches.slice(0, 50) };
      }
      case 'count': {
        if (!msg.candidate) return { ok: false, error: 'probe count needs a candidate' };
        const count = await buildLocator(this._page, msg.candidate).count();
        return { ok: true, count };
      }
      case 'eval': {
        const fn = String(msg.fn ?? '');
        // Two guards, both refusing before anything runs — a Judger that can
        // change the page can fake the very effect it is meant to observe:
        //  1. the proxy's shared mutation rule (click/dispatch/known-property
        //     assignment) — the same one the Writer's evaluate is held to.
        //  2. a stricter probe-only guard: ANY bare assignment. The shared rule
        //     lists specific properties (.value/.innerHTML/…); a probe is pure
        //     observation, so any `x = y` that is not a comparison (==, ===, !=,
        //     >=, <=) or an arrow (=>) is refused, catching assignments the
        //     property list does not enumerate (document.title =, style.x =, …).
        //     This deliberately also refuses a default parameter (`a = 3`) — a
        //     false positive we accept: refusing a rare read-only form (rewrite
        //     without the default) is the safe side; letting one real mutation
        //     through is not. A probe is a one-liner read; it should not need one.
        const bareAssignment = /[^=!<>]=(?![=>])/;
        if (isMutatingEvaluateFn(fn) || bareAssignment.test(fn)) {
          return { ok: false, error: 'probe eval must be read-only — it assigns or drives the page. Observe (read a value, count elements, read text); write it as a single reading expression with no `=` assignment (a default parameter counts — avoid it).' };
        }
        const value = await this._page.evaluate(new Function(`return (${fn})();`));
        return { ok: true, value };
      }
      default:
        return { ok: false, error: `unknown probe kind: ${kind}` };
    }
  }

  /**
   * SCOUT MODE ONLY: try an interaction on the shadow to find out how to make the
   * step's effect happen — a double-click, the row's leading checkbox cell, etc.
   * This is the one place the Judger is allowed to DRIVE the shadow, not just read
   * it, and it exists because a Writer stuck on the same step for rounds needs to
   * be TOLD how to click, not just told it failed again.
   *
   * The safety is not "undo each click" (unreliable on UI5); it is that scouting
   * runs on a state the caller will THROW AWAY — the proxy resets the shadow to the
   * clean pre-step prefix before scouting and again before the Writer re-records,
   * so whatever the scout does to the page does not leak into a recorded step. We
   * report what the click did (did the selected-count change?) so the Judger can
   * tell which interaction actually works.
   *
   * `method` defaults to click; `candidate` is a trace candidate; `probeAfter` is
   * an optional read to run right after (e.g. count the selected rows) so the
   * Judger sees the effect in one round-trip.
   */
  async _tryClick(msg) {
    if (!this._page) return { ok: false, error: 'tryClick before setup' };
    const { candidate, method = 'click' } = msg;
    if (!candidate) return { ok: false, error: 'tryClick needs a candidate' };
    const urlBefore = this._page.url();
    try {
      const loc = buildLocator(this._page, candidate);
      // Only genuine, recordable interaction methods — never an evaluate/script.
      const ALLOWED = new Set(['click', 'dblclick', 'check', 'hover', 'press']);
      if (!ALLOWED.has(method)) return { ok: false, error: `tryClick method '${method}' not allowed (scout uses real interactions only)` };
      if (method === 'press') await loc.press(msg.key ?? 'Enter');
      else await loc[method]();
      let after;
      if (msg.probeAfter) {
        try { after = await this._probe(msg.probeAfter); } catch (e) { after = { ok: false, error: e.message }; }
      }
      return { ok: true, urlBefore, urlAfter: this._page.url(), after };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e), urlBefore, urlAfter: this._page.url() };
    }
  }

  /**
   * Rebuild the shadow to a clean state by replaying a list of records from a
   * fresh page — the prefix that led up to (but not including) the stuck step.
   * Used to (a) give the scout a clean pre-step page to explore on, and (b) undo
   * the scout's exploration before the Writer re-records. This is the "replay the
   * prefix" fallback the user named: preferred over trying to reverse individual
   * clicks, because on UI5 a real replay of the known-good prefix is the reliable
   * way back to a known state.
   */
  async _resetTo(records) {
    // Self-heal: if the browser was never launched (resetTo arrived first), launch
    // it now rather than erroring — a reset to a prefix is a complete "bring the
    // page to this state" request and should not depend on a prior setup call.
    if (!this._browser) {
      const s = await this._setup();
      if (!s.ok) return s;
    }
    // Fresh context/page so no leftover state from the scout's poking survives.
    try { await this._context?.close(); } catch { /* gone */ }
    this._context = await this._browser.newContext({
      baseURL: this._origin, locale: 'zh-CN', viewport: { width: 1440, height: 900 },
    });
    this._context.setDefaultTimeout(120_000);
    this._context.setDefaultNavigationTimeout(120_000);
    this._page = await this._context.newPage();
    this._values = {};
    for (const [i, rec] of (records ?? []).entries()) {
      const res = await this._step(rec);
      if (!res.ok) return { ok: false, error: `prefix replay failed at record ${i}: ${res.error}`, at: i };
    }
    return { ok: true, replayed: (records ?? []).length };
  }

  async _close() {
    try { await this._context?.close(); } catch { /* already gone */ }
    try { await this._browser?.close(); } catch { /* already gone */ }
    this._page = this._context = this._browser = null;
    return { ok: true };
  }
}

/**
 * Serialise handle() calls: the resident page is one shared resource, and once a
 * second client (the Judger's read-only probe channel) connects alongside the
 * proxy, two requests could otherwise interleave on the same page. A promise
 * chain makes the runner process one request start-to-finish before the next —
 * which is also the recording model (one step at a time), so it costs nothing the
 * design did not already assume.
 */
function serialise(runner) {
  let tail = Promise.resolve();
  return (msg) => {
    const run = tail.then(() => runner.handle(msg));
    // keep the chain alive even if one handle rejects (it shouldn't — handle
    // catches — but a bug must not wedge the queue)
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * Transport. Two modes:
 *
 *  - **socket** (SHADOW_SOCK set): listen on a unix socket, accept many clients
 *    (the proxy for `step`, the Judger's MCP shim for read-only `probe`), all
 *    sharing ONE resident browser through the serialised queue. This is the mode
 *    the recording pipeline uses — the Judger has to see the same accumulated
 *    page the proxy just drove a step on, so they must share one shadow, not each
 *    spawn their own.
 *  - **stdio** (no SHADOW_SOCK): one client on stdin/stdout. Kept for the direct
 *    single-client uses (stage-0/1 smoke, unit exercising) and as the simplest
 *    path when no second observer exists.
 */
export function main() {
  const runner = new ShadowRunner({
    // Explicit, not null: passing null would defeat target()'s default-parameter
    // fallback to process.env.BASE_URL. The child inherits BASE_URL from the proxy's
    // env (spawnShadow passes it through), so the shadow navigates the same origin
    // the Writer's recording session does.
    baseURL: process.env.BASE_URL,
    headless: process.env.SHADOW_HEADED ? false : true,
  });
  const dispatch = serialise(runner);

  if (process.env.SHADOW_SOCK) {
    const server = createServer((conn) => {
      const reader = new ReadBuffer();
      conn.on('data', async (chunk) => {
        for (const msg of reader.append(chunk.toString('utf8'))) {
          // A `close` from ONE client ends only that client's connection — it must
          // NOT tear down the shared resident browser (that would take it out from
          // under the other client mid-feature). So a socket-mode close is answered
          // and the connection dropped WITHOUT dispatching to _close(); the browser
          // lives until the proxy kills the child (spawnShadow().kill on stdin end /
          // SIGINT / upstream exit), the one owner entitled to end it.
          if (msg.cmd === 'close') { conn.write(JSON.stringify({ id: msg.id, ok: true }) + '\n'); conn.end(); break; }
          const out = await dispatch(msg);
          conn.write(JSON.stringify(out) + '\n');
        }
      });
      conn.on('error', () => { /* a client dropped; other clients live on */ });
    });
    server.listen(process.env.SHADOW_SOCK);
    server.on('error', (e) => { process.stderr.write(`[shadow] socket error: ${e.message}\n`); process.exit(1); });
    return;
  }

  const reader = new ReadBuffer();
  const reply = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  process.stdin.on('data', async (chunk) => {
    for (const msg of reader.append(chunk.toString('utf8'))) {
      const out = await dispatch(msg);
      reply(out);
      if (msg.cmd === 'close') process.exit(0);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (process.argv[1] && process.argv[1].endsWith('shadow-runner.mjs')) main();
