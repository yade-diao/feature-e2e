/**
 * Counterexamples for how a rejection is labelled.
 *
 * The label used to be inferred: "the gate that stopped it is the one after the
 * last that passed". That is only true if the gates that passed form a prefix of
 * the list, and they do not — staticGates runs all four and reports them
 * together, precisely so one retry can fix every fault at once. A rejection by
 * step coverage and banned patterns, with liveness and redundancy passing, was
 * therefore filed under "liveness": a gate that had passed.
 *
 * It matters because the journal's whole purpose is to say whether a rule is
 * doing real work or has never fired once. A miscounted histogram answers that
 * question wrongly, and looks exactly like a correct one.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { staticGates } from '../gates.mjs';

function fixture(featureBody, specBody) {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-gates-'));
  const feature = join(dir, 'x.feature');
  const spec = join(dir, 'x.spec.ts');
  writeFileSync(feature, featureBody);
  writeFileSync(spec, specBody);
  return { feature, spec, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FEATURE = (steps) => `Feature: F\n  Scenario: S\n${steps.map(s => `    ${s}`).join('\n')}\n`;
const SPEC = (body) => `import { test, expect } from '@playwright/test';\n`
  + `test.describe('F', () => {\n  test('S', async ({ page }) => {\n${body}\n  });\n});\n`;

test('rejection: names the gates that said no, never one that passed', async () => {
  // Fails step coverage (one step of two is wrapped) and banned patterns
  // (.first()), while liveness and locator redundancy both pass — the exact
  // shape the old inference mislabelled.
  const f = fixture(
    FEATURE(['Given a page', 'Then something is shown']),
    SPEC(`    await test.step('Given a page', async () => { await expect(page.getByRole('row').first()).toBeVisible(); });`));

  const v = await staticGates(f.feature, f.spec);

  assert.equal(v.ok, false);
  assert.deepEqual(v.failed, ['step coverage', 'banned patterns']);
  assert.equal(v.failed.includes('liveness'), false,
    'liveness passed here — the old label read it off the count of passing gates and named it anyway');
  assert.equal(v.passed.length, 2,
    'two gates passed, which is what used to be turned into an index into the gate order');
  f.cleanup();
});

test('rejection: a spec that clears every static gate names nothing', async () => {
  const f = fixture(
    FEATURE(['Given a page', 'Then the rows are shown']),
    SPEC(`    await test.step('Given a page', async () => { await page.goto('/'); });
    await test.step('Then the rows are shown', async () => { await expect(page.getByRole('row')).toHaveCount(3); });`));

  const v = await staticGates(f.feature, f.spec);

  assert.equal(v.ok, true, v.critique ?? '');
  assert.deepEqual(v.failed, [], 'nothing rejected it, so nothing may be named');
  f.cleanup();
});

/**
 * Counterexamples for the cut a rejection hands the next attempt.
 *
 * `earliestLine` is what lets a retry replay the prefix that was fine instead of
 * re-driving the whole feature. Both of these are ways it named a line that was
 * not safe to keep — and a cut that keeps the fault is worse than no cut, because
 * every remaining attempt inherits it.
 */

/** The 1-based line a fragment first appears on. */
const lineOf = (source, fragment) => source.slice(0, source.indexOf(fragment)).split('\n').length;

test('cut: a spec that skipped a step offers no prefix at all', async () => {
  // Coverage fails (one step of two is wrapped) and banned patterns fails on a
  // line, so a cut was perfectly computable — and computing it would have frozen
  // the missing step into the seed, where the retry is told not to touch it.
  const f = fixture(
    FEATURE(['Given a page', 'Then something is shown']),
    SPEC(`    await test.step('Given a page', async () => { await expect(page.getByRole('row').first()).toBeVisible(); });`));

  const v = await staticGates(f.feature, f.spec);

  assert.equal(v.ok, false);
  assert.deepEqual(v.failed, ['step coverage', 'banned patterns']);
  assert.equal(v.earliestLine, null,
    'a missing step is a hole in the prefix, not a bad line in it — there is no '
    + 'safe cut to offer, however many other gates reported one');
  f.cleanup();
});

test('cut: a repeated step title resolves to its first occurrence', async () => {
  // A Background step is prepended to every scenario, so a feature with one
  // guarantees repeated step text. Liveness reports the step by title, and the
  // title has to resolve back to the copy that offends first — resolving to the
  // last left the offending step sitting inside the prefix, which is exactly
  // what the cut exists to exclude.
  const feature = 'Feature: F\n'
    + '  Background:\n'
    + '    Given no error banner is shown\n'
    + '  Scenario: One\n'
    + '    Then the first list is shown\n'
    + '  Scenario: Two\n'
    + '    Then the second list is shown\n';

  const naked = (title, body) =>
    `    await test.step('${title}', async () => {\n      ${body}\n    });\n`;

  const spec = `import { test, expect } from '@playwright/test';\n`
    + `test.describe('F', () => {\n`
    + `  test('One', async ({ page }) => {\n`
    + naked('Given no error banner is shown', `await expect(page.getByRole('alert')).toHaveCount(0);`)
    + naked('Then the first list is shown', `await expect(page.getByRole('row')).toHaveCount(3);`)
    + `  });\n`
    + `  test('Two', async ({ page }) => {\n`
    + naked('Given no error banner is shown', `await expect(page.getByRole('alert')).toHaveCount(0);`)
    + naked('Then the second list is shown', `await expect(page.getByRole('list')).toHaveCount(2);`)
    + `  });\n});\n`;

  const f = fixture(feature, spec);
  const v = await staticGates(f.feature, f.spec);

  assert.equal(v.ok, false);
  assert.deepEqual(v.failed, ['liveness'], 'only the absence-only Background step is at fault');

  const first = lineOf(spec, `await test.step('Given no error banner is shown'`);
  const last = spec.split('\n').findLastIndex(l => l.includes(`test.step('Given no error banner is shown'`)) + 1;
  assert.notEqual(first, last, 'the fixture has to actually repeat the title');
  assert.equal(v.earliestLine, first,
    `the cut must name the first copy (line ${first}), not the last (line ${last})`);
  f.cleanup();
});
