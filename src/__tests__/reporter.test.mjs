/**
 * Counterexamples for the pieces that turn a red replay into a focused heal.
 *
 * Two pure facts hold the loop together: the reporter records *which spec file*
 * each test belongs to (not just its steps), and `redSpecsFrom` turns that into
 * the list `heal` must touch. Both are deterministic code; if either breaks,
 * healing silently degrades back to re-running every green spec to find the red
 * one, which is exactly the two-hour waste this exists to avoid.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import StepReporter from '../reporter.mjs';
import { redSpecsFrom } from '../gates.mjs';

test('reporter: records each spec file with its verdict alongside the steps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-reporter-'));
  const out = join(dir, 'report.json');
  process.env.STEP_REPORT = out;
  try {
    const r = new StepReporter();
    r.onTestEnd({ location: { file: 'tests/run/people/search.spec.ts' } }, { status: 'failed' });
    r.onStepEnd({ title: 'S' }, {}, {
      category: 'test.step', title: 'Given a page',
      location: { file: 'tests/run/people/search.spec.ts', line: 5 }, error: null, steps: [],
    });
    r.onStepEnd({ title: 'S' }, {}, { category: 'pw:api', title: 'click' });
    r.onEnd();

    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(parsed.tests, [{ file: 'tests/run/people/search.spec.ts', status: 'failed', error: null }]);
    assert.equal(parsed.steps.length, 1, 'only test.step categories are recorded');
    assert.equal(parsed.steps[0].title, 'Given a page');
  } finally {
    delete process.env.STEP_REPORT;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('red specs: only failed and timedOut count, deduplicated and non-null', () => {
  const tests = [
    { file: 'a.spec.ts', status: 'failed' },
    { file: 'b.spec.ts', status: 'timedOut' },
    { file: 'c.spec.ts', status: 'passed' },
    { file: 'd.spec.ts', status: 'skipped' },
    { file: 'e.spec.ts', status: 'interrupted' },
    { file: null, status: 'failed' },
    { file: 'a.spec.ts', status: 'failed' },
  ];
  assert.deepEqual(redSpecsFrom(tests), ['a.spec.ts', 'b.spec.ts']);
});

test('red specs: an empty run leaves nothing to heal', () => {
  assert.deepEqual(redSpecsFrom([]), []);
});
