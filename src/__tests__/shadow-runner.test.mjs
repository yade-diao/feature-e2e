/**
 * ShadowRunner scout primitives: _tryClick (the one write the scout gets) and
 * _resetTo (the "replay the prefix" recovery). The real browser path is exercised
 * end-to-end; here we pin the logic with an injected fake page/browser so the
 * method whitelist, the probeAfter round-trip, and the prefix-replay contract are
 * tested fast and deterministically — no Chrome, no flakiness.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ShadowRunner } from '../shadow-runner.mjs';

// A fake page whose locators record what was driven. buildLocator (record-interpret)
// calls page.getByRole(...).click() etc.; we make those chainable and log calls.
function fakePage({ url = 'about:blank' } = {}) {
  const calls = [];
  const loc = () => new Proxy({}, { get: (_t, m) => {
    if (m === 'then') return undefined;
    return async (...a) => { calls.push({ m: String(m), a }); return undefined; };
  }});
  const page = {
    calls,
    url: () => url,
    getByRole: () => loc(), getByTestId: () => loc(), getByText: () => loc(),
    getByLabel: () => loc(), getByPlaceholder: () => loc(), locator: () => loc(),
    goto: async (p) => { calls.push({ m: 'goto', a: [p] }); },
    evaluate: async () => 0,
  };
  return page;
}

test('_tryClick refuses a method that is not a real interaction (no evaluate/script)', async () => {
  const r = new ShadowRunner();
  r._page = fakePage();
  const res = await r._tryClick({ candidate: { kind: 'role', role: 'button', name: 'X' }, method: 'evaluate' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not allowed|read-only|interaction/i);
});

test('_tryClick drives an allowed interaction and runs probeAfter', async () => {
  const r = new ShadowRunner();
  r._page = fakePage({ url: 'https://app/create' });
  const res = await r._tryClick({
    candidate: { kind: 'role', role: 'row', name: 'PD100046' },
    method: 'click',
    probeAfter: { kind: 'url' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.urlBefore, 'https://app/create');
  assert.ok(res.after && res.after.ok, 'probeAfter ran');
  assert.equal(res.after.url, 'https://app/create');
});

test('_tryClick reports failure without throwing when the interaction errors', async () => {
  const r = new ShadowRunner();
  const page = fakePage();
  page.getByRole = () => new Proxy({}, { get: (_t, m) => (m === 'then' ? undefined : async () => { throw new Error('element not found'); }) });
  r._page = page;
  const res = await r._tryClick({ candidate: { kind: 'role', role: 'button', name: 'Nope' }, method: 'click' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
});

test('_resetTo replays each prefix record from a fresh context', async () => {
  const r = new ShadowRunner();
  // Fake browser whose newContext yields a fresh fake page each time.
  let contexts = 0;
  const pages = [];
  r._browser = {
    newContext: async () => {
      contexts++;
      return {
        setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
        newPage: async () => { const p = fakePage(); pages.push(p); return p; },
        close: async () => {},
      };
    },
  };
  const prefix = [
    { scenario: 's', step: 'open', actions: [{ method: 'goto', arg: { literal: '/a' } }] },
    { scenario: 's', step: 'go b', actions: [{ method: 'goto', arg: { literal: '/b' } }] },
  ];
  const res = await r._resetTo(prefix);
  assert.equal(res.ok, true);
  assert.equal(res.replayed, 2, 'both prefix records replayed');
  assert.equal(contexts, 1, 'a single fresh context was built for the reset');
});

test('_resetTo reports which record failed if the prefix replay breaks', async () => {
  const r = new ShadowRunner();
  r._browser = {
    newContext: async () => ({
      setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
      newPage: async () => {
        const p = fakePage();
        p.goto = async (path) => { if (path === '/b') throw new Error('nav failed'); };
        return p;
      },
      close: async () => {},
    }),
  };
  const prefix = [
    { scenario: 's', step: 'open', actions: [{ method: 'goto', arg: { literal: '/a' } }] },
    { scenario: 's', step: 'go b', actions: [{ method: 'goto', arg: { literal: '/b' } }] },
  ];
  const res = await r._resetTo(prefix);
  assert.equal(res.ok, false);
  assert.equal(res.at, 1, 'names the failing record index');
  assert.match(res.error, /nav failed/);
});

// ── armReset / reset: the scout decides when to replay (not the proxy, every time) ─

test('handle armReset stores the prefix without replaying it', async () => {
  const r = new ShadowRunner();
  let contexts = 0;
  r._browser = { newContext: async () => { contexts++; return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, newPage: async () => fakePage(), close: async () => {} }; } };
  const prefix = [{ scenario: 's', step: 'open', actions: [{ method: 'goto', arg: { literal: '/a' } }] }];
  const res = await r.handle({ id: 1, cmd: 'armReset', records: prefix });
  assert.equal(res.ok, true);
  assert.equal(res.armed, 1, 'reports how many records were armed');
  assert.equal(contexts, 0, 'arming does NOT replay — no context built');
  assert.deepEqual(r._armedPrefix, prefix, 'the prefix is stored for a later reset');
});

test('handle reset replays the armed prefix (the scout\'s on-demand recovery)', async () => {
  const r = new ShadowRunner();
  let contexts = 0;
  r._browser = { newContext: async () => { contexts++; return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, newPage: async () => fakePage(), close: async () => {} }; } };
  const prefix = [
    { scenario: 's', step: 'open', actions: [{ method: 'goto', arg: { literal: '/a' } }] },
    { scenario: 's', step: 'go b', actions: [{ method: 'goto', arg: { literal: '/b' } }] },
  ];
  await r.handle({ id: 1, cmd: 'armReset', records: prefix });
  const res = await r.handle({ id: 2, cmd: 'reset' });
  assert.equal(res.ok, true);
  assert.equal(res.replayed, 2, 'reset replays exactly the armed prefix');
  assert.equal(contexts, 1, 'reset builds one fresh context');
});

test('handle reset with nothing armed replays an empty prefix (no crash)', async () => {
  const r = new ShadowRunner();
  r._browser = { newContext: async () => ({ setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, newPage: async () => fakePage(), close: async () => {} }) };
  const res = await r.handle({ id: 1, cmd: 'reset' });
  assert.equal(res.ok, true);
  assert.equal(res.replayed, 0, 'an un-armed reset is a no-op replay, not a failure');
});

// ── _step dirty tracking: a failed step marks the shadow diverged ────────────

/** A page whose goto can be made to throw, to drive a step to failure. */
function togglePage({ gotoThrows = false } = {}) {
  const p = fakePage();
  p.goto = async () => { if (gotoThrows) throw new Error('navigation blocked'); };
  return p;
}

test('_step marks the shadow dirty on an action failure, clears it on success', async () => {
  const r = new ShadowRunner();
  // A clean step leaves dirty=false.
  r._page = togglePage({ gotoThrows: false });
  r._dirty = true;   // pretend a previous step had dirtied it
  const ok = await r._step({ scenario: 's', step: 'go', actions: [{ method: 'goto', arg: { literal: '/a' } }] });
  assert.equal(ok.ok, true);
  assert.equal(r._dirty, false, 'a clean step clears the dirty flag');
  assert.ok(!ok.dirty, 'a clean step does not report dirty');

  // A failing action sets dirty and reports it.
  r._page = togglePage({ gotoThrows: true });
  const bad = await r._step({ scenario: 's', step: 'go', actions: [{ method: 'goto', arg: { literal: '/a' } }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.dirty, true, 'a failed step reports dirty so the proxy rebuilds before the next');
  assert.equal(r._dirty, true, 'and the runner remembers it is diverged');
});

test('_captureState includes a main-region marker to tell same-URL views apart', async () => {
  const r = new ShadowRunner();
  // A page whose main region text differs from its heading — the marker is what
  // distinguishes a UI5 list view from the detail view it navigates to at the same URL.
  const p = fakePage({ url: 'https://app/#/plan' });
  p.locator = (sel) => ({
    first: () => ({
      innerText: async () => (String(sel).includes('main') || String(sel).includes('body')
        ? 'Promotions (111)  row row row'
        : 'Account Plan'),
    }),
  });
  const st = await r._captureState.call({ _page: p });
  assert.equal(st.marker, 'Promotions (111) row row row', 'marker carries the main-region signature, whitespace-collapsed');
  assert.equal(st.heading, 'Account Plan');
});

