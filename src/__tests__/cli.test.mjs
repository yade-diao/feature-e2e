/**
 * Counterexamples for the exit codes, run through the CLI itself.
 *
 * `check` and `replay` used to exit 1 whenever there was nothing to run, which
 * reads as "these specs break the rules" when what happened is that there are no
 * specs. A checkout that carries the tool without a suite could then never go
 * green, and CI stopped at a step that had found nothing wrong.
 *
 * For `replay` it cost more than a red step. CI runs it with continue-on-error,
 * so its exit code is not a verdict but the signal to wake the healer — and an
 * empty suite sent every run down that path to heal nothing.
 *
 * Not checking anything is still not the same as everything being fine, so the
 * other half is here too: an unrecorded feature must still fail — under
 * `status`, the command that owns that question, which is why CI runs it first.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const FEATURE = 'Feature: F\n  Scenario: S\n    Given a page\n';

/** A scratch checkout, optionally with one unrecorded feature in it. */
function checkout({ withFeature = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-cli-'));
  if (withFeature) {
    mkdirSync(join(dir, 'tests', 'features', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'features', 'demo', 'x.feature'), FEATURE);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

test('check: a checkout carrying the tool and no suite is not a failure', () => {
  const c = checkout();
  const r = run(['check'], c.dir);
  assert.equal(r.status, 0, `nothing to check is not a rule violation\n${r.stdout}${r.stderr}`);
  c.cleanup();
});

test('check: an unrecorded feature is status to fail on, not check', () => {
  const c = checkout({ withFeature: true });

  const chk = run(['check'], c.dir);
  assert.equal(chk.status, 0, `${chk.stdout}${chk.stderr}`);
  assert.match(chk.stdout, /1 feature\(s\) are waiting to be recorded/,
    'it still has to say what is missing, it just does not fail on it');

  const st = run(['status'], c.dir);
  assert.equal(st.status, 1,
    'an unrecorded feature is absent from CI, and an absent test looks exactly like a passing one');
  c.cleanup();
});

test('check: a named target with nothing behind it stays an error', () => {
  const c = checkout({ withFeature: true });
  const r = run(['check', 'demo'], c.dir);
  assert.equal(r.status, 1, 'asking about something that is not there has no answer');
  c.cleanup();
});

test('replay: an empty suite must not wake the healer', () => {
  const c = checkout();
  const r = run(['replay'], c.dir);
  assert.equal(r.status, 0,
    `CI reads a red replay as "a spec broke, go heal it"\n${r.stdout}${r.stderr}`);
  c.cleanup();
});

test('replay: an unrecorded feature is named, not failed on', () => {
  const c = checkout({ withFeature: true });
  const r = run(['replay'], c.dir);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /1 feature\(s\) are waiting to be recorded/);
  c.cleanup();
});

test('replay: a named target with nothing behind it stays an error', () => {
  const c = checkout({ withFeature: true });
  const r = run(['replay', 'demo'], c.dir);
  assert.equal(r.status, 1, 'asking to replay something that was never recorded has no answer');
  c.cleanup();
});
