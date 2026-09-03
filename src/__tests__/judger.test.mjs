/**
 * The Judger's pure helpers: which steps get judged, and how the state /
 * assertion classification works. The LLM behaviour (invokeJudger spawning a real
 * agent) is covered end-to-end; here we pin the mechanical predicates that decide
 * when the Judger is spent — including the vacuous/hollow-step rule.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isStateChangingStep, needsJudging, hasNoAssertions } from '../judger.mjs';

const click = { method: 'click', locators: [{ kind: 'role', role: 'button', name: 'X' }] };
const goto = { method: 'goto', arg: { literal: '/x' } };
const fill = { method: 'fill', locators: [{ kind: 'testid', id: 'n' }], arg: { literal: 'v' } };
const visible = { target: [{ kind: 'role', role: 'heading', name: 'H' }], matcher: 'toBeVisible' };

test('isStateChangingStep: a mutation (click/fill/select/…) is state-changing', () => {
  assert.equal(isStateChangingStep({ actions: [click] }), true);
  assert.equal(isStateChangingStep({ actions: [fill] }), true);
  assert.equal(isStateChangingStep({ actions: [goto] }), false, 'pure nav is not state-changing');
  assert.equal(isStateChangingStep({ actions: [], assertions: [visible] }), false, 'pure assert is not state-changing');
});

test('needsJudging: state-changing steps are judged', () => {
  assert.equal(needsJudging({ actions: [click], assertions: [visible] }), true);
  assert.equal(needsJudging({ actions: [fill], assertions: [] }), true);
});

test('needsJudging: an assertion-free NON-navigation step is judged (the vacuous case)', () => {
  // A step that only acts (hover, a non-mutating interaction) and asserts nothing —
  // the Judger must weigh whether the missing assertion is a real gap.
  const hoverOnly = { actions: [{ method: 'hover', locators: [{ kind: 'text', text: 'x' }] }], assertions: [] };
  // hover is in STATE_CHANGING? no — so this exercises the assertion-free branch.
  assert.equal(isStateChangingStep(hoverOnly), false);
  assert.equal(needsJudging(hoverOnly), true, 'assertion-free, non-nav → judged for hollowness');
});

test('needsJudging: a pure-navigation step is NOT judged even with no assertions', () => {
  assert.equal(needsJudging({ actions: [goto], assertions: [] }), false, 'nav asserts by the next step reaching the page');
  assert.equal(needsJudging({ actions: [goto, goto], assertions: [] }), false);
});

test('needsJudging: a pure-assertion step (no actions) is not judged when it has assertions', () => {
  assert.equal(needsJudging({ actions: [], assertions: [visible] }), false, 'it already verifies something');
});

test('needsJudging: an empty step (no action, no assertion) is judged (nothing proven)', () => {
  // validateRecord rejects this at write time, but the predicate still classifies it
  // as needing judgement rather than silently passing.
  assert.equal(needsJudging({ actions: [], assertions: [] }), true);
});

test('hasNoAssertions reflects the assertions array', () => {
  assert.equal(hasNoAssertions({ assertions: [] }), true);
  assert.equal(hasNoAssertions({ actions: [click] }), true);
  assert.equal(hasNoAssertions({ assertions: [visible] }), false);
});
