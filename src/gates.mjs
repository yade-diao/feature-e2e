/**
 * Acceptance gates, and the critique they produce.
 *
 * This is the Critic half of a producer–critic loop. The producer is the agent;
 * the critic is this file. Keeping the critic as deterministic code rather than
 * a second agent is deliberate: the reason the pattern separates the two roles
 * at all is to remove the bias of something grading its own work, and code has
 * no bias to remove.
 *
 * Every rejection carries a critique that names what is wrong and what to do
 * instead. A gate that only says "no" wastes the most useful thing it knows.
 *
 * Order matters — cheapest first, so a recording that skipped a step is turned
 * away before a browser is spent on it.
 */

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { checkStepCoverage, checkStepSubstance, checkBannedPatterns, checkLiveness } from './checks.mjs';
import { playwright } from './playwright.mjs';

const STEP_REPORT = '.step-report.json';

/**
 * Every rejection reports what already passed alongside what failed.
 *
 * Without it the loop regresses: told only that `.nth()` was wrong, an attempt
 * fixed the locators and dropped the test.step wrappers it had got right the
 * round before. A critique that names only the fault reads as if nothing else
 * mattered.
 */
function reject(passed, body) {
  const kept = passed.length
    ? `Already correct — keep these as they are:\n${passed.map(p => `  - ${p}`).join('\n')}\n\n`
    : '';
  return { ok: false, passed, critique: kept + body };
}

/**
 * Gates 1–3: text only, milliseconds, no browser.
 *
 * Split from the replay gate so they can run on their own — over specs recorded
 * long ago, in CI, or while iterating on the rules themselves. Gates that only
 * run at recording time never revisit what they let through, so a rule added
 * later silently exempts everything already in the repository.
 *
 * @returns {{ ok: boolean, passed: string[], critique: string|null }}
 */
export async function staticGates(featurePath, specPath) {
  const passed = [];

  const coverage = checkStepCoverage(featurePath, specPath);
  if (!coverage.ok) {
    return reject(passed, `${coverage.missing.length} feature step(s) have no matching test.step:\n`
      + coverage.missing.map(m => `  - ${m}`).join('\n')
      + `\n\nEvery step of the scenario must appear as \`await test.step('<step text verbatim>', ...)\`.`
      + ` The title has to match the feature text exactly.`);
  }
  passed.push(`step coverage ${coverage.found}/${coverage.wanted}`);

  const banned = await checkBannedPatterns(specPath);
  if (!banned.ok) {
    return reject(passed, `${banned.hits.length} banned pattern(s):\n`
      + banned.hits.map(h => `  line ${h.line}: ${h.what}\n    ${h.text.slice(0, 100)}\n    ${h.why}`).join('\n'));
  }
  passed.push('no banned patterns');

  const liveness = checkLiveness(featurePath, specPath);
  if (!liveness.ok) {
    return reject(passed, `${liveness.naked.length} step(s) assert only absence or an upper bound:\n`
      + liveness.naked.map(n => `  - ${n}`).join('\n')
      + `\n\nZero satisfies "at most N", and "nothing matches" is satisfied by nothing being there at all,`
      + ` so these pass on a blank page or a failed render. Pair each with evidence the page is alive —`
      + ` an assertion in the same step that something which should be there is there.`);
  }
  passed.push('absence assertions have liveness evidence');

  return { ok: true, passed, critique: null };
}

/**
 * Gates 4–5: replay the spec(s) for real, then check what the run actually did.
 *
 * Gate 5 is free — the step reporter rides along on the run gate 4 needs anyway.
 * Both are here rather than in the caller so that `record`, `replay` and `check`
 * cannot drift into judging a run by different rules.
 *
 * @returns {{ ok, passed, critique, inconclusive?, stepCount? }}
 */
export function replayGate(specPaths) {
  const passed = [];
  if (existsSync(STEP_REPORT)) unlinkSync(STEP_REPORT);

  const paths = specPaths.map(p => p.split('\\').join('/'));
  const run = playwright(['test', ...paths, '--reporter=./src/reporter.mjs'],
    { env: { ...process.env, STEP_REPORT }, stdio: 'pipe', encoding: 'utf8' });

  let recorded = [];
  try { recorded = JSON.parse(readFileSync(STEP_REPORT, 'utf8')); } catch { /* handled below */ }
  if (existsSync(STEP_REPORT)) unlinkSync(STEP_REPORT);

  if (run.status !== 0) {
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    return reject(passed, `the recorded spec does not replay:\n\n${output.slice(-2500)}`
      + `\n\nThis is the run failing against the live page, so the problem is in the recording itself`
      + ` — a locator that was never really there, a wait that was never really needed, or a step`
      + ` performed in the wrong order.`);
  }
  passed.push('replays green');

  // Playwright exiting 0 is too weak on its own: a skipped test, a test with no
  // assertions and an empty test.step all exit 0. Seeing zero steps means the
  // reporter never ran, which is a tool failure, not a passing suite.
  if (!recorded.length) {
    return { ok: false, passed, critique: null,
      inconclusive: 'the step reporter produced nothing — Playwright exited 0 but no test.step was observed' };
  }
  const substance = checkStepSubstance(recorded);
  if (!substance.ok) {
    return reject(passed, `${substance.empty.length} test.step ran but performed no action, assertion or attachment:\n`
      + substance.empty.map(e => `  - ${e.title}`).join('\n')
      + `\n\nAn empty step reads as coverage while proving nothing. If the step only asks for something`
      + ` to be looked at, attach the evidence inside it with testInfo.attach and a screenshot.`);
  }
  passed.push(`${substance.total} steps, none empty`);

  return { ok: true, passed, critique: null, stepCount: substance.total };
}

/** All five gates, cheapest first — what a recording has to clear. */
export async function runGates(featurePath, specPath) {
  const stat = await staticGates(featurePath, specPath);
  if (!stat.ok) return stat;

  const rep = replayGate([specPath]);
  return { ...rep, passed: [...stat.passed, ...rep.passed] };
}
