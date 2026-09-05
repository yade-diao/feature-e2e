/**
 * validateRecord — the write-time shape check. Covered here for the `inner`
 * field added for UI5 wrapper → inner-input candidates: it is optional, must be a
 * non-empty string when present, and does not otherwise change a candidate's
 * validity. (The bulk of record validation is exercised through appendTrace in the
 * recorder/render tests; this pins the inner rule directly.)
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateRecord } from '../trace.mjs';

const withLocator = (loc) => ({
  scenario: 'S', step: 'When I set the name',
  actions: [{ method: 'fill', locators: [loc], arg: { literal: 'x' } }],
  assertions: [],
});

test('validateRecord: a candidate with a valid inner selector is accepted', () => {
  assert.deepEqual(validateRecord(withLocator({ kind: 'testid', id: 'promotionName', inner: '#inner' })), []);
  assert.deepEqual(validateRecord(withLocator({ kind: 'role', role: 'textbox', name: 'N', inner: 'input' })), []);
});

test('validateRecord: a candidate with no inner is still accepted (inner is optional)', () => {
  assert.deepEqual(validateRecord(withLocator({ kind: 'testid', id: 'promotionName' })), []);
});

test('validateRecord: a malformed inner (empty / non-string) is rejected', () => {
  assert.ok(validateRecord(withLocator({ kind: 'testid', id: 'x', inner: '' })).length > 0, 'empty inner rejected');
  assert.ok(validateRecord(withLocator({ kind: 'testid', id: 'x', inner: 5 })).length > 0, 'non-string inner rejected');
});

// ── locator kind: the escape hatch for nested/filtered locators ──────────────

// A driftable-anchored candidate (getByAltText/getByTitle/raw locator(css)) is
// only a valid *action* lead with a stable fallback behind it — the same
// redundancy rule the renderer enforces, now checked at write time. These cases
// verify the locator-kind expr is accepted for its shape, so they pair a
// driftable expr with a stable testid fallback to isolate that from the
// redundancy rule (which its own test covers).
const withLocators = (...locs) => ({
  scenario: 'S', step: 'When I set the name',
  actions: [{ method: 'fill', locators: locs, arg: { literal: 'x' } }],
  assertions: [],
});

test('validateRecord: a locator kind with a valid Playwright chain is accepted', () => {
  assert.deepEqual(validateRecord(withLocator({ kind: 'locator', expr: "getByTestId('cell').getByTestId('input').locator('#inner')" })), []);
  assert.deepEqual(validateRecord(withLocator({ kind: 'locator', expr: "getByRole('row').filter({ hasText: 'PD100046' }).getByRole('button')" })), []);
  assert.deepEqual(validateRecord(withLocators({ kind: 'locator', expr: "getByAltText('logo')" }, { kind: 'testid', id: 'logo' })), []);
  assert.deepEqual(validateRecord(withLocators({ kind: 'locator', expr: "locator('.grid').getByTestId('x')" }, { kind: 'testid', id: 'x' })), []);
});

test('validateRecord: a locator kind is rejected for a positional method', () => {
  assert.ok(validateRecord(withLocator({ kind: 'locator', expr: "getByRole('row').first()" })).length > 0, 'first() rejected');
  assert.ok(validateRecord(withLocator({ kind: 'locator', expr: "getByRole('row').nth(2)" })).length > 0, 'nth() rejected');
  assert.ok(validateRecord(withLocator({ kind: 'locator', expr: "getByTestId('x').last()" })).length > 0, 'last() rejected');
});

test('validateRecord: a locator kind is rejected for a non-builder start (no arbitrary JS)', () => {
  assert.ok(validateRecord(withLocator({ kind: 'locator', expr: "document.querySelector('x')" })).length > 0, 'raw DOM rejected');
  assert.ok(validateRecord(withLocator({ kind: 'locator', expr: "page.getByTestId('x')" })).length > 0, 'leading page. rejected (renderer adds it)');
  assert.ok(validateRecord(withLocator({ kind: 'locator', expr: '' })).length > 0, 'empty rejected');
  assert.ok(validateRecord(withLocator({ kind: 'locator', expr: 42 })).length > 0, 'non-string rejected');
});

// ── shape rule: a driftable action locator with no fallback ──────────────────
// The redundancy rule the renderer designs out, now enforced at write time so
// the record is rejected at the step that produced it, not at render after the
// whole feature is recorded.

test('validateRecord: an action led by a driftable text candidate with no fallback is rejected', () => {
  const problems = validateRecord(withLocator({ kind: 'text', text: 'AI快不快', exact: true }));
  assert.ok(problems.some(p => /driftable/.test(p)), `expected a driftable-fallback problem, got ${JSON.stringify(problems)}`);
});

test('validateRecord: a driftable action candidate WITH a stable fallback is accepted', () => {
  assert.deepEqual(
    validateRecord(withLocators({ kind: 'text', text: 'AI快不快' }, { kind: 'testid', id: 'accountPlanRow' })),
    []);
});

test('validateRecord: a lone stable candidate (role/testid) needs no fallback', () => {
  assert.deepEqual(validateRecord(withLocator({ kind: 'role', role: 'button', name: 'Save' })), []);
  assert.deepEqual(validateRecord(withLocator({ kind: 'testid', id: 'promotion-save' })), []);
});

// ── action method whitelist (a typo'd or hallucinated method is caught here) ──

const withMethod = (method, extra = {}) => ({
  scenario: 'S', step: 'When I act',
  actions: [{ method, locators: [{ kind: 'role', role: 'button', name: 'Save' }], ...extra }],
  assertions: [],
});

test('validateRecord: a known interaction method is accepted', () => {
  for (const m of ['click', 'dblclick', 'hover', 'check', 'uncheck', 'selectOption']) {
    assert.deepEqual(validateRecord(withMethod(m)), [], `${m} accepted`);
  }
  // fill carries an arg; press carries a key — both known, both fine.
  assert.deepEqual(validateRecord(withMethod('fill', { arg: { literal: 'x' } })), []);
  assert.deepEqual(validateRecord(withMethod('press', { key: 'Enter' })), []);
});

test('validateRecord: an unknown/typo\'d action method is rejected (not just non-empty)', () => {
  for (const m of ['clik', 'select', 'evaluate', 'submit', 'tapp']) {
    const problems = validateRecord(withMethod(m));
    assert.ok(problems.some(p => /unknown method/.test(p)), `${m} rejected with an "unknown method" problem, got ${JSON.stringify(problems)}`);
  }
});

test('validateRecord: goto is not in the interaction whitelist but is still accepted (its own navigation path)', () => {
  assert.deepEqual(validateRecord({
    scenario: 'S', step: 'Given I open the page',
    actions: [{ method: 'goto', arg: { literal: '/' } }], assertions: [],
  }), []);
});

test('validateRecord: an ASSERTION target may be a lone driftable candidate (not gated)', () => {
  const rec = {
    scenario: 'S', step: 'Then I see the name',
    actions: [],
    assertions: [{ target: [{ kind: 'text', text: 'Planned' }], matcher: 'toBeVisible' }],
  };
  assert.deepEqual(validateRecord(rec), []);
});

// ── ref resolution: incremental, against already-declared values ─────────────
// validateRecord alone (no priorValues) keeps the write-well-formed-only
// contract — a ref to another record's value is not its business. With
// priorValues (what appendTrace passes), a ref resolvable against
// (prior ∪ own) passes; one that resolves nowhere is rejected at write time.

const usesRef = (name, ownValues) => ({
  scenario: 'S', step: 'When I fill the field',
  actions: [{ method: 'fill', locators: [{ kind: 'testid', id: 'field' }], arg: { ref: name } }],
  assertions: [],
  ...(ownValues ? { values: ownValues } : {}),
});

test('validateRecord: without priorValues, an unresolved ref is not flagged (lone-record contract)', () => {
  assert.deepEqual(validateRecord(usesRef('CUSTOMER')), []);
});

test('validateRecord: a ref resolved by the record\'s own values passes', () => {
  assert.deepEqual(
    validateRecord(usesRef('CUSTOMER', { CUSTOMER: { kind: 'fixed', literal: 'L6' } }), {}),
    []);
});

test('validateRecord: a ref resolved by a prior record\'s values passes', () => {
  assert.deepEqual(
    validateRecord(usesRef('ORDER_NAME'), { ORDER_NAME: { kind: 'dynamic', expr: '`x`' } }),
    []);
});

test('validateRecord: a ref that no record declares is rejected when priorValues is given', () => {
  const problems = validateRecord(usesRef('PRODUCT_1'), {});
  assert.ok(problems.some(p => /PRODUCT_1/.test(p) && /declared/.test(p)),
    `expected an unresolved-ref problem, got ${JSON.stringify(problems)}`);
});

// ── B5: a numeric literal on a text-content matcher is rejected ──────────────

test('validateRecord: toHaveText/toContainText with a number literal is rejected (invalid in Playwright)', () => {
  for (const matcher of ['toHaveText', 'toContainText']) {
    const rec = {
      scenario: 'S', step: 'Then it shows 5',
      actions: [], assertions: [{ target: [{ kind: 'role', role: 'status' }], matcher, value: { literal: 5 } }],
    };
    const problems = validateRecord(rec);
    assert.ok(problems.some(p => /takes text, not the number/.test(p)), `${matcher}(5) rejected, got ${JSON.stringify(problems)}`);
  }
});

test('validateRecord: a numeric literal on a NUMERIC matcher (toHaveCount) is accepted', () => {
  const rec = {
    scenario: 'S', step: 'Then there are no alerts',
    actions: [], assertions: [{ target: [{ kind: 'role', role: 'alert' }], matcher: 'toHaveCount', value: { literal: 0 } }],
  };
  assert.deepEqual(validateRecord(rec), []);
});

test('validateRecord: a string literal on toHaveText is accepted (it renders as a regex fragment)', () => {
  const rec = {
    scenario: 'S', step: 'Then the status is Draft',
    actions: [], assertions: [{ target: [{ kind: 'role', role: 'status' }], matcher: 'toHaveText', value: { literal: 'Draft' } }],
  };
  assert.deepEqual(validateRecord(rec), []);
});
