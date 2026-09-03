/**
 * The tool-enforced uniqueness check: a candidate is turned into a Playwright
 * locator expression, resolved on the live page by Playwright's own engine, and a
 * step is refused if any candidate matches ≠1. These tests pin the pure logic —
 * the locator-expression rendering, the reply interpretation, the flattening, the
 * decision, the rejection text — with the page count injected as a stub, so the
 * whole judgement is covered without a browser. The one thing only a real run
 * proves (that the expression Playwright resolves matches what the agent intended)
 * is left to end-to-end verification.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateLocatorExpr, interpretEvaluateReply, actionCandidates,
  checkRecordUniqueness, uniquenessRejection, describeCandidate,
  EDITING_METHODS, editabilityCheckExpr, interpretEditabilityReply, editabilityRejection,
} from '../locator-count.mjs';

// ── candidateLocatorExpr: each kind rendered as a Playwright locator ─────────

test('candidateLocatorExpr: role with name and exact', () => {
  assert.equal(candidateLocatorExpr({ kind: 'role', role: 'textbox', name: '密码', exact: true }),
    "getByRole('textbox', { name: '密码', exact: true })");
});

test('candidateLocatorExpr: role with name, non-exact', () => {
  assert.equal(candidateLocatorExpr({ kind: 'role', role: 'region', name: 'Card' }),
    "getByRole('region', { name: 'Card' })");
});

test('candidateLocatorExpr: role without a name', () => {
  assert.equal(candidateLocatorExpr({ kind: 'role', role: 'button' }), "getByRole('button')");
});

test('candidateLocatorExpr: testid / label / placeholder / text', () => {
  assert.equal(candidateLocatorExpr({ kind: 'testid', id: 'promo-name' }), "getByTestId('promo-name')");
  assert.equal(candidateLocatorExpr({ kind: 'label', text: 'Customer', exact: true }),
    "getByLabel('Customer', { exact: true })");
  assert.equal(candidateLocatorExpr({ kind: 'placeholder', text: 'Search' }), "getByPlaceholder('Search')");
  assert.equal(candidateLocatorExpr({ kind: 'text', text: 'Planned', exact: true }),
    "getByText('Planned', { exact: true })");
  assert.equal(candidateLocatorExpr({ kind: 'text', text: 'Planned' }), "getByText('Planned')");
});

test('candidateLocatorExpr: single quotes and backslashes in a value are escaped', () => {
  // A name carrying a single quote / backslash must not break out of the JS string literal.
  const expr = candidateLocatorExpr({ kind: 'text', text: "it's a \\ trap", exact: true });
  assert.equal(expr, "getByText('it\\'s a \\\\ trap', { exact: true })");
});

test('candidateLocatorExpr: unknown kind throws', () => {
  assert.throws(() => candidateLocatorExpr({ kind: 'css' }), /unknown candidate kind/);
});

test('candidateLocatorExpr: an inner selector chains .locator() (the UI5 wrapper→inner-input path)', () => {
  assert.equal(candidateLocatorExpr({ kind: 'testid', id: 'promotionName', inner: '#inner' }),
    "getByTestId('promotionName').locator('#inner')");
  assert.equal(candidateLocatorExpr({ kind: 'role', role: 'textbox', name: 'X', inner: 'input' }),
    "getByRole('textbox', { name: 'X' }).locator('input')");
});

test('candidateLocatorExpr: a locator kind is the chain itself, page. stripped', () => {
  assert.equal(candidateLocatorExpr({ kind: 'locator', expr: "getByTestId('cell').getByTestId('input').locator('#inner')" }),
    "getByTestId('cell').getByTestId('input').locator('#inner')");
});

// ── editabilityCheckExpr / interpretEditabilityReply: the wrapper trap ───────

test('editabilityCheckExpr: is valid JS and checks the element itself', () => {
  const expr = editabilityCheckExpr();
  assert.doesNotThrow(() => new Function(`return ${expr}`), 'the check is a valid function expression');
  assert.match(expr, /isContentEditable/);
});

test('editabilityCheckExpr: an input is editable, a wrapper div is not — even if it contains an input', () => {
  const fn = new Function(`return ${editabilityCheckExpr()}`)();
  // A native input resolves editable.
  assert.equal(fn({ tagName: 'INPUT' }), 'editable');
  assert.equal(fn({ tagName: 'TEXTAREA' }), 'editable');
  assert.equal(fn({ tagName: 'DIV', isContentEditable: true }), 'editable');
  // A wrapper div is NOT editable — the check is on the element itself, not its
  // subtree, matching Playwright's fill (which lands on the resolved element). A
  // wrapper that merely contains an input must be reached via an `inner` selector.
  assert.equal(fn({ tagName: 'DIV' }), 'not-editable');
  assert.equal(fn(null), 'not-editable');
});

test('interpretEditabilityReply: reads ONLY the Result value, not the echoed code', () => {
  // The official reply echoes the evaluated function source under "Ran Playwright
  // code", and that source contains the literal 'not-editable'. The interpreter
  // must read the Result value, not the echo — matching the whole text would
  // always see 'not-editable'. (This was a real bug: a valid inner input was
  // rejected because the function-source echo was matched instead of the result.)
  const echoed = fn => `### Result\n"${fn}"\n### Ran Playwright code\n\`\`\`js\n`
    + `await page.getByTestId('x').evaluate('(el) => { ... return \\'not-editable\\' ... }');\n\`\`\`\n### Page`;
  assert.equal(interpretEditabilityReply({ isError: false, content: [{ type: 'text', text: echoed('editable') }] }), true);
  assert.equal(interpretEditabilityReply({ isError: false, content: [{ type: 'text', text: echoed('not-editable') }] }), false);
  assert.equal(interpretEditabilityReply({ isError: true, content: [{ type: 'text', text: '### Error\nboom' }] }), null);
  assert.equal(interpretEditabilityReply(null), null);
});

test('EDITING_METHODS covers fill and type', () => {
  assert.ok(EDITING_METHODS.has('fill'));
  assert.ok(EDITING_METHODS.has('type'));
  assert.ok(!EDITING_METHODS.has('click'));
});

test('editabilityRejection: names the offender and points at the inner selector', () => {
  const rec = { step: 'set name', actions: [{ method: 'fill', locators: [{ kind: 'testid', id: 'promotionName' }] }] };
  const msg = editabilityRejection(rec, [{ actionIndex: 0, candidateIndex: 0, method: 'fill', candidate: { kind: 'testid', id: 'promotionName' }, editable: false }]);
  assert.match(msg, /not editable/);
  assert.match(msg, /wrapper/);
  assert.match(msg, /inner/);
  assert.match(msg, /testid="promotionName"/);
});

// ── interpretEvaluateReply: read Playwright's verdict as a count ─────────────

test('interpretEvaluateReply: a normal (non-error) result means exactly one match', () => {
  const reply = { isError: false, content: [{ type: 'text', text: '### Result\n1\n### Ran Playwright code' }] };
  assert.equal(interpretEvaluateReply(reply), 1);
});

test('interpretEvaluateReply: a strict-mode violation reports N (>1)', () => {
  const reply = { isError: true, content: [{ type: 'text',
    text: "### Error\nError: strict mode violation: getByRole('button', { name: '继续' }) resolved to 2 elements:\n 1) <button>…" }] };
  assert.equal(interpretEvaluateReply(reply), 2);
});

test('interpretEvaluateReply: "does not match any elements" is zero', () => {
  const reply = { isError: true, content: [{ type: 'text',
    text: '### Error\nError: "getByRole(\'textbox\', { name: \'x\' })" does not match any elements.' }] };
  assert.equal(interpretEvaluateReply(reply), 0);
});

test('interpretEvaluateReply: an unrecognised error is null (refuse, do not trust)', () => {
  const reply = { isError: true, content: [{ type: 'text', text: '### Error\nError: element is detached' }] };
  assert.equal(interpretEvaluateReply(reply), null);
});

test('interpretEvaluateReply: no reply / no text is null', () => {
  assert.equal(interpretEvaluateReply(null), null);
  assert.equal(interpretEvaluateReply({ isError: false, content: [] }), null);
});

// ── actionCandidates: flatten action locators, skip goto and assertions ──────

const RECORD = {
  scenario: 'S', step: "When I open the card",
  actions: [
    { method: 'goto', arg: { literal: '/x' } },                                   // no locators
    { method: 'click', locators: [{ kind: 'text', text: 'AI快不快', exact: true }, { kind: 'role', role: 'region', name: 'Card' }] },
    { method: 'fill', locators: [{ kind: 'testid', id: 'name' }], arg: { literal: 'v' } },
  ],
  assertions: [{ target: [{ kind: 'role', role: 'heading', name: 'X' }], matcher: 'toBeVisible' }],
};

test('actionCandidates: one entry per action-locator candidate, goto and assertions excluded', () => {
  const items = actionCandidates(RECORD);
  assert.equal(items.length, 3, 'click(2) + fill(1); goto and the assertion contribute none');
  assert.deepEqual(items.map(i => `${i.actionIndex}.${i.candidateIndex}`), ['1.0', '1.1', '2.0']);
});

// ── checkRecordUniqueness: the decision, page count injected ─────────────────

test('checkRecordUniqueness: a candidate matching several is an offender', async () => {
  // Simulate the real Card failure: the text is unique (1), the shared-Card role
  // matches 6, the testid is unique (1). The stub receives the locator expression.
  const countOne = async (expr) => (expr.includes("getByRole('region'") && expr.includes("'Card'")) ? 6 : 1;
  const { ok, offenders } = await checkRecordUniqueness(RECORD, countOne);
  assert.equal(ok, false);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].actionIndex, 1);
  assert.equal(offenders[0].candidateIndex, 1);
  assert.equal(offenders[0].count, 6);
});

test('checkRecordUniqueness: all-unique passes', async () => {
  const { ok, offenders } = await checkRecordUniqueness(RECORD, async () => 1);
  assert.equal(ok, true);
  assert.deepEqual(offenders, []);
});

test('checkRecordUniqueness: a zero match (wrong element) is also refused', async () => {
  const { ok, offenders } = await checkRecordUniqueness(
    { scenario: 'S', step: 's', actions: [{ method: 'click', locators: [{ kind: 'testid', id: 'gone' }] }] },
    async () => 0);
  assert.equal(ok, false);
  assert.equal(offenders[0].count, 0);
});

test('checkRecordUniqueness: a candidate the page could not count (null) is refused', async () => {
  const rec = { scenario: 'S', step: 's', actions: [{ method: 'click', locators: [{ kind: 'testid', id: 'x' }] }] };
  const { ok, offenders } = await checkRecordUniqueness(rec, async () => null);
  assert.equal(ok, false);
  assert.equal(offenders[0].count, null);
  const msg = uniquenessRejection(rec, offenders);
  assert.match(msg, /could not be counted/);
});

// ── rejection message ────────────────────────────────────────────────────────

test('uniquenessRejection: names each offender, its count, and points at the fix', async () => {
  const { offenders } = await checkRecordUniqueness(RECORD,
    async (expr) => (expr.includes("getByRole('region'") && expr.includes("'Card'")) ? 6 : 1);
  const msg = uniquenessRejection(RECORD, offenders);
  assert.match(msg, /When I open the card/);
  assert.match(msg, /matched 6 elements, not 1/);
  assert.match(msg, /role=region name="Card"/);
  assert.match(msg, /strict-mode/);
});

test('describeCandidate: a short tag per kind', () => {
  assert.equal(describeCandidate({ kind: 'role', role: 'button', name: 'Save' }), 'role=button name="Save"');
  assert.equal(describeCandidate({ kind: 'testid', id: 'x' }), 'testid="x"');
  assert.equal(describeCandidate({ kind: 'text', text: 'Planned' }), 'text="Planned"');
});
