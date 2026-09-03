/**
 * The proxy glue: framing (ReadBuffer), and ProxyCore's routing + the record_step
 * count-and-append flow, driven against a fake upstream so no browser or spawn is
 * needed. What only a real run proves — that the official server actually counts
 * and that Claude calls record_step — is left to end-to-end verification.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReadBuffer, serialize, ProxyCore, shadowActivityLine, judgeActivityLine } from '../mcp-proxy.mjs';

// ── ReadBuffer: line-delimited JSON framing ──────────────────────────────────

test('ReadBuffer: splits on newlines, buffers partial lines, tolerates CRLF', () => {
  const rb = new ReadBuffer();
  assert.deepEqual(rb.append('{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  // A partial line is held until its newline arrives.
  assert.deepEqual(rb.append('{"c":'), []);
  assert.deepEqual(rb.append('3}\r\n'), [{ c: 3 }]);
  // Non-JSON noise on a line is skipped, not thrown.
  assert.deepEqual(rb.append('garbage\n{"d":4}\n'), [{ d: 4 }]);
});

test('serialize: one JSON object per line', () => {
  assert.equal(serialize({ id: 1, method: 'x' }), '{"id":1,"method":"x"}\n');
});

// ── harness: a ProxyCore with captured sinks and a fake upstream ─────────────

function harness({ appendRecord, countRecords, evalTimeoutMs, replayStep, truncate, judgeStep, scout, appendVerdict, judgeRound, priorVerdicts, scoutCount, scoutLimit, resetShadow, readPrefix } = {}) {
  const toAgent = [];
  const toUpstream = [];
  const appends = [];
  const truncations = [];
  const verdicts = [];
  const activity = [];   // activity-log lines the proxy would append (shadow/judge)
  const core = new ProxyCore({
    sendToAgent: m => toAgent.push(m),
    sendToUpstream: m => toUpstream.push(m),
    appendRecord: appendRecord ?? ((feature, record) => { appends.push({ feature, record }); return 'run/x.trace.jsonl'; }),
    countRecords: countRecords ?? (() => appends.length),
    ...(evalTimeoutMs != null ? { evalTimeoutMs } : {}),
    ...(replayStep != null ? { replayStep } : {}),
    ...(judgeStep != null ? { judgeStep } : {}),
    ...(scout != null ? { scout } : {}),
    ...(judgeRound != null ? { judgeRound } : {}),
    ...(priorVerdicts != null ? { priorVerdicts } : {}),
    ...(scoutCount != null ? { scoutCount } : {}),
    ...(scoutLimit != null ? { scoutLimit } : {}),
    ...(resetShadow != null ? { resetShadow } : {}),
    ...(readPrefix != null ? { readPrefix } : {}),
    truncate: truncate ?? ((feature, count) => { truncations.push({ feature, count }); return count; }),
    // Default: collect verdict/scout lines in-memory instead of writing reports/*.judge-log.jsonl.
    appendVerdict: appendVerdict ?? ((feature, entry) => { verdicts.push({ feature, entry }); }),
    // Capture activity lines in-memory instead of writing the activity.log file.
    appendActivity: (feature, line) => { activity.push({ feature, line }); },
  });
  return { core, toAgent, toUpstream, appends, truncations, verdicts, activity };
}

// Reply to every browser_evaluate the proxy has sent upstream, until the agent
// gets its record_step result. record_step awaits between evaluates, so we yield
// to the microtask queue each round.
//
// The proxy issues two kinds of evaluate: a uniqueness count (fn `() => 1`) and,
// for a fill/type, an editability check (fn from editabilityCheckExpr, recognisable
// by `isContentEditable`). We answer each by kind:
//   count: rendered as the real official reply for that many matches —
//     1 → normal result · N>1 → strict-mode isError · 0 → does-not-match isError · null → unrelated isError
//   editability: a normal result of 'editable' / 'not-editable' (or an isError for null)
function evaluateReplyForCount(count) {
  if (count === 1) return { content: [{ type: 'text', text: '### Result\n1\n### Ran Playwright code' }], isError: false };
  if (count === 0) return { content: [{ type: 'text', text: '### Error\nError: "getByRole(…)" does not match any elements.' }], isError: true };
  if (count == null) return { content: [{ type: 'text', text: '### Error\nError: element is detached' }], isError: true };
  return { content: [{ type: 'text', text: `### Error\nError: strict mode violation: getByRole(…) resolved to ${count} elements:` }], isError: true };
}
function editabilityReply(editable) {
  if (editable == null) return { content: [{ type: 'text', text: '### Error\nError: boom' }], isError: true };
  return { content: [{ type: 'text', text: `### Result\n${editable ? 'editable' : 'not-editable'}\n### Ran` }], isError: false };
}
const isEditabilityEval = m => String(m.params?.arguments?.function || '').includes('isContentEditable');


// ── tools/list injection ─────────────────────────────────────────────────────

test('tools/list is relayed, and its result gets record_step injected before reaching the agent', () => {
  const h = harness();
  h.core.onAgentMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(h.toUpstream.length, 1, 'relayed to upstream');
  assert.equal(h.toUpstream[0].method, 'tools/list');

  // Upstream answers with the official tools; the agent must see record_step too.
  h.core.onUpstreamMessage({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'browser_click' }] } });
  assert.equal(h.toAgent.length, 1);
  assert.deepEqual(h.toAgent[0].result.tools.map(t => t.name), ['browser_click', 'record_step']);
});

test('an ordinary (non-action) tool call is relayed verbatim, its reply passed straight back', () => {
  const h = harness();
  // A non-action tool (navigate) is relayed synchronously — only action tools
  // (click/type/…) are held back for drive-time verification.
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: '/' } } };
  h.core.onAgentMessage(call);
  assert.deepEqual(h.toUpstream[0], call, 'relayed unchanged');
  const reply = { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'navigated' }] } };
  h.core.onUpstreamMessage(reply);
  assert.deepEqual(h.toAgent[0], reply, 'reply passed straight back');
});

test('an action driven by a snapshot ref is refused by the proxy, not relayed upstream', () => {
  const h = harness();
  const call = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'browser_click', arguments: { target: 'f3e1356', element: 'Create Promotion button' } } };
  h.core.onAgentMessage(call);
  assert.equal(h.toUpstream.length, 0, 'a ref action is NOT relayed upstream');
  const reply = h.toAgent.find(m => m.id === 7);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /snapshot ref/);
  assert.match(reply.result.content[0].text, /f3e1356/);
});

test('a read-only look by ref is still relayed (only actions are refused)', () => {
  const h = harness();
  const call = { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'browser_snapshot', arguments: { target: 'e9' } } };
  h.core.onAgentMessage(call);
  assert.equal(h.toUpstream.length, 1, 'a snapshot by ref is relayed — looking by ref is fine');
  assert.deepEqual(h.toUpstream[0], call);
});

test('a driving browser_evaluate is refused by the proxy, not relayed upstream', () => {
  const h = harness();
  const call = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'browser_evaluate', arguments: { function: "(el) => { el.value = 'x'; el.dispatchEvent(new Event('input')); }" } } };
  h.core.onAgentMessage(call);
  assert.equal(h.toUpstream.length, 0, 'a mutating evaluate is NOT relayed upstream');
  const reply = h.toAgent.find(m => m.id === 9);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /read-only|READ-ONLY/i);
});

test('a read-only browser_evaluate is relayed normally (state checks are the look use)', () => {
  const h = harness();
  const call = { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'browser_evaluate', arguments: { function: '() => document.querySelectorAll("[role=row]").length' } } };
  h.core.onAgentMessage(call);
  assert.equal(h.toUpstream.length, 1, 'a read-only evaluate is relayed');
  assert.deepEqual(h.toUpstream[0], call);
});

// ── action verification at drive time (count/editability on the current page) ─

// Drive one action through the proxy and answer its verification evaluate(s):
// the uniqueness count, and — for a fill/type — the editability check. Returns
// once the proxy has decided (relayed the action, or refused it).
async function driveAction(h, actionMsg, { count = 1, editable = true } = {}) {
  h.core.onAgentMessage(actionMsg);
  for (let guard = 0; guard < 50; guard++) {
    await Promise.resolve();
    const evals = h.toUpstream.filter(m => m.params?.name === 'browser_evaluate');
    let answeredAny = false;
    for (const e of evals) {
      if (h.answered?.has(e.id)) continue;
      (h.answered ??= new Set()).add(e.id);
      answeredAny = true;
      const reply = isEditabilityEval(e) ? editabilityReply(editable) : evaluateReplyForCount(count);
      h.core.onUpstreamMessage({ jsonrpc: '2.0', id: e.id, result: reply });
    }
    // Done when the action was either relayed upstream or refused back to the agent.
    if (h.toUpstream.some(m => m.id === actionMsg.id) || h.toAgent.some(m => m.id === actionMsg.id)) {
      if (!answeredAny) break;
    }
  }
}

const clickAction = (id, target) => ({ jsonrpc: '2.0', id, method: 'tools/call',
  params: { name: 'browser_click', arguments: { target, element: 'x' } } });
const fillAction = (id, target) => ({ jsonrpc: '2.0', id, method: 'tools/call',
  params: { name: 'browser_type', arguments: { target, text: 'v', element: 'x' } } });

test('action: a unique click is verified, relayed to execute, and remembered', async () => {
  const h = harness();
  await driveAction(h, clickAction(2, "getByRole('button', { name: 'Save' })"), { count: 1 });
  assert.ok(h.toUpstream.some(m => m.id === 2 && m.params?.name === 'browser_click'), 'relayed to execute');
  assert.ok(!h.toAgent.some(m => m.id === 2 && m.result?.isError), 'not refused');
  assert.ok(h.core._verifiedLocators.has("getByRole('button', { name: 'Save' })"), 'remembered as verified');
});

test('action: a non-unique click is refused and NOT relayed', async () => {
  const h = harness();
  await driveAction(h, clickAction(3, "getByRole('button', { name: 'Edit' })"), { count: 3 });
  assert.ok(!h.toUpstream.some(m => m.id === 3 && m.params?.name === 'browser_click'), 'not executed');
  const reply = h.toAgent.find(m => m.id === 3);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /not unique|matched 3/);
  assert.ok(!h.core._verifiedLocators.size, 'a non-unique locator is not remembered');
});

test('action: a fill on a non-editable wrapper is refused and NOT relayed', async () => {
  const h = harness();
  await driveAction(h, fillAction(4, "getByTestId('promotionName')"), { count: 1, editable: false });
  assert.ok(!h.toUpstream.some(m => m.id === 4 && m.params?.name === 'browser_type'), 'not executed');
  const reply = h.toAgent.find(m => m.id === 4);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /not editable|inner/);
});

test('action: a fill on an editable inner input is verified and relayed', async () => {
  const h = harness();
  await driveAction(h, fillAction(5, "getByTestId('promotionName').locator('#inner')"), { count: 1, editable: true });
  assert.ok(h.toUpstream.some(m => m.id === 5 && m.params?.name === 'browser_type'), 'relayed to execute');
  assert.ok(h.core._verifiedLocators.has("getByTestId('promotionName').locator('#inner')"), 'remembered');
});

// ── record_step: accept locators verified at drive time, refuse the rest ─────

const recordStepMsg = (record) => ({ jsonrpc: '2.0', id: 42, method: 'tools/call',
  params: { name: 'record_step', arguments: { feature: 'features/p/x.feature', ...record } } });

test('record_step: a step whose action locators were all verified → appended', async () => {
  const h = harness();
  // Drive the action first (verified + remembered), then record the step naming it.
  await driveAction(h, clickAction(2, "getByRole('button', { name: 'Save' })"), { count: 1 });
  h.core.onAgentMessage(recordStepMsg({
    scenario: 'S', step: 'When I click Save',
    actions: [{ method: 'click', locators: [{ kind: 'role', role: 'button', name: 'Save' }] }],
    assertions: [],
  }));
  await Promise.resolve();
  assert.equal(h.appends.length, 1, 'appended — the locator was verified when the click was driven');
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(reply.result.isError, false);
  assert.match(reply.result.content[0].text, /recorded step 1/);
});

test('record_step: a step naming a locator never driven → refused, not appended', async () => {
  const h = harness();
  // No action driven; record_step names a locator the proxy never verified.
  h.core.onAgentMessage(recordStepMsg({
    scenario: 'S', step: 'When I click Save',
    actions: [{ method: 'click', locators: [{ kind: 'role', role: 'button', name: 'Save' }] }],
    assertions: [],
  }));
  await Promise.resolve();
  assert.equal(h.appends.length, 0, 'nothing appended for an unverified locator');
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /not the one you drove|Drive each action/);
});

test('record_step: a cross-page step records login-form locators verified before the submit navigated away', async () => {
  const h = harness();
  // Login step: fill email + password on the login page, click submit (which
  // navigates to Account Plans). Each action is verified on the login page as it
  // is driven — the submit's later navigation cannot un-verify them.
  await driveAction(h, fillAction(2, "getByLabel('电子邮件或用户名')"), { count: 1, editable: true });
  await driveAction(h, fillAction(3, "getByLabel('密码')"), { count: 1, editable: true });
  await driveAction(h, clickAction(4, "getByRole('button', { name: '登录' })"), { count: 1 });
  // Now record the whole login step — its actions' locators were all verified,
  // even though a live re-count on the (now Account Plans) page would find none.
  h.core.onAgentMessage(recordStepMsg({
    scenario: 'Login', step: 'Given I try to login system with authorized user "kyle"',
    actions: [
      { method: 'goto', arg: { literal: '/' } },
      { method: 'fill', locators: [{ kind: 'label', text: '电子邮件或用户名' }], arg: { literal: 'kyle@x' } },
      { method: 'fill', locators: [{ kind: 'label', text: '密码' }], arg: { literal: 'pw' } },
      { method: 'click', locators: [{ kind: 'role', role: 'button', name: '登录' }] },
    ],
    assertions: [{ target: [{ kind: 'role', role: 'heading', name: 'Account Plans' }], matcher: 'toBeVisible' }],
  }));
  await Promise.resolve();
  assert.equal(h.appends.length, 1, 'the cross-page login step is recorded whole');
  const rec = h.appends[0].record;
  assert.equal(rec.actions.length, 4, 'all four actions kept — none dropped to slip past a check');
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(reply.result.isError, false);
});

test('record_step: missing feature path is refused with a clear message', () => {
  const h = harness();
  h.core.onAgentMessage({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'record_step', arguments: { scenario: 'S', step: 's', actions: [] } } });
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /missing "feature"/);
});

test('action: an upstream that never answers the count times out and refuses, does not hang', async () => {
  const h = harness({ evalTimeoutMs: 5 });
  h.core.onAgentMessage(clickAction(2, "getByRole('button', { name: 'Save' })"));
  // Deliberately never reply to the browser_evaluate the proxy sent upstream.
  await new Promise(r => setTimeout(r, 40));   // longer than the 5ms eval timeout
  const reply = h.toAgent.find(m => m.id === 2);
  assert.ok(reply, 'the action still returns rather than hanging the agent');
  assert.equal(reply.result.isError, true);
  assert.ok(!h.toUpstream.some(m => m.id === 2 && m.params?.name === 'browser_click'), 'not executed on a failed count');
});

// ── step-wise shadow replay hook (now a FACT SOURCE, not a gate) ─────────────
// A goto-only record has no driving locator, so it skips the verified-locator
// check and goes straight to append → shadow replay — isolating the hook. With no
// Judger wired, a step is accepted whether or not the replay reports a failure (the
// mechanical layer only reports; only the Judger rules). When a Judger IS wired,
// every step is judged (see mustJudge = !!this._judgeStep).

const gotoRecordMsg = () => recordStepMsg({
  scenario: 'S', step: 'When I open the dashboard',
  actions: [{ method: 'goto', arg: { literal: '/dashboard' } }],
});

test('shadow replay ok → the step is appended and accepted as normal', async () => {
  const h = harness({ replayStep: async () => ({ ok: true }) });
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(h.appends.length, 1, 'appended');
  assert.equal(h.truncations.length, 0, 'not rolled back');
  assert.ok(!reply.result.isError, 'accepted');
  assert.match(reply.result.content[0].text, /recorded step 1/);
});

test('shadow replay fails but NO judger wired → the failure is only a fact; the step is accepted (mechanical never judges)', async () => {
  // The whole point of the redesign: a mechanical failure is not a verdict. With no
  // Judger to rule on it, a pure-navigation step is accepted, not rolled back.
  const h = harness({ replayStep: async () => ({ ok: false, error: 'Selected Products = 0', phase: 'assertion', index: 0, before: { url: 'u' }, after: { url: 'u' } }) });
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(h.appends.length, 1, 'appended');
  assert.equal(h.truncations.length, 0, 'NOT rolled back — the mechanical layer does not fail a step on its own');
  assert.ok(!reply.result.isError, 'accepted (no arbiter for the failure)');
});

test('shadow replay fails AND judger rejects → NOW it is rolled back and refused', async () => {
  // The mechanical failure becomes a fact handed to the Judger; the Judger rules
  // reject; only then is the step rolled back. A state-changing (click) record so it
  // goes to the Judger.
  let seenFacts;
  const h = harness({
    replayStep: async () => ({ ok: false, error: 'Selected Products = 0', phase: 'assertion', index: 0, before: { url: 'u' }, after: { url: 'u' } }),
    judgeStep: async (_r, _f, _s, replayFacts) => { seenFacts = replayFacts; return { outcome: 'reject', report: [{ where: 'selected list', problem: 'count is 0', suggestion: 'click the checkbox cell' }] }; },
  });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(seenFacts.mechOk, false, 'the mechanical failure was passed to the judger as a fact');
  assert.equal(seenFacts.certainMechFail, true, 'assertion-phase + unchanged URL is flagged a certain mechanical fact');
  assert.deepEqual(h.truncations, [{ feature: 'features/p/x.feature', count: 0 }], 'rolled back to N-1 on the reject');
  assert.equal(reply.result.isError, true, 'refused');
  assert.match(reply.result.content[0].text, /count is 0|business effect did NOT happen/i);
});

test('shadow throwing (infra failure) → the step is kept and accepted, not blamed on the agent', async () => {
  const h = harness({ replayStep: async () => { throw new Error('shadow-runner exited'); } });
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(h.appends.length, 1, 'kept');
  assert.equal(h.truncations.length, 0, 'not rolled back on an infra failure');
  assert.ok(!reply.result.isError, 'accepted despite the shadow being down');
  assert.match(reply.result.content[0].text, /recorded step 1|shadow unavailable/);
});

test('no replayStep wired (STEPWISE off) → append → accept exactly as before, no replay attempted', async () => {
  const h = harness();   // replayStep defaults to null
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(h.appends.length, 1);
  assert.equal(h.truncations.length, 0);
  assert.ok(!reply.result.isError);
  assert.match(reply.result.content[0].text, /recorded step 1/);
});

// ── Judger hook: the FINAL arbiter, three outcomes ──────────────────────────
// A state-changing record: method 'click' with no locators skips the
// verified-locator check (harness's fake append does not validate shape), so the
// test isolates the Judger path. replayStep passes mechanically; the Judger rules
// accept / reject / attribution.

const clickRecordMsg = () => recordStepMsg({
  scenario: 'S', step: 'When I select product PD100046',
  actions: [{ method: 'click' }],
});

const passReplay = async () => ({ ok: true });

test('judger outcome:accept → the step is accepted and kept (not truncated)', async () => {
  const h = harness({ replayStep: passReplay, judgeStep: async () => ({ outcome: 'accept', report: [{ where: 'selected list', problem: 'PD100046 present', suggestion: 'proceed' }] }) });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(h.truncations.length, 0, 'not rolled back');
  assert.ok(!reply.result.isError, 'accepted');
  assert.match(reply.result.content[0].text, /recorded step 1/);
  assert.equal(h.verdicts.length, 1, 'one verdict line written');
  assert.equal(h.verdicts[0].entry.outcome, 'accept');
});

test('judger accept of a TERMINAL action (mechanical failure ruled a legit transition) → kept, not truncated, message names the transition', async () => {
  // The mechanical replay "fails" (the step's own locators are gone on the new
  // page), but the Judger looked at before/after + the new page and ruled the
  // transition legitimate (D3 — it confirmed the effect there). Accept, keep.
  const h = harness({
    replayStep: async () => ({ ok: false, error: 'locator not found', phase: 'assertion', index: 0, before: { url: '/edit' }, after: { url: '/list' } }),
    judgeStep: async () => ({ outcome: 'accept', report: [{ where: 'plans list', problem: 'the draft appears in the list', suggestion: 'ok' }] }),
  });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(h.truncations.length, 0, 'a confirmed terminal action is KEPT, never truncated');
  assert.ok(!reply.result.isError, 'accepted');
  assert.match(reply.result.content[0].text, /terminal action|navigated/i, 'the message names the verified transition');
});

test('judger outcome:reject → rolled back and refused with the report suggestions', async () => {
  const h = harness({ replayStep: passReplay, judgeStep: async () => ({
    outcome: 'reject',
    rebuttal: 'the selected-products count is still 0 after the click',
    report: [{ where: 'selected products region', problem: 'count is 0 after clicking the data cell', suggestion: 'click the row leading checkbox cell, not the data cell' }],
  }), scout: null });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.deepEqual(h.truncations, [{ feature: 'features/p/x.feature', count: 0 }], 'rolled back to N-1');
  assert.equal(reply.result.isError, true, 'refused');
  assert.match(reply.result.content[0].text, /count is still 0|business effect did NOT happen/i);
  assert.match(reply.result.content[0].text, /leading checkbox cell/, 'carries the concrete suggestion');
  assert.match(reply.result.content[0].text, /re-record ONLY this step|do not skip/i);
  const reject = h.verdicts.find(v => v.entry.outcome === 'reject');
  assert.ok(reject, 'a reject verdict line was written');
});

test('judger outcome:attribution → NOT re-recorded; stopped and handed to a human, step dropped', async () => {
  const h = harness({ replayStep: passReplay, judgeStep: async () => ({
    outcome: 'attribution',
    attribution: { class: 'environment', agrees: true },
    report: [{ where: 'product search', problem: 'PD100046 is not in this environment', suggestion: 'seed the product or point BASE_URL at an env that has it' }],
  }) });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.deepEqual(h.truncations, [{ feature: 'features/p/x.feature', count: 0 }], 'the un-achieved step is dropped');
  assert.equal(reply.result.isError, true, 'stopped');
  assert.match(reply.result.content[0].text, /environment problem/i, 'names the class');
  assert.match(reply.result.content[0].text, /human needs to act|Stop on this step/i, 'sends it to a human');
  assert.match(reply.result.content[0].text, /do not proceed to the next step/i, 'does not let the writer march on');
  const attr = h.verdicts.find(v => v.entry.outcome === 'attribution');
  assert.ok(attr, 'an attribution verdict line was written');
  assert.equal(attr.entry.attribution.class, 'environment', 'the class is recorded');
});

test('judger inconclusive → the step is accepted, not blamed on the agent', async () => {
  const h = harness({ replayStep: passReplay, judgeStep: async () => ({ inconclusive: 'judger wrote no verdict' }) });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(h.truncations.length, 0);
  assert.ok(!reply.result.isError, 'accepted despite inconclusive judge');
  assert.match(reply.result.content[0].text, /recorded step 1/);
});

test('judger throwing → the step is accepted (infra failure not the agent\'s fault)', async () => {
  const h = harness({ replayStep: passReplay, judgeStep: async () => { throw new Error('spawn failed'); } });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(h.truncations.length, 0);
  assert.ok(!reply.result.isError);
  assert.match(reply.result.content[0].text, /recorded step 1|judger unavailable/);
});

test('EVERY step is judged now — even a mechanically-clean goto-only nav step', async () => {
  // Design change: the Judger rules on every step, not only failing/state-changing
  // ones, because replayability defects (a frozen dynamic value, a hardcoded env
  // value) can hide in a step that mechanically replays clean. So a clean nav-only
  // step still goes to the Judger.
  let judged = false;
  const h = harness({ replayStep: passReplay, judgeStep: async () => { judged = true; return { outcome: 'accept', report: [] }; } });
  h.core.onAgentMessage(gotoRecordMsg());   // goto only — clean, but still judged
  await new Promise(r => setImmediate(r));
  assert.equal(judged, true, 'the judger IS called for a clean nav-only step (every step is judged)');
  const reply = h.toAgent.find(m => m.id === 42);
  assert.ok(!reply.result.isError);
  assert.match(reply.result.content[0].text, /recorded step 1/);
});

test('judger atLimit (duel exhausted) → accept as-is and flag for human review', async () => {
  const h = harness({ replayStep: passReplay, judgeStep: async () => ({ atLimit: true }) });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(h.truncations.length, 0, 'not rolled back — accepted');
  assert.ok(!reply.result.isError, 'accepted');
  assert.match(reply.result.content[0].text, /human should review|unresolved/i);
});

test('stillHolds and attribution in record_step args are stripped from the record and passed to the judger', async () => {
  let seenStillHolds, seenAttribution;
  const h = harness({
    replayStep: passReplay,
    judgeStep: async (record, _feature, stillHolds, _facts, attribution) => { seenStillHolds = stillHolds; seenAttribution = attribution; return { outcome: 'accept', report: [] }; },
  });
  h.core.onAgentMessage({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'record_step',
    arguments: { feature: 'features/p/x.feature', scenario: 'S', step: 'When I select X',
      actions: [{ method: 'click' }], stillHolds: 'the chip is visible, you missed it',
      attribution: { class: 'feature', evidence: 'the page has no such control', suggestedChange: 'clarify the step' } } } });
  await new Promise(r => setImmediate(r));
  assert.equal(seenStillHolds, 'the chip is visible, you missed it', 'push-back reached the judger');
  assert.equal(seenAttribution.class, 'feature', 'attribution reached the judger');
  assert.ok(!('stillHolds' in h.appends[0].record), 'stillHolds is not written to the trace record');
  assert.ok(!('attribution' in h.appends[0].record), 'attribution is not written to the trace record');
});

// ── scout escalation (a reject scouts AT ONCE — D4 — bounded by scoutLimit) ───
// A reject verdict on a mechanical failure. The scout is summoned on the FIRST
// reject (no rejection-count threshold): a real failure means the Writer is stuck.

const failReplay = async () => ({ ok: false, error: 'Selected Products = 0', phase: 'assertion', index: 0, before: { url: 'u' }, after: { url: 'u' } });
const rejectJudge = async () => ({ outcome: 'reject', report: [{ where: 'selected list', problem: 'count is 0', suggestion: 'try the checkbox cell' }] });

test('a reject with no scout wired → plain refusal, re-record', async () => {
  const h = harness({ replayStep: failReplay, judgeStep: rejectJudge });   // scout defaults to null
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /Re-drive and re-record|Re-record this step/i);
});

test('a reject with a scout wired → scout is summoned on the FIRST reject and its finding TELLS the writer how to drive it', async () => {
  let scoutCalled = 0;
  const h = harness({
    replayStep: failReplay,
    judgeStep: rejectJudge,
    scout: async () => { scoutCalled++; return { resolved: true, report: [
      { where: 'product row PD100046', problem: 'clicking the data cell only focuses it', suggestion: 'click getByRole(row,{name:PD100046}).getByRole(checkbox)' },
    ]}; },
  });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  assert.equal(scoutCalled, 1, 'scout summoned at once on the first reject — no threshold');
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /scout drove the page/i, 'announces the scout');
  assert.match(reply.result.content[0].text, /getByRole\(checkbox\)/, 'hands over the exact interaction');
  const scoutLine = h.verdicts.find(v => v.entry.kind === 'scout');
  assert.ok(scoutLine, 'a scout line was written for the count bound');
  assert.equal(scoutLine.entry.resolved, true);
});

test('scout says unresolvable → handed to a human, not re-recorded', async () => {
  const h = harness({
    replayStep: failReplay,
    judgeStep: rejectJudge,
    scout: async () => ({ resolved: false,
      unresolvable: { category: 'environment', summary: 'product PD100046 is not in this environment\'s catalog' },
      report: [{ problem: 'the product search returns nothing for any interaction', suggestion: 'seed the product or point BASE_URL at an env that has it' }],
    }),
  });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /environment problem/i, 'names the non-click category');
  assert.match(reply.result.content[0].text, /human must act|Stop on this step/i, 'sends it to a human');
});

test('scout inconclusive → surfaces the reason and falls back to re-record', async () => {
  const h = harness({
    replayStep: failReplay,
    judgeStep: rejectJudge,
    scout: async () => ({ inconclusive: 'scout reset failed: prefix replay broke at record 4' }),
  });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /scout.*could not complete|reset failed/i, 'surfaces why the scout failed');
  assert.match(reply.result.content[0].text, /different approach|Re-record/i, 'still lets the writer retry');
});

test('scout is bounded: once scouted scoutLimit times, the step goes to a human instead of scouting again', async () => {
  let scoutCalled = 0;
  const h = harness({
    replayStep: failReplay,
    judgeStep: rejectJudge,
    scoutCount: () => 2,             // already scouted twice
    scoutLimit: 2,                   // limit reached
    scout: async () => { scoutCalled++; return { resolved: true, report: [] }; },
  });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(scoutCalled, 0, 'scout is NOT summoned again past the limit');
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /scout.*2 times|human needs to look|beyond automatic/i, 'hands it to a human');
});

test('every reject writes exactly one reject verdict line (the single-writer rule)', async () => {
  const h = harness({ replayStep: failReplay, judgeStep: rejectJudge });   // no scout
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const rejects = h.verdicts.filter(v => v.entry.kind === 'verdict' && v.entry.outcome === 'reject');
  assert.equal(rejects.length, 1, 'exactly one reject verdict line — not double-written');
});

test('a plain refusal lists prior tried-and-failed approaches so the writer does not repeat them', async () => {
  const h = harness({
    replayStep: failReplay,
    judgeStep: rejectJudge,
    priorVerdicts: () => [
      { kind: 'verdict', outcome: 'reject', rebuttal: 'clicking the data cell left the count at 0', report: [{ suggestion: 'clicked the data cell' }] },
      { kind: 'verdict', outcome: 'reject', rebuttal: 'double-click also left the count at 0', report: [{ suggestion: 'double-clicked the data cell' }] },
    ],
  });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const reply = h.toAgent.find(m => m.id === 42);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /Already tried on this step and rejected/i, 'shows the dead-end history');
  assert.match(reply.result.content[0].text, /data cell/, 'lists the first failed approach');
  assert.match(reply.result.content[0].text, /double-click/, 'lists the second failed approach');
  assert.match(reply.result.content[0].text, /DIFFERENT approach/i, 'tells the writer to change tack');
});

// ── resume: shadow prefix alignment (both browsers reach step K's start) ──────
// A Mode B resume records from step K with K-1 steps already on disk. Those K-1
// steps ran on the Writer's browser (generator_setup_page) but never on the shadow.
// Before the FIRST shadow replay, the proxy must resetShadow to that K-1 prefix so
// the Judger rules on the right page, not a blank one.

test('resume: the first replay of a step with a prior on-disk prefix aligns the shadow to that prefix first', async () => {
  const calls = [];
  const prefix = Array.from({ length: 29 }, (_, i) => ({ scenario: 'S', step: `step ${i + 1}`, actions: [{ method: 'goto', arg: { literal: '/' } }] }));
  const h = harness({
    countRecords: () => 30,                         // this is step 30 on disk
    readPrefix: () => [...prefix, { step: 'step 30' }],  // disk holds 30 records (prefix + this)
    resetShadow: async (records) => { calls.push({ kind: 'reset', n: records.length }); },
    replayStep: async () => { calls.push({ kind: 'replay' }); return { ok: true }; },
  });
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [{ kind: 'reset', n: 29 }, { kind: 'replay' }],
    'the shadow is reset to the 29-step prefix BEFORE the step is replayed');
});

test('resume: alignment happens once — the second step does not re-align', async () => {
  let n = 30;
  const calls = [];
  const h = harness({
    countRecords: () => n,
    readPrefix: () => Array.from({ length: n }, (_, i) => ({ step: `step ${i + 1}` })),
    resetShadow: async () => { calls.push('reset'); },
    replayStep: async () => { calls.push('replay'); return { ok: true }; },
  });
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  n = 31;
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, ['reset', 'replay', 'replay'], 'only the first step aligns; the second just replays');
});

test('fresh (Mode A) run: the first step is step 1, so there is no prefix and no reset', async () => {
  const calls = [];
  const h = harness({
    // default countRecords = appends.length → 1 after the first append
    resetShadow: async () => { calls.push('reset'); },
    replayStep: async () => { calls.push('replay'); return { ok: true }; },
  });
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, ['replay'], 'a from-scratch run never resets — it accumulates from blank');
});

test('resume: a failed alignment does not block recording (the step still replays)', async () => {
  const calls = [];
  const h = harness({
    countRecords: () => 5,
    readPrefix: () => Array.from({ length: 5 }, (_, i) => ({ step: `step ${i + 1}` })),
    resetShadow: async () => { calls.push('reset'); throw new Error('prefix replay broke at record 3'); },
    replayStep: async () => { calls.push('replay'); return { ok: true }; },
  });
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, ['reset', 'replay'], 'alignment failure is logged but the step still replays');
  const reply = h.toAgent.find(m => m.id === 42);
  assert.ok(!reply.result.isError, 'recording is not blocked by an alignment failure');
});

// ── shadow re-aligns when a prior step left it diverged (dirty) ───────────────
// A step whose shadow replay reported `dirty` (its action/assertion did not land,
// so the page is not where the trace implies) must NOT let the next step be judged
// on that stale page. Before judging the next step, the proxy rebuilds the shadow to
// the on-disk prefix. This is the fix for "a mid-feature nav/search that replayed but
// didn't take effect leaves every later step judged on the wrong page → good steps
// rejected." Distinct from the one-shot resume alignment: it fires whenever a step
// came back dirty, at any point in the feature.

test('a dirty step triggers a shadow rebuild before the NEXT step is judged', async () => {
  let n = 10;
  const calls = [];
  const replies = [
    { ok: false, dirty: true, error: 'search matched 0 rows', phase: 'action', index: 0, before: { url: 'u', marker: 'list' }, after: { url: 'u', marker: 'list' } },
    { ok: true, before: { url: 'u', marker: 'detail' }, after: { url: 'u', marker: 'detail' } },
  ];
  let call = 0;
  const h = harness({
    countRecords: () => n,
    readPrefix: () => Array.from({ length: n }, (_, i) => ({ step: `step ${i + 1}` })),
    resetShadow: async (records) => { calls.push({ kind: 'reset', n: records.length }); },
    replayStep: async () => { calls.push({ kind: 'replay' }); return replies[call++]; },
  });
  // Step 10 replays dirty. It is the first replay, so the one-shot resume alignment
  // also fires here (reset to 9) — that's expected; what matters is the SECOND step.
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  // Step 11: because step 10 came back dirty, the proxy must reset to the 10-step
  // prefix BEFORE replaying/judging step 11.
  n = 11;
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [
    { kind: 'reset', n: 9 },    // one-shot resume alignment before the first replay
    { kind: 'replay' },         // step 10 — comes back dirty
    { kind: 'reset', n: 10 },   // step 10 was dirty → rebuild to the 10-step prefix
    { kind: 'replay' },         // step 11 now judged on the correct page
  ], 'a dirty step forces a prefix rebuild before the next step is judged');
});

test('a clean step does NOT trigger a rebuild for the next step', async () => {
  let n = 10;
  const calls = [];
  const h = harness({
    countRecords: () => n,
    readPrefix: () => Array.from({ length: n }, (_, i) => ({ step: `step ${i + 1}` })),
    resetShadow: async (records) => { calls.push({ kind: 'reset', n: records.length }); },
    replayStep: async () => { calls.push({ kind: 'replay' }); return { ok: true }; },   // never dirty
  });
  h.core.onAgentMessage(gotoRecordMsg());   // step 10 — one-shot resume align, then replay
  await new Promise(r => setImmediate(r));
  n = 11;
  h.core.onAgentMessage(gotoRecordMsg());   // step 11 — prior step clean, no rebuild
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [
    { kind: 'reset', n: 9 },
    { kind: 'replay' },
    { kind: 'replay' },
  ], 'after a clean step the shadow keeps accumulating — no extra rebuild');
});

// ── scout receives replayFacts (so it can judge whether it needs to reset) ────

test('a reject passes replayFacts to the scout (for its reset-or-not judgement)', async () => {
  let seenFacts = 'UNSET';
  const h = harness({
    replayStep: async () => ({ ok: false, error: 'assertion failed', phase: 'assertion', index: 0, before: { url: 'u1' }, after: { url: 'u1' } }),
    judgeStep: async (_r, _f, _s, replayFacts) => ({ outcome: 'reject', report: [{ problem: 'x', suggestion: 'y' }], _facts: replayFacts }),
    scout: async (_record, _feature, replayFacts) => { seenFacts = replayFacts; return { resolved: true, report: [] }; },
  });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  assert.notEqual(seenFacts, 'UNSET', 'scout was called with a third argument');
  assert.equal(seenFacts?.mechOk, false, 'the mechanical facts reached the scout');
  assert.equal(seenFacts?.before?.url, 'u1', 'before/after are there for the scout to judge a navigation');
});

// ── unified activity log: shadow + judge lines land in the shared log ─────────
// The activity log is the single readable stream of what all three roles did.
// The writer's lines come from recorder.mjs; these pin that the proxy contributes
// the SHADOW's mechanical result and the JUDGE's outcome, so "what is the shadow
// doing / why did the judge reject" is answerable from one file, not guesswork.

test('shadowActivityLine reads ok vs FAIL with phase and error', () => {
  assert.equal(shadowActivityLine('When I click Save', { ok: true }), '[shadow] step "When I click Save" → ok');
  assert.equal(
    shadowActivityLine('And I search the promotion', { ok: false, phase: 'assertion', error: 'Promotions (111) not (1)' }),
    '[shadow] step "And I search the promotion" → FAIL (assertion: Promotions (111) not (1))');
});

test('judgeActivityLine reads outcome, round and note', () => {
  assert.equal(judgeActivityLine('When I click Save', 'accept', { round: 1 }), '[judge] step "When I click Save" → accept  (round 1)');
  assert.equal(
    judgeActivityLine('Then status is Draft', 'reject', { round: 2, note: 'the row shows Planned' }),
    '[judge] step "Then status is Draft" → reject  (round 2) — the row shows Planned');
});

test('a shadow replay writes a [shadow] activity line for the step', async () => {
  const h = harness({ replayStep: async () => ({ ok: true }) });
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  const shadowLines = h.activity.filter(a => a.line.startsWith('[shadow] step'));
  assert.equal(shadowLines.length, 1, 'the shadow replay of the step is recorded to the activity log');
  assert.match(shadowLines[0].line, /→ ok/);
});

test('a judge accept writes a [judge] activity line', async () => {
  const h = harness({
    replayStep: async () => ({ ok: false, phase: 'assertion', index: 0, before: { url: '/x' }, after: { url: '/y' } }),  // mechOk false → mustJudge
    judgeStep: async () => ({ outcome: 'accept', report: [{ where: 'w', problem: 'confirmed', suggestion: 'proceed' }] }),
  });
  h.core.onAgentMessage(gotoRecordMsg());
  await new Promise(r => setImmediate(r));
  const judgeLines = h.activity.filter(a => a.line.startsWith('[judge]'));
  assert.equal(judgeLines.length, 1, 'the judge outcome is recorded to the activity log');
  assert.match(judgeLines[0].line, /→ accept/);
});

test('a judge reject writes a [judge] reject activity line', async () => {
  const h = harness({
    replayStep: async () => ({ ok: false, phase: 'assertion', index: 0, before: { url: 'u' }, after: { url: 'u' } }),
    judgeStep: async () => ({ outcome: 'reject', report: [{ where: 'list', problem: 'count is 0', suggestion: 'fix locator' }], rebuttal: 'the filter did not apply' }),
    scout: async () => ({ resolved: false, unresolvable: true, report: [] }),
  });
  h.core.onAgentMessage(clickRecordMsg());
  await new Promise(r => setImmediate(r));
  const rejectLines = h.activity.filter(a => a.line.includes('→ reject'));
  assert.equal(rejectLines.length, 1, 'the reject is recorded to the activity log with its reason');
  assert.match(rejectLines[0].line, /the filter did not apply/);
});
