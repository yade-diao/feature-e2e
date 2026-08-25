/**
 * Read a recorded spec by parsing it, not by matching text against it.
 *
 * Every check here used to scrape the source with regular expressions, and that
 * was not a stylistic shortcut — it was a hole. The pattern for an action
 * required `page` and `.getByText(` to sit next to each other, so a chain the
 * generator had formatted across lines matched nothing at all, and the locator
 * redundancy gate passed every multi-line action it existed to reject. The
 * generator formats long chains across lines as a matter of course, so that was
 * most of them.
 *
 * Widening the pattern would have bought one formatting variation. A comment
 * inside the chain, a template literal, a helper holding the locator — each is
 * the same bug again. A parser has no opinion about whitespace, so none of those
 * can come back.
 *
 * `@typescript-eslint/parser` is already a dependency: the banned-patterns gate
 * runs ESLint over these files with it.
 */

import { readFileSync } from 'fs';
import { parse } from '@typescript-eslint/parser';

const cache = new Map();

/** Parse a spec once per path+content. */
function tree(specPath) {
  const source = readFileSync(specPath, 'utf8');
  const hit = cache.get(specPath);
  if (hit && hit.source === source) return hit;
  const entry = { source, ast: parse(source, { range: true, loc: true }) };
  cache.set(specPath, entry);
  return entry;
}

/** Every node in the tree, depth first. */
function* walk(node) {
  if (!node || typeof node.type !== 'string') return;
  yield node;
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) yield* walk(child);
    } else if (value && typeof value.type === 'string') {
      yield* walk(value);
    }
  }
}

/**
 * The string a node denotes, or null if it does not denote one statically.
 *
 * The parser has already decoded the escapes, which is the other thing the old
 * regex had to do by hand: it captured raw source, so a title written with
 * `“` arrived as the six characters that spell it rather than the quote it
 * means, and then failed to match its feature step.
 */
function staticString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map(q => q.value.cooked ?? '').join('');
  }
  return null;
}

/**
 * Every `test.step(...)` call, with its title and the source of its callback.
 *
 * The body is the callback's own range, so a step containing a nested step keeps
 * the nested one inside it — which is what liveness wants to see. The old
 * version sliced from one title to the next, which cut an outer step short at
 * its first child.
 */
export function testSteps(specPath) {
  const { source, ast } = tree(specPath);
  const steps = [];
  for (const node of walk(ast)) {
    if (node.type !== 'CallExpression') continue;
    const callee = node.callee;
    if (callee.type !== 'MemberExpression' || callee.computed) continue;
    if (callee.property.type !== 'Identifier' || callee.property.name !== 'step') continue;
    if (callee.object.type !== 'Identifier' || callee.object.name !== 'test') continue;

    const title = staticString(node.arguments[0]);
    if (title === null) continue;
    const body = node.arguments[1];
    steps.push({
      title,
      body: body ? source.slice(body.range[0], body.range[1]) : '',
      line: node.loc.start.line,
    });
  }
  return steps;
}

/**
 * Every string the spec actually contains, comments excluded.
 *
 * Excluded for free: the parser does not hand back comment text, so the old
 * strip-the-comments-with-a-regex pass is gone along with the cases it got
 * wrong (a `//` inside a string literal took the rest of the line with it).
 */
export function specStrings(specPath) {
  const { ast } = tree(specPath);
  const out = [];
  for (const node of walk(ast)) {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      out.push(node.value);
    } else if (node.type === 'TemplateLiteral') {
      for (const quasi of node.quasis) {
        const text = quasi.value.cooked ?? '';
        if (text) out.push(text);
      }
    }
  }
  return out;
}

/**
 * Every node, paired with the node that encloses it.
 *
 * `walk` answers questions about a node in isolation, which is all the checks
 * ever needed. Cutting a spec is a question about where a node *sits*: which
 * test holds it, and which calls are still open after it.
 */
function* walkWithParent(node, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  yield [node, parent];
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) yield* walkWithParent(child, node);
    } else if (value && typeof value.type === 'string') {
      yield* walkWithParent(value, node);
    }
  }
}

/** The nearest call a node sits inside, or null at the top level. */
function enclosingCall(node, parents) {
  for (let p = parents.get(node); p; p = parents.get(p)) {
    if (p.type === 'CallExpression') return p;
  }
  return null;
}

/**
 * `test(...)` — one scenario. Not `test.step(...)`, not `test.describe(...)`.
 *
 * The modifiers count too. A `test.only` or `test.skip` earlier in the file is
 * still a test the seed would carry, and counting only the bare form let one
 * through: the guard below saw a single test, the slice kept both, and with
 * `only` in play Playwright runs the wrong one. Nothing here can see a test
 * imported under another name (`import { test as it }`); the generator does not
 * write that, and a seed built from one would be caught by the parse at the end
 * only if it happened not to parse.
 */
const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail', 'slow']);

const isTestCall = (node) => {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type === 'Identifier') return callee.name === 'test';
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  return callee.object.type === 'Identifier' && callee.object.name === 'test'
    && callee.property.type === 'Identifier' && TEST_MODIFIERS.has(callee.property.name);
};

const isStepCall = node =>
  node.type === 'CallExpression'
  && node.callee.type === 'MemberExpression' && !node.callee.computed
  && node.callee.property.type === 'Identifier' && node.callee.property.name === 'step'
  && node.callee.object.type === 'Identifier' && node.callee.object.name === 'test';

/** The indentation of the line a node opens on. */
function indentOf(source, node) {
  const lineStart = source.lastIndexOf('\n', node.range[0] - 1) + 1;
  return source.slice(lineStart, node.range[0]).match(/^[ \t]*/)[0];
}

/**
 * How long the replayed prefix may take before the seed gives up.
 *
 * The MCP server runs a seed with `timeout: 0` — no per-test bound — which is
 * right for the blank seed it was written for, and wrong for this one: a resume
 * seed replays real clicks, and a Playwright action carries no timeout of its
 * own unless the config sets one. A prefix whose locator has since gone missing
 * would then hang until the recorder killed the whole agent, with no critique
 * to show for the attempt. The seed sets its own bound instead.
 */
const RESUME_TIMEOUT_MS = 300_000;

/**
 * The spec's source up through the last `test.step` that ends before
 * `cutoffLine`, closed so the result parses and runs on its own.
 *
 * This is what lets a retry replay the part that already worked — for real,
 * with Playwright, no model involved — and hand the agent only the part the
 * gates actually objected to, instead of re-driving the whole feature again.
 *
 * Everything about the file's shape is read off the parse. An earlier version
 * appended a fixed `});\n});` because that is how a recorded spec is nested,
 * and produced a file that did not parse the moment the shape differed: one
 * closer short when the cut landed inside a nested step, one too many when the
 * spec had no `test.describe`. Either way the seed failed to load and the
 * attempt was lost — the same class of mistake as reading a spec with a regex.
 *
 * @returns the truncated source, or null when there is nothing safe to keep —
 *          the retry then gets the ordinary blank seed.
 */
export function truncateBeforeLine(specPath, cutoffLine) {
  const { source, ast } = tree(specPath);

  const parents = new Map();
  for (const [node, parent] of walkWithParent(ast)) parents.set(node, parent);
  const nodes = [...parents.keys()];

  // A seed holds exactly one test. Playwright pauses at the end of *every* test
  // function and the generator attaches at the first pause, so a seed carrying
  // two tests hands it the page as it stood at the end of the first — not where
  // the last attempt stopped. Emitting only the test the cut falls in would fix
  // the landing but lose the other scenarios' source from the journal, and with
  // it any way for the retry to write them back. A feature with more than one
  // scenario therefore re-records from the blank seed, as it did before any of
  // this existed.
  const tests = nodes.filter(isTestCall);
  if (tests.length !== 1) return null;
  const theTest = tests[0];

  const callback = theTest.arguments.find(a =>
    a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression');
  if (!callback || callback.body.type !== 'BlockStatement') return null;
  const blockOpen = callback.body.range[0];   // the `{` of the test body

  let kept = null;
  for (const node of nodes) {
    if (!isStepCall(node)) continue;
    // Only the steps the test holds directly. A nested step belongs to its
    // parent; keeping it on its own would cut that parent in half.
    if (enclosingCall(node, parents) !== theTest) continue;
    // The step must be entirely clear of the cutoff — checking only where it
    // *starts* would let a step that straddles the cutoff (starts before it,
    // but its body runs past it, which is exactly where the first offending
    // line tends to live) through as "safe", freezing the very thing the
    // cutoff was computed to exclude into every future retry's seed.
    if (node.loc.end.line >= cutoffLine) continue;
    if (kept === null || node.range[1] > kept.range[1]) kept = node;
  }
  if (kept === null) return null;

  // The call sits in `await test.step(...);` — include the semicolon so the
  // truncated source doesn't end mid-statement.
  let end = kept.range[1];
  if (source[end] === ';') end += 1;

  // Close exactly the calls the kept step sits inside, innermost first, each at
  // the indentation it opened on.
  const closers = [];
  for (let call = enclosingCall(kept, parents); call; call = enclosingCall(call, parents)) {
    closers.push(`${indentOf(source, call)}});`);
  }

  const out = source.slice(0, blockOpen + 1)
    + `\n${indentOf(source, kept)}test.setTimeout(${RESUME_TIMEOUT_MS});`
    + `   // the seed's own bound — not part of the recording`
    + source.slice(blockOpen + 1, end)
    + `\n${closers.join('\n')}\n`;

  // Whatever this function still gets wrong about a shape it has not seen shows
  // up here, as a retry that falls back to the blank seed, rather than as a seed
  // Playwright cannot load and an attempt spent finding that out.
  try { parse(out, { range: true, loc: true }); } catch { return null; }
  return out;
}

/** Locator methods whose result depends on wording, markup or raw CSS. */
const DRIFTABLE_SOURCE = new Set(['getByText', 'getByAltText', 'getByTitle', 'locator']);

/** Anything that starts or continues a locator chain. */
const LOCATOR_METHOD = /^(?:getBy\w+|locator|or|and|filter|first|last|nth|frameLocator|getByRole)$/;

/**
 * The methods a locator chain is built from, tail first, following a variable
 * back to whatever it was assigned.
 *
 * `$page` marks a chain that reaches `page`, which is what tells a locator apart
 * from any other method call that happens to end in `.click()`.
 */
function chainMethods(node, vars, seen = new Set()) {
  const methods = [];
  let cur = node;
  while (cur) {
    if (cur.type === 'AwaitExpression') { cur = cur.argument; continue; }
    if (cur.type === 'TSNonNullExpression') { cur = cur.expression; continue; }
    if (cur.type === 'CallExpression') {
      const callee = cur.callee;
      if (callee.type === 'MemberExpression' && !callee.computed
          && callee.property.type === 'Identifier') {
        methods.push(callee.property.name);
        cur = callee.object;
        continue;
      }
      return methods;
    }
    if (cur.type === 'MemberExpression' && !cur.computed) { cur = cur.object; continue; }
    if (cur.type === 'Identifier') {
      if (cur.name === 'page') { methods.push('$page'); return methods; }
      if (seen.has(cur.name)) return methods;      // a self-referential assignment
      seen.add(cur.name);
      const init = vars.get(cur.name);
      if (!init) return methods;
      return [...methods, ...chainMethods(init, vars, seen)];
    }
    return methods;
  }
  return methods;
}

/**
 * Every call of one of `actionMethods` made on a locator chain.
 *
 * @returns {Array<{ line: number, method: string, chain: string, methods: string[],
 *                   driftable: boolean, hasFallback: boolean }>}
 */
export function actionLocators(specPath, actionMethods) {
  const { source, ast } = tree(specPath);
  const wanted = new Set(actionMethods);

  const vars = new Map();
  for (const node of walk(ast)) {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      vars.set(node.id.name, node.init);
    }
  }

  const found = [];
  for (const node of walk(ast)) {
    if (node.type !== 'CallExpression') continue;
    const callee = node.callee;
    if (callee.type !== 'MemberExpression' || callee.computed) continue;
    if (callee.property.type !== 'Identifier' || !wanted.has(callee.property.name)) continue;

    const methods = chainMethods(callee.object, vars);
    // Not a locator: no chain reaching `page`, and nothing that builds a locator.
    if (!methods.includes('$page') && !methods.some(m => LOCATOR_METHOD.test(m))) continue;

    found.push({
      line: callee.property.loc.start.line,
      method: callee.property.name,
      chain: source.slice(callee.object.range[0], callee.object.range[1]).replace(/\s+/g, ' ').trim(),
      methods,
      driftable: methods.some(m => DRIFTABLE_SOURCE.has(m)),
      hasFallback: methods.includes('or'),
    });
  }
  return found;
}
