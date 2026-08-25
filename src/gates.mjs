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
 * Order matters — cheapest first, and every failing gate is collected and
 * reported together in one critique. Returning on the first fault made one fix
 * per retry, so a spec with three faults burned three rounds; naming all of
 * them at once lets a single retry fix all of them.
 */

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { checkStepCoverage, checkStepSubstance, checkBannedPatterns, checkLiveness, checkLocatorRedundancy } from './checks.mjs';
import { playwright } from './playwright.mjs';
import { testSteps } from './spec-ast.mjs';

/**
 * Step title -> the line the *first* step with that title opens on.
 *
 * Duplicate titles are ordinary rather than exceptional: two scenarios opening
 * with the same Given is plain Gherkin, and a Background step is prepended to
 * every scenario, so a feature with a Background guarantees them. `new Map(...)`
 * over the pairs keeps the last of each, which is the wrong end — a fault
 * reported by title then resolved to a later copy, and the cut computed from it
 * left the offending step itself sitting inside the prefix. That is precisely
 * what the cutoff exists to exclude, arriving through the other door.
 */
function firstLineByTitle(specPath) {
  const byTitle = new Map();
  for (const step of testSteps(specPath)) {
    if (!byTitle.has(step.title)) byTitle.set(step.title, step.line);
  }
  return byTitle;
}

/**
 * The first line any gate objected to, so a retry can replay the untouched
 * prefix instead of re-driving the whole feature through the agent again.
 *
 * `liveness` reports step titles, not lines — the same shape `checkLiveness`
 * already returns — so it is resolved back to a line through the spec's own
 * `test.step` titles, the same title text `checkStepCoverage` matches on.
 */
function earliestLine(specPath, { coverage, banned, liveness, redundancy }) {
  // A spec that skipped a feature step has no prefix worth keeping. The gap is
  // not a bad line, so a line-based answer cannot see it: cutting anyway leaves
  // the missing step inside the seed, and the retry is told to pick up after
  // the cut — so the same coverage rejection comes back every attempt until
  // they run out. "No prefix" is the honest answer to a hole.
  if (!coverage.ok) return null;

  const lines = [
    ...banned.hits.map(h => h.line),
    ...redundancy.naked.map(n => n.line),
  ];
  if (liveness.naked.length) {
    const byTitle = firstLineByTitle(specPath);
    for (const title of liveness.naked) {
      const line = byTitle.get(title);
      if (line !== undefined) lines.push(line);
    }
  }
  return lines.length ? Math.min(...lines) : null;
}

const STEP_REPORT = '.step-report.json';

/**
 * Every rejection reports what already passed alongside what failed.
 *
 * Without it the loop regresses: told only that `.nth()` was wrong, an attempt
 * fixed the locators and dropped the test.step wrappers it had got right the
 * round before. A critique that names only the fault reads as if nothing else
 * mattered.
 */
function reject(passed, body, failed = []) {
  const kept = passed.length
    ? `Already correct — keep these as they are:\n${passed.map(p => `  - ${p}`).join('\n')}\n\n`
    : '';
  return { ok: false, passed, failed, critique: kept + body };
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
  const failed = [];
  const failures = [];

  const coverage = checkStepCoverage(featurePath, specPath);
  if (coverage.ok) {
    passed.push(`step coverage ${coverage.found}/${coverage.wanted}`);
  } else if (coverage.empty) {
    failed.push('step coverage');
    failures.push(`${featurePath} states no steps, so there is nothing for a recording to verify.`
      + ` A coverage check would clear it at 0/0 and let a spec that proves nothing through.`
      + ` Write the scenario's steps, or delete the feature.`);
  } else {
    failed.push('step coverage');
    failures.push(`${coverage.missing.length} feature step(s) have no matching test.step:\n`
      + coverage.missing.map(m => `  - ${m}`).join('\n')
      + `\n\nEvery step of the scenario must appear as \`await test.step('<step text verbatim>', ...)\`.`
      + ` The title has to match the feature text exactly.`);
  }

  const banned = await checkBannedPatterns(specPath);
  if (banned.ok) {
    passed.push('no banned patterns');
  } else {
    failed.push('banned patterns');
    failures.push(`${banned.hits.length} banned pattern(s):\n`
      + banned.hits.map(h => `  line ${h.line}: ${h.what}\n    ${h.text.slice(0, 100)}\n    ${h.why}`).join('\n')
      + `\n\n\`.first()\`/\`.nth()\`/\`.last()\` pin to DOM order, which drifts when rows reorder or filter.`
      + ` Remove that line — a count assertion (\`toHaveCount(n)\` or \`toBeGreaterThanOrEqual(n)\`) already proves the list is alive.`
      + ` If you must point at one specific row, use \`getByRole\`/\`getByTestId\` with a name, never a positional index.`);
  }

  const liveness = checkLiveness(featurePath, specPath);
  if (liveness.ok) {
    passed.push('absence assertions have liveness evidence');
  } else {
    failed.push('liveness');
    failures.push(`${liveness.naked.length} step(s) assert only absence or an upper bound:\n`
      + liveness.naked.map(n => `  - ${n}`).join('\n')
      + `\n\nZero satisfies "at most N", and "nothing matches" is satisfied by nothing being there at all,`
      + ` so these pass on a blank page or a failed render. Pair each with evidence the page is alive —`
      + ` an assertion in the same step that something which should be there is there.`
      + ` Use a count or text assertion (e.g. \`await expect(rows).toHaveCount(n)\`),`
      + ` not \`.first()\`/\`.nth()\`, which the banned-pattern gate rejects.`);
  }

  const redundancy = checkLocatorRedundancy(specPath);
  if (redundancy.ok) {
    passed.push('every action has a stable locator or a fallback');
  } else {
    failed.push('locator redundancy');
    failures.push(`${redundancy.naked.length} action(s) are located in only one way, and that one way will drift:\n`
      + redundancy.naked.map(n => `  line ${n.line}: ${n.method}() on "${n.chain}"`).join('\n')
      + `\n\nAn action that stops matching fails the whole test — every assertion after it never runs.`
      + ` Give each action a fallback with .or() (getByTestId('x').or(getByRole('button', { name: '...' }))),`
      + ` or locate it purely by role / label / placeholder so it does not depend on ids or wording.`);
  }

  if (failures.length) {
    return { ...reject(passed, failures.join('\n\n'), failed),
      earliestLine: earliestLine(specPath, { coverage, banned, liveness, redundancy }) };
  }

  return { ok: true, passed, failed: [], critique: null, earliestLine: null };
}

/**
 * Which spec files a run left red.
 *
 * `status` is Playwright's own verdict string. Only failed and timedOut count
 * as red — skipped, interrupted and expected-to-fail do not, because a spec in
 * any of those states has no broken locator to heal.
 */
export function redSpecsFrom(tests) {
  return [...new Set(
    tests.filter(t => t.status === 'failed' || t.status === 'timedOut').map(t => t.file).filter(Boolean),
  )];
}

/**
 * The reason a replay went red, most specific first.
 *
 * The custom reporter replaces Playwright's console output, so the failure
 * detail survives only in the step/test records it wrote — never on
 * stdout/stderr. A critique that says only "it does not replay" gives the
 * producer nothing to fix, so the step and test errors are named here.
 */
function describeFailures(tests, steps) {
  const lines = [];
  for (const s of steps) {
    if (!s.ok && s.error) lines.push(`step "${s.title}": ${s.error.split('\n')[0]}`);
  }
  for (const t of tests) {
    if ((t.status === 'failed' || t.status === 'timedOut') && t.error) {
      lines.push(`${t.file ?? '?'} (${t.status}): ${t.error.split('\n')[0]}`);
    }
  }
  return lines.join('\n');
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

  let recorded = { steps: [], tests: [] };
  try { recorded = JSON.parse(readFileSync(STEP_REPORT, 'utf8')); } catch { /* handled below */ }
  if (existsSync(STEP_REPORT)) unlinkSync(STEP_REPORT);
  // The reporter writes `{ steps, tests }`. `steps` feeds the substance gate;
  // `tests` names which spec files went red, so healing can touch only those.
  const steps = Array.isArray(recorded) ? recorded : (recorded.steps ?? []);
  const tests = Array.isArray(recorded) ? [] : (recorded.tests ?? []);

  if (run.status !== 0) {
    // The custom reporter swallows Playwright's own output, so the reason lives
    // in the step/test records above — stdout/stderr is only the fallback.
    const detail = describeFailures(tests, steps) || `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    const redSpecs = redSpecsFrom(tests);
    // Same reasoning as the static gates' earliestLine: a step that failed to
    // replay names itself in `steps[].title`, the same title text a test.step
    // is written with, so a retry can still replay the untouched prefix
    // instead of re-driving steps that never had anything wrong with them.
    const failedTitles = new Set(steps.filter(s => !s.ok && s.error).map(s => s.title));
    let earliestLine = null;
    if (failedTitles.size && specPaths.length === 1) {
      const byTitle = firstLineByTitle(specPaths[0]);
      const lines = [...failedTitles].map(t => byTitle.get(t)).filter(l => l !== undefined);
      if (lines.length) earliestLine = Math.min(...lines);
    }
    return { ...reject(passed, `the recorded spec does not replay:\n\n${detail.slice(0, 2500)}`
      + `\n\nThis is the run failing against the live page, so the problem is in the recording itself`
      + ` — a locator that was never really there, a wait that was never really needed, or a step`
      + ` performed in the wrong order.`, ['replay']), redSpecs, earliestLine };
  }
  passed.push('replays green');

  // Playwright exiting 0 is too weak on its own: a skipped test, a test with no
  // assertions and an empty test.step all exit 0. Seeing zero steps means the
  // reporter never ran, which is a tool failure, not a passing suite.
  if (!steps.length) {
    return { ok: false, passed, failed: [], critique: null,
      inconclusive: 'the step reporter produced nothing — Playwright exited 0 but no test.step was observed' };
  }
  const substance = checkStepSubstance(steps);
  if (!substance.ok) {
    return reject(passed, `${substance.empty.length} test.step ran but performed no action, assertion or attachment:\n`
      + substance.empty.map(e => `  - ${e.title}`).join('\n')
      + `\n\nAn empty step reads as coverage while proving nothing. If the step only asks for something`
      + ` to be looked at, attach the evidence inside it with testInfo.attach and a screenshot.`, ['step substance']);
  }
  passed.push(`${substance.total} steps, none empty`);

  return { ok: true, passed, failed: [], critique: null, stepCount: substance.total };
}

/** All five gates, cheapest first — what a recording has to clear. */
export async function runGates(featurePath, specPath) {
  const stat = await staticGates(featurePath, specPath);
  if (!stat.ok) return stat;

  const rep = replayGate([specPath]);
  return { ...rep, passed: [...stat.passed, ...rep.passed] };
}
