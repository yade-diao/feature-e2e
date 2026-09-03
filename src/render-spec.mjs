/**
 * The deterministic renderer: trace -> spec.ts.
 *
 * This is where the quality guarantee lives. The recorder produces structured
 * data (trace.mjs); this compiles it into a Playwright spec, and because it is a
 * pure function following a fixed template, it cannot emit the shapes the gates
 * reject. The banned-pattern and locator-redundancy classes are designed out
 * here, not caught downstream and retried:
 *
 *   - goto is rendered with the path only, never a scheme+host (banned: absolute
 *     URL in goto).
 *   - a locator built from a driftable source (visible text) is always given an
 *     .or() fallback; pure role/label/placeholder/testid may stand alone
 *     (redundancy gate).
 *   - .first/.nth/.last are never emitted (banned: no-nth-methods).
 *   - no `if` is ever emitted inside a test (banned: no-conditional-in-test).
 *   - a step whose body performs a write, or asserts absence, is rendered with a
 *     presence assertion in the same body (liveness / writeCheckpoint gates) —
 *     the recorder is asked to supply one; a naked write is left for the audit to
 *     flag rather than silently patched.
 *   - the test.step title is the feature step verbatim (coverage gate). The
 *     record's `step` must be the FULL feature step including its Gherkin keyword
 *     — "When I click 'Save'", not "I click 'Save'" — because the coverage gate
 *     matches against `${keyword} ${text}` (feature.mjs allSteps). A title
 *     missing the keyword reads as an uncovered step.
 *
 * Dynamic values (a promotion name that must be regenerated per run) render as a
 * top-level `const NAME = <expr>` evaluated once when the file loads and shared
 * by every test in it — so Create's generated name is the one Edit searches for,
 * self-consistent within a run and different on the next. Fixed business inputs
 * render as string literals.
 */

import { DRIFTABLE_SOURCE } from './spec-ast.mjs';

/**
 * Serialise a string as a single-quoted JS literal, escaping what must be.
 *
 * Every character that JS treats as a *line terminator* has to be escaped, not
 * just `\n`: a raw CR, or a Unicode line/paragraph separator (U+2028/U+2029),
 * inside a single-quoted literal is a syntax error ("unterminated string"), so a
 * step title or value pasted from Windows or rich text would compile to a spec
 * that cannot be parsed — a red replay whose error points at the spec text, not
 * the page. These are rare but silent, so escape all four.
 */
function q(s) {
  return "'" + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    + "'";
}

/**
 * One locator candidate -> a `page.getByX(...)` expression (a full expression,
 * with the leading `page.`).
 *
 * `exact: true` renders the `{ exact: true }` option where the API supports it,
 * so a title of "Save" does not also match "Save and close".
 *
 * An optional `inner` chains `.locator(inner)` onto the candidate — how a UI5
 * field reaches its native `<input>` inside the wrapper the testid resolves to
 * (`getByTestId('promotionName').locator('#inner')`). It is a plain CSS selector,
 * never a positional method.
 */
export function renderCandidate(c) {
  const inner = c.inner ? `.locator(${q(c.inner)})` : '';
  switch (c.kind) {
    case 'role': {
      const opts = [];
      if (c.name != null) opts.push(`name: ${q(c.name)}`);
      if (c.exact) opts.push('exact: true');
      const optStr = opts.length ? `, { ${opts.join(', ')} }` : '';
      return `page.getByRole(${q(c.role)}${optStr})${inner}`;
    }
    case 'testid':
      return `page.getByTestId(${q(c.id)})${inner}`;
    case 'label':
      return `page.getByLabel(${q(c.text)}${c.exact ? ', { exact: true }' : ''})${inner}`;
    case 'placeholder':
      return `page.getByPlaceholder(${q(c.text)}${c.exact ? ', { exact: true }' : ''})${inner}`;
    case 'text':
      return `page.getByText(${q(c.text)}${c.exact ? ', { exact: true }' : ''})${inner}`;
    case 'locator':
      // A full locator chain the flat kinds cannot express (nested scope, filter,
      // getByAltText/Title). `expr` is validated at write time (trace.mjs
      // validLocatorExpr) to start with an allowed builder and carry no positional
      // method, so it is rendered verbatim after `page.`.
      return `page.${c.expr}`;
    default:
      throw new Error(`unknown candidate kind: ${c.kind}`);
  }
}

/**
 * Whether a candidate renders to a driftable locator — judged by its ANCHOR (the
 * source the chain starts from), using the same DRIFTABLE_SOURCE spec-ast's audit
 * uses, so render-time and audit are one judgement. Anchored on a stable testid/
 * role/label is fine even when the chain later refines with `.locator('#inner')`
 * (the UI5 inner-input case); only a chain anchored on `getByText`/`getByAltText`/
 * `getByTitle`/a raw `locator(css)` drifts.
 */
function isDriftableCandidate(c) {
  const expr = renderCandidate(c).replace(/^page\./, '');
  // The anchor is the FIRST source builder in the rendered expression.
  const m = expr.match(/^(getByRole|getByTestId|getByLabel|getByPlaceholder|getByText|getByAltText|getByTitle|locator|frameLocator)\b/);
  return m != null && DRIFTABLE_SOURCE.has(m[1]);
}

/** `a.or(b).or(c)` from candidates, first bare. No redundancy check. */
function orChain(candidates) {
  return candidates.slice(1).reduce(
    (acc, c) => `${acc}.or(${renderCandidate(c)})`,
    renderCandidate(candidates[0]));
}

/**
 * A chain of candidates -> `a.or(b).or(c)`.
 *
 * The redundancy gate rejects an action locator that is driftable and has no
 * `.or()`. So: if the first candidate is driftable, the chain must carry at
 * least one more candidate to fall back to. A pure-semantic single candidate
 * (role/label/placeholder/testid) is allowed to stand alone.
 *
 * @param forAction  when true, enforce the redundancy rule (assertions are not
 *                   checked by the gate and may be a single driftable locator —
 *                   a fallback on an assertion would cause a false green).
 */
export function renderLocator(candidates, { forAction = false } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('renderLocator: need at least one candidate');
  }
  if (forAction && isDriftableCandidate(candidates[0]) && candidates.length < 2) {
    throw new Error(
      `renderLocator: action locator leads with a driftable '${candidates[0].kind}' `
      + 'candidate and has no fallback — supply a role/label/testid candidate too');
  }
  // First candidate bare; every candidate after it wrapped in `.or(...)`.
  return orChain(candidates);
}

/**
 * The interaction methods an action may drive, beyond `goto` (which navigates by
 * path, not a locator). The single source of truth: validateRecord (trace.mjs)
 * rejects a record whose action names anything else at write time, and both the
 * renderer (`renderAction`) and the live replay (`runAction`, record-interpret.mjs)
 * only ever emit/drive one of these — so a typo'd or hallucinated method
 * (`clik`, `evaluate`, `select`) is caught as the step is recorded, not as a broken
 * `.clik()` in the spec text or a `loc[method] is not a function` at replay.
 *
 * `press` is included but takes its key from the action's `key` field, not `arg`;
 * `goto` is deliberately NOT here (it is the no-locator navigation special case).
 */
export const ACTION_METHODS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck',
  'selectOption', 'hover', 'setInputFiles', 'dragTo', 'focus', 'clear', 'tap',
]);

/** Render an argument reference: a literal string, or a bare variable name. */
function renderArg(arg) {
  if (arg == null) return '';
  if ('ref' in arg) return arg.ref;                 // bare identifier -> the const
  return typeof arg.literal === 'number' ? String(arg.literal) : q(arg.literal);
}

/**
 * One action -> a single awaited statement.
 *
 * `goto` is special: it takes a path string, never a locator, and the path is
 * stripped of any origin so the spec stays portable (baseURL decides the host).
 *
 * `press` is special too: its argument is a keyboard key held in the action's
 * own `key` field (`'Enter'`, `'Tab'`), not in `arg` — `arg` carries a fill's
 * text value, a different thing. It renders as `.press('Enter')`; the key is a
 * fixed literal, never a value ref.
 */
function renderAction(action) {
  const { method, locators, arg, key } = action;

  if (method === 'goto') {
    const raw = arg && 'literal' in arg ? String(arg.literal) : '';
    const path = raw.replace(/^https?:\/\/[^/]+/, '') || '/';
    return `  await page.goto(${q(path)});`;
  }

  const loc = renderLocator(locators, { forAction: true });
  if (method === 'press') {
    return `  await ${loc}.press(${q(key)});`;
  }
  const argStr = arg != null ? renderArg(arg) : '';
  return `  await ${loc}.${method}(${argStr});`;
}

/**
 * Matchers that need no argument. Exported as the single source of truth: the
 * shadow runner's runAssertion (record-interpret.mjs) imports THIS set rather than
 * keeping its own copy, so the renderer and the live replay agree on which matchers
 * are nullary — they cannot drift apart.
 */
export const NULLARY_MATCHERS = new Set([
  'toBeVisible', 'toBeHidden', 'toBeAttached', 'toBeChecked', 'toBeEnabled', 'toBeDisabled',
]);

/**
 * Text-content matchers whose STRING value is matched as a regex FRAGMENT (a
 * substring), not a whole-string literal. `toHaveText('Draft')` in Playwright is a
 * trimmed WHOLE-text equality — brittle to any surrounding markup, a stray space,
 * or a dynamic suffix the page renders around the word. For a step that asserts a
 * label/status is present, "the text contains Draft" is what the feature means and
 * what survives replay; so a fixed string here renders (and replays) as
 * `.toHaveText(new RegExp('Draft'))`, i.e. a substring. This is the single source of
 * truth: record-interpret's runAssertion imports it so the live replay wraps the
 * same value the same way — spec and shadow cannot disagree.
 *
 * NOT included: `toHaveValue` (an input's value — a value asserted equal to X means
 * exactly X, regex-loosening it would let "X2" satisfy "X") and the numeric matchers
 * (`toHaveCount` etc.). A `ref` value (a dynamic value captured earlier) is ALWAYS
 * passed through as the variable, never regex-wrapped, on any matcher.
 */
export const TEXT_FRAGMENT_MATCHERS = new Set(['toHaveText', 'toContainText']);

/**
 * The RegExp source for a fixed string matched as a fragment: escape every regex
 * metacharacter so the string is matched literally-as-a-substring, not as a pattern.
 * Shared by the renderer (which emits `new RegExp('<this>')`) and the replay (which
 * builds `new RegExp(<this>)`), so both match the identical substring.
 */
export function regexFragmentSource(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One assertion -> an awaited web-first expect.
 *
 * `.or()` is deliberately allowed on an assertion target (the gate does not
 * check assertions), but the renderer only adds one when the recorder gave more
 * than one candidate; a single-candidate assertion stays a single locator, which
 * is the honest "this element must be here" signal.
 */
function renderAssertion(as) {
  const target = orChain(as.target);
  const { matcher, value } = as;
  if (NULLARY_MATCHERS.has(matcher) || value == null) {
    return `  await expect(${target}).${matcher}();`;
  }
  // A dynamic value (a ref captured earlier) is passed through as the variable on
  // any matcher — never regex-wrapped, it is already the exact value to match.
  if ('ref' in value) return `  await expect(${target}).${matcher}(${value.ref});`;
  // A text-content matcher with a FIXED string matches it as a regex FRAGMENT
  // (substring), so the assertion tolerates whitespace/markup the page renders
  // around the word — `toHaveText('Draft')` would demand the WHOLE trimmed text be
  // exactly "Draft" and break on "Draft ". record-interpret wraps the same value the
  // same way, so the replay matches identically.
  if (TEXT_FRAGMENT_MATCHERS.has(matcher) && typeof value.literal === 'string') {
    return `  await expect(${target}).${matcher}(new RegExp(${q(regexFragmentSource(value.literal))}));`;
  }
  // A numeric value on a numeric matcher (toHaveCount(0), toBeGreaterThan…) goes
  // through bare. A number on a TEXT matcher is invalid and is rejected at write
  // time (validateRecord), so it never reaches here.
  if (typeof value.literal === 'number') return `  await expect(${target}).${matcher}(${value.literal});`;
  // Any other fixed string (e.g. toHaveValue) is an exact literal — an input value
  // asserted equal to X means exactly X.
  return `  await expect(${target}).${matcher}(${q(value.literal)});`;
}

/**
 * One trace record -> a `test.step(...)` block.
 *
 * The title is the feature step verbatim (coverage gate matches it after
 * whitespace/quote normalisation). Actions then assertions, each its own awaited
 * statement.
 *
 * `checkLocators` turns on the uniqueness pass: before each action that locates
 * an element (everything but `goto`), one `await expect(<candidate>).toHaveCount(1)`
 * is emitted per candidate. This makes a non-unique candidate go red on the
 * assertion — in the locating layer, naming the candidate and its count — rather
 * than as an opaque strict-mode throw when the action later runs. It is emitted
 * *before* the action so the count is taken against exactly the DOM the action
 * will strict-match against (the action may then mutate it). Assertion targets are
 * never checked: an assertion legitimately matches ≠1 (absence, a list count) and
 * verify.md blesses a single/`.or()` assertion locator.
 */
export function renderStepBlock(record, { checkLocators = false } = {}) {
  const lines = [];
  lines.push(`    await test.step(${q(record.step)}, async () => {`);
  for (const action of record.actions ?? []) {
    if (checkLocators && Array.isArray(action.locators)) {
      for (const c of action.locators) {
        lines.push(`      await expect(${renderCandidate(c)}).toHaveCount(1);`);
      }
    }
    lines.push('  ' + renderAction(action));
  }
  for (const as of record.assertions ?? []) {
    lines.push('  ' + renderAssertion(as));
  }
  lines.push('    });');
  return lines.join('\n');
}

/**
 * The `const` block for a scenario's named values.
 *
 * Dynamic values render as their runtime expression (re-evaluated every load —
 * every replay a fresh value). Fixed values render as literals. Declared once at
 * file top level (inside describe, above the tests) so a value created in one
 * scenario is the same one a later scenario references.
 */
function renderValueConsts(values) {
  const lines = [];
  for (const [name, v] of Object.entries(values)) {
    if (v.kind === 'dynamic') {
      lines.push(`  const ${name} = ${v.expr};`);
    } else {
      const lit = typeof v.literal === 'number' ? String(v.literal) : q(v.literal);
      lines.push(`  const ${name} = ${lit};`);
    }
  }
  return lines;
}

/**
 * Render a full (or prefix) spec from a trace.
 *
 * @param trace   array of records (trace.mjs readTrace output).
 * @param upto    optional exclusive upper bound — render only records[0..upto).
 *                Used to build a resume seed: the prefix that already worked,
 *                replayed for real so the agent can take over at the bad step.
 * @param checkLocators  when true, emit a per-candidate
 *                `expect(...).toHaveCount(1)` before each action locator, so a
 *                non-unique candidate reds in the locating layer. Used to build
 *                the uniqueness-check spec (gates.mjs uniquenessReplayGate); the
 *                promoted spec is rendered without it.
 *
 * The whole feature renders as a single `test(...)` so its scenarios share one
 * browser context (a recording is a continuous flow: log in, then act as that
 * session). Scenarios are kept legible as `// Scenario:` comments, in first-seen
 * order. All named values are hoisted into one const block inside the describe,
 * so a dynamic value shared across scenarios (Create's name, Edit's search) is
 * one variable.
 */
export function renderSpec(trace, { upto, checkLocators = false } = {}) {
  const records = upto == null ? trace : trace.slice(0, upto);

  // Merge every record's values into one map (later wins on collision — a value
  // redefined mid-trace is a recorder choice we preserve as-is).
  const values = {};
  for (const rec of records) Object.assign(values, rec.values ?? {});

  // A ref that resolves to no value would render as a bare identifier and throw
  // ReferenceError at replay — a failure that reads as a page problem, not a
  // trace one. Catch it here, where the whole rendered set is in view (this also
  // guards a prefix render whose ref was declared in a record `upto` cut away).
  const declared = new Set(Object.keys(values));
  for (const rec of records) {
    const refs = [
      ...(rec.actions ?? []).map(a => a.arg),
      ...(rec.assertions ?? []).map(a => a.value),
    ];
    for (const r of refs) {
      if (r && 'ref' in r && !declared.has(r.ref)) {
        throw new Error(`renderSpec: step ${JSON.stringify(rec.step)} references `
          + `value '${r.ref}', which no rendered record declares`);
      }
    }
  }

  // Group records by scenario, preserving first-seen order.
  const byScenario = new Map();
  for (const rec of records) {
    if (!byScenario.has(rec.scenario)) byScenario.set(rec.scenario, []);
    byScenario.get(rec.scenario).push(rec);
  }

  const out = [];
  out.push(`import { test, expect } from '@playwright/test';`);
  out.push('');
  out.push(`test.describe('Recorded', () => {`);

  const constLines = renderValueConsts(values);
  if (constLines.length) {
    out.push(...constLines);
    out.push('');
  }

  // The whole feature is one test, so its scenarios share a browser context.
  // A recording is a continuous business flow — log in, then act as that session
  // — and Playwright gives each test() a fresh context, so a per-scenario test
  // would lose the login (and any state a later scenario builds on) the moment
  // the next test began. Scenarios stay legible as `// Scenario:` comments; the
  // feature steps are the test.step blocks the coverage gate reads, flat and in
  // order, regardless of which scenario they came from.
  out.push(`  test('recorded flow', async ({ page }) => {`);
  let firstScenario = true;
  for (const [scenario, recs] of byScenario) {
    if (!firstScenario) out.push('');
    firstScenario = false;
    out.push(`    // Scenario: ${scenario}`);
    out.push(recs.map(rec => renderStepBlock(rec, { checkLocators })).join('\n'));
  }
  out.push('  });');
  out.push('');

  out.push('});');
  out.push('');
  return out.join('\n');
}
