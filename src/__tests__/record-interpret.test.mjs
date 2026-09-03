/**
 * The shared record-interpret layer's contract: it executes a record the SAME
 * way render-spec.mjs renders it.
 *
 * The equivalence that matters — and the one a comment cannot guarantee — is that
 * the candidate a shadow-run drives is the candidate the spec text names. So the
 * load-bearing test asserts `locatorExpr(c)` equals render-spec's
 * `renderCandidate(c)` minus `page.` for every kind: one candidate→getByX mapping,
 * proven, not promised. If someone edits render-spec's candidate rendering and not
 * this, this test goes red — which is the point.
 *
 * buildLocator is exercised against a stub page that records the getByX / locator
 * calls, so we assert the live-locator path takes the same shape without a real
 * browser. Value resolution and the goto path rule are pure and tested directly.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderCandidate } from '../render-spec.mjs';
import { locatorExpr, buildLocator, resolveValues, runAction } from '../record-interpret.mjs';

// Every candidate kind the renderer knows, one representative each.
const CANDIDATES = [
  { kind: 'role', role: 'button', name: 'Save' },
  { kind: 'role', role: 'button', name: 'Save', exact: true },
  { kind: 'role', role: 'row' },                                  // no name
  { kind: 'testid', id: 'promo-save' },
  { kind: 'testid', id: 'promotionName', inner: '#inner' },
  { kind: 'label', text: 'Customer' },
  { kind: 'label', text: 'Customer', exact: true },
  { kind: 'placeholder', text: 'Search' },
  { kind: 'text', text: 'Planned', exact: true },
  { kind: 'locator', expr: "getByTestId('cell').getByTestId('input').locator('#inner')" },
  { kind: 'locator', expr: "getByRole('row').filter({ hasText: 'PD100046' }).getByRole('button', { name: 'Edit' })" },
];

test('locatorExpr equals renderCandidate minus the leading page. for every kind', () => {
  for (const c of CANDIDATES) {
    assert.equal(locatorExpr(c), renderCandidate(c).replace(/^page\./, ''),
      `mismatch for ${JSON.stringify(c)}`);
  }
});

/**
 * A stub page/locator that records the builder chain it was asked for as a
 * string, so buildLocator's live path can be compared to the rendered expression.
 * Each getByX / locator / filter returns a new stub carrying the accumulated expr.
 */
function stubPage() {
  const make = (expr) => new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === '__expr') return expr;
      return (...args) => {
        const argStr = args.map(a => {
          if (typeof a === 'string') return `'${a}'`;
          if (a && typeof a === 'object') return JSON.stringify(a);
          return String(a);
        }).join(', ');
        return make(`${expr}.${String(prop)}(${argStr})`);
      };
    },
    apply() { return make(expr); },
  });
  // page itself: getByX(...) starts a chain rooted at the bare builder (no `page.`).
  return new Proxy({}, {
    get(_t, prop) {
      return (...args) => {
        const argStr = args.map(a => {
          if (typeof a === 'string') return `'${a}'`;
          if (a && typeof a === 'object') return JSON.stringify(a);
          return String(a);
        }).join(', ');
        return make(`${String(prop)}(${argStr})`);
      };
    },
  });
}

test('buildLocator drives the flat kinds through the getByX API (inner chains .locator)', () => {
  const p = stubPage();
  assert.equal(buildLocator(p, { kind: 'testid', id: 'x' }).__expr, "getByTestId('x')");
  assert.equal(buildLocator(p, { kind: 'testid', id: 'x', inner: '#inner' }).__expr,
    "getByTestId('x').locator('#inner')");
  assert.equal(buildLocator(p, { kind: 'text', text: 'Planned', exact: true }).__expr,
    "getByText('Planned', {\"exact\":true})");
});

test('resolveValues: fixed is its literal, dynamic evaluates its expr once', () => {
  const rec = { values: {
    CUSTOMER: { kind: 'fixed', literal: 'L6 - Costco' },
    N: { kind: 'dynamic', expr: '`Auto-test-42`' },
  }};
  const v = resolveValues(rec);
  assert.equal(v.CUSTOMER, 'L6 - Costco');
  assert.equal(v.N, 'Auto-test-42');
});

test('resolveValues: a later record sees an earlier record\'s value (accumulated scope)', () => {
  const first = resolveValues({ values: { PROMO: { kind: 'fixed', literal: 'P1' } } });
  const second = resolveValues({ values: { OTHER: { kind: 'fixed', literal: 'O' } } }, first);
  assert.equal(second.PROMO, 'P1');   // still in scope for the later record
  assert.equal(second.OTHER, 'O');
});

test('runAction: goto strips scheme+host and resolves the path (matches renderAction)', async () => {
  const seen = [];
  const page = { goto: async (p) => seen.push(p) };
  await runAction(page, { method: 'goto', arg: { literal: 'https://host.example.com/promotion/dashboard' } }, {});
  await runAction(page, { method: 'goto', arg: { literal: '/already/a/path' } }, {});
  await runAction(page, { method: 'goto', arg: { literal: 'https://host.example.com' } }, {});  // bare origin → '/'
  assert.deepEqual(seen, ['/promotion/dashboard', '/already/a/path', '/']);
});

// ── B5: runAssertion wraps a fixed text string the SAME way renderAssertion does ─
// A stub expect() captures the argument passed to the matcher, so we can assert the
// replay side matches the renderer: a fixed string on toHaveText becomes a RegExp
// fragment; a ref / an exact toHaveValue / a count stays as-is.

import { runAssertion } from '../record-interpret.mjs';

function captureExpect() {
  const calls = [];
  const expect = () => new Proxy({}, { get: (_t, matcher) => (arg) => { calls.push({ matcher, arg }); } });
  return { expect, calls };
}
const assertionStubPage = () => ({ locator: () => ({}), getByRole: () => ({}), getByLabel: () => ({}) });

test('runAssertion: toHaveText with a fixed string is matched as a RegExp fragment (mirrors the renderer)', async () => {
  const { expect, calls } = captureExpect();
  await runAssertion(assertionStubPage(), expect,
    { target: [{ kind: 'role', role: 'status' }], matcher: 'toHaveText', value: { literal: 'Draft' } }, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].matcher, 'toHaveText');
  assert.ok(calls[0].arg instanceof RegExp, 'a fixed text string is wrapped in a RegExp');
  assert.ok(calls[0].arg.test('the status is Draft now'), 'it matches as a substring, tolerating surrounding text');
});

test('runAssertion: toHaveValue with a fixed string stays the exact string (not regex)', async () => {
  const { expect, calls } = captureExpect();
  await runAssertion(assertionStubPage(), expect,
    { target: [{ kind: 'label', text: 'Name' }], matcher: 'toHaveValue', value: { literal: 'ABC' } }, {});
  assert.equal(calls[0].arg, 'ABC', 'toHaveValue is exact');
});

test('runAssertion: a ref value on toHaveText is the resolved string, passed through (never regex)', async () => {
  const { expect, calls } = captureExpect();
  await runAssertion(assertionStubPage(), expect,
    { target: [{ kind: 'role', role: 'status' }], matcher: 'toHaveText', value: { ref: 'NAME' } }, { NAME: 'Exact Name' });
  assert.equal(calls[0].arg, 'Exact Name', 'a ref is the resolved value, matched exactly');
});

test('runAssertion: a nullary matcher is called with no argument', async () => {
  const { expect, calls } = captureExpect();
  await runAssertion(assertionStubPage(), expect,
    { target: [{ kind: 'role', role: 'heading', name: 'X' }], matcher: 'toBeVisible' }, {});
  assert.equal(calls[0].arg, undefined);
});
