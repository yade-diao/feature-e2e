/**
 * Acceptance checks for a recorded spec.
 *
 * Cheapest first: text-only checks run before a browser is spent on a recording
 * that was never going to hold up. They do not ask whether the assertions are
 * *good* — that is a separate problem; they rule out a recording that skipped a
 * step, or one shaped like coverage while proving nothing.
 */

import { readFileSync } from 'fs';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

/**
 * The gate always applies this project's rules, wherever the spec happens to
 * live. Letting ESLint discover a config from the file's directory would make
 * the verdict depend on what sits next to the spec — including nothing at all,
 * which fails outright rather than passing, but for the wrong reason.
 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_FILE = join(ROOT, 'eslint.config.mjs');
import { allSteps } from './feature.mjs';
import { testSteps, specStrings, actionLocators } from './spec-ast.mjs';
import { normalise } from './text.mjs';

/** Titles of the `test.step(...)` calls in a spec, in source order. */
export function specStepTitles(specPath) {
  return testSteps(specPath).map(s => s.title);
}

/**
 * Every feature step must appear as a `test.step` title.
 *
 * Matching is exact after whitespace/quote normalisation. Deliberately strict:
 * a fuzzy match would let a step drift away from what the feature asked while
 * still reporting coverage, which is the failure mode this exists to catch.
 */
export function checkStepCoverage(featurePath, specPath) {
  const wanted = allSteps(featurePath).map(s => s.full);

  // No steps is not full coverage. A feature stating nothing clears this gate at
  // 0/0 and lets through a spec that verifies nothing — the same "absent reads
  // as passing" the gate exists to refuse.
  if (!wanted.length) return { ok: false, empty: true, missing: [], extra: [], wanted: 0, found: 0 };

  const found = specStepTitles(specPath).map(normalise);
  const missing = wanted.filter(w => !found.includes(normalise(w)));
  const extra = found.filter(f => !wanted.map(normalise).includes(f));
  return { ok: missing.length === 0, missing, extra, wanted: wanted.length, found: found.length };
}

/**
 * Shapes a recording may not use (delegated to eslint-plugin-playwright).
 *
 * eslint-plugin-playwright carries almost all of these rules, maintained by the
 * Playwright community and working on the AST rather than on lines of text. It
 * also catches an un-awaited assertion (which never fails) and a test with no
 * assertions at all (which passes by definition).
 *
 * The rules live in eslint.config.mjs so that a person editing a spec in their
 * editor and the gate rejecting one see exactly the same list.
 */
export async function checkBannedPatterns(specPath) {
  let results;
  try {
    // lintText rather than lintFiles: a flat config ignores anything outside its
    // own directory tree, and the gate has to be able to judge a spec sitting in
    // a scratch directory just as it judges one in the repository. The file path
    // handed over is only used to decide which config block applies.
    results = await new ESLint({ overrideConfigFile: CONFIG_FILE }).lintText(
      readFileSync(specPath, 'utf8'),
      { filePath: join(ROOT, 'run', basename(specPath)) });
  } catch (e) {
    // A linter that could not run has cleared nothing. Reporting "ok" here would
    // be the same mistake as a check that never executes.
    return { ok: false, unavailable: true,
      hits: [{ line: 0, what: 'eslint did not run', text: '', why: e.message }] };
  }

  const hits = results.flatMap(file =>
    file.messages.map(m => ({
      line: m.line ?? 0,
      what: m.ruleId ?? 'syntax error',
      text: (file.source ?? readFileSync(specPath, 'utf8')).split('\n')[(m.line ?? 1) - 1]?.trim() ?? '',
      why: m.message,
    })));

  return { ok: hits.length === 0, hits };
}

/**
 * Every body belonging to a step with this title, not just the first.
 *
 * Scenarios in one feature repeat step text all the time — two of them opening
 * with the same Given is ordinary Gherkin. Taking only the first match would let
 * a second scenario implement the same step wrongly and be cleared by whatever
 * the first one did.
 *
 * Each body is the callback's own source, so a step wrapping a nested step keeps
 * the nested one inside it.
 */
function stepBodies(specPath, step) {
  const wanted = normalise(step.full);
  return testSteps(specPath).filter(s => normalise(s.title) === wanted).map(s => s.body);
}

/** Matchers that claim something is not there, or is bounded from above. */
const ABSENCE = [
  /\.toBeHidden\s*\(/,
  /\.not\s*\.\s*toBeVisible\s*\(/,
  /\.not\s*\.\s*toBeAttached\s*\(/,
  /\.toHaveCount\s*\(\s*0\s*\)/,
  /\.toBeLessThan(OrEqual)?\s*\(/,
  /\.toHaveLength\s*\(\s*0\s*\)/,
];

/** Matchers that claim something is there. */
export const PRESENCE = [
  /\.toBeVisible\s*\(/,
  /\.toBeAttached\s*\(/,
  /\.toHaveText\s*\(/,
  /\.toContainText\s*\(/,
  /\.toHaveValue\s*\(/,
  /\.toHaveTitle\s*\(/,
  /\.toHaveURL\s*\(/,
  /\.toMatchAriaSnapshot\s*\(/,
  /\.toBeGreaterThan(OrEqual)?\s*\(/,
  /\.toHaveCount\s*\(\s*[1-9]/,
  /\.toBeChecked\s*\(/,
  /\.toBeEnabled\s*\(/,
];

const matchesAny = (res, text) => res.some(re => re.test(text));

/**
 * A step that only asserts absence needs evidence the page is alive.
 *
 * "at most 10 rows" is satisfied by zero rows. "no row lacks the keyword" is
 * satisfied by no rows at all. A step built only from upper bounds and absences
 * passes on a blank page, a failed render and a filter that wiped the list —
 * the three things it was presumably written to catch.
 *
 * The pairing rule is the one the assertion itself implies: if you are claiming
 * something is *not* there, show that you were looking at a page where it could
 * have been.
 *
 * Classification is by matcher, not by wording, so this holds for a feature
 * written in any language.
 */
export function checkLiveness(featurePath, specPath) {
  const naked = [];

  for (const step of allSteps(featurePath)) {
    for (const body of stepBodies(specPath, step)) {
      if (!matchesAny(ABSENCE, body)) continue;    // nothing to pair
      if (matchesAny(PRESENCE, body)) continue;    // already paired
      naked.push(step.full);
      break;                                       // one report per step is enough
    }
  }
  const unique = [...new Set(naked)];
  return { ok: unique.length === 0, naked: unique };
}

/**
 * Audit — strings the spec names that the feature never authorised.
 *
 * A feature step quotes the labels it cares about verbatim — `opens the "教育"
 * channel` — and those quoted strings are the anchors a recorder is allowed to
 * use. Anything else the spec names that reads as page content (CJK text) is
 * data read off the live page while recording: a headline, a product name, a
 * placeholder. That is the assertion that goes red tomorrow because the content
 * changed, not because anything regressed — the failure the README's "Known
 * limitation" calls out.
 *
 * This is deliberately an audit, not a hard gate. The signal — CJK text that is
 * not one of the feature's own quoted anchors — is strong but not proof, and a
 * false rejection here would block a recorder that did nothing wrong. List, do
 * not reject: the human decides whether each hit is a real data assertion.
 */
export function checkSemanticStability(featurePath, specPath) {
  const anchors = new Set();
  for (const step of allSteps(featurePath)) {
    anchors.add(normalise(step.full));   // the step title, verbatim
    for (const m of step.full.matchAll(/["“]([^"”]+)["”]/g)) {
      anchors.add(normalise(m[1]));      // quoted labels the feature authorised
    }
  }

  const flagged = new Set();
  for (const raw of specStrings(specPath)) {
    const n = normalise(raw);
    if (!n) continue;
    if (anchors.has(n)) continue;
    if (!/\p{Script=Han}/u.test(n)) continue;   // CJK is the page-content signal
    flagged.add(n);
  }
  return { ok: flagged.size === 0, flagged: [...flagged] };
}

/**
 * Audit — locators that will break on the next build.
 *
 * A recorded locator pins whatever it was made from. Some sources are stable —
 * role, label, a hand-written testid; others change on every rebuild or the next
 * refactor: CSS-module hashes, styled-components / emotion class names, and
 * testids that embed an id or index. A spec that names one goes red tomorrow for
 * a reason that has nothing to do with a regression.
 *
 * Like checkSemanticStability, this is an audit, not a hard gate — regexes over
 * generated class names can misfire, and a false reject would block a recorder
 * that did nothing wrong. List, do not reject.
 */

/** Generated-class signatures that change on every build. */
const GENERATED_CLASS = [
  /[\w-]+__[A-Za-z0-9]{5,}/,        // CSS modules: .Module_x__ab12cd
  /(?:^|[.\s])sc-[A-Za-z0-9]{5,}/,  // styled-components: .sc-bdVaJa
  /(?:^|[.\s])css-[a-z0-9]{5,}/,    // emotion: .css-1vz4ukc
];

export function checkLocatorRobustness(specPath) {
  const flagged = new Set();
  for (const raw of specStrings(specPath)) {
    if (!raw) continue;
    if (GENERATED_CLASS.some(re => re.test(raw))) flagged.add(raw);
  }
  return { ok: flagged.size === 0, flagged: [...flagged] };
}

/**
 * An action locator with no fallback.
 *
 * A locator that drives an action (click, fill, select…) fails the whole test
 * when it stops matching: the step throws and every assertion after it never
 * runs. So an action must survive a rebuild — either by carrying a `.or()`
 * backup chain, or by being pure accessibility semantics (role / label /
 * placeholder), which does not depend on ids, classes or wording.
 *
 * Assertions are deliberately NOT checked. An assertion locator that fails is
 * the point — it is the "this business logic does not hold" signal, and giving
 * it a fallback would let it match some near element and go green while the
 * component it was watching is gone. Redundancy here prevents a false red;
 * redundancy on an assertion would cause a false green.
 */

/** Action methods on a Locator — the ones that throw when the target is gone. */
const ACTION_METHODS = [
  'click', 'dblclick', 'fill', 'clear', 'press', 'type', 'selectOption',
  'check', 'uncheck', 'hover', 'dragTo', 'setInputFiles',
];

/**
 * Which sources count as drifting — visible text, alt text, title attributes and
 * raw CSS — is decided in spec-ast.mjs, where the chain is read off the parse.
 * `getByTestId` is deliberately not among them: a stable, hand-written testid is
 * the developer's contract with the suite, not a rebuild artifact, which is the
 * same order of preference the agent records by.
 */
export function checkLocatorRedundancy(specPath) {
  const naked = actionLocators(specPath, ACTION_METHODS)
    .filter(a => a.driftable && !a.hasFallback)
    .map(({ line, method, chain }) => ({ line, method, chain }));
  return { ok: naked.length === 0, naked };
}

/**
 * Audit — a step that changes state must prove it, in the same step.
 *
 * A write (create / update / delete) can appear to succeed — the click landed,
 * nothing threw — while the operation silently failed. Without a direct
 * assertion the step reads as done, and the failure only surfaces later when a
 * downstream step uses data that was never really there: a misattributed
 * cascade (see knowledge/local/engine/cascading-failure.md).
 *
 * A step is a "naked write" when its body performs a mutating action but asserts
 * nothing present. Detection mirrors checkLiveness: classify by matcher on the
 * step body, not by wording, so it holds in any language. Mutation is judged by
 * the method invoked (fill/selectOption/check/type…), the subset of actions that
 * change state — a bare navigation `click` is not one, which keeps read-only
 * navigation steps from tripping it.
 *
 * This ships as an audit, not a hard gate: `press('Enter')` is shared by a
 * search (a read) and a form submit (a write), and a search that asserts its
 * result in the same step is fine — but the signal is strong enough to list, and
 * a human decides. List, do not reject.
 */

/** Actions that mutate state — the write subset of ACTION_METHODS. */
const WRITE_ACTIONS = [
  /\.fill\s*\(/,
  /\.selectOption\s*\(/,
  /\.check\s*\(/,
  /\.uncheck\s*\(/,
  /\.setInputFiles\s*\(/,
  /\.clear\s*\(/,
  /\.type\s*\(/,
];

export function checkWriteCheckpoint(specPath) {
  const naked = [];
  for (const { title, body, line } of testSteps(specPath)) {
    if (!matchesAny(WRITE_ACTIONS, body)) continue;   // no mutation here
    if (matchesAny(PRESENCE, body)) continue;         // already proven
    naked.push({ line, title });
  }
  return { ok: naked.length === 0, naked };
}
