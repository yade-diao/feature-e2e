/**
 * Counterexamples for undoing a rejected recording.
 *
 * This one has a history. A spec the gates turned away was left on disk, and
 * `status` promptly paired the feature with it and reported it as recorded — the
 * "a file on disk proves nothing" failure the gates exist to prevent, happening
 * inside the tool that runs them.
 *
 * Both halves need a test. Always deleting costs a working spec the moment a
 * re-record is turned away; never deleting is the bug this replaced.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discardRejectedSpec } from '../recorder.mjs';

/** A scratch directory with a spec path in it, and the way to clean it up. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-rec-'));
  return { spec: join(dir, 'x.spec.ts'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('rejected recording: a first-time reject is removed, so status cannot pair with it', () => {
  const s = scratch();
  writeFileSync(s.spec, 'the spec the gates turned away');
  assert.equal(discardRejectedSpec(s.spec, null), 'discarded');
  assert.equal(existsSync(s.spec), false,
    'a spec the gates rejected must not survive to be counted as a recording');
  s.cleanup();
});

test('rejected recording: an earlier working spec is put back, not lost', () => {
  const s = scratch();
  const working = Buffer.from('the spec that replays green');
  writeFileSync(s.spec, 'the reject that overwrote it');
  assert.equal(discardRejectedSpec(s.spec, working), 'restored');
  assert.equal(readFileSync(s.spec, 'utf8'), 'the spec that replays green',
    're-recording a feature must not cost the spec that already worked');
  s.cleanup();
});

test('rejected recording: a run that produced no file leaves nothing to undo', () => {
  const s = scratch();
  assert.equal(discardRejectedSpec(s.spec, null), 'nothing');
  assert.equal(existsSync(s.spec), false);
  s.cleanup();
});
