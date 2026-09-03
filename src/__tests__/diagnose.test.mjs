/**
 * Counterexamples for the diagnosis-report validator.
 *
 * The report's whole purpose is that an agent cannot free-associate a verdict.
 * So the tests centre on the closed enums: a category or evidence type outside
 * the allowed set must be rejected, because the moment the validator accepts a
 * plausible-but-invented category, the report stops meaning anything machine-
 * readable. Both halves matter — the complete report must pass, or the validator
 * is a wall with no door.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateDiagnosis, renderDiagnosis, reportPaths, detectCascade } from '../diagnose.mjs';

const VALID = {
  report_version: '1.0',
  id: 'recruit-search-20260820-a1b2c3',
  created_at: '2026-08-20T10:00:00Z',
  stage: 'verify',
  feature: 'features/recruit/search.feature',
  diagnoses: [{
    scenario: 'Narrow the list with a keyword',
    step: 'Then the list shows at most 10 openings',
    verdict: { category: 'backend', summary: 'the search endpoint returned 0 rows', confidence: 'high' },
    attempt: { steps_completed: 3, last_action: 'searched for 腾讯', obstacle: 'the list stayed empty' },
    evidence: [{ type: 'network', target: 'GET /api/search?q=腾讯', status: 200, finding: '0 rows returned' }],
    suggested_fix: 'check the query filter',
  }],
};

test('diagnosis: accepts a complete, well-formed report', () => {
  assert.equal(validateDiagnosis(VALID).ok, true);
});

test('diagnosis: rejects a verdict category outside the enum', () => {
  const r = structuredClone(VALID);
  r.diagnoses[0].verdict.category = 'banana';
  const v = validateDiagnosis(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('category')), 'must name the offending field');
});

test('diagnosis: rejects an evidence type outside the enum', () => {
  const r = structuredClone(VALID);
  r.diagnoses[0].evidence[0].type = 'hunch';
  assert.equal(validateDiagnosis(r).ok, false);
});

test('diagnosis: rejects a missing attempt', () => {
  const r = structuredClone(VALID);
  delete r.diagnoses[0].attempt;
  assert.equal(validateDiagnosis(r).ok, false, 'an empty effort is worse than a wrong verdict');
});

test('diagnosis: rejects an empty diagnoses array', () => {
  const r = structuredClone(VALID);
  r.diagnoses = [];
  assert.equal(validateDiagnosis(r).ok, false);
});

test('diagnosis: rejects a non-object report', () => {
  assert.equal(validateDiagnosis(null).ok, false);
  assert.equal(validateDiagnosis('x').ok, false);
  assert.equal(validateDiagnosis([]).ok, false);
});

test('diagnosis: reports every violation, not just the first', () => {
  const r = structuredClone(VALID);
  r.diagnoses[0].verdict.category = 'banana';
  r.diagnoses[0].evidence[0].type = 'hunch';
  delete r.diagnoses[0].attempt;
  const v = validateDiagnosis(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 3, 'a report with six problems should not be bounced five times');
});

test('diagnosis: render produces markdown naming the feature and the verdict', () => {
  const md = renderDiagnosis(VALID);
  assert.ok(md.includes('# Diagnosis'));
  assert.ok(md.includes('backend'));
  assert.ok(md.includes('Narrow the list with a keyword'));
});

test('diagnosis: reportPaths maps a feature to a project-scoped path', () => {
  const p = reportPaths('features/recruit/search.feature');
  assert.ok(p.json.endsWith('search.diagnosis.json'));
  assert.ok(p.md.endsWith('search.diagnosis.md'));
  assert.ok(p.json.includes('recruit'));
});

// ── cascade detection (advisory) ──────────────────────────────────────────────

test('cascade: a single diagnosis is never a cascade', () => {
  assert.equal(detectCascade(VALID).likelyCascade, false);
});

test('cascade: downstream timeouts after a substantive first failure are flagged', () => {
  const r = structuredClone(VALID);
  r.diagnoses = [
    {
      scenario: 'S', step: 'When the applicant submits the form',
      verdict: { category: 'backend', summary: 'the create endpoint returned 500', confidence: 'high' },
      attempt: { steps_completed: 2, obstacle: 'the save failed' },
      evidence: [{ type: 'network', target: 'POST /api/create', status: 500, finding: 'server error' }],
    },
    {
      scenario: 'S', step: 'Then the new item is shown',
      verdict: { category: 'frontend', summary: 'the item never appeared', confidence: 'low' },
      attempt: { steps_completed: 2, obstacle: 'timed out waiting for the row' },
      evidence: [{ type: 'dom', finding: 'no such element' }],
    },
    {
      scenario: 'S', step: 'Then the count increases',
      verdict: { category: 'frontend', summary: 'the counter was not found', confidence: 'low' },
      attempt: { steps_completed: 2, obstacle: 'element not found, timeout' },
      evidence: [],
    },
  ];
  const c = detectCascade(r);
  assert.equal(c.likelyCascade, true);
  assert.match(c.note, /submits the form/);   // names the first, substantive step
});

test('cascade: genuinely independent failures are not flagged', () => {
  const r = structuredClone(VALID);
  r.diagnoses = [
    {
      scenario: 'S', step: 'When the applicant submits the form',
      verdict: { category: 'backend', summary: 'the create endpoint returned 500', confidence: 'high' },
      attempt: { steps_completed: 2, obstacle: 'the save failed' },
      evidence: [{ type: 'network', status: 500, finding: 'server error' }],
    },
    {
      scenario: 'S', step: 'Then the price is correct',
      verdict: { category: 'backend', summary: 'the price was off by a cent', confidence: 'high' },
      attempt: { steps_completed: 4, obstacle: 'assertion mismatch on the total' },
      evidence: [{ type: 'assertion', finding: 'expected 9.99 got 9.98' }],
    },
  ];
  // The second failure carries substantive assertion evidence — not a consequence.
  assert.equal(detectCascade(r).likelyCascade, false);
});
