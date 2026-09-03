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

import { discardRejectedSpec, buildPrompt } from '../recorder.mjs';

/** A scratch directory with a spec path in it, and the way to clean it up. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-rec-'));
  return { spec: join(dir, 'x.spec.ts'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The fields buildPrompt always needs; each test overrides the mode-specific ones. */
const BASE = {
  featurePath: 'features/p/x.feature',
  featureText: 'Feature: F\n  Scenario: S\n    Given a',
  baseURL: 'https://example.com/app/',
};

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

// ── buildPrompt: Mode A vs Mode B ────────────────────────────────────────────

test('buildPrompt Mode A: no reference, no Mode B section, no retrace', () => {
  const p = buildPrompt({ ...BASE });
  assert.ok(!p.includes('Mode B'), 'a from-scratch run carries no Mode B section');
  assert.ok(!p.includes('retrace'), 'and no retrace instruction');
});

test('buildPrompt Mode A with a critique: records from scratch', () => {
  const p = buildPrompt({ ...BASE, critique: 'the spec did not replay' });
  assert.ok(!p.includes('Mode B'), 'still Mode A — nothing on disk to lean on');
  assert.match(p, /Record the scenario again from the start/, 'a rejected Mode A run rebuilds from scratch');
});

test('buildPrompt Mode B, confirmed prefix: resume from the named step', () => {
  const p = buildPrompt({
    ...BASE, resumeFromStep: 4,
    existingSpecPath: 'run/p/x.spec.ts', existingTracePath: 'run/p/x.trace.jsonl',
  });
  assert.ok(p.includes('Mode B'), 'a resume run is a Mode B run');
  assert.match(p, /confirmed prefix is already staged/, 'the confirmed-prefix path is named');
  assert.match(p, /resume from step 4/i, 'and the step to pick up at');
  assert.ok(p.includes('run/p/x.trace.jsonl'), 'the existing trace path reaches the prompt');
  // A confirmed prefix already replayed, so the agent is not told to retrace.
  assert.ok(!p.includes('does not hold, stop'), 'no step-by-step follow when a prefix is confirmed');
});

test('buildPrompt Mode B, no confirmed prefix: follow the artifact and retrace', () => {
  const p = buildPrompt({
    ...BASE,
    existingSpecPath: 'run/p/x.spec.ts', existingTracePath: 'run/p/x.trace.jsonl',
  });
  assert.ok(p.includes('Mode B'), 'an existing spec/trace with no resume is a Mode B run');
  assert.match(p, /follow the existing artifact step by step/i, 'the agent is told to follow, not replay in one shot');
  assert.ok(p.includes('retrace features/p/x.feature'), 'the retrace command names the feature');
  assert.ok(p.includes('run/p/x.spec.ts'), 'the existing spec path reaches the prompt');
  assert.ok(!p.includes('confirmed prefix is already staged'), 'no confirmed-prefix claim without a resume step');
});

test('buildPrompt Mode B: a replay failure is passed as a starting hint', () => {
  const p = buildPrompt({
    ...BASE, existingSpecPath: 'run/p/x.spec.ts',
    replayFailure: 'step "When b": strict mode violation, 7 elements',
  });
  assert.ok(p.includes('Mode B'), 'a red-spec repair is Mode B');
  assert.ok(p.includes('strict mode violation, 7 elements'), 'the replay failure text reaches the prompt');
  assert.match(p, /where to look first/i, 'framed as a hint, not the verdict');
});

// ── writeStallDiagnosis: the watchdog's abandon verdict becomes a valid diagnosis ─

import { writeStallDiagnosis } from '../recorder.mjs';
import { validateDiagnosis } from '../diagnose.mjs';
import { mkdirSync } from 'node:fs';

function inScratchFeature(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-stall-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    mkdirSync('features/p', { recursive: true });
    const feature = 'features/p/x.feature';
    writeFileSync(feature, 'Feature: F\n\n  Scenario: Do the thing\n    Given I open the page\n    When I act\n');
    return fn(feature, dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeStallDiagnosis: an environment abandon writes a schema-valid diagnosis', () => {
  inScratchFeature((feature) => {
    const { json, md, ok } = writeStallDiagnosis(feature, {
      klass: 'environment', summary: 'the login page never loaded (network down)',
      report: [{ problem: 'goto / hung', suggestion: 'check the VPN and re-run' }],
      stepsRecorded: 0, nowIso: '2026-09-03T00:00:00.000Z',
    });
    assert.ok(ok, 'the built diagnosis is schema-valid');
    assert.ok(existsSync(json) && existsSync(md), 'both json and md are written');
    const report = JSON.parse(readFileSync(json, 'utf8'));
    assert.deepEqual(validateDiagnosis(report), { ok: true, errors: [] });
    assert.equal(report.diagnoses[0].verdict.category, 'environment');
    assert.match(report.diagnoses[0].verdict.summary, /environment: the login page/);
    assert.equal(report.diagnoses[0].attempt.steps_completed, 0);
    assert.match(report.diagnoses[0].step, /setup/, 'a setup-phase stall is labelled as such');
  });
});

test('writeStallDiagnosis: a feature/data class maps onto the schema\'s unverifiable category (with the real class in the summary)', () => {
  inScratchFeature((feature) => {
    const { json, ok } = writeStallDiagnosis(feature, {
      klass: 'feature', summary: 'the feature asks for a button the page does not have',
      report: [], stepsRecorded: 12, nowIso: '2026-09-03T00:00:00.000Z',
    });
    assert.ok(ok);
    const report = JSON.parse(readFileSync(json, 'utf8'));
    assert.equal(report.diagnoses[0].verdict.category, 'unverifiable', 'feature has no exact schema category');
    assert.match(report.diagnoses[0].verdict.summary, /feature:/, 'the real class is preserved in the summary');
    assert.equal(report.diagnoses[0].attempt.steps_completed, 12);
    assert.match(report.diagnoses[0].step, /after step 12/, 'a mid-run stall names the step count');
  });
});

// ── buildPrompt: a resume run tells the agent to fall back if the seed prefix breaks ─

test('buildPrompt: a resume run instructs the agent to take over if the seed prefix errors', () => {
  const p = buildPrompt({
    featurePath: 'features/p/x.feature', featureText: 'Feature: F\n', baseURL: null,
    resumeFromStep: 30, resumeSeed: 'run/p/.resume-seed.spec.ts',
  });
  assert.match(p, /resume from step 30/i, 'names the resume step');
  assert.match(p, /retrace/, 'points at the takeover command');
  assert.match(p, /ERRORS|not at step .* starting state|no longer holds/i, 'covers the seed-breaks-fall-back path');
});
