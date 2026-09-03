/**
 * The judge log: the Judger's cross-round memory for one feature.
 *
 * The Writer may re-record a step the Judger refused, and — like the mte
 * step-writer's `stillFixtureRebuttal` — may push back, insisting the effect DID
 * happen and the Judger misread the page (`stillHolds`). Without a memory the two
 * could thrash: the Judger re-refuses on the same ground the Writer already
 * rebutted, round after round. So every verdict on a step is appended here as one
 * JSONL line, and the Judger reads the prior lines for that step before judging
 * again — it sees its own earlier reasoning and the Writer's rebuttal, and either
 * holds its ground on fresh evidence or concedes.
 *
 * One log per feature, beside its diagnosis (reports/<project>/…), so a run's
 * arbitration history is inspectable after the fact.
 *
 * ## The entry schema (one shape, one writer per event)
 *
 * A line is one of two KINDS, discriminated by `kind`:
 *
 *   kind:'verdict'  — one Judger ruling on a step. Carries:
 *     { kind:'verdict', scenario, step, round, outcome, report?, rebuttal?,
 *       attribution?:{ class, agrees }, stillHolds? }
 *     `outcome` ∈ 'accept' | 'reject' | 'attribution':
 *       - accept      — the step held (incl. a terminal action confirmed on the
 *                       new page). Not a rejection; the Writer moves on.
 *       - reject      — a real failure; the step was rolled back and the Writer
 *                       must re-record. THIS is what counts toward the scout/duel.
 *       - attribution — a non-step cause (feature/env/…); handed to a human.
 *
 *   kind:'scout'    — one scout investigation of a stuck step. Carries:
 *     { kind:'scout', scenario, step, round, resolved?, unresolvable?,
 *       inconclusive?, scoutFinding? }
 *     Memory, NOT a rejection. Every scout writes one line — resolved,
 *     unresolvable, AND inconclusive — so `scoutCount` bounds re-scouting even when
 *     a scout could not complete (the bug where an inconclusive scout wrote nothing
 *     and re-scouted forever).
 *
 * ONE event writes ONE line. The old design wrote a holds:false verdict twice
 * (once by the Judger's `done`, once by the proxy's reject path), which doubled the
 * round count and tripped the duel limit at half the intended rounds. The single
 * `kind:'verdict'` line is the fix: the proxy is the one writer of a verdict line.
 *
 * `ts` is omitted (Date.now() is unavailable in some sandboxes and the order in the
 * file is the order that matters); `round` is the 1-based judge attempt on this step.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, basename } from 'path';
import { projectOf } from './paths.mjs';

/** Where a feature's judge log lives. */
export function judgeLogPath(featurePath) {
  const project = projectOf(featurePath) ?? '(root)';
  const base = basename(featurePath).replace(/\.feature$/, '');
  return join('reports', project, `${base}.judge-log.jsonl`);
}

/** A stable key for one step within a feature (scenario disambiguates a step reused across scenarios). */
export function stepKey(scenario, step) {
  return `${scenario} ${step}`;
}

/** Append one entry line (a verdict or a scout). */
export function appendJudgeLog(featurePath, entry) {
  const path = judgeLogPath(featurePath);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n');
  return path;
}

/** Read all entry lines for a feature (empty if none yet). */
export function readJudgeLog(featurePath) {
  const path = judgeLogPath(featurePath);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** The prior entries for one step, in order — the Judger's memory for a re-judge. */
export function priorVerdicts(featurePath, scenario, step) {
  const key = stepKey(scenario, step);
  return readJudgeLog(featurePath).filter(e => stepKey(e.scenario, e.step) === key);
}

/**
 * How many times this step has been JUDGED — the duel round counter. Counts only
 * `kind:'verdict'` lines (a scout line is memory, not a judging round). One verdict
 * event is one line, so a holds/reject no longer double-counts as it did when a
 * refusal was written on two separate paths.
 */
export function judgeRound(featurePath, scenario, step) {
  const key = stepKey(scenario, step);
  return readJudgeLog(featurePath).filter(e =>
    stepKey(e.scenario, e.step) === key && e.kind === 'verdict'
  ).length;
}

/**
 * How many times this step has been REJECTED — the counter that decides when the
 * Writer is stuck. A rejection is a `kind:'verdict'` line whose `outcome` is
 * 'reject' (a real failure the Writer must re-record). An 'accept' (incl. a
 * confirmed terminal action) is not a rejection; an 'attribution' ends the step
 * (human), so it is not counted toward re-record pressure either.
 */
export function rejectionCount(featurePath, scenario, step) {
  const key = stepKey(scenario, step);
  return readJudgeLog(featurePath).filter(e =>
    stepKey(e.scenario, e.step) === key && e.kind === 'verdict' && e.outcome === 'reject'
  ).length;
}

/**
 * How many times the scout has already investigated this step — the scout lines in
 * the log. Bounds scout escalation: a step scouted N times and still failing is not
 * going to be solved by an (N+1)th scout. Every scout writes a line — resolved,
 * unresolvable, and inconclusive alike — so this bound holds even when a scout could
 * not complete (an inconclusive scout that wrote nothing used to re-scout forever).
 */
export function scoutCount(featurePath, scenario, step) {
  const key = stepKey(scenario, step);
  return readJudgeLog(featurePath).filter(e =>
    stepKey(e.scenario, e.step) === key && e.kind === 'scout'
  ).length;
}

/**
 * Compress one prior entry into a one-line digest for the "near-detailed,
 * far-summarized" memory the Judger prompt shows: the newest round is rendered in
 * full elsewhere; every OLDER round is shown through this, so the prompt does not
 * carry every round's full report. A digest keeps exactly what stops a repeat:
 *   - the attribution class (what kind of problem it was judged to be),
 *   - the core judgement (why it did / didn't hold — the rebuttal, or the outcome),
 *   - the core fix that was suggested (the first report suggestion / scoutFinding),
 *   - the result (the outcome, or scout resolved/unresolvable).
 * Mirrors mte's digestRound (class + suggestion + result).
 */
export function digestVerdict(entry) {
  if (!entry) return '';
  if (entry.kind === 'scout') {
    const result = entry.resolved === true ? 'scout: resolved'
      : entry.unresolvable ? `scout: unresolvable (${entry.unresolvable.category})`
      : entry.inconclusive ? 'scout: inconclusive'
      : 'scout';
    const fix = entry.scoutFinding ? ` — ${entry.scoutFinding}` : '';
    return `round ${entry.round ?? '?'}: ${result}${fix}`;
  }
  // a verdict line
  const cls = entry.attribution?.class ? ` [${entry.attribution.class}]` : '';
  const core = entry.rebuttal ? ` — ${entry.rebuttal}` : '';
  const fix = firstSuggestion(entry.report);
  return `round ${entry.round ?? '?'}: ${entry.outcome ?? 'verdict'}${cls}${core}${fix ? ` → ${fix}` : ''}`;
}

/** The first report item's suggestion (the "how to fix" the digest carries), if any. */
function firstSuggestion(report) {
  if (!Array.isArray(report)) return '';
  const first = report.find(r => r && r.suggestion);
  return first ? first.suggestion : '';
}
