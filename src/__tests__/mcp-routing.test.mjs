/**
 * The proxy's message-routing decisions, pinned as pure functions: which messages
 * are relayed, which the proxy handles, how record_step is injected into the tool
 * list, how a browser_evaluate reply becomes a number. The stdio transport and the
 * spawn are glue tested end-to-end; the decisions are here.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECORD_STEP_TOOL, isRequest, isToolsList, isRecordStepCall,
  injectRecordStep, evaluateRequest, toolResult,
  isSnapshotRef, isRefAction, refActionRejection,
  isMutatingEvaluate, mutatingEvaluateRejection,
} from '../mcp-routing.mjs';

const evalCall = (fn) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_evaluate', arguments: { function: fn } } });

test('isMutatingEvaluate: a driving evaluate is caught (click/value=/dispatchEvent/focus/…)', () => {
  assert.ok(isMutatingEvaluate(evalCall('() => el.click()')));
  assert.ok(isMutatingEvaluate(evalCall("(el) => { el.value = 'x'; el.dispatchEvent(new Event('input')); }")));
  assert.ok(isMutatingEvaluate(evalCall('(el) => el.checked = true')));
  assert.ok(isMutatingEvaluate(evalCall('(el) => el.focus()')));
  assert.ok(isMutatingEvaluate(evalCall('(el) => el.setAttribute("x","y")')));
  assert.ok(isMutatingEvaluate(evalCall('(el) => el.submit()')));
});

test('isMutatingEvaluate: a read-only evaluate is NOT caught (the legitimate "look" use)', () => {
  assert.ok(!isMutatingEvaluate(evalCall('() => document.querySelectorAll("[role=row]").length')));
  assert.ok(!isMutatingEvaluate(evalCall('(el) => el.textContent')));
  assert.ok(!isMutatingEvaluate(evalCall('(el) => el.value')));            // reading .value, not assigning
  assert.ok(!isMutatingEvaluate(evalCall('(el) => el.getAttribute("checked")')));
  assert.ok(!isMutatingEvaluate(evalCall("() => fetch('/api/x', {credentials:'include'}).then(r=>r.json())")));
  assert.ok(!isMutatingEvaluate(evalCall('(el) => el.value === "expected"')));   // === comparison, not assignment
  // not an evaluate at all
  assert.ok(!isMutatingEvaluate({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_click', arguments: { target: 'x' } } }));
});

test('mutatingEvaluateRejection: explains read-only rule and points at a persistent action', () => {
  const msg = mutatingEvaluateRejection();
  assert.match(msg, /READ-ONLY|read-only/i);
  assert.match(msg, /cannot be recorded/);
  assert.match(msg, /browser_click|browser_type|getByRole|getByTestId/);
});

test('isSnapshotRef: recognises one-shot refs, not persistent locators', () => {
  assert.ok(isSnapshotRef('e12'));
  assert.ok(isSnapshotRef('f3e1356'));
  assert.ok(isSnapshotRef('  e1  '));   // trimmed
  assert.ok(!isSnapshotRef("getByRole('button', { name: 'Save' })"));
  assert.ok(!isSnapshotRef('[data-testid="x"]'));
  assert.ok(!isSnapshotRef('#inner'));
  assert.ok(!isSnapshotRef(undefined));
});

test('isRefAction: an action tool driven by a ref is caught; a locator target and read-only tools are not', () => {
  const call = (name, target) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { target } } });
  assert.ok(isRefAction(call('browser_click', 'f3e1356')), 'click by ref');
  assert.ok(isRefAction(call('browser_type', 'e9')), 'type by ref');
  assert.ok(!isRefAction(call('browser_click', "getByTestId('x')")), 'click by locator is fine');
  assert.ok(!isRefAction(call('browser_snapshot', 'e9')), 'a read-only look by ref is fine');
  assert.ok(!isRefAction(call('browser_evaluate', 'e9')), 'evaluate is not an action tool here');
  assert.ok(!isRefAction({ jsonrpc: '2.0', method: 'notifications/x' }), 'not a request');
});

test('refActionRejection: names the tool and ref, and points at a persistent locator', () => {
  const msg = refActionRejection('browser_click', 'f3e1356');
  assert.match(msg, /browser_click/);
  assert.match(msg, /f3e1356/);
  assert.match(msg, /snapshot ref/);
  assert.match(msg, /getByRole|getByTestId/);
});

test('isRequest / isToolsList / isRecordStepCall classify messages', () => {
  assert.equal(isRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), true);
  assert.equal(isRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), false, 'a notification has no id');
  assert.equal(isRequest({ jsonrpc: '2.0', id: 1, result: {} }), false, 'a response has no method');

  assert.equal(isToolsList({ id: 1, method: 'tools/list' }), true);
  assert.equal(isToolsList({ id: 1, method: 'tools/call', params: {} }), false);

  assert.equal(isRecordStepCall({ id: 2, method: 'tools/call', params: { name: 'record_step' } }), true);
  assert.equal(isRecordStepCall({ id: 2, method: 'tools/call', params: { name: 'browser_click' } }), false);
  assert.equal(isRecordStepCall({ id: 2, method: 'tools/list' }), false);
});

test('injectRecordStep appends record_step, once, preserving the official tools', () => {
  const official = { tools: [{ name: 'browser_click' }, { name: 'browser_evaluate' }] };
  const merged = injectRecordStep(official);
  assert.deepEqual(merged.tools.map(t => t.name), ['browser_click', 'browser_evaluate', 'record_step']);
  // Idempotent: a second injection does not duplicate it.
  assert.equal(injectRecordStep(merged).tools.filter(t => t.name === 'record_step').length, 1);
  // The injected tool is the exported definition.
  assert.equal(merged.tools.at(-1), RECORD_STEP_TOOL);
});

test('injectRecordStep is defensive about a missing tools array', () => {
  assert.deepEqual(injectRecordStep({}).tools, [RECORD_STEP_TOOL]);
  assert.deepEqual(injectRecordStep(undefined).tools, [RECORD_STEP_TOOL]);
});

test('evaluateRequest builds a browser_evaluate call in the proxy id space, resolving a locator via target', () => {
  const req = evaluateRequest(-7, "getByRole('textbox', { name: '密码' })");
  assert.equal(req.method, 'tools/call');
  assert.equal(req.params.name, 'browser_evaluate');
  // The candidate is passed as `target` (Playwright resolves it in Node), and the
  // function is a no-op run on the resolved element.
  assert.equal(req.params.arguments.target, "getByRole('textbox', { name: '密码' })");
  assert.equal(req.params.arguments.function, '() => 1');
  assert.equal(typeof req.params.arguments.intent, 'string', 'intent is required by the official tool');
  assert.ok(req.params.arguments.intent.length > 0);
  assert.equal(typeof req.params.arguments.element, 'string', 'element is required by the official tool');
  assert.equal(req.id, -7);
});

test('toolResult wraps text in a JSON-RPC result envelope', () => {
  const ok = toolResult(5, 'recorded step 3');
  assert.equal(ok.id, 5);
  assert.equal(ok.result.content[0].text, 'recorded step 3');
  assert.equal(ok.result.isError, false);
  const bad = toolResult(5, 'not unique', true);
  assert.equal(bad.result.isError, true);
});
