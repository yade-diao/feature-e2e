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

import { staticGates, coverageGate, isCountMismatch, describeFailures } from '../gates.mjs';

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

// ── coverageGate: the recording path's only static gate ──────────────────────
//
// runGates dropped banned/liveness/redundancy — the renderer makes those shapes
// unreachable on the recording path, so checking for them there rejects the
// agent for a bug it cannot cause and render-spec's own tests already cover.
// coverageGate is what runGates uses instead: coverage, and nothing else. These
// pin that narrowing so it cannot silently regrow.

test('coverageGate: a banned shape no longer blocks the recording path', async () => {
  // A .first() would fail the old staticGates (banned patterns). coverageGate
  // does not look at shape — only that every step is covered — so it passes.
  const f = fixture(
    FEATURE(['Given a page']),
    SPEC(`    await test.step('Given a page', async () => { await expect(page.getByRole('row').first()).toBeVisible(); });`));

  const cov = coverageGate(f.feature, f.spec);
  assert.equal(cov.ok, true, cov.critique ?? '');

  // And the full audit suite still catches it — the shape check lives on for
  // the `check` command, it is just off the recording path.
  const stat = await staticGates(f.feature, f.spec);
  assert.equal(stat.ok, false);
  assert.equal(stat.failed.includes('banned patterns'), true);
  f.cleanup();
});

test('coverageGate: a skipped step is still rejected', async () => {
  // The one thing the renderer cannot catch — a missing record is a missing
  // test.step, faithfully rendered — so coverage stays a hard gate.
  const f = fixture(
    FEATURE(['Given a page', 'Then the rows are shown']),
    SPEC(`    await test.step('Given a page', async () => { await page.goto('/'); });`));

  const cov = coverageGate(f.feature, f.spec);
  assert.equal(cov.ok, false);
  assert.deepEqual(cov.failed, ['step coverage']);
  f.cleanup();
});

// ── uniqueness-check failure recognition and critique sharpening ─────────────

// What Playwright writes when an injected `expect(loc).toHaveCount(1)` finds
// several matches — the numbers live on later lines, not the first.
const COUNT_ERROR = 'Error: expect(locator).toHaveCount(expected)\n\nLocator: getByRole(\'region\')\nExpected: 1\nReceived: 6';
const GENERIC_ERROR = 'locator.click: Element is not an <input>… strict mode was not the issue';

test('describeFailures: keeps the Expected/Received lines for a count mismatch', () => {
  const detail = describeFailures([], [{ title: "When I open the card", ok: false, error: COUNT_ERROR }]);
  assert.match(detail, /When I open the card/, 'names the step');
  assert.match(detail, /Received:\s*6/, 'carries the count so the mismatch is recognisable');
});

test('describeFailures: a non-count failure keeps just its first line', () => {
  const detail = describeFailures([], [{ title: 'When I click Save', ok: false, error: GENERIC_ERROR }]);
  assert.match(detail, /Element is not an <input>/);
  assert.doesNotMatch(detail, /Received:/);
});

test('isCountMismatch: true only when a candidate matched more than one', () => {
  assert.equal(isCountMismatch(describeFailures([], [{ title: 't', ok: false, error: COUNT_ERROR }])), true);
  assert.equal(isCountMismatch(describeFailures([], [{ title: 't', ok: false, error: GENERIC_ERROR }])), false);
  // A missing element (Received: 0) is a different failure, not a uniqueness one.
  assert.equal(isCountMismatch('Expected: 1 Received: 0'), false);
});
