/**
 * The stream-json parser: turning `claude -p --output-format=stream-json` lines
 * into readable activity and the agent's final text.
 *
 * These pin the observability contract — a tool_use event becomes a `→ tool arg`
 * line, the result event yields the final text — and the robustness the recorder
 * relies on: partial lines across chunk boundaries are reassembled, and blank or
 * non-JSON lines are skipped rather than crashing a recording.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeLineBuffer, parseEventLine, eventToActivity, finalTextFromEvent,
} from '../stream-json.mjs';

// ── makeLineBuffer: reassemble lines across chunk boundaries ─────────────────

test('makeLineBuffer yields whole lines and holds the partial', () => {
  const b = makeLineBuffer();
  assert.deepEqual(b.push('{"a":1}\n{"b":2}\n{"c'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(b.push('":3}\n'), ['{"c":3}']);
  assert.deepEqual(b.flush(), []);
});

test('makeLineBuffer flush returns a trailing partial with no newline', () => {
  const b = makeLineBuffer();
  assert.deepEqual(b.push('no newline yet'), []);
  assert.deepEqual(b.flush(), ['no newline yet']);
});

// ── parseEventLine: tolerate blank / non-JSON ────────────────────────────────

test('parseEventLine parses JSON, skips blank and garbage', () => {
  assert.deepEqual(parseEventLine('{"type":"result"}'), { type: 'result' });
  assert.equal(parseEventLine(''), null);
  assert.equal(parseEventLine('   '), null);
  assert.equal(parseEventLine('not json at all'), null);
});

// ── eventToActivity: the readable line(s) per event ──────────────────────────

test('a tool_use becomes a → line naming the tool and its key arg', () => {
  const ev = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'knowledge/local/engine/search-combobox.md' } }] },
  };
  assert.deepEqual(eventToActivity(ev), ['→ Read knowledge/local/engine/search-combobox.md']);
});

test('record_step surfaces the step being recorded', () => {
  const ev = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'mcp__playwright-test__record_step', input: { step: 'When I click Save', scenario: 'S' } }] },
  };
  assert.deepEqual(eventToActivity(ev), ['→ mcp__playwright-test__record_step When I click Save']);
});

test('a browser action surfaces its element/text arg', () => {
  const ev = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'browser_click', input: { element: 'Edit button', ref: 'e12' } }] },
  };
  assert.deepEqual(eventToActivity(ev), ['→ browser_click element=Edit button']);
});

test('assistant text becomes a · line; multiple content items each get a line', () => {
  const ev = {
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'Looking at the page' },
      { type: 'tool_use', name: 'browser_snapshot', input: {} },
    ] },
  };
  assert.deepEqual(eventToActivity(ev), ['· Looking at the page', '→ browser_snapshot']);
});

test('system init reports the mcp connection state', () => {
  const ev = {
    type: 'system', subtype: 'init',
    mcp_servers: [{ name: 'playwright-test', status: 'connected' }, { name: 'codegraph', status: 'connected' }],
  };
  assert.deepEqual(eventToActivity(ev), ['[start] mcp: playwright-test:connected, codegraph:connected']);
});

test('result reports ok/error and turn count', () => {
  assert.deepEqual(
    eventToActivity({ type: 'result', subtype: 'success', is_error: false, num_turns: 7 }),
    ['[done] success turns=7']);
  assert.deepEqual(
    eventToActivity({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 40 }),
    ['[done] ERROR turns=40']);
});

test('tool_result and unknown events produce no activity line', () => {
  assert.deepEqual(eventToActivity({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }), []);
  assert.deepEqual(eventToActivity({ type: 'whatever' }), []);
  assert.deepEqual(eventToActivity(null), []);
});

// ── finalTextFromEvent: the agent's final text ───────────────────────────────

test('finalTextFromEvent returns the result text only for a result event', () => {
  assert.equal(finalTextFromEvent({ type: 'result', result: 'the answer' }), 'the answer');
  assert.equal(finalTextFromEvent({ type: 'assistant', message: { content: [] } }), null);
  assert.equal(finalTextFromEvent({ type: 'result' }), null);   // no result field
});

// ── end-to-end: a realistic stream drives activity + final text ──────────────

test('a full event stream produces the expected activity and final text', () => {
  const lines = [
    '{"type":"system","subtype":"init","mcp_servers":[{"name":"playwright-test","status":"connected"}]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"knowledge/local/engine/dynamic-list-rows.md"}}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__playwright-test__record_step","input":{"step":"Then the row is visible"}}]}}',
    '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"done"}',
  ];
  const activity = [];
  let finalText = '';
  const b = makeLineBuffer();
  // feed as two chunks split mid-line to exercise the buffer
  const blob = lines.join('\n') + '\n';
  const mid = Math.floor(blob.length / 2);
  for (const chunk of [blob.slice(0, mid), blob.slice(mid)]) {
    for (const line of b.push(chunk)) {
      const ev = parseEventLine(line);
      if (!ev) continue;
      activity.push(...eventToActivity(ev));
      const ft = finalTextFromEvent(ev);
      if (ft != null) finalText = ft;
    }
  }
  assert.deepEqual(activity, [
    '[start] mcp: playwright-test:connected',
    '→ Read knowledge/local/engine/dynamic-list-rows.md',
    '→ mcp__playwright-test__record_step Then the row is visible',
    '[done] success turns=3',
  ]);
  assert.equal(finalText, 'done');
});
