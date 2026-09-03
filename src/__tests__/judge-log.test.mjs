/**
 * The judge log: append / read / round-count / digest, the Judger's cross-round
 * memory.
 *
 * These write under reports/<project>/, so the test uses a throwaway project name
 * and removes that one directory afterwards — it never touches a real feature's log.
 *
 * Run with: node --test src/__tests__/
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { appendJudgeLog, readJudgeLog, priorVerdicts, judgeRound, stepKey, judgeLogPath, rejectionCount, scoutCount, digestVerdict } from '../judge-log.mjs';

const PROJECT = '__judgelog_test__';
const FEATURE = join('features', PROJECT, 'x.feature');

afterEach(() => { try { rmSync(join('reports', PROJECT), { recursive: true, force: true }); } catch { /* nothing to clean */ } });

test('judgeLogPath maps a feature to reports/<project>/<base>.judge-log.jsonl', () => {
  assert.equal(judgeLogPath(FEATURE), join('reports', PROJECT, 'x.judge-log.jsonl'));
});

test('append then read round-trips entries in order', () => {
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'a', round: 1, outcome: 'reject', rebuttal: 'nope' });
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'a', round: 2, outcome: 'accept' });
  const all = readJudgeLog(FEATURE);
  assert.equal(all.length, 2);
  assert.equal(all[0].outcome, 'reject');
  assert.equal(all[1].round, 2);
});

test('priorVerdicts and judgeRound scope to one step (scenario + step)', () => {
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'a', round: 1, outcome: 'reject' });
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'b', round: 1, outcome: 'accept' });   // different step
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'a', round: 2, outcome: 'reject' });
  assert.equal(judgeRound(FEATURE, 'S', 'a'), 2, 'two rounds on step a');
  assert.equal(judgeRound(FEATURE, 'S', 'b'), 1, 'one round on step b');
  const a = priorVerdicts(FEATURE, 'S', 'a');
  assert.deepEqual(a.map(v => v.round), [1, 2]);
});

test('a step reused across scenarios is keyed distinctly', () => {
  assert.notEqual(stepKey('Create', 'When I save'), stepKey('Edit', 'When I save'));
});

test('judgeRound counts only verdict lines, and ONE verdict is ONE line (no double-count)', () => {
  // The old bug: a holds:false was written twice (Judger done + proxy reject), so
  // judgeRound double-counted and tripped the duel limit at half the rounds. Now a
  // verdict event is exactly one kind:'verdict' line.
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'a', round: 1, outcome: 'reject', rebuttal: 'r1' });
  appendJudgeLog(FEATURE, { kind: 'scout', scenario: 'S', step: 'a', round: 2, resolved: true });   // scout is not a round
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'a', round: 2, outcome: 'reject', rebuttal: 'r2' });
  assert.equal(judgeRound(FEATURE, 'S', 'a'), 2, 'two verdict rounds; the scout line does not count');
});

test('rejectionCount counts only outcome:reject verdicts; accept/attribution are not rejections', () => {
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'a', round: 1, outcome: 'reject' });
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'a', round: 2, outcome: 'accept' });        // terminal action held — not a rejection
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'a', round: 3, outcome: 'reject' });
  appendJudgeLog(FEATURE, { kind: 'scout', scenario: 'S', step: 'a', round: 4, resolved: true });             // scout — not a rejection
  assert.equal(rejectionCount(FEATURE, 'S', 'a'), 2, 'only the two reject verdicts count');
});

test('every scout writes a line — resolved, unresolvable, AND inconclusive — so scoutCount bounds re-scouting', () => {
  appendJudgeLog(FEATURE, { kind: 'verdict', scenario: 'S', step: 'a', round: 1, outcome: 'reject' });        // a rejection, not a scout
  appendJudgeLog(FEATURE, { kind: 'scout', scenario: 'S', step: 'a', round: 2, resolved: true, scoutFinding: 'click the checkbox cell' });
  appendJudgeLog(FEATURE, { kind: 'scout', scenario: 'S', step: 'a', round: 3, inconclusive: 'reset failed' });  // the old bug: this used to write NOTHING
  appendJudgeLog(FEATURE, { kind: 'scout', scenario: 'S', step: 'b', round: 1, resolved: false });             // different step
  assert.equal(scoutCount(FEATURE, 'S', 'a'), 2, 'both scouts on step a count — incl. the inconclusive one');
  assert.equal(scoutCount(FEATURE, 'S', 'b'), 1, 'one scout on step b');
  assert.equal(rejectionCount(FEATURE, 'S', 'a'), 1, 'the reject verdict is the only rejection; scouts are not rejections');
  // the resolved scout is still in prior verdicts so a later scout reads what the first found
  const priors = priorVerdicts(FEATURE, 'S', 'a');
  assert.equal(priors.find(p => p.kind === 'scout' && p.resolved)?.scoutFinding, 'click the checkbox cell');
});

test('reading a feature with no log yet is an empty array, not an error', () => {
  assert.deepEqual(readJudgeLog(join('features', PROJECT, 'never-written.feature')), []);
  assert.equal(judgeRound(join('features', PROJECT, 'never-written.feature'), 'S', 'a'), 0);
});

test('digestVerdict compresses a verdict to one line: outcome + class + core judgement + fix', () => {
  const line = digestVerdict({
    kind: 'verdict', round: 2, outcome: 'reject', rebuttal: 'the selected count is 0',
    report: [{ where: 'the list', problem: 'nothing selected', suggestion: 'click the checkbox cell' }],
  });
  assert.match(line, /round 2/);
  assert.match(line, /reject/);
  assert.match(line, /selected count is 0/);
  assert.match(line, /click the checkbox cell/);
});

test('digestVerdict compresses an attribution verdict with its class', () => {
  const line = digestVerdict({ kind: 'verdict', round: 1, outcome: 'attribution', attribution: { class: 'feature', agrees: true } });
  assert.match(line, /attribution/);
  assert.match(line, /feature/);
});

test('digestVerdict compresses a scout line with its result and finding', () => {
  const resolved = digestVerdict({ kind: 'scout', round: 3, resolved: true, scoutFinding: 'double-click the row' });
  assert.match(resolved, /scout: resolved/);
  assert.match(resolved, /double-click the row/);
  const unresolvable = digestVerdict({ kind: 'scout', round: 4, resolved: false, unresolvable: { category: 'environment', summary: 'x' } });
  assert.match(unresolvable, /unresolvable \(environment\)/);
  const inconclusive = digestVerdict({ kind: 'scout', round: 5, inconclusive: 'reset failed' });
  assert.match(inconclusive, /scout: inconclusive/);
});
