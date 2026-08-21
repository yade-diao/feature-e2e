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
