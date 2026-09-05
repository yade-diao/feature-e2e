/**
 * The renderer's contract: every shape it emits clears every gate.
 *
 * The whole point of moving spec authorship off the model and onto a template is
 * that the template cannot forget a rule. That guarantee is only real if it is
 * tested against the actual gates, not a paraphrase of them — so these tests
 * render a trace and feed the result to the real check functions from
 * checks.mjs, exactly as the recorder's gate stage will.
 *
 * A failure here is the renderer emitting a shape a gate rejects — the one class
 * of bug the whole design exists to make impossible.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '@typescript-eslint/parser';

import { renderSpec, renderLocator, renderCandidate } from '../render-spec.mjs';
import { appendTrace, readTrace, validateRecord, featureToTrace, resumeIndexFromFailures, truncateTrace, backupTrace } from '../trace.mjs';
import {
  checkBannedPatterns, checkLocatorRedundancy, checkWriteCheckpoint,
  checkLiveness, checkStepCoverage, checkSemanticStability, checkLocatorRobustness,
} from '../checks.mjs';

/**
 * Render a trace + its feature to a scratch dir and hand back both paths.
 *
 * The feature is derived from the trace: one scenario per distinct trace
 * scenario, its steps the trace steps verbatim — which is the arrangement the
 * coverage gate expects, and the one the recorder produces.
 */
function fixture(trace) {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-render-'));
  const spec = join(dir, 'x.spec.ts');
  writeFileSync(spec, renderSpec(trace));

  const byScenario = new Map();
  for (const rec of trace) {
    if (!byScenario.has(rec.scenario)) byScenario.set(rec.scenario, []);
    byScenario.get(rec.scenario).push(rec.step);
  }
  let body = 'Feature: F\n';
  for (const [name, steps] of byScenario) {
    body += `\n  Scenario: ${name}\n${steps.map(s => `    ${s}`).join('\n')}\n`;
  }
  const feature = join(dir, 'x.feature');
  writeFileSync(feature, body);
  return { feature, spec, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Assert every gate passes on a rendered fixture; report the first that fails. */
async function assertAllGatesPass(f) {
  const banned = await checkBannedPatterns(f.spec);
  assert.equal(banned.ok, true, `banned: ${JSON.stringify(banned.hits ?? [])}`);
  assert.equal(checkLocatorRedundancy(f.spec).ok, true, 'redundancy');
  assert.equal(checkWriteCheckpoint(f.spec).ok, true, 'writeCheckpoint');
  assert.equal(checkLiveness(f.feature, f.spec).ok, true, 'liveness');
  assert.equal(checkStepCoverage(f.feature, f.spec).ok, true, 'coverage');
  assert.equal(checkSemanticStability(f.feature, f.spec).ok, true, 'semantic');
  assert.equal(checkLocatorRobustness(f.spec).ok, true, 'robustness');
}

// A trace touching every shape the gates judge: origin-stripped goto, an action
// with an .or() fallback, a write (fill) that must prove presence, a dynamic
// value regenerated per run, a fixed literal, and an absence assertion paired
// with a presence one in the same step.
const FULL_TRACE = [
  {
    scenario: 'Create',
    step: "Given I open dashboard",
    values: {
      ORDER_NAME: { kind: 'dynamic', expr: '`Auto-test${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`' },
      CUSTOMER: { kind: 'fixed', literal: 'Acme Wholesale US 001' },
    },
    actions: [{ method: 'goto', arg: { literal: 'https://host.example/orders/dashboard' } }],
    assertions: [{ target: [{ kind: 'role', role: 'heading', name: 'Dashboard' }], matcher: 'toBeVisible' }],
  },
  {
    scenario: 'Create',
    step: "When I set customer",
    actions: [
      { method: 'click', locators: [{ kind: 'role', role: 'combobox', name: 'Customer' }, { kind: 'testid', id: 'customer-select' }] },
      { method: 'fill', locators: [{ kind: 'label', text: 'Customer' }], arg: { ref: 'CUSTOMER' } },
    ],
    assertions: [{ target: [{ kind: 'label', text: 'Customer' }], matcher: 'toHaveValue', value: { ref: 'CUSTOMER' } }],
  },
  {
    scenario: 'Create',
    step: 'And I set promotion name',
    actions: [
      { method: 'fill', locators: [{ kind: 'placeholder', text: 'Order Name' }, { kind: 'testid', id: 'promo-name' }], arg: { ref: 'ORDER_NAME' } },
    ],
    assertions: [{ target: [{ kind: 'placeholder', text: 'Order Name' }], matcher: 'toHaveValue', value: { ref: 'ORDER_NAME' } }],
  },
  {
    scenario: 'Create',
    step: 'Then I confirm no error',
    actions: [{ method: 'click', locators: [{ kind: 'role', role: 'button', name: 'Next Step' }] }],
    assertions: [
      { target: [{ kind: 'role', role: 'alert' }], matcher: 'toHaveCount', value: { literal: 0 } },
      { target: [{ kind: 'role', role: 'heading', name: 'Products' }], matcher: 'toBeVisible' },
    ],
  },
];

// ── the guarantee: rendered spec clears every gate ──────────────────────────

test('render: a full trace passes every gate', async () => {
  const f = fixture(FULL_TRACE);
  await assertAllGatesPass(f);
  f.cleanup();
});

test('render: prefix (upto) also passes every gate and parses', async () => {
  // A resume seed is the trace up to the bad step. It must be a legal spec on
  // its own — the part that already worked, replayed for real.
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-prefix-'));
  const spec = join(dir, 'x.spec.ts');
  writeFileSync(spec, renderSpec(FULL_TRACE, { upto: 2 }));
  const feature = join(dir, 'x.feature');
  writeFileSync(feature, 'Feature: F\n\n  Scenario: Create\n    Given I open dashboard\n    When I set customer\n');
  const f = { feature, spec, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  await assertAllGatesPass(f);
  f.cleanup();
});

test('render: output is syntactically valid TypeScript', () => {
  // Parsing is what the banned gate does first; a syntax error there reports as
  // "eslint did not run" rather than a clean rejection, so prove it parses.
  assert.doesNotThrow(() => parse(renderSpec(FULL_TRACE), { range: true, loc: true }));
});

// ── checkLocators: per-candidate toHaveCount(1) before each action locator ───

test('render checkLocators: one toHaveCount(1) per action candidate, before the action', () => {
  const spec = renderSpec(FULL_TRACE, { checkLocators: true });
  // FULL_TRACE action candidates: step2 click(2) + fill(1), step3 fill(2), step4 click(1) = 6.
  // goto (step1) has no locator and is skipped.
  assert.equal((spec.match(/\.toHaveCount\(1\)/g) ?? []).length, 6,
    'one uniqueness assertion per action candidate, goto excluded');

  // Each injected assertion sits immediately before the action that uses it.
  const clickIdx = spec.indexOf('.getByRole(\'combobox\', { name: \'Customer\' }).or(');
  const countIdx = spec.indexOf('await expect(page.getByRole(\'combobox\', { name: \'Customer\' })).toHaveCount(1)');
  assert.ok(countIdx !== -1, 'combobox candidate gets its own count assertion');
  assert.ok(countIdx < clickIdx, 'the count assertion is emitted before the action');
});

test('render checkLocators: goto and assertion targets are never injected', () => {
  const spec = renderSpec(FULL_TRACE, { checkLocators: true });
  // step1 is a goto — no toHaveCount(1) in that step block.
  const step1 = spec.slice(spec.indexOf("Given I open dashboard"), spec.indexOf("When I set customer"));
  assert.doesNotMatch(step1, /toHaveCount\(1\)/, 'goto step gets no uniqueness assertion');
  // step4 has a business assertion toHaveCount(0) on role=alert — never turned into (1).
  assert.match(spec, /\.toHaveCount\(0\)/, 'the business absence assertion is preserved as-is');
});

test('render checkLocators: default (off) injects nothing', () => {
  const spec = renderSpec(FULL_TRACE);
  assert.equal((spec.match(/\.toHaveCount\(1\)/g) ?? []).length, 0,
    'without checkLocators there are no injected uniqueness assertions');
});

test('render checkLocators: the injected spec still parses and clears every gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-check-'));
  const spec = join(dir, 'x.spec.ts');
  writeFileSync(spec, renderSpec(FULL_TRACE, { checkLocators: true }));
  const byScenario = new Map();
  for (const rec of FULL_TRACE) {
    if (!byScenario.has(rec.scenario)) byScenario.set(rec.scenario, []);
    byScenario.get(rec.scenario).push(rec.step);
  }
  let body = 'Feature: F\n';
  for (const [name, steps] of byScenario) body += `\n  Scenario: ${name}\n${steps.map(s => `    ${s}`).join('\n')}\n`;
  const feature = join(dir, 'x.feature');
  writeFileSync(feature, body);
  const f = { feature, spec, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  assert.doesNotThrow(() => parse(renderSpec(FULL_TRACE, { checkLocators: true }), { range: true, loc: true }));
  await assertAllGatesPass(f);   // titles unchanged → coverage ok; injected lines are legal awaited expects
  f.cleanup();
});

// ── seedTimeoutMs / navTimeoutMs: the state-driven ceilings a resume seed uses ─
// A resume seed renders with short timeouts so a stale prefix fails fast (assertions
// AND actions at 2s, goto at a longer nav allowance) instead of waiting out the
// config's 15s/120s; the promoted spec renders WITHOUT them and must stay
// byte-for-byte the bare form (CI's 120s budget untouched).

test('seedTimeoutMs: omitting it leaves the promoted spec byte-for-byte unchanged', () => {
  // The default render is the contract CI replays against — injecting nothing must
  // produce exactly the same text as before this option existed.
  const bare = renderSpec(FULL_TRACE);
  assert.doesNotMatch(bare, /\{ timeout:/, 'no timeout option anywhere in the promoted spec');
  // Assertions stay the bare web-first form.
  assert.match(bare, /await expect\([^\n]*\)\.toBeVisible\(\);/, 'nullary matcher stays argument-less');
  assert.match(bare, /await expect\([^\n]*\)\.toHaveCount\(0\);/, 'numeric matcher stays bare');
  // Actions stay bare too — no injected options object.
  assert.match(bare, /await page\.goto\('\/orders\/dashboard'\);/, 'goto stays bare');
  assert.match(bare, /\.fill\(CUSTOMER\);/, 'fill stays bare (value only)');
});

test('seedTimeoutMs: a seed render injects { timeout } into every assertion form', () => {
  const seed = renderSpec(FULL_TRACE, { seedTimeoutMs: 2000 });
  // nullary (toBeVisible): the options object is the sole argument.
  assert.match(seed, /\.toBeVisible\(\{ timeout: 2000 \}\);/, 'nullary matcher takes the options object alone');
  // numeric (toHaveCount(0)): value first, then the options object.
  assert.match(seed, /\.toHaveCount\(0, \{ timeout: 2000 \}\);/, 'numeric matcher keeps its value then the timeout');
  // ref value (toHaveValue(CUSTOMER)): variable first, then the options object.
  assert.match(seed, /\.toHaveValue\(CUSTOMER, \{ timeout: 2000 \}\);/, 'ref matcher keeps its variable then the timeout');
  // Every assertion got one — there should be no bare (option-less) expect left.
  const bareVisible = (seed.match(/\.toBeVisible\(\);/g) ?? []).length;
  assert.equal(bareVisible, 0, 'no assertion is left without the short timeout');
});

test('seedTimeoutMs: a seed render injects { timeout } into located ACTIONS too (the biggest hang)', () => {
  const seed = renderSpec(FULL_TRACE, { seedTimeoutMs: 2000 });
  // click(): no positional arg → the options object is the sole argument.
  assert.match(seed, /\.click\(\{ timeout: 2000 \}\);/, 'click takes the options object alone');
  // fill(value): value first, then the options object.
  assert.match(seed, /\.fill\(CUSTOMER, \{ timeout: 2000 \}\);/, 'fill keeps its value then the timeout');
  // No bare click/fill left — an action on a vanished element must fail fast, not run to 120s.
  assert.equal((seed.match(/\.click\(\);/g) ?? []).length, 0, 'no bare click left');
});

test('navTimeoutMs: goto gets the longer nav allowance, not the short step timeout', () => {
  const seed = renderSpec(FULL_TRACE, { seedTimeoutMs: 2000, navTimeoutMs: 120000 });
  // goto is an arrival — it must NOT be capped at 2s (a remote cold paint needs more).
  assert.match(seed, /page\.goto\('\/orders\/dashboard', \{ timeout: 120000 \}\);/, 'goto uses the nav timeout');
  assert.doesNotMatch(seed, /page\.goto\([^\n]*timeout: 2000/, 'goto is never given the 2s step timeout');
});

test('seedTimeoutMs: combined with checkLocators, the toHaveCount(1) probes also get it', () => {
  const seed = renderSpec(FULL_TRACE, { checkLocators: true, seedTimeoutMs: 2000 });
  // The injected uniqueness probes must fail fast too, or a stale prefix hangs on a
  // vanished action locator instead of a vanished assertion.
  assert.match(seed, /\.toHaveCount\(1, \{ timeout: 2000 \}\);/, 'uniqueness probe carries the short timeout');
  assert.equal((seed.match(/\.toHaveCount\(1\)/g) ?? []).length, 0,
    'no uniqueness probe is left without the timeout');
});

test('seedTimeoutMs: the seed render still parses as valid TS', () => {
  assert.doesNotThrow(
    () => parse(renderSpec(FULL_TRACE, { checkLocators: true, seedTimeoutMs: 2000, navTimeoutMs: 120000 }), { range: true, loc: true }),
    'a timeout-injected seed is legal TypeScript');
});


// ── renderCandidate: each kind renders the expected expression ───────────────

test('renderCandidate: every kind renders its getByX expression', () => {
  assert.equal(renderCandidate({ kind: 'role', role: 'button', name: 'Save' }), "page.getByRole('button', { name: 'Save' })");
  assert.equal(renderCandidate({ kind: 'role', role: 'button', name: 'Save', exact: true }), "page.getByRole('button', { name: 'Save', exact: true })");
  assert.equal(renderCandidate({ kind: 'testid', id: 'promo-save' }), "page.getByTestId('promo-save')");
  assert.equal(renderCandidate({ kind: 'label', text: 'Customer' }), "page.getByLabel('Customer')");
  assert.equal(renderCandidate({ kind: 'placeholder', text: 'Search' }), "page.getByPlaceholder('Search')");
  assert.equal(renderCandidate({ kind: 'text', text: 'Planned', exact: true }), "page.getByText('Planned', { exact: true })");
  assert.throws(() => renderCandidate({ kind: 'bogus' }), /unknown candidate kind/);
});

test('renderCandidate: an inner selector chains .locator() (UI5 wrapper → native input)', () => {
  assert.equal(renderCandidate({ kind: 'testid', id: 'promotionName', inner: '#inner' }),
    "page.getByTestId('promotionName').locator('#inner')");
  assert.equal(renderCandidate({ kind: 'role', role: 'textbox', name: 'Name', inner: 'input' }),
    "page.getByRole('textbox', { name: 'Name' }).locator('input')");
});

test('renderCandidate: a locator kind renders its chain verbatim after page.', () => {
  assert.equal(renderCandidate({ kind: 'locator', expr: "getByTestId('cell').getByTestId('input').locator('#inner')" }),
    "page.getByTestId('cell').getByTestId('input').locator('#inner')");
  assert.equal(renderCandidate({ kind: 'locator', expr: "getByRole('row').filter({ hasText: 'PD100046' }).getByRole('button', { name: 'Edit' })" }),
    "page.getByRole('row').filter({ hasText: 'PD100046' }).getByRole('button', { name: 'Edit' })");
});

// ── driftable judged from the rendered expression, single source of truth ────

test('renderLocator: driftability follows the ANCHOR source, not any method in the chain', () => {
  const action = { forAction: true };
  // Anchored on a stable testid/role → allowed alone, EVEN with a .locator('#inner')
  // refinement (the UI5 inner-input case — this is what a wrong "any locator method
  // in the chain" rule broke, aborting the whole render).
  assert.doesNotThrow(() => renderLocator([{ kind: 'testid', id: 'promotionName', inner: '#inner' }], action));
  assert.doesNotThrow(() => renderLocator([{ kind: 'role', role: 'textbox', name: 'N', inner: 'input' }], action));
  assert.doesNotThrow(() => renderLocator([{ kind: 'locator', expr: "getByTestId('cell').getByTestId('input').locator('#inner')" }], action));
  // Anchored on a driftable source → refused alone.
  assert.throws(() => renderLocator([{ kind: 'locator', expr: "getByText('临时价格')" }], action), /driftable|fallback/);
  assert.throws(() => renderLocator([{ kind: 'locator', expr: "locator('.foo')" }], action), /driftable|fallback/);
  // Regressions.
  assert.throws(() => renderLocator([{ kind: 'text', text: 'Planned' }], action), /driftable|fallback/);
  assert.doesNotThrow(() => renderLocator([{ kind: 'testid', id: 'x' }], action));
});

// ── dynamic vs fixed values ─────────────────────────────────────────────────

test('render: dynamic value becomes a runtime const, referenced not inlined', () => {
  const spec = renderSpec(FULL_TRACE);
  // The expression is present as a const, evaluated when the file loads.
  assert.match(spec, /const ORDER_NAME = `Auto-test\$\{new Date\(\)/);
  // The name is never frozen into a literal — the fill references the variable.
  assert.match(spec, /\.fill\(ORDER_NAME\)/);
  assert.doesNotMatch(spec, /\.fill\('Auto-test/);
});

test('render: fixed value becomes a literal const', () => {
  const spec = renderSpec(FULL_TRACE);
  assert.match(spec, /const CUSTOMER = 'Acme Wholesale US 001'/);
  assert.match(spec, /\.fill\(CUSTOMER\)/);
});

test('render: a dynamic value shared across scenarios is one variable', () => {
  // Create sets the name; a later Edit scenario searches for it. Same const,
  // declared once at describe level → self-consistent within a run.
  const trace = [
    FULL_TRACE[0], FULL_TRACE[2],
    {
      scenario: 'Edit',
      step: 'When I search the promotion by name',
      actions: [{ method: 'fill', locators: [{ kind: 'placeholder', text: 'Search' }], arg: { ref: 'ORDER_NAME' } }],
      assertions: [{ target: [{ kind: 'role', role: 'row', name: 'match' }], matcher: 'toBeVisible' }],
    },
  ];
  const spec = renderSpec(trace);
  assert.equal((spec.match(/const ORDER_NAME =/g) ?? []).length, 1, 'declared exactly once');
  // One test for the whole feature, so scenarios share a browser context;
  // scenarios stay legible as comments.
  assert.equal((spec.match(/  test\(/g) ?? []).length, 1, 'the feature is one test');
  assert.match(spec, /\/\/ Scenario: Create/);
  assert.match(spec, /\/\/ Scenario: Edit/);
});

// ── goto is always origin-stripped ──────────────────────────────────────────

test('render: goto keeps the path, drops the origin', () => {
  const spec = renderSpec(FULL_TRACE);
  assert.match(spec, /page\.goto\('\/orders\/dashboard'\)/);
  assert.doesNotMatch(spec, /goto\('https?:/);
});

// ── renderLocator: the redundancy rule lives here ───────────────────────────

test('renderLocator: pure-semantic single candidate stands alone', () => {
  assert.equal(
    renderLocator([{ kind: 'role', role: 'button', name: 'Save' }], { forAction: true }),
    "page.getByRole('button', { name: 'Save' })");
});

test('renderLocator: driftable text with a fallback renders an .or() chain', () => {
  const out = renderLocator(
    [{ kind: 'text', text: 'Planned' }, { kind: 'role', role: 'status' }], { forAction: true });
  assert.equal(out, "page.getByText('Planned').or(page.getByRole('status'))");
});

test('renderLocator: driftable text alone for an action is rejected', () => {
  assert.throws(
    () => renderLocator([{ kind: 'text', text: 'Planned' }], { forAction: true }),
    /no fallback/);
});

test('renderLocator: driftable text alone is fine for an assertion (not forAction)', () => {
  assert.doesNotThrow(() => renderLocator([{ kind: 'text', text: 'Planned' }]));
});

test('renderLocator: exact renders the option', () => {
  assert.equal(
    renderLocator([{ kind: 'role', role: 'button', name: 'Save', exact: true }]),
    "page.getByRole('button', { name: 'Save', exact: true })");
});

// ── trace read/write + validation ───────────────────────────────────────────

test('trace: featureToTrace mirrors the spec path shape', () => {
  const p = featureToTrace(join('features', 'demo', 'checkout.feature'));
  assert.equal(p, join('run', 'demo', 'checkout.trace.jsonl'));
});

test('trace: append then read round-trips records in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-trace-'));
  const feature = join('features', 'p', 'x.feature');
  // appendTrace writes under SPEC_DIR relative to cwd; run it in the scratch dir.
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    appendTrace(feature, FULL_TRACE[0]);
    appendTrace(feature, FULL_TRACE[1]);
    const back = readTrace(feature);
    assert.equal(back.length, 2);
    assert.equal(back[0].step, FULL_TRACE[0].step);
    assert.equal(back[1].step, FULL_TRACE[1].step);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trace: readTrace of an absent trace is empty, not an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-trace-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.deepEqual(readTrace(join('features', 'p', 'nope.feature')), []);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render: a ref that no record declares is rejected at render time', () => {
  // A dangling ref is a whole-trace question (a value may be declared in another
  // record), so it is caught by renderSpec, not by a single-record validate.
  const trace = [{
    scenario: 'S', step: 'When I fill',
    actions: [{ method: 'fill', locators: [{ kind: 'label', text: 'X' }], arg: { ref: 'MISSING' } }],
    assertions: [{ target: [{ kind: 'label', text: 'X' }], matcher: 'toHaveValue', value: { ref: 'MISSING' } }],
  }];
  assert.throws(() => renderSpec(trace), /value 'MISSING'/);
});

test('validateRecord: an action with no locators is rejected', () => {
  const problems = validateRecord({
    scenario: 'S', step: 'When I click',
    actions: [{ method: 'click', locators: [] }],
  });
  assert.ok(problems.some(p => /no locators/.test(p)), problems.join('; '));
});

test('validateRecord: a well-formed record has no problems', () => {
  assert.deepEqual(validateRecord(FULL_TRACE[1]), []);
});

test('validateRecord: an empty step (no action, no assertion) is rejected', () => {
  // The substance guarantee, moved off the replay gate and onto the trace's own
  // contract: an empty step never enters the trace, instead of being caught a
  // whole run later.
  const problems = validateRecord({ scenario: 'S', step: 'When I do nothing', actions: [], assertions: [] });
  assert.ok(problems.some(p => /neither an action nor an assertion/.test(p)), problems.join('; '));
});

test('validateRecord: a step that only asserts is fine', () => {
  assert.deepEqual(validateRecord({
    scenario: 'S', step: 'Then I see the heading',
    actions: [], assertions: [{ target: [{ kind: 'role', role: 'heading', name: 'X' }], matcher: 'toBeVisible' }],
  }), []);
});

test('validateRecord: a step that only acts (navigation) is fine', () => {
  assert.deepEqual(validateRecord({
    scenario: 'S', step: 'When I open the page',
    actions: [{ method: 'goto', arg: { literal: '/x' } }], assertions: [],
  }), []);
});

// ── resume: locate the failed step, keep the clean prefix ────────────────────

const RESUME_TRACE = [
  { scenario: 'S', step: 'Given a' },
  { scenario: 'S', step: "When I click 'Save'" },
  { scenario: 'S', step: 'Then c' },
];

test('resumeIndexFromFailures: earliest failed step wins', () => {
  assert.equal(resumeIndexFromFailures(RESUME_TRACE, ["When I click 'Save'", 'Then c']), 1);
  assert.equal(resumeIndexFromFailures(RESUME_TRACE, ['Then c']), 2);
});

test('resumeIndexFromFailures: quote/space normalisation matches the coverage gate', () => {
  // Curly quotes and repeated spaces must still match — the same normalise the
  // coverage gate uses, so a resume point is never missed on quote shape alone.
  assert.equal(resumeIndexFromFailures(RESUME_TRACE, ['When I click ‘Save’']), 1);
});

test('resumeIndexFromFailures: no match, or empty, means no safe prefix', () => {
  assert.equal(resumeIndexFromFailures(RESUME_TRACE, ['nonexistent']), null);
  assert.equal(resumeIndexFromFailures(RESUME_TRACE, []), null);
});

test('truncateTrace: keeps the first N records, drops the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-trunc-'));
  const feature = join('features', 'p', 'x.feature');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    for (const rec of [
      { scenario: 'S', step: 'Given a', actions: [{ method: 'goto', arg: { literal: '/a' } }], assertions: [] },
      { scenario: 'S', step: 'When b', actions: [{ method: 'click', locators: [{ kind: 'role', role: 'button', name: 'B' }] }], assertions: [] },
      { scenario: 'S', step: 'Then c', actions: [], assertions: [{ target: [{ kind: 'role', role: 'heading', name: 'C' }], matcher: 'toBeVisible' }] },
    ]) appendTrace(feature, rec);
    assert.equal(truncateTrace(feature, 2), 2);
    assert.deepEqual(readTrace(feature).map(r => r.step), ['Given a', 'When b']);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── backup: every truncate / restart leaves a .bak of what it dropped ─────────

/** The three-record trace used by the backup/retrace cases below. */
const THREE = [
  { scenario: 'S', step: 'Given a', actions: [{ method: 'goto', arg: { literal: '/a' } }], assertions: [] },
  { scenario: 'S', step: 'When b', actions: [{ method: 'click', locators: [{ kind: 'role', role: 'button', name: 'B' }] }], assertions: [] },
  { scenario: 'S', step: 'Then c', actions: [], assertions: [{ target: [{ kind: 'role', role: 'heading', name: 'C' }], matcher: 'toBeVisible' }] },
];

test('backupTrace: copies the trace to .bak, verbatim; nothing to back up is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-bak-'));
  const feature = join('features', 'p', 'x.feature');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    // Nothing on disk yet: no-op, returns null, writes no .bak.
    assert.equal(backupTrace(feature), null);
    const tracePath = featureToTrace(feature);
    assert.equal(existsSync(`${tracePath}.bak`), false);

    for (const rec of THREE) appendTrace(feature, rec);
    const before = readFileSync(tracePath, 'utf8');
    const bak = backupTrace(feature);
    assert.equal(bak, `${tracePath}.bak`);
    assert.equal(readFileSync(bak, 'utf8'), before, '.bak is a verbatim copy');
    // The live trace is untouched by a backup.
    assert.deepEqual(readTrace(feature).map(r => r.step), ['Given a', 'When b', 'Then c']);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('truncateTrace: backs up the pre-truncation trace to .bak before dropping records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-trunc-bak-'));
  const feature = join('features', 'p', 'x.feature');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    for (const rec of THREE) appendTrace(feature, rec);
    const tracePath = featureToTrace(feature);
    truncateTrace(feature, 2);
    // The dropped record survives in the backup — the whole point of the .bak.
    const bak = readFileSync(`${tracePath}.bak`, 'utf8');
    const bakSteps = bak.split('\n').filter(Boolean).map(l => JSON.parse(l).step);
    assert.deepEqual(bakSteps, ['Given a', 'When b', 'Then c'], '.bak holds the full pre-truncation trace');
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('truncateTrace: K-1 = 0 empties the trace but the .bak keeps every record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-trunc-zero-'));
  const feature = join('features', 'p', 'x.feature');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    for (const rec of THREE) appendTrace(feature, rec);
    const tracePath = featureToTrace(feature);
    // retrace <feature> 1 truncates to 0: a full re-record, but nothing is lost.
    assert.equal(truncateTrace(feature, 0), 0);
    assert.deepEqual(readTrace(feature), []);
    const bakSteps = readFileSync(`${tracePath}.bak`, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).step);
    assert.deepEqual(bakSteps, ['Given a', 'When b', 'Then c']);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── B5: text-content assertions match a fixed string as a regex fragment ─────

test('render: toHaveText with a fixed string renders as a regex fragment (substring), not an exact literal', () => {
  const spec = renderSpec([{
    scenario: 'S', step: 'Then the status is Draft',
    actions: [{ method: 'goto', arg: { literal: '/' } }],
    assertions: [{ target: [{ kind: 'role', role: 'status' }], matcher: 'toHaveText', value: { literal: 'Draft' } }],
  }]);
  assert.match(spec, /\.toHaveText\(new RegExp\('Draft'\)\)/, 'a fixed string is a regex fragment so surrounding markup/space is tolerated');
  assert.doesNotMatch(spec, /\.toHaveText\('Draft'\)/, 'not an exact whole-text literal');
});

test('render: regex metacharacters in a text value are escaped so they match literally', () => {
  const spec = renderSpec([{
    scenario: 'S', step: 'Then it shows the total',
    actions: [{ method: 'goto', arg: { literal: '/' } }],
    assertions: [{ target: [{ kind: 'role', role: 'status' }], matcher: 'toContainText', value: { literal: '$1.50 (net)' } }],
  }]);
  // The RegExp source escapes $ . ( ) so they match as themselves. In the emitted
  // TS SOURCE each backslash is doubled again by string-quoting, so the source text
  // reads new RegExp('\\$1\\.50 \\(net\\)') — which parses to /\$1\.50 \(net\)/.
  assert.match(spec, /new RegExp\('\\\\\$1\\\\\.50 \\\\\(net\\\\\)'\)/, 'metacharacters escaped');
  // And prove the parsed regex actually matches the literal string as a substring.
  const src = spec.match(/new RegExp\('([^']*)'\)/)[1].replace(/\\\\/g, '\\');
  assert.ok(new RegExp(src).test('Total: $1.50 (net) today'), 'the escaped regex matches the literal substring');
});

test('render: toHaveValue with a fixed string stays an EXACT literal (a value equals X means exactly X)', () => {
  const spec = renderSpec([{
    scenario: 'S', step: 'Then the field holds ABC',
    actions: [{ method: 'goto', arg: { literal: '/' } }],
    assertions: [{ target: [{ kind: 'label', text: 'Name' }], matcher: 'toHaveValue', value: { literal: 'ABC' } }],
  }]);
  assert.match(spec, /\.toHaveValue\('ABC'\)/, 'toHaveValue is exact, not regex-loosened');
});

test('render: a dynamic ref on toHaveText is the bare variable, never regex-wrapped', () => {
  const spec = renderSpec([{
    scenario: 'S', step: 'Then the name shows',
    actions: [{ method: 'goto', arg: { literal: '/' } }],
    values: { NAME: { literal: 'x' } },
    assertions: [{ target: [{ kind: 'role', role: 'status' }], matcher: 'toHaveText', value: { ref: 'NAME' } }],
  }]);
  assert.match(spec, /\.toHaveText\(NAME\)/, 'a ref is passed through as the variable');
});
