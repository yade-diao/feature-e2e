/**
 * Counting a locator candidate's matches on the live page — the tool-enforced
 * uniqueness check that record_step runs before it will append a step.
 *
 * The problem this exists to solve: verify.md asks the agent to count every
 * candidate to exactly one and rewrite anything that matches more, but the agent
 * can skip that — nothing made it, and record-step (plain Node) could not
 * re-count. So a non-unique locator reached the trace and only blew up at replay
 * (strict mode). Here the count is taken by the tool, on the real page, at the
 * moment the step is recorded: the agent cannot skip it and cannot fake it.
 *
 * How the count is taken — with Playwright's OWN engine, not an approximation.
 * A candidate is turned into a Playwright locator EXPRESSION (getByRole/
 * getByTestId/…) and handed to browser_evaluate's `target`, which resolves it in
 * Node with `page.locator(...)` — the real getByRole, the real accessible-name
 * and role computation, the real strict-mode. The reply tells us the count
 * unambiguously (see interpretEvaluateReply):
 *   - it resolved and ran            → exactly 1 match     → unique, allowed
 *   - "strict mode violation … resolved to N elements" → N (>1) matches → refused
 *   - "does not match any elements"  → 0 matches          → refused
 * This replaces an earlier hand-written DOM-predicate approximation that could not
 * keep up with Playwright's semantics (native `<input>` carries no `role`
 * attribute, so `role=textbox` counted 0 and every login step was refused). There
 * is no approximation left: the judge is Playwright itself. The injected-replay
 * gate stays as a cheap second net.
 */

import { renderCandidate } from './render-spec.mjs';

/**
 * The Playwright locator expression for one candidate, as the string handed to
 * browser_evaluate's `target` (Playwright parses it in Node with its own locator
 * parser). This MUST be the exact expression the final spec uses, or "unique at
 * record time" and "the locator in the spec" could drift — so it reuses
 * render-spec's renderCandidate (the single source of the candidate→getByX
 * mapping) and only drops the leading `page.` that browser_evaluate's target does
 * not want.
 *
 *   role → getByRole(...) · testid → getByTestId(...) · label → getByLabel(...)
 *   placeholder → getByPlaceholder(...) · text → getByText(...)
 */
export function candidateLocatorExpr(c) {
  return renderCandidate(c).replace(/^page\./, '');
}

/**
 * Interpret one browser_evaluate reply issued against a candidate locator, into a
 * match count. Playwright's engine already did the counting; we only read its verdict:
 *   - a normal result (it ran)               → 1  (the locator resolved to one element)
 *   - "resolved to N elements" (strict mode) → N  (>1, the offender)
 *   - "does not match any elements"          → 0
 *   - anything else / no reply               → null (cannot be trusted → refuse)
 *
 * @param reply the JSON-RPC `result` object of the browser_evaluate call, or null
 */
export function interpretEvaluateReply(reply) {
  const text = reply?.content?.find(p => p?.type === 'text')?.text;
  if (text == null) return null;
  const s = String(text);
  if (reply.isError) {
    const strict = s.match(/resolved to (\d+) elements/);
    if (strict) return Number(strict[1]);
    if (/does not match any elements/.test(s)) return 0;
    return null;   // some other error (bad selector, detached, timeout) — refuse
  }
  // A non-error reply means the single-element evaluate ran: exactly one match.
  return 1;
}

/** Methods that put text into a field and therefore need an editable target. */
export const EDITING_METHODS = new Set(['fill', 'type']);

/**
 * The page-context function (for browser_evaluate, run on the element the target
 * locator resolved to) that answers: is THIS element one a fill/type can put text
 * into — a native `<input>`/`<textarea>` or a contenteditable?
 *
 * It checks the resolved element ITSELF, not its subtree. This is deliberate and
 * matches Playwright's `.fill()`: fill lands on the element the locator resolves
 * to, and only succeeds if that element is editable — a wrapper `<div>` that
 * merely *contains* an input is not fillable, so counting a descendant would give
 * the wrong verdict (it would bless the wrapper the trap is about). To reach the
 * inner field the candidate carries an `inner` selector, and the locator then
 * resolves to that input directly, which this check then sees as editable.
 *
 * Returns the marker 'editable' / 'not-editable' (interpretEditabilityReply reads
 * it back), not a boolean, so it survives the official server's result formatting.
 * Reads the DOM only — no mutation.
 */
export function editabilityCheckExpr() {
  return `(el) => {
  if (!el) return 'not-editable';
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea') return 'editable';
  if (el.isContentEditable) return 'editable';
  return 'not-editable';
}`;
}

/**
 * Read an editability check's browser_evaluate reply into a verdict:
 *   true  → the target can take text
 *   false → it cannot — a wrapper mis-target
 *   null  → the check could not run (no reply, an error) — do not trust, refuse
 *
 * Only the value under the official `### Result` header is read, NOT the whole
 * reply: the official server echoes the evaluated function source under a
 * "### Ran Playwright code" section, and that source contains the literal
 * 'not-editable' — matching against the whole text would read the echo, not the
 * result, and always report not-editable.
 */
export function interpretEditabilityReply(reply) {
  const text = reply?.content?.find(p => p?.type === 'text')?.text;
  if (text == null || reply.isError) return null;
  const s = String(text);
  const m = s.match(/###\s*Result\s*\n\s*"?(editable|not-editable)"?/);
  if (!m) return null;
  return m[1] === 'editable';
}

/** The message when a fill/type target is unique but not editable (the wrapper trap). */
export function editabilityRejection(record, offenders) {
  const lines = offenders.map(o =>
    `  action[${o.actionIndex}].locators[${o.candidateIndex}] (${o.method}, ${describeCandidate(o.candidate)})`
    + (o.editable === null ? ' could not be checked for editability' : ' resolves to an element that cannot take text'));
  return `step ${JSON.stringify(record.step)}: a ${[...EDITING_METHODS].join('/')} targets an element that is not editable:\n`
    + lines.join('\n')
    + `\n\nThis is the UI5 wrapper trap: the locator is unique but points at the wrapper, not the native`
    + ` <input> inside it, so the fill would silently do nothing. Reach the inner field by adding an`
    + ` \`inner\` selector to the candidate — e.g. testid with \`"inner": "#inner"\` (or \`"input"\`) — as the`
    + ` UI5 interaction convention describes, then record the step again.`;
}

/**
 * Every action-locator candidate in a record, flattened with its position, so the
 * caller can count each and report exactly which one is not unique. Assertions are
 * not included — an assertion legitimately matches ≠1 (absence, a list count), and
 * verify.md blesses a single/`.or()` assertion locator; strict mode only bites on
 * actions. `goto` has no locators and contributes nothing.
 */
export function actionCandidates(record) {
  const out = [];
  (record.actions ?? []).forEach((action, actionIndex) => {
    (action.locators ?? []).forEach((candidate, candidateIndex) => {
      out.push({ actionIndex, candidateIndex, method: action.method, candidate });
    });
  });
  return out;
}

/**
 * Check every action-locator candidate in a record is unique on the live page.
 *
 * `countOne(locatorExpr)` resolves the candidate's Playwright locator expression on
 * the real page and returns its match count — injected so this stays a pure
 * decision function (the real one issues a browser_evaluate with `target` set to
 * the expression, then reads interpretEvaluateReply; tests pass a stub). Any
 * candidate whose count is not exactly 1 is an offender; a record with no
 * offenders passes.
 *
 * @returns {{ ok: boolean, offenders: Array<{actionIndex,candidateIndex,method,candidate,count}> }}
 */
export async function checkRecordUniqueness(record, countOne) {
  const offenders = [];
  for (const item of actionCandidates(record)) {
    const count = await countOne(candidateLocatorExpr(item.candidate));
    if (count !== 1) offenders.push({ ...item, count });
  }
  return { ok: offenders.length === 0, offenders };
}

/**
 * The message handed back to the agent when record_step is refused — names each
 * non-unique candidate and its count, and points at the fix, so the agent rewrites
 * the offending candidate rather than guessing. This is the tool speaking the same
 * language verify.md's Locators rule does.
 */
export function uniquenessRejection(record, offenders) {
  const lines = offenders.map(o => {
    const found = o.count == null
      ? 'could not be counted (the page did not return a number)'
      : `matched ${o.count} elements, not 1`;
    return `  action[${o.actionIndex}].locators[${o.candidateIndex}] (${o.method}, ${describeCandidate(o.candidate)}) ${found}`;
  });
  return `step ${JSON.stringify(record.step)}: ${offenders.length} locator candidate(s) are not unique on the page:\n`
    + lines.join('\n')
    + `\n\nEach candidate must identify exactly one element. Rewrite the non-unique one with a`
    + ` distinguishing scope — a role+accessible-name, a stable testid, or for a list row/card the`
    + ` row's own text — then record the step again. A candidate that matches several elements throws`
    + ` a strict-mode violation the moment the action runs.`;
}

/** A short human tag for a candidate, for the rejection message. */
export function describeCandidate(c) {
  switch (c.kind) {
    case 'role': return `role=${c.role}${c.name != null ? ` name=${JSON.stringify(c.name)}` : ''}`;
    case 'testid': return `testid=${JSON.stringify(c.id)}`;
    case 'label': return `label=${JSON.stringify(c.text)}`;
    case 'placeholder': return `placeholder=${JSON.stringify(c.text)}`;
    case 'text': return `text=${JSON.stringify(c.text)}`;
    case 'locator': return `locator=${JSON.stringify(c.expr)}`;
    default: return `kind=${c.kind}`;
  }
}
