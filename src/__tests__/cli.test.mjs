/**
 * Counterexamples for the exit codes, run through the CLI itself.
 *
 * `check` and `replay` used to exit 1 whenever there was nothing to run, which
 * reads as "these specs break the rules" when what happened is that there are no
 * specs. A checkout that carries the tool without a suite could then never go
 * green, and CI stopped at a step that had found nothing wrong.
 *
 * For `replay` it cost more than a red step. CI runs it with continue-on-error,
 * so its exit code is not a verdict but the signal to trigger a Mode B repair
 * (`record`) — and an empty suite sent every run down that path to repair nothing.
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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const FEATURE = 'Feature: F\n  Scenario: S\n    Given a page\n';

/** A scratch checkout, optionally with one unrecorded feature in it. */
function checkout({ withFeature = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-cli-'));
  if (withFeature) {
    mkdirSync(join(dir, 'features', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'features', 'demo', 'x.feature'), FEATURE);
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

test('replay: an empty suite must not trigger a repair run', () => {
  const c = checkout();
  const r = run(['replay'], c.dir);
  assert.equal(r.status, 0,
    `CI reads a red replay as "a spec broke, go repair it in Mode B"\n${r.stdout}${r.stderr}`);
  c.cleanup();
});

// ── retrace: the agent's controlled trace truncation for a Mode B takeover ────

/** A checkout with a feature and a three-record trace on disk. */
function checkoutWithTrace() {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-cli-'));
  mkdirSync(join(dir, 'features', 'demo'), { recursive: true });
  writeFileSync(join(dir, 'features', 'demo', 'x.feature'), FEATURE);
  mkdirSync(join(dir, 'run', 'demo'), { recursive: true });
  const records = [
    { scenario: 'S', step: 'Given a', actions: [{ method: 'goto', arg: { literal: '/a' } }], assertions: [] },
    { scenario: 'S', step: 'When b', actions: [{ method: 'click', locators: [{ kind: 'role', role: 'button', name: 'B' }] }], assertions: [] },
    { scenario: 'S', step: 'Then c', actions: [], assertions: [{ target: [{ kind: 'role', role: 'heading', name: 'C' }], matcher: 'toBeVisible' }] },
  ];
  const tracePath = join(dir, 'run', 'demo', 'x.trace.jsonl');
  writeFileSync(tracePath, records.map(r => JSON.stringify(r) + '\n').join(''));
  return { dir, tracePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const traceSteps = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).step);

test('retrace: truncates to K-1 records and backs the full trace up to .bak', () => {
  const c = checkoutWithTrace();
  const r = run(['retrace', 'features/demo/x.feature', '2'], c.dir);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepEqual(traceSteps(c.tracePath), ['Given a'], 'kept K-1 = 1 record before the takeover step');
  assert.deepEqual(traceSteps(`${c.tracePath}.bak`), ['Given a', 'When b', 'Then c'],
    'the .bak holds every record the truncation dropped');
  c.cleanup();
});

test('retrace K=1: empties the trace for a full re-record, .bak keeps everything', () => {
  const c = checkoutWithTrace();
  const r = run(['retrace', 'features/demo/x.feature', '1'], c.dir);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(existsSync(c.tracePath), true);
  assert.deepEqual(traceSteps(c.tracePath), [], 'a takeover at step 1 leaves no prefix');
  assert.deepEqual(traceSteps(`${c.tracePath}.bak`), ['Given a', 'When b', 'Then c']);
  c.cleanup();
});

test('retrace: a missing or non-positive K is refused', () => {
  const c = checkoutWithTrace();
  assert.equal(run(['retrace', 'features/demo/x.feature'], c.dir).status, 2, 'K is required');
  assert.equal(run(['retrace', 'features/demo/x.feature', '0'], c.dir).status, 1, 'K must be >= 1');
  assert.equal(run(['retrace', 'features/demo/x.feature', 'nope'], c.dir).status, 1, 'K must be an integer');
  // A refused retrace must not touch the trace.
  assert.deepEqual(traceSteps(c.tracePath), ['Given a', 'When b', 'Then c']);
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

// ── record derives BASE_URL from the feature when the env var is unset ─────────

/**
 * A checkout whose feature names an entry-page URL, plus a stub `claude` on PATH
 * that exits at once. `record` spawns `claude`; the stub lets the run get past
 * the point where BASE_URL is resolved and logged without driving a browser.
 */
function checkoutWithUrlFeature() {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-cli-'));
  mkdirSync(join(dir, 'features', 'demo'), { recursive: true });
  writeFileSync(join(dir, 'features', 'demo', 'x.feature'),
    'Feature: F\n' +
    '  Scenario: Login\n' +
    '    Given I try to login with user "kyle"\n' +
    '      | Url                          | User |\n' +
    '      | https://env.example.com/app/ | kyle |\n');
  // A stub `claude` that produces nothing, so recordFeature returns "no trace"
  // fast. We only assert on the environment line, which prints before the spawn.
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'claude');
  writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  chmodSync(stub, 0o755);
  return { dir, bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const runWithEnv = (args, cwd, env) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env });

test('record: BASE_URL comes from the feature when the env var is unset', () => {
  const c = checkoutWithUrlFeature();
  const env = { ...process.env, PATH: `${c.bin}:${process.env.PATH}` };
  delete env.BASE_URL;
  const r = runWithEnv(['record', 'features/demo/x.feature'], c.dir, env);
  assert.match(r.stdout, /environment: https:\/\/env\.example\.com \(from the feature\)/,
    'a forgotten BASE_URL must fall back to the URL the feature names, not a placeholder');
  c.cleanup();
});

test('record: an explicit BASE_URL wins over the feature URL', () => {
  const c = checkoutWithUrlFeature();
  const env = { ...process.env, PATH: `${c.bin}:${process.env.PATH}`, BASE_URL: 'https://override.example.com/' };
  const r = runWithEnv(['record', 'features/demo/x.feature'], c.dir, env);
  assert.match(r.stdout, /environment: https:\/\/override\.example\.com\/ \(from BASE_URL\)/,
    'a person overriding the target must beat what the feature names');
  c.cleanup();
});

test('record: one feature URL does not leak into the next feature', () => {
  // Two features recorded in one run: the first names a URL, the second names
  // none. With no BASE_URL override, the second must NOT inherit the first's
  // origin — recording it against the wrong environment is exactly the silent
  // mis-target this fallback was added to prevent.
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-cli-'));
  // 'a' sorts before 'b', so listFeatures records them in that order.
  mkdirSync(join(dir, 'features', 'a'), { recursive: true });
  mkdirSync(join(dir, 'features', 'b'), { recursive: true });
  writeFileSync(join(dir, 'features', 'a', 'x.feature'),
    'Feature: A\n  Scenario: S\n    Given login\n      | Url |\n      | https://first.example.com/ |\n');
  writeFileSync(join(dir, 'features', 'b', 'y.feature'),
    'Feature: B\n  Scenario: S\n    Given a page with no url\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'claude'), 0o755);

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.BASE_URL;
  const r = runWithEnv(['record'], dir, env);
  assert.match(r.stdout, /environment: https:\/\/first\.example\.com \(from the feature\)/,
    'the first feature is recorded against the URL it names');
  const firstOriginMentions = (r.stdout.match(/https:\/\/first\.example\.com/g) ?? []).length;
  assert.equal(firstOriginMentions, 1,
    "the first feature's origin must appear once — the second, which names no URL, must not inherit it");
  rmSync(dir, { recursive: true, force: true });
});
