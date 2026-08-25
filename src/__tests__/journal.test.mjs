import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summary } from '../journal.mjs';

/**
 * Counterexamples for what the journal can see.
 *
 * An attempt that produced no spec was never judged by a gate. It used to be
 * left out of the journal entirely, so a feature that ended in a diagnosis every
 * time looked — to the thing whose whole job is measuring this tool — like a
 * feature nobody had tried to record.
 */
test('journal: an attempt that produced no spec still counts as a run', () => {
  const s = summary([
    { run: 'r1', feature: 'a.feature', attempt: 1, ok: false, outcome: 'diagnosis' },
  ]);
  assert.equal(s.runs, 1, 'it happened and cost a browser session');
  assert.equal(s.firstTry, 0);
  assert.deepEqual(s.rejections, [], 'no gate judged it, so no gate may be blamed');
  assert.deepEqual(s.outcomes, [['diagnosis', 1]],
    'a rate with nothing accounting for it reads as gates rejecting silently');
});

test('journal: a gate rejection is not an outcome, and vice versa', () => {
  const s = summary([
    { run: 'r1', feature: 'a.feature', attempt: 1, ok: false, gates: ['liveness'] },
    { run: 'r1', feature: 'a.feature', attempt: 2, ok: true, gates: [] },
    { run: 'r2', feature: 'b.feature', attempt: 1, ok: false, outcome: 'no artifact' },
  ]);
  assert.equal(s.runs, 2);
  assert.equal(s.attempts, 3);
  assert.deepEqual(s.rejections, [['liveness', 1]]);
  assert.deepEqual(s.outcomes, [['no artifact', 1]]);
});
