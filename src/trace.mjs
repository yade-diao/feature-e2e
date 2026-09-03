/**
 * The trace: the recording's first-class artifact.
 *
 * The model produces only structured data — one record per feature step: what it
 * did, two or three ways to find each element, what it means to assert. A
 * deterministic renderer (render-spec.mjs) compiles that into spec.ts, and the
 * renderer cannot forget a rule, so a banned pattern or a locator with no
 * fallback is designed out at the template rather than caught and retried. The
 * model does not have to hold a page of formatting rules in mind while driving a
 * browser; it supplies data the live page proved, and the renderer owns the code.
 *
 * The trace is stored on its own (`.trace.jsonl`, one record per line), beside
 * the spec but not inside it, so an interrupted run leaves a legal prefix and a
 * later attempt can resume from a bad step instead of re-driving the whole
 * feature.
 *
 * ## Record shape
 *
 *   {
 *     scenario: string,           // Gherkin scenario name — groups steps into tests
 *     step: string,               // feature step verbatim — becomes the test.step title
 *                                 //   (must survive coverage gate's normalise() exactly)
 *     actions: [
 *       { method: 'click' | 'fill' | 'selectOption' | 'press' | ... ,
 *         locators: [ <candidate>, ... ],   // 2-3, rendered as an .or() chain
 *         arg?: <ArgRef>,                    // fill/selectOption value (a literal or value ref)
 *         key?: string }                     // press key ('Enter', 'Tab') — only for method 'press'
 *     ],
 *     assertions: [
 *       { target: [ <candidate>, ... ],     // locator candidates for the asserted element
 *         matcher: 'toBeVisible' | 'toHaveText' | 'toHaveCount' | ... ,
 *         value?: <ArgRef> }                // matcher argument, if any
 *     ],
 *     values?: {                            // named values referenced by actions/assertions
 *       PROMOTION_NAME: { kind: 'dynamic', expr: '`Auto-test${...}`' },  // re-evaluated each replay
 *       CUSTOMER:       { kind: 'fixed',   literal: 'L6 - SAPCostco...' } // frozen business input
 *     }
 *   }
 *
 * ### <candidate> — one way to find an element
 *   { kind: 'role',        role: 'button', name: 'Save', exact?: true }
 *   { kind: 'testid',      id: 'promotion-save' }
 *   { kind: 'label',       text: 'Customer', exact?: true }
 *   { kind: 'placeholder', text: 'Search' }
 *   { kind: 'text',        text: 'Planned', exact?: true }   // driftable: only valid with a fallback
 *
 * ### <ArgRef> — a literal, or a reference to a named value
 *   { literal: 'PD100046' }     // fixed business value, rendered as a string literal
 *   { ref: 'PROMOTION_NAME' }   // reference to values[PROMOTION_NAME], rendered as the bare identifier
 *
 * The distinction between `dynamic` and `fixed` values is the one design point
 * the recorder cannot get from the page: a promotion name is regenerated on every
 * run (so Create and Edit must reference one shared variable, self-consistent
 * within a run), while a customer or product id is a fixed input that stays a
 * literal. Getting it wrong collides on a duplicate name (dynamic recorded as
 * fixed) or drifts (fixed recorded as dynamic) — so it is validated here.
 */

import { appendFileSync, readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, relative, join, sep } from 'path';
import { SPEC_DIR, FEATURE_DIR } from './paths.mjs';
import { renderLocator, ACTION_METHODS, TEXT_FRAGMENT_MATCHERS } from './render-spec.mjs';
import { normalise } from './text.mjs';

const toNative = p => p.split(/[\\/]/).join(sep);

/**
 * feature path -> trace path.
 *
 * Mirrors featureToSpec: same directory shape under SPEC_DIR, `.trace.jsonl`
 * instead of `.spec.ts`. Living beside the spec (not the feature) keeps the
 * recorded artifacts together and the feature tree read-only.
 */
export function featureToTrace(featurePath) {
  const rel = relative(FEATURE_DIR, toNative(featurePath));
  if (rel.startsWith('..')) throw new Error(`feature must live under ${FEATURE_DIR}: ${featurePath}`);
  return join(SPEC_DIR, rel.replace(/\.feature$/, '.trace.jsonl'));
}

/** The candidate kinds a locator may be built from. */
const CANDIDATE_KINDS = new Set(['role', 'testid', 'label', 'placeholder', 'text', 'locator']);

/**
 * A `locator` candidate's expression must be a chain of Playwright locator
 * builders — the escape hatch for what the flat kinds cannot express (a nested
 * scope like `getByTestId('cell').getByTestId('input')`, a `.filter({ hasText })`,
 * a `getByAltText`/`getByTitle`). It is rendered verbatim after `page.`, so it is
 * constrained: it must START with an allowed builder (never arbitrary JS), and it
 * must not contain a positional method — the same `.first()`/`.nth()`/`.last()`
 * ban the renderer enforces everywhere else.
 */
const LOCATOR_EXPR_START = /^(getByRole|getByTestId|getByLabel|getByPlaceholder|getByText|getByAltText|getByTitle|locator)\s*\(/;
const POSITIONAL_METHOD = /\.(first|last|nth)\s*\(/;
function validLocatorExpr(expr) {
  return typeof expr === 'string' && expr.length > 0
    && LOCATOR_EXPR_START.test(expr.trim())
    && !POSITIONAL_METHOD.test(expr);
}

/**
 * Whether a candidate object is well-formed for its kind.
 *
 * A malformed candidate would render into a locator that does not compile or,
 * worse, one that compiles and points nowhere — so the shape is checked at write
 * time, where the offending record can still be rejected, not at render time.
 *
 * An optional `inner` is a CSS selector chained onto the candidate with
 * `.locator(inner)` — how a UI5 field reaches its native `<input>` inside the
 * wrapper (`#inner`, `input`). It never carries a positional method (`.first()`
 * etc.); those stay banned.
 *
 * A `locator` candidate carries a full Playwright locator expression in `expr`
 * (see validLocatorExpr) — the escape hatch for nested/filtered locators the flat
 * kinds cannot express. `inner` does not apply to it (chain inside `expr` instead).
 */
function validCandidate(c) {
  if (!c || typeof c !== 'object' || !CANDIDATE_KINDS.has(c.kind)) return false;
  if ('inner' in c && !(typeof c.inner === 'string' && c.inner.length > 0)) return false;
  switch (c.kind) {
    case 'role':        return typeof c.role === 'string' && c.role.length > 0;
    case 'testid':      return typeof c.id === 'string' && c.id.length > 0;
    case 'label':       return typeof c.text === 'string' && c.text.length > 0;
    case 'placeholder': return typeof c.text === 'string' && c.text.length > 0;
    case 'text':        return typeof c.text === 'string' && c.text.length > 0;
    case 'locator':     return validLocatorExpr(c.expr);
    default:            return false;
  }
}

/**
 * Whether a name is a plain JS identifier — the only shape safe to emit as a
 * bare `const <name>` or a bare `.fill(<name>)` in the rendered spec.
 *
 * Value names and value refs come from the model (the record_step tool), not from
 * trusted code, and the renderer drops them into the spec verbatim as identifiers.
 * Without this a name like `1; await page.close()` or `x-y` compiles to a broken
 * or hostile spec — and it slips past every downstream gate, which inspect the
 * rendered AST, not the legality of a value name. So reject it here, at write
 * time, where the offending record is still rejectable. Conservative on purpose:
 * ASCII letters/`_`/`$` to start, then word chars — the names the recorder ever
 * generates (PROMOTION_NAME, CUSTOMER) all fit, and anything exotic is refused.
 */
function validIdentifier(name) {
  return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** Whether an argument reference is well-formed: exactly one of literal | ref. */
function validArg(a) {
  if (a == null) return true;                       // optional
  if (typeof a !== 'object') return false;
  const hasLiteral = 'literal' in a;
  const hasRef = 'ref' in a;
  if (hasLiteral === hasRef) return false;          // exactly one
  if (hasLiteral) return typeof a.literal === 'string' || typeof a.literal === 'number';
  // A ref renders as a bare identifier — it must be one, not an arbitrary string.
  return validIdentifier(a.ref);
}

/**
 * Reject a record whose shape the renderer could not turn into a legal spec.
 *
 * Returns an array of human-readable problems; empty means the record is sound.
 * This is the schema check the plan's risk #5 calls for — the recorder writes
 * trace through Write/Edit, so a fat-fingered record must not silently become a
 * broken spec three steps later.
 */
export function validateRecord(rec, priorValues = null) {
  const problems = [];
  if (!rec || typeof rec !== 'object') return ['record is not an object'];
  if (typeof rec.scenario !== 'string' || !rec.scenario.trim()) problems.push('scenario missing');
  if (typeof rec.step !== 'string' || !rec.step.trim()) problems.push('step missing');

  const values = rec.values ?? {};
  for (const [name, v] of Object.entries(values)) {
    if (!validIdentifier(name)) {
      problems.push(`value name '${name}' is not a plain identifier — it is emitted as a bare `
        + `const in the spec, so it must match [A-Za-z_$][A-Za-z0-9_$]*`);
    }
    if (!v || typeof v !== 'object') { problems.push(`value ${name} not an object`); continue; }
    if (v.kind === 'dynamic') {
      if (typeof v.expr !== 'string' || !v.expr.trim()) problems.push(`dynamic value ${name} missing expr`);
    } else if (v.kind === 'fixed') {
      if (!('literal' in v)) problems.push(`fixed value ${name} missing literal`);
    } else {
      problems.push(`value ${name} has unknown kind ${v.kind}`);
    }
  }

  // Which value names a ref in this record may resolve to. A ref legitimately
  // points at a value another record declared — Create defines PROMOTION_NAME,
  // Edit references it — so resolution is a whole-trace question the renderer
  // once owned alone. But the trace is written in order: when appendTrace passes
  // the values declared by every ALREADY-written record as `priorValues`, a ref
  // resolvable against (prior ∪ this record's own) can be checked at write time,
  // where the offending record is still rejectable. Only a forward reference (use
  // before declare) slips past — vanishingly rare, and still caught at render.
  // When priorValues is null (a lone record with no trace context) we skip ref
  // resolution and keep the original write-well-formed-only contract.
  const resolvable = priorValues == null
    ? null
    : new Set([...Object.keys(priorValues), ...Object.keys(values)]);
  const checkArg = (a, where) => {
    if (!validArg(a)) { problems.push(`${where}: malformed arg`); return; }
    if (resolvable && a && 'ref' in a && !resolvable.has(a.ref)) {
      problems.push(`${where}: references value '${a.ref}', which no record has declared — `
        + `declare it in this record's values, or check the name`);
    }
  };

  // `goto` navigates by path (its arg), not by a locator — the one action with
  // no element to find. Every other action needs at least one locator candidate.
  const NAVIGATION = new Set(['goto']);

  const actions = rec.actions ?? [];
  if (!Array.isArray(actions)) problems.push('actions is not an array');
  else actions.forEach((act, i) => {
    if (typeof act.method !== 'string' || !act.method) problems.push(`action[${i}]: method missing`);
    if (NAVIGATION.has(act.method)) {
      if (!act.arg || !('literal' in act.arg)) problems.push(`action[${i}]: ${act.method} needs a literal path arg`);
    } else if (typeof act.method === 'string' && act.method && !ACTION_METHODS.has(act.method)) {
      // A method neither `goto` nor a known interaction verb: a typo or a
      // hallucinated method (`select`, `evaluate`, `clik`). Reject it at write time
      // — it would otherwise render as `.select()` in the spec text or throw
      // `loc[method] is not a function` at replay, far from where it can be fixed.
      problems.push(`action[${i}]: unknown method '${act.method}' (expected goto or one of ${[...ACTION_METHODS].join('/')})`);
    } else if (!Array.isArray(act.locators) || act.locators.length === 0) {
      problems.push(`action[${i}]: no locators`);
    } else {
      act.locators.forEach((c, j) => { if (!validCandidate(c)) problems.push(`action[${i}].locators[${j}]: malformed`); });
      // The one shape rule the deterministic renderer refuses to emit: an action
      // locator whose lead candidate is driftable (visible text) with no stable
      // fallback drifts on replay. renderLocator is the single source of that
      // judgement — run it here, on well-formed candidates only, so the record is
      // rejected at write time (agent rewrites the step now) instead of surviving
      // to a render failure after the whole feature is recorded.
      if (act.locators.every(validCandidate)) {
        try { renderLocator(act.locators, { forAction: true }); }
        catch (e) { problems.push(`action[${i}]: ${e.message}`); }
      }
    }
    // `press` renders as `.press(key)` — the key is a keyboard key ('Enter',
    // 'Tab') carried in the action's own `key` field, not in `arg`. A press
    // recorded without it renders as an empty `.press()` that throws on replay,
    // so require the field at write time where the step can still be re-recorded.
    if (act.method === 'press' && !(typeof act.key === 'string' && act.key.length > 0)) {
      problems.push(`action[${i}]: press needs a non-empty key ('Enter', 'Tab', …)`);
    }
    checkArg(act.arg, `action[${i}].arg`);
  });

  const assertions = rec.assertions ?? [];
  if (!Array.isArray(assertions)) problems.push('assertions is not an array');
  else assertions.forEach((as, i) => {
    if (typeof as.matcher !== 'string' || !as.matcher) problems.push(`assertion[${i}]: matcher missing`);
    if (!Array.isArray(as.target) || as.target.length === 0) problems.push(`assertion[${i}]: no target`);
    else as.target.forEach((c, j) => { if (!validCandidate(c)) problems.push(`assertion[${i}].target[${j}]: malformed`); });
    // A text-content matcher (toHaveText/toContainText) takes a string or RegExp,
    // never a number — `toHaveText(5)` is invalid in Playwright and would throw on
    // replay. Reject a numeric literal on a text matcher at write time; a number
    // belongs on a numeric matcher (toHaveCount, toBeGreaterThan…). A `ref` is a
    // captured value whose type is not known here, so it is not gated.
    if (TEXT_FRAGMENT_MATCHERS.has(as.matcher) && as.value && !('ref' in as.value) && typeof as.value.literal === 'number') {
      problems.push(`assertion[${i}]: ${as.matcher} takes text, not the number ${as.value.literal} — use a numeric matcher (toHaveCount, toBeGreaterThan) for a count, or assert the text as a string`);
    }
    checkArg(as.value, `assertion[${i}].value`);
  });

  // An empty step — one that neither acts nor asserts — would render as a
  // `test.step` with a title and nothing inside it, which reads as coverage while
  // proving nothing. Refusing it here means such a step never enters the trace. A
  // step may act without asserting (a plain navigation) or assert without acting
  // (a Then that only checks), but it may not do neither.
  if (Array.isArray(actions) && Array.isArray(assertions)
      && actions.length === 0 && assertions.length === 0) {
    problems.push('step has neither an action nor an assertion — an empty step proves nothing');
  }

  return problems;
}

/**
 * Append one validated record to the feature's trace.
 *
 * Rejects a malformed record rather than writing it: a broken line in the
 * .trace.jsonl would surface as a render failure or, worse, a silently wrong
 * spec, far from the step that produced it.
 *
 * The already-written records are the ref-resolution context: their declared
 * values (plus this record's own) are the names this record's refs may resolve
 * to, so a step that references an undeclared value is rejected here — at the
 * step that produced it — rather than at render after the whole feature is
 * recorded. Reading the prefix is the same read the "recorded step N" count
 * already does; on the first record it is empty.
 */
export function appendTrace(featurePath, record) {
  const priorValues = {};
  for (const rec of readTrace(featurePath)) Object.assign(priorValues, rec.values ?? {});
  const problems = validateRecord(record, priorValues);
  if (problems.length) throw new Error(`invalid trace record:\n  ${problems.join('\n  ')}`);
  const tracePath = featureToTrace(featurePath);
  mkdirSync(dirname(tracePath), { recursive: true });
  appendFileSync(tracePath, JSON.stringify(record) + '\n');
  return tracePath;
}

/**
 * Read a feature's trace as an array of records, in recorded order.
 *
 * A blank or absent trace is an empty array, not an error: the first attempt
 * starts from nothing. A malformed line is fatal — a half-written record means
 * the resume prefix would be wrong, and continuing on it hides that.
 */
export function readTrace(featurePath) {
  const tracePath = featureToTrace(featurePath);
  if (!existsSync(tracePath)) return [];
  const text = readFileSync(tracePath, 'utf8');
  const records = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let rec;
    try { rec = JSON.parse(trimmed); }
    catch { throw new Error(`${tracePath}:${i + 1}: not valid JSON`); }
    const problems = validateRecord(rec);
    if (problems.length) throw new Error(`${tracePath}:${i + 1}: invalid record:\n  ${problems.join('\n  ')}`);
    records.push(rec);
  });
  return records;
}

/**
 * The index of the earliest record whose step failed to replay — the point a
 * resume should pick up from.
 *
 * The replay gate reports which step titles went red (`failedTitles`), and a
 * record's `step` is that same title. So the first record whose step is among
 * the failed titles is the earliest thing wrong, and every record before it
 * replayed clean and is worth keeping as a prefix.
 *
 * @returns the 0-based index of that record, or null when no failed title
 *          matches any record (nothing safe to resume from — re-record whole).
 */
export function resumeIndexFromFailures(trace, failedTitles) {
  if (!failedTitles?.length) return null;
  const failed = new Set(failedTitles.map(normalise));
  for (let i = 0; i < trace.length; i++) {
    if (failed.has(normalise(trace[i].step))) return i;
  }
  return null;
}

/**
 * Copy a feature's trace to `<trace>.bak` before it is truncated or discarded.
 *
 * Truncating and `--restart` both rewrite or delete the trace, and a resume that
 * misfires — or an agent that mislabels a takeover point — can shorten it in a
 * way that is expensive to recover by hand (a 75-step recording once collapsed to
 * one). The `.bak` is a single-slot undo: overwritten each time, so it always
 * holds the trace as it stood immediately before the last destructive write. A
 * missing or empty trace has nothing to back up and is a no-op.
 *
 * @returns the backup path when one was written, or null when there was nothing
 *          to back up.
 */
export function backupTrace(featurePath) {
  const tracePath = featureToTrace(featurePath);
  if (!existsSync(tracePath)) return null;
  const bakPath = `${tracePath}.bak`;
  copyFileSync(tracePath, bakPath);
  return bakPath;
}

/**
 * Truncate a feature's trace to its first `count` records, rewriting the file.
 *
 * Used to drop a failed step and everything after it before a resume: the kept
 * prefix is the records that replayed clean, and the agent re-records from there.
 * Writing the shortened trace back (rather than passing a slice around) keeps the
 * file the single source of truth — a resume run's `record-step` appends onto
 * exactly this prefix. The pre-truncation trace is copied to `.bak` first, so a
 * wrong `count` never loses the records it dropped.
 */
export function truncateTrace(featurePath, count) {
  const tracePath = featureToTrace(featurePath);
  backupTrace(featurePath);
  const kept = readTrace(featurePath).slice(0, count);
  writeFileSync(tracePath, kept.map(r => JSON.stringify(r) + '\n').join(''));
  return kept.length;
}
