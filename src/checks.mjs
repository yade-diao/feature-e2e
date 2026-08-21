/**
 * Acceptance checks for a recorded spec.
 *
 * Cheapest first: text-only checks run before a browser is spent on a recording
 * that was never going to hold up.
 *
 * Neither asks whether the assertions are *good*; that is a separate problem.
 * What they rule out is a recording that skipped a step, or that produced a step
 * shaped like coverage but containing nothing. An empty `test.step` is worse
 * than a missing one, because it reads as done.
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

/** Titles of the `test.step(...)` calls in a spec, in source order. */
export function specStepTitles(specPath) {
  const src = readFileSync(specPath, 'utf8');
  const titles = [];
  const re = /\btest\.step\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) titles.push(decodeStringLiteral(m[2]));
  return titles;
}

/**
 * Decode the body of a JavaScript string literal.
 *
 * The regex captures raw source, so an escape written by the recorder — \u201c,
 * \n, \" — arrives as the characters that spell it rather than the character it
 * means, and the title then fails to match the feature step. JSON.parse does the
 * decoding properly; anything it cannot parse falls back to the raw text, since
 * a title that will not decode is still better compared literally than dropped.
 */
function decodeStringLiteral(body) {
  try {
    return JSON.parse(`"${body.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"')}"`);
  } catch {
    return body.replace(/\\(['"`\\])/g, '$1');
  }
}

const normalise = t => String(t).replace(/\s+/g, ' ').replace(/["'“”‘’]/g, '"').trim();

/**
 * Gate 1 — every feature step must appear as a `test.step` title.
 *
 * Matching is exact after whitespace/quote normalisation. Deliberately strict:
 * a fuzzy match would let a step drift away from what the feature asked while
 * still reporting coverage, which is the failure mode this exists to catch.
 */
export function checkStepCoverage(featurePath, specPath) {
  const wanted = allSteps(featurePath).map(s => s.full);
  const found = specStepTitles(specPath).map(normalise);
  const missing = wanted.filter(w => !found.includes(normalise(w)));
  const extra = found.filter(f => !wanted.map(normalise).includes(f));
  return { ok: missing.length === 0, missing, extra, wanted: wanted.length, found: found.length };
}

/**
 * Gate 2 — no `test.step` may be empty.
 *
 * Input is the step records collected by src/reporter.mjs during replay:
 * a step that performed nothing has no child steps at all, which is exactly
 * how a silently skipped step looks from the outside.
 */
export function checkStepSubstance(recordedSteps) {
  const empty = recordedSteps.filter(s => s.children.length === 0);
  return { ok: empty.length === 0, empty, total: recordedSteps.length };
}


/**
 * Gate 1b — shapes a recording may not use.
 *
 * This was a hand-written table of regexes until eslint-plugin-playwright turned
 * out to already have almost all of it, maintained by the Playwright community
 * and working on the AST rather than on lines of text. It also carries rules the
 * table never had — an un-awaited assertion never fails, and a test with no
 * assertions at all passes by definition.
 *
 * The rules themselves live in eslint.config.mjs so that a person editing a spec
 * in their editor and the gate rejecting one see exactly the same list.
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
      { filePath: join(ROOT, 'tests', 'run', basename(specPath)) });
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
 * Each body runs from the end of its title to the start of the next test.step,
 * or to the end of the file.
 */
function stepBodies(src, step) {
  const re = /\btest\.step\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  const found = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    found.push({ title: decodeStringLiteral(m[2]), start: m.index, end: m.index + m[0].length });
  }
  const wanted = normalise(step.full);
  return found
    .map((f, i) => ({ ...f, next: i + 1 < found.length ? found[i + 1].start : src.length }))
    .filter(f => normalise(f.title) === wanted)
    .map(f => src.slice(f.end, f.next));
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
const PRESENCE = [
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
 * Gate 1c — a step that only asserts absence needs evidence the page is alive.
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
  const src = readFileSync(specPath, 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const naked = [];

  for (const step of allSteps(featurePath)) {
    for (const body of stepBodies(bare, step)) {
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
 * Gate 6 (audit) — strings the spec names that the feature never authorised.
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

  const src = readFileSync(specPath, 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const flagged = new Set();
  for (const m of bare.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const n = normalise(decodeStringLiteral(m[2]));
    if (!n) continue;
    if (anchors.has(n)) continue;
    if (!/\p{Script=Han}/u.test(n)) continue;   // CJK is the page-content signal
    flagged.add(n);
  }
  return { ok: flagged.size === 0, flagged: [...flagged] };
}

/**
 * Gate 7 (audit) — locators that will break on the next build.
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
  const src = readFileSync(specPath, 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const flagged = new Set();
  for (const m of bare.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const n = decodeStringLiteral(m[2]);
    if (!n) continue;
    if (GENERATED_CLASS.some(re => re.test(n))) flagged.add(n);
  }
  return { ok: flagged.size === 0, flagged: [...flagged] };
}

/**
 * Gate 4 — an action locator with no fallback.
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
 * Locator sources that drift: visible text (wording changes), alt text, title
 * attributes, and raw CSS. `getByTestId` is deliberately absent — a stable,
 * hand-written testid is the developer's contract with the suite, not a rebuild
 * artifact, so it is treated as stable (matching the recording prompt's
 * locator preference order).
 */
const DRIFTABLE = /getByText|getByAltText|getByTitle|\.locator\s*\(/;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const collapse = s => s.replace(/\s+/g, ' ').trim();

/** Does this locator chain need a fallback and lack one? */
function needsRedundancy(chain) {
  if (chain.includes('.or(')) return false;   // a fallback is already there
  return DRIFTABLE.test(chain);               // drifts, and nothing backs it up
}

export function checkLocatorRedundancy(specPath) {
  const src = readFileSync(specPath, 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const actions = ACTION_METHODS.join('|');
  const naked = [];

  // Inline chain — the generator's usual shape:
  //   await page.getByTestId('search-input').click();
  const inlineRe = new RegExp(`(page\\.(?:getBy\\w+|locator)\\([^;]*?)\\.(${actions})\\s*\\(`, 'g');
  for (const m of bare.matchAll(inlineRe)) {
    if (needsRedundancy(m[1])) {
      naked.push({ line: lineOf(bare, m.index), method: m[2], chain: collapse(m[1]) });
    }
  }

  // Variable form — collected first so the action can be judged by the locator
  // it was assigned:
  //   const input = page.getByTestId('search-input');
  //   await input.click();
  const vars = new Map();
  const varRe = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(page\.(?:getBy\w+|locator)\([^;]*?);/g;
  for (const m of bare.matchAll(varRe)) vars.set(m[1], m[2]);
  if (vars.size) {
    const varActionRe = new RegExp(`\\b(${[...vars.keys()].join('|')})\\.(${actions})\\s*\\(`, 'g');
    for (const m of bare.matchAll(varActionRe)) {
      const chain = vars.get(m[1]);
      if (chain && needsRedundancy(chain)) {
        naked.push({ line: lineOf(bare, m.index), method: m[2], chain: collapse(chain) });
      }
    }
  }

  return { ok: naked.length === 0, naked };
}
