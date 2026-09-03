/**
 * The proxy's message-routing logic — the pure decisions the stdio glue makes,
 * kept here so they can be tested without spawning anything.
 *
 * The proxy sits between the agent (Claude) and the official Playwright MCP
 * server it spawns. Almost every message is relayed verbatim to the official
 * server. Two are special:
 *   - tools/list: the official tool list comes back, and `record_step` is appended
 *     so the agent sees it as just another tool.
 *   - tools/call for `record_step`: the proxy handles it itself (counts each
 *     candidate via the official browser_evaluate, then appends the trace record),
 *     rather than relaying it.
 *
 * Everything here is a pure function of a parsed JSON-RPC message; the transport,
 * the spawn, and the browser_evaluate round-trip live in the glue layer.
 */

/**
 * The record_step tool as the agent sees it. Its input is one trace record — the
 * same shape record-step took on the command line — so the agent builds the same
 * structured record it always did, but now the tool counts every action-locator
 * candidate on the live page before it will append, and refuses a non-unique one.
 */
export const RECORD_STEP_TOOL = {
  name: 'record_step',
  description:
    'Record one verified feature step as a trace record. Before appending, every '
    + 'action-locator candidate is counted on the live page; if any matches other '
    + 'than exactly one element the step is refused, naming the offender and its '
    + 'count, and you must rewrite that candidate and call record_step again. This '
    + 'is the only way to record a step.',
  inputSchema: {
    type: 'object',
    properties: {
      feature: { type: 'string', description: 'The .feature file path this step belongs to (pass it in every call).' },
      scenario: { type: 'string', description: 'The Scenario name.' },
      step: { type: 'string', description: 'The feature step verbatim, Gherkin keyword and all.' },
      values: { type: 'object', description: 'Named dynamic/fixed values this step introduces.' },
      actions: { type: 'array', description: 'The actions driven, each with method, locators, arg.' },
      assertions: { type: 'array', description: 'The assertions that prove the step held.' },
    },
    required: ['feature', 'scenario', 'step'],
  },
};

/** Is this parsed message a JSON-RPC request (has an id and a method)? */
export function isRequest(msg) {
  return msg != null && typeof msg === 'object' && 'method' in msg && 'id' in msg;
}

/** Is this a tools/list request? */
export function isToolsList(msg) {
  return isRequest(msg) && msg.method === 'tools/list';
}

/** Is this a tools/call for our own record_step tool (proxy handles it, not relayed)? */
export function isRecordStepCall(msg) {
  return isRequest(msg) && msg.method === 'tools/call' && msg.params?.name === 'record_step';
}

/**
 * A snapshot ref, the one-shot handle Playwright puts in an accessibility snapshot
 * (`e12`, `f3e1356`). It is session-local and invalidated by any re-render — the
 * exact opposite of a persistent locator — so it must never be what an action is
 * driven by. The official server distinguishes a ref from a selector with this
 * same pattern (targetLocator: `/^(f\d+)?e\d+$/`).
 */
export function isSnapshotRef(target) {
  return typeof target === 'string' && /^(f\d+)?e\d+$/.test(target.trim());
}

/**
 * The official tools that DRIVE an element (they land in the recording) and take a
 * `target`. A ref is only wrong for these — a read-only look (snapshot/find) may
 * legitimately reference a ref. `browser_evaluate` is excluded: the proxy itself
 * issues evaluates with a locator target, and the agent's own read-only evaluates
 * are not actions that get recorded.
 */
const ACTION_TOOLS = new Set([
  'browser_click', 'browser_type', 'browser_fill_form', 'browser_hover',
  'browser_drag', 'browser_select_option', 'browser_press_key',
]);

/** Action tools that put text into a field, so their target must be editable. */
const EDITING_ACTION_TOOLS = new Set(['browser_type', 'browser_fill_form']);

/**
 * Is this a tools/call that DRIVES an element by a persistent locator `target`
 * (not a ref)? These are the actions the proxy verifies BEFORE relaying them: it
 * counts the target on the CURRENT page (where the action is about to happen) and
 * refuses a non-unique/non-editable one, so verification lands on the page the
 * element actually lives on — the fix for a step whose actions cross pages (fill a
 * login form on the login page, submit, land on a new page: the login-form
 * locators can only be counted before the submit navigates away).
 */
export function isActionCall(msg) {
  return isRequest(msg) && msg.method === 'tools/call'
    && ACTION_TOOLS.has(msg.params?.name)
    && typeof msg.params?.arguments?.target === 'string'
    && !isSnapshotRef(msg.params.arguments.target);
}

/** Does this action tool need its target to be editable (a fill/type)? */
export function actionNeedsEditable(toolName) {
  return EDITING_ACTION_TOOLS.has(toolName);
}

/**
 * Is this an action tool call whose `target` is a snapshot ref? Such a call points
 * the action at a one-shot handle: it may click the right element now, but the
 * agent then has to *guess* a persistent locator to record — and the guess can
 * miss (matched 0), stranding the step. Forcing the action itself onto a persistent
 * locator makes "can click" and "can record" the same fact.
 */
export function isRefAction(msg) {
  return isRequest(msg) && msg.method === 'tools/call'
    && ACTION_TOOLS.has(msg.params?.name)
    && isSnapshotRef(msg.params?.arguments?.target);
}

/** The refusal handed back when an action is driven by a snapshot ref. */
export function refActionRejection(toolName, target) {
  return `${toolName} was called with target ${JSON.stringify(target)}, a snapshot ref.`
    + ` A ref is a one-shot handle — it cannot go into a replayable spec, and driving an action`
    + ` by ref then forces you to guess a separate persistent locator to record, which is how a`
    + ` step ends up matching 0. Drive the action with the SAME persistent locator you will`
    + ` record: a Playwright locator expression as \`target\` — e.g.`
    + ` \`getByRole('button', { name: 'Create Promotion' })\`, \`getByTestId('...')\`, or a`
    + ` \`getByTestId('...').locator('#inner')\` chain for a UI5 field. If a locator does not`
    + ` resolve, look with browser_snapshot/browser_find and consult the UI5 interaction`
    + ` convention — do not fall back to the ref.`;
}

/**
 * Patterns that make a browser_evaluate function DRIVE the page rather than read
 * it — DOM interaction: dispatching events, clicking, setting a control's value or
 * checked/selected state, focus/blur, editing markup. These are exactly what an
 * agent must NOT do through evaluate: an evaluate interaction cannot be rendered
 * into the spec (the trace has no "run this script" action — only
 * `locator.click()/.fill()/…`), so a step done this way records as a standard
 * action it did not actually perform, and replay drifts. `browser_evaluate` is a
 * *look* tool (read a value, fetch an OData check); driving is done with the
 * persistent-locator action tools, which is what reaches the spec.
 *
 * Reads (`.textContent`, `.value` read, `getAttribute`, `fetch(url)` for a check,
 * `querySelectorAll` to count) do not match and stay allowed.
 */
const EVALUATE_MUTATION_PATTERNS = [
  /\.click\s*\(/,
  /\.dispatchEvent\s*\(/,
  /\.value\s*=(?!=)/,           // assignment, not === comparison
  /\.checked\s*=(?!=)/,
  /\.selected\s*=(?!=)/,
  /\.innerHTML\s*=(?!=)/,
  /\.innerText\s*=(?!=)/,
  /\.textContent\s*=(?!=)/,
  /\.focus\s*\(/,
  /\.blur\s*\(/,
  /\.select\s*\(\s*\)/,         // el.select() (select all text), not Array.select
  /\.setAttribute\s*\(/,
  /\.removeAttribute\s*\(/,
  /\.submit\s*\(/,
  /\.setSelectionRange\s*\(/,
];

/**
 * Does this function SOURCE drive the page (a mutation) rather than read it? The
 * pure predicate over the fn string — the single source of the read-only rule,
 * shared by isMutatingEvaluate (which checks an MCP message) and the shadow's
 * read-only probe guard (which checks a Judger's probe fn). A read-only evaluate
 * — the legitimate "look" use — is not matched.
 */
export function isMutatingEvaluateFn(fn) {
  if (typeof fn !== 'string') return false;
  return EVALUATE_MUTATION_PATTERNS.some(re => re.test(fn));
}

/**
 * Is this a browser_evaluate whose function DRIVES the page (a mutation), rather
 * than reading it? Only the function source is inspected. A read-only evaluate —
 * the legitimate "look" use — is not matched.
 */
export function isMutatingEvaluate(msg) {
  if (!isRequest(msg) || msg.method !== 'tools/call' || msg.params?.name !== 'browser_evaluate') return false;
  return isMutatingEvaluateFn(msg.params?.arguments?.function);
}

/** The refusal handed back when browser_evaluate is used to drive the page. */
export function mutatingEvaluateRejection() {
  return `browser_evaluate was called with a function that drives the page`
    + ` (a click, a value/checked assignment, dispatchEvent, focus, or similar DOM mutation).`
    + ` browser_evaluate is a READ-ONLY look — use it to check state (read a value/text, count`
    + ` elements, fetch an OData endpoint), never to perform an interaction. An evaluate`
    + ` interaction cannot be recorded: the trace only holds standard actions`
    + ` (\`locator.click()\`, \`locator.fill()\`, …), so a step done through evaluate records as`
    + ` an action you did not actually perform and drifts on replay. Perform the interaction with`
    + ` a persistent-locator action instead — \`browser_click\`/\`browser_type\` on a`
    + ` \`getByRole\`/\`getByTestId\` locator, or a \`getByTestId('...').locator('#inner')\` chain`
    + ` to reach a UI5 field's native input (a real \`.fill()\` there fires the native events UI5`
    + ` needs, and it is what the spec will replay). See the UI5 interaction convention.`;
}

/**
 * Append record_step to a tools/list *result*, so the merged list is what the
 * agent sees. Leaves the official tools untouched and in order; adds ours last.
 * Defensive about the result shape (an object with a `tools` array).
 */
export function injectRecordStep(toolsListResult) {
  const tools = Array.isArray(toolsListResult?.tools) ? toolsListResult.tools : [];
  // Never add it twice (a re-issued tools/list, or an upstream that already has one).
  if (tools.some(t => t?.name === 'record_step')) return toolsListResult;
  return { ...toolsListResult, tools: [...tools, RECORD_STEP_TOOL] };
}

/**
 * Build the browser_evaluate tools/call request the proxy issues against a
 * candidate with Playwright's own engine. `id` must be from the proxy's own id
 * space (kept disjoint from the agent's, so replies are told apart). `locatorExpr`
 * is a Playwright locator expression (candidateLocatorExpr output, e.g.
 * `getByRole('textbox', { name: '密码' })`); passing it as `target` makes the
 * official server resolve it in Node with `page.locator(...)` — the real getByRole,
 * accessible-name, and strict-mode.
 *
 * `fn` is the function evaluated on the resolved element. It defaults to a no-op
 * `() => 1` for the uniqueness count: it runs when the locator resolves to exactly
 * one, and the server errors with "resolved to N elements" (>1) or "does not match"
 * (0) — which interpretEvaluateReply turns into the count. The editability check
 * passes its own fn (editabilityCheckExpr) to read the resolved element instead.
 *
 * `intent` and `element` are required by the official tool (a bare call is
 * rejected with an invalid_type error).
 */
export function evaluateRequest(id, locatorExpr, fn = '() => 1') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'browser_evaluate',
      arguments: {
        intent: 'resolve a locator candidate for the record_step checks',
        target: locatorExpr,
        element: 'locator candidate under the record_step checks',
        function: fn,
      },
    },
  };
}

/** A JSON-RPC result envelope for a tool call the proxy handled itself. */
export function toolResult(id, text, isError = false) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } };
}
