/**
 * Counterexamples for every gate.
 *
 * A gate that has never rejected anything is indistinguishable from no gate at
 * all — and one of these had been passing vacuously for days before a
 * counterexample was written for it. So each rule gets both halves: something it
 * must reject, and something it must let through.
 *
 * The "let through" half matters as much as the other. A gate that is wider than
 * what it judges lets bad specs in; a gate that is narrower rejects good ones,
 * and a recorder that cannot satisfy its own rules never finishes.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkStepCoverage, checkBannedPatterns, checkStepSubstance } from '../checks.mjs';

/** Write a feature and a spec to a scratch directory and hand back their paths. */
function fixture(featureBody, specBody) {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-'));
  const feature = join(dir, 'x.feature');
  const spec = join(dir, 'x.spec.ts');
  writeFileSync(feature, featureBody);
  writeFileSync(spec, specBody);
  return { feature, spec, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FEATURE = (steps) => `Feature: F\n  Scenario: S\n${steps.map(s => `    ${s}`).join('\n')}\n`;
const SPEC = (body) => `import { test, expect } from '@playwright/test';\n`
  + `test.describe('F', () => {\n  test('S', async ({ page }) => {\n${body}\n  });\n});\n`;

// ── step coverage ────────────────────────────────────────────────────────────

test('step coverage: rejects a scenario step with no test.step', () => {
  const f = fixture(
    FEATURE(['Given a page', 'Then something is shown']),
    SPEC(`    await test.step('Given a page', async () => { await page.goto('/'); });`));
  const r = checkStepCoverage(f.feature, f.spec);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['Then something is shown']);
  f.cleanup();
});

test('step coverage: accepts every step wrapped verbatim', () => {
  const f = fixture(
    FEATURE(['Given a page', 'Then something is shown']),
    SPEC(`    await test.step('Given a page', async () => { await page.goto('/'); });
    await test.step('Then something is shown', async () => { await expect(page.getByRole('main')).toBeVisible(); });`));
  assert.equal(checkStepCoverage(f.feature, f.spec).ok, true);
  f.cleanup();
});

test('step coverage: title quoting and whitespace do not matter', () => {
  const f = fixture(
    FEATURE(['Then the "教育" channel is shown']),
    SPEC(`    await test.step("Then the \u201c教育\u201d channel   is shown", async () => { await page.goto('/'); });`));
  assert.equal(checkStepCoverage(f.feature, f.spec).ok, true, 'curly quotes and repeated spaces are normalised');
  f.cleanup();
});

// ── banned patterns (delegated to eslint-plugin-playwright) ─────────────────
//
// These assert the wiring and the choice of rules, not the plugin's own
// correctness — that is its test suite's job. What matters here is that the
// shapes we care about are actually covered, and that the ones we deliberately
// allow are not swept up with them.

const BANNED_CASES = [
  ['nth()', `await expect(page.getByRole('row').nth(2)).toBeVisible();`, true],
  ['first()', `await expect(page.getByRole('row').first()).toBeVisible();`, true],
  ['networkidle', `await page.waitForLoadState('networkidle');\n    await expect(page.getByRole('main')).toBeVisible();`, true],
  ['waitForTimeout', `await page.waitForTimeout(500);\n    await expect(page.getByRole('main')).toBeVisible();`, true],
  ['manual assertion', `expect(await page.getByText('hi').isVisible()).toBe(true);`, true],
  ['un-awaited assertion', `expect(page.getByRole('main')).toBeVisible();`, true],
  ['absolute url', `await page.goto('https://example.com/x');\n    await expect(page.getByRole('main')).toBeVisible();`, true],
  ['page.pause', `await page.pause();\n    await expect(page.getByRole('main')).toBeVisible();`, true],
  ['force option', `await page.getByRole('button').click({ force: true });\n    await expect(page.getByRole('main')).toBeVisible();`, true],

  ['expect.poll for a count', `await expect.poll(() => page.getByRole('row').count()).toBeGreaterThanOrEqual(300);`, false],
  ['toHaveCount', `await expect(page.getByRole('row')).toHaveCount(3);`, false],
  ['filter with hasNotText', `await expect(page.getByRole('row').filter({ hasNotText: 'x' })).toHaveCount(0);`, false],
  ['custom element tag locator', `await page.locator('bili-comment-thread-renderer').click();\n    await expect(page.getByRole('main')).toBeVisible();`, false],
  ['relative url', `await page.goto('/x');\n    await expect(page.getByRole('main')).toBeVisible();`, false],
];

for (const [name, line, shouldReject] of BANNED_CASES) {
  test(`banned patterns: ${shouldReject ? 'rejects' : 'allows'} ${name}`, async () => {
    const f = fixture(FEATURE(['Given a page']), SPEC(`    ${line}`));
    const r = await checkBannedPatterns(f.spec);
    assert.equal(r.ok, !shouldReject,
      shouldReject ? `should have rejected: ${line}` : `should have allowed: ${line}\n${JSON.stringify(r.hits, null, 1)}`);
    f.cleanup();
  });
}

test('banned patterns: a test with no assertion at all is rejected', async () => {
  const f = fixture(FEATURE(['Given a page']), SPEC(`    await page.goto('/');`));
  const r = await checkBannedPatterns(f.spec);
  assert.equal(r.ok, false, 'a test that asserts nothing passes by definition');
  f.cleanup();
});

test('banned patterns: a linter that cannot run is not a pass', async () => {
  const r = await checkBannedPatterns('/nonexistent/nowhere.spec.ts');
  assert.equal(r.ok, false, 'no result must never read as a clean result');
});

// ── step substance ───────────────────────────────────────────────────────────

test('step substance: rejects a step that did nothing at runtime', () => {
  const r = checkStepSubstance([
    { title: 'Given a page', children: ['pw:api'] },
    { title: 'Then something', children: [] },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.empty.length, 1);
});

test('step substance: an attachment counts as doing something', () => {
  const r = checkStepSubstance([{ title: 'Then it looks right', children: ['pw:api', 'test.attach'] }]);
  assert.equal(r.ok, true);
});

test('step coverage: escape sequences in the title are decoded before matching', () => {
  const f = fixture(
    FEATURE(['Then the "教育" channel is shown']),
    SPEC(`    await test.step("Then the \\u201c教育\\u201d channel is shown", async () => { await page.goto('/'); });`));
  assert.equal(checkStepCoverage(f.feature, f.spec).ok, true,
    'a title written with \\uXXXX escapes must still match the feature step');
  f.cleanup();
});

// ── target splitting ─────────────────────────────────────────────────────────

test('target: splits an entry-page URL into origin and path', async () => {
  const { target } = await import('../target.mjs');
  const t = target('http://127.0.0.1:8123/some/page.html?q=1');
  assert.equal(t.origin, 'http://127.0.0.1:8123');
  assert.equal(t.path, '/some/page.html?q=1');
});

test('target: a bare origin yields the root path', async () => {
  const { target } = await import('../target.mjs');
  assert.equal(target('https://example.com').path, '/');
});


// ── liveness ─────────────────────────────────────────────────────────────────

test('liveness: rejects a step that only asserts an upper bound', async () => {
  const { checkLiveness } = await import('../checks.mjs');
  const f = fixture(
    FEATURE(['Then at most 10 rows remain']),
    SPEC(`    await test.step('Then at most 10 rows remain', async () => {
      await expect.poll(() => rows.count()).toBeLessThanOrEqual(10);
    });`));
  const r = checkLiveness(f.feature, f.spec);
  assert.equal(r.ok, false, 'zero rows satisfies "at most 10" — a blank page passes');
  f.cleanup();
});

test('liveness: rejects a step that only asserts absence', async () => {
  const { checkLiveness } = await import('../checks.mjs');
  const f = fixture(
    FEATURE(['Then no error is shown']),
    SPEC(`    await test.step('Then no error is shown', async () => {
      await expect(page.getByRole('alert')).toBeHidden();
    });`));
  assert.equal(checkLiveness(f.feature, f.spec).ok, false);
  f.cleanup();
});

test('liveness: accepts absence paired with evidence the page is alive', async () => {
  const { checkLiveness } = await import('../checks.mjs');
  const f = fixture(
    FEATURE(['Then no error is shown']),
    SPEC(`    await test.step('Then no error is shown', async () => {
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('alert')).toBeHidden();
    });`));
  assert.equal(checkLiveness(f.feature, f.spec).ok, true);
  f.cleanup();
});

test('liveness: a step with no absence assertion is not checked', async () => {
  const { checkLiveness } = await import('../checks.mjs');
  const f = fixture(
    FEATURE(['Then the list is shown']),
    SPEC(`    await test.step('Then the list is shown', async () => {
      await expect(page.getByRole('list')).toBeVisible();
    });`));
  assert.equal(checkLiveness(f.feature, f.spec).ok, true);
  f.cleanup();
});

