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

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { dirname, basename, join } from 'path';
import { checkStepCoverage, checkBannedPatterns, checkLiveness, checkLocatorRedundancy } from './checks.mjs';
import { playwright } from './playwright.mjs';
import { renderSpec } from './render-spec.mjs';
import { readTrace, featureToTrace } from './trace.mjs';
import { featureToSpec } from './paths.mjs';

const STEP_REPORT = '.step-report.json';

/** The tail of a replay-failure critique — the generic "why it went red" advice. */
const REPLAY_TAIL = '\n\nThis is the run failing against the live page, so the problem is in the recording itself'
  + ' — a locator that was never really there, a wait that was never really needed, or a step'
  + ' performed in the wrong order.';

/**
 * The tail swapped in when the failure is a uniqueness-check count mismatch —
 * a candidate matched more than one element. This is directly actionable, unlike
 * the generic tail, so it points the agent at the count rule it skipped.
 */
const COUNT_TAIL = '\n\nA locator candidate on this step matched more than one element (see the count above:'
  + ' Received > 1). That is the uniqueness rule going unmet — per your Locators rules, count every'
  + ' candidate for this step to exactly one with browser_evaluate, and rewrite the non-unique one with a'
  + ' distinguishing scope (a name, a parent, or the row/card\'s own text via .filter({ hasText })).'
  + ' Then retrace from this step and re-record it.';

/** Does a critique's failure detail look like a toHaveCount(1) mismatch? */
export function isCountMismatch(critique) {
  return /Expected:\s*1\b/.test(critique) && /Received:\s*[2-9]/.test(critique);
}

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
 * The one static gate a recording must clear: every feature step has a matching
 * `test.step`.
 *
 * Coverage catches the agent skipping a step — a missing record renders as a
 * missing test.step, which the renderer cannot detect on its own — so it is a
 * hard gate on the recording path. Locator and assertion shape are the renderer's
 * responsibility (render-spec.mjs builds the spec from a template), so those are
 * not re-checked here.
 *
 * The full static suite lives in `staticGates`, which the `check` command runs
 * to audit specs already on disk (human-edited specs, where shape can vary).
 */
export function coverageGate(featurePath, specPath) {
  const coverage = checkStepCoverage(featurePath, specPath);
  if (coverage.ok) {
    return { ok: true, passed: [`step coverage ${coverage.found}/${coverage.wanted}`], failed: [], critique: null };
  }
  const body = coverage.empty
    ? `${featurePath} states no steps, so there is nothing for a recording to verify.`
      + ` A coverage check would clear it at 0/0 and let a spec that proves nothing through.`
      + ` Write the scenario's steps, or delete the feature.`
    : `${coverage.missing.length} feature step(s) have no matching test.step:\n`
      + coverage.missing.map(m => `  - ${m}`).join('\n')
      + `\n\nEvery step of the scenario must be recorded, so it renders as`
      + ` \`await test.step('<step text verbatim>', ...)\`. The record's step text has`
      + ` to match the feature step exactly, Gherkin keyword and all.`;
  return reject([], body, ['step coverage']);
}

/**
 * The full static suite: text only, milliseconds, no browser — coverage, banned
 * patterns, liveness, locator redundancy, reported together.
 *
 * This is the engine of the `check` command, which audits specs already on disk
 * (human-edited specs, where locator and assertion shape can vary). It runs over
 * a spec wherever it sits, so a rule added later revisits everything in the
 * repository rather than silently exempting what predates it.
 *
 * The recording path uses `coverageGate` + replay instead (see runGates).
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
    return reject(passed, failures.join('\n\n'), failed);
  }

  return { ok: true, passed, failed: [], critique: null };
}

/**
 * Which spec files a run left red.
 *
 * `status` is Playwright's own verdict string. Only failed and timedOut count
 * as red — skipped, interrupted and expected-to-fail do not, because a spec in
 * any of those states has no broken locator to repair.
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
 *
 * The first line is usually the assertion/locator name; for a count mismatch
 * (`toHaveCount`) Playwright puts the numbers on later `Expected:`/`Received:`
 * lines, so those are carried along too — that is what lets a uniqueness failure
 * be recognised and its critique sharpened.
 */
function describeFailures(tests, steps) {
  const lines = [];
  for (const s of steps) {
    if (!s.ok && s.error) {
      const errLines = s.error.split('\n');
      const extra = errLines.filter(l => /^\s*(Expected|Received):/.test(l));
      lines.push(`step "${s.title}": ${[errLines[0], ...extra].join(' ')}`);
    }
  }
  for (const t of tests) {
    if ((t.status === 'failed' || t.status === 'timedOut') && t.error) {
      lines.push(`${t.file ?? '?'} (${t.status}): ${t.error.split('\n')[0]}`);
    }
  }
  return lines.join('\n');
}

export { describeFailures };

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
  // The reporter writes `{ steps, tests }`. `tests` names which spec files went
  // red, so a repair run can touch only those; `steps` carries the per-step
  // titles a resume maps its failure back to.
  const steps = recorded.steps ?? [];
  const tests = recorded.tests ?? [];

  if (run.status !== 0) {
    // The custom reporter swallows Playwright's own output, so the reason lives
    // in the step/test records above — stdout/stderr is only the fallback.
    const detail = describeFailures(tests, steps) || `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    const redSpecs = redSpecsFrom(tests);
    // A step that failed to replay names itself in `steps[].title`, the same
    // title text a trace record carries — so the recorder maps these back to the
    // trace record that failed and resumes from there, keeping the clean prefix
    // (resumeIndexFromFailures / truncateTrace in trace.mjs) instead of
    // re-driving steps that never had anything wrong with them.
    const failedTitles = [...new Set(steps.filter(s => !s.ok && s.error).map(s => s.title))];
    return { ...reject(passed, `the recorded spec does not replay:\n\n${detail.slice(0, 2500)}`
      + REPLAY_TAIL, ['replay']),
      redSpecs, failedTitles };
  }
  passed.push('replays green');

  // Playwright exiting 0 is too weak on its own: a skipped test and a test that
  // did nothing both exit 0. Seeing zero steps means the reporter never ran,
  // which is a tool failure, not a passing suite — kept as an inconclusive.
  if (!steps.length) {
    return { ok: false, passed, failed: [], critique: null,
      inconclusive: 'the step reporter produced nothing — Playwright exited 0 but no test.step was observed' };
  }

  return { ok: true, passed, failed: [], critique: null, stepCount: steps.length };
}

/**
 * The uniqueness-check replay: replay a spec whose every action locator carries
 * a per-candidate `toHaveCount(1)` assertion, so a non-unique candidate reds in
 * the locating layer (naming the candidate and its count) instead of as an opaque
 * strict-mode throw when the action runs.
 *
 * The check spec is rendered fresh from the trace with `checkLocators:true` and
 * written to a dot-hidden sibling of the promoted spec — `listSpecs` excludes dot
 * files, so it is invisible to `status`/`pairing`/`replay` and can never be
 * mistaken for a recording or written into `.red-specs.json`. It is removed in a
 * `finally`, and being dot-hidden a crash-leftover trips nothing.
 *
 * On a count-mismatch failure the generic replay critique tail is swapped for one
 * that points at the uniqueness rule — the piece that makes the failure
 * actionable for the agent.
 */
export function uniquenessReplayGate(featurePath) {
  const promoted = featureToSpec(featurePath);
  const checkSpec = join(dirname(promoted), '.' + basename(promoted).replace(/\.spec\.ts$/, '.check.spec.ts'));
  try {
    writeFileSync(checkSpec, renderSpec(readTrace(featurePath), { checkLocators: true }));
    const verdict = replayGate([checkSpec]);
    // The check spec is a throwaway; a run must never surface its path. Replace
    // the file it names in redSpecs with the promoted spec, and sharpen the
    // critique when the failure is a uniqueness (count) mismatch.
    if (!verdict.ok && verdict.critique) {
      if (isCountMismatch(verdict.critique)) {
        verdict.critique = verdict.critique.replace(REPLAY_TAIL, COUNT_TAIL);
      }
    }
    if (verdict.redSpecs?.length) verdict.redSpecs = [promoted];
    return verdict;
  } finally {
    if (existsSync(checkSpec)) unlinkSync(checkSpec);
  }
}

/**
 * What a recording has to clear: coverage, then the uniqueness-check replay.
 *
 * The renderer owns the spec's shape, so the recording path checks the two things
 * it cannot vouch for: that no feature step was skipped (coverage, over the
 * promoted spec), and that the spec runs green against the live page with every
 * action locator proven unique (the injected replay). The injected replay is a
 * strict superset of a plain replay — it runs the real actions and proves each
 * action locator matches exactly one element the instant before it is used — so
 * it replaces the plain replay rather than adding a second run.
 */
export async function runGates(featurePath, specPath) {
  const cov = coverageGate(featurePath, specPath);
  if (!cov.ok) return cov;

  const rep = uniquenessReplayGate(featurePath);
  return { ...rep, passed: [...cov.passed, ...rep.passed] };
}
