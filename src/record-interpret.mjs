/**
 * The shared record-interpret layer.
 *
 * A trace record is compiled two ways in this system: render-spec.mjs turns it
 * into spec *text* (`page.getByRole(...).click()`), and the shadow runner
 * (shadow-runner.mjs) has to *execute* it on a live page. If those two derived
 * their locators, their goto-path stripping, or their value resolution from
 * separate code, a record could execute one way in the shadow and render another
 * way into the spec — the exact "shadow green, spec red" gap the whole
 * step-wise-verification design exists to close.
 *
 * So the candidate→locator mapping, the goto path rule, and the dynamic/fixed
 * value resolution live here once, and BOTH consumers call this. The equivalence
 * is not a promise in a comment; it is pinned by a test
 * (record-interpret.test.mjs) that asserts `locatorExpr(c)` equals
 * render-spec's `renderCandidate(c)` minus the leading `page.` for every
 * candidate kind — the same tie locator-count.mjs already relies on.
 *
 * render-spec.mjs keeps owning the *text* form (the `.or()` redundancy rule, the
 * banned-pattern shapes, the `test.step` wrapping) — that is a rendering concern
 * with no runtime counterpart. This module owns only what a live execution and a
 * rendered statement must agree on.
 */

import { renderCandidate, NULLARY_MATCHERS, TEXT_FRAGMENT_MATCHERS, regexFragmentSource } from './render-spec.mjs';

/**
 * The Playwright locator expression a candidate compiles to, WITHOUT the leading
 * `page.` — the single string form both the renderer and this executor agree on.
 * Delegates to renderCandidate so there is exactly one candidate→getByX mapping
 * in the codebase (locator-count.mjs's candidateLocatorExpr does the same).
 */
export function locatorExpr(candidate) {
  return renderCandidate(candidate).replace(/^page\./, '');
}

/**
 * A candidate → a live Playwright Locator on `page`.
 *
 * Mirrors renderCandidate's semantics kind-for-kind. The flat kinds build
 * through the getByX API; `inner` chains `.locator(inner)` exactly as the
 * rendered `.locator('#inner')` would. The `locator` escape-hatch carries a full
 * chain in `expr` (a nested scope or `.filter({ hasText })` the flat kinds cannot
 * express) — the renderer emits it verbatim after `page.`, and here it is
 * evaluated against the real `page` the same way, through a scoped Function so
 * the chain resolves against `page` and nothing else.
 */
export function buildLocator(page, candidate) {
  const withInner = (loc) => (candidate.inner ? loc.locator(candidate.inner) : loc);
  switch (candidate.kind) {
    case 'role': {
      const opts = {};
      if (candidate.name != null) opts.name = candidate.name;
      if (candidate.exact) opts.exact = true;
      return withInner(page.getByRole(candidate.role, Object.keys(opts).length ? opts : undefined));
    }
    case 'testid':
      return withInner(page.getByTestId(candidate.id));
    case 'label':
      return withInner(page.getByLabel(candidate.text, candidate.exact ? { exact: true } : undefined));
    case 'placeholder':
      return withInner(page.getByPlaceholder(candidate.text, candidate.exact ? { exact: true } : undefined));
    case 'text':
      return withInner(page.getByText(candidate.text, candidate.exact ? { exact: true } : undefined));
    case 'locator': {
      // `expr` is validated at write time (trace.mjs validLocatorExpr): it starts
      // with an allowed getByX/locator builder and carries no positional method.
      // Evaluate it against `page` — the same string the renderer prints after
      // `page.`, run rather than printed.
      const fn = new Function('page', `return page.${candidate.expr};`);
      return fn(page);
    }
    default:
      throw new Error(`unknown candidate kind: ${candidate.kind}`);
  }
}

/**
 * Resolve a record's named values to concrete runtime values, matching
 * renderValueConsts: a `fixed` value is its literal; a `dynamic` value is its
 * `expr` evaluated once (`` `Auto-test${Date.now()}` `` → a string). The rendered
 * spec evaluates the dynamic expr in a `const` at file load; the shadow evaluates
 * it once here, per step-set — same value seen by every ref in the record.
 *
 * A prior map lets a later record reference a value an earlier record declared
 * (Create's PROMOTION_NAME read by Edit), the whole-trace scope the renderer
 * gives value consts. The caller threads it across a feature's records.
 */
export function resolveValues(record, prior = {}) {
  const out = { ...prior };
  for (const [name, v] of Object.entries(record.values ?? {})) {
    if (v.kind === 'dynamic') {
      // Same expr the renderer would print into `const NAME = <expr>`. Evaluated
      // in a bare scope: it references only globals (Date, Math) as the renderer's
      // const would at spec load.
      out[name] = new Function(`return (${v.expr});`)();
    } else {
      out[name] = v.literal;
    }
  }
  return out;
}

/** An action/assertion arg or value ref → its concrete value, given resolved values. */
function argValue(argOrValue, values) {
  if (argOrValue == null) return undefined;
  if ('ref' in argOrValue) {
    if (!(argOrValue.ref in values)) {
      throw new Error(`value ref '${argOrValue.ref}' resolves to nothing — not declared by this or a prior record`);
    }
    return values[argOrValue.ref];
  }
  return argOrValue.literal;
}

/**
 * Execute one action on `page`. `values` is the resolved value map (resolveValues).
 *
 * `goto` strips any scheme+host and resolves the path against the context
 * baseURL — byte-for-byte the rule renderAction uses, so the shadow navigates
 * where the spec's `page.goto(path)` would. Every other method drives the
 * action's DRIVING locator (locators[0], the candidate the proxy verified as it
 * was driven); the `.or()` fallbacks are a replay-robustness concern the renderer
 * chains into the spec text, not something a single live drive needs.
 */
export async function runAction(page, action, values) {
  const { method, locators, arg, key } = action;
  if (method === 'goto') {
    const raw = arg && 'literal' in arg ? String(arg.literal) : '';
    const path = raw.replace(/^https?:\/\/[^/]+/, '') || '/';
    await page.goto(path);
    return;
  }
  const loc = buildLocator(page, locators[0]);
  if (method === 'press') {
    await loc.press(key);
    return;
  }
  const val = argValue(arg, values);
  await loc[method](val === undefined ? undefined : val);
}

/**
 * Execute one assertion on `page` using the injected `expect`. Mirrors
 * renderAssertion: a nullary matcher (or a null value) calls with no argument;
 * otherwise the resolved value is the matcher argument. The assertion target uses
 * its first candidate — the shadow drives one path, the renderer's `.or()` on an
 * assertion target is text-only robustness. `NULLARY_MATCHERS` is imported from
 * render-spec (the single source of truth), so the replay and the renderer cannot
 * disagree on which matchers are nullary.
 */
export async function runAssertion(page, expect, assertion, values) {
  const loc = buildLocator(page, assertion.target[0]);
  const { matcher, value } = assertion;
  if (NULLARY_MATCHERS.has(matcher) || value == null) {
    await expect(loc)[matcher]();
    return;
  }
  // Mirror renderAssertion EXACTLY, so a shadow replay matches the same thing the
  // rendered spec would. A fixed string on a text-content matcher is matched as a
  // regex fragment (substring); everything else — a dynamic ref value, a numeric
  // count, an exact toHaveValue string — is passed through as-is.
  if (value && !('ref' in value) && TEXT_FRAGMENT_MATCHERS.has(matcher) && typeof value.literal === 'string') {
    await expect(loc)[matcher](new RegExp(regexFragmentSource(value.literal)));
    return;
  }
  await expect(loc)[matcher](argValue(value, values));
}
