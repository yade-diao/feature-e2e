/**
 * Knowledge subsystem: loading, selection (progressive disclosure), and the
 * neutrality rule.
 *
 * Progressive disclosure: the prompt does NOT carry the knowledge — it points at
 * knowledge/local/engine/INDEX.md and lets the agent read the one topic it needs. These
 * tests pin that contract: the pointer names the index, the index lists every
 * core topic, and both stay product-neutral.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadCoreKnowledge, readLinks, linkForProject, loadExternalKnowledge, selectKnowledge,
  classifyExtra, slugForRepo, CORE_INDEX,
} from '../knowledge.mjs';
import { buildPrompt } from '../recorder.mjs';

const BANNED = /\b(RGM|KPI|SAC|UI5|SAP|SAPUI5|Fiori|OData|HANA|Gatling|Promotion|Analytics)\b/;

// ── neutrality: core knowledge and its index name no product/framework ───────

test('core knowledge is product-neutral', () => {
  const core = loadCoreKnowledge();
  assert.ok(core.length >= 6, 'expected the six core topics');
  for (const doc of core) {
    const hit = doc.text.match(BANNED);
    assert.equal(hit, null,
      `engine/${doc.topic}.md names a product term "${hit?.[0]}" — core must stay neutral`);
  }
});

test('the index itself is product-neutral', () => {
  // The index is maintained alongside core and held to the same bar.
  const hit = readFileSync(CORE_INDEX, 'utf8').match(BANNED);
  assert.equal(hit, null, `INDEX.md names a product term "${hit?.[0]}" — must stay neutral`);
});

test('core knowledge covers the expected topics', () => {
  const topics = loadCoreKnowledge().map(d => d.topic).sort();
  for (const t of ['cascading-failure', 'locator-priority', 'search-combobox',
    'slow-third-party-components', 'web-components-shadow-dom', 'write-checkpoint']) {
    assert.ok(topics.includes(t), `missing core topic ${t}`);
  }
});

test('loadCoreKnowledge excludes the index file', () => {
  assert.ok(!loadCoreKnowledge().some(d => d.topic === 'INDEX'),
    'INDEX.md is the index, not a knowledge topic');
});

// ── the index lists every core topic — a topic with no row is invisible ──────

test('INDEX.md lists every core topic', () => {
  const index = readFileSync(CORE_INDEX, 'utf8');
  for (const { topic } of loadCoreKnowledge()) {
    assert.ok(index.includes(`${topic}.md`),
      `core topic ${topic} has no row in INDEX.md — the agent would never see it`);
  }
});

// ── selection: a pointer to the index, not the knowledge itself ──────────────

test('selectKnowledge points at the index, fenced as reference', () => {
  const { text, index, external } = selectKnowledge('features/anything/x.feature');
  assert.match(text, /--- KNOWLEDGE \(reference;/);
  assert.match(text, /--- END KNOWLEDGE ---$/);
  assert.ok(text.includes(index), 'the pointer names the index path');
  assert.ok(index.endsWith('INDEX.md'), 'index resolves to engine/INDEX.md');
  assert.equal(external, null, 'no external clone for an unlinked project');
});

test('selectKnowledge does not inline the core knowledge', () => {
  // Progressive disclosure: the body of a core topic must NOT appear in the
  // pointer — that is the whole change from the full-inject design.
  const { text } = selectKnowledge('features/anything/x.feature');
  const shadow = loadCoreKnowledge().find(d => d.topic === 'web-components-shadow-dom');
  assert.ok(!text.includes(shadow.text), 'pointer must not carry the topic body');
  assert.ok(text.length < 1000, 'pointer stays short; it names the index, not the content');
});

test('selectKnowledge reports an external clone when one is synced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-kb-'));
  const clone = join(dir, 'demo-kb');
  mkdirSync(clone, { recursive: true });
  const links = { projects: { demo: { repo: 'x/demo-kb', areas: [], conventions: true } } };
  const { text, external } = selectKnowledge('features/demo/x.feature',
    { linksOverride: links, destOverride: clone });
  assert.equal(external, clone, 'external points at the synced clone');
  assert.ok(text.includes(clone), 'the pointer names the external directory');
  assert.match(text, /on demand|on-demand|the same way/i, 'and tells the agent to read it on demand');
  rmSync(dir, { recursive: true, force: true });
});

test('selectKnowledge omits external when the clone is absent', () => {
  const links = { projects: { ghost: { repo: 'x/ghost', areas: ['a'] } } };
  const { external } = selectKnowledge('features/ghost/x.feature', { linksOverride: links });
  assert.equal(external, null, 'no clone on disk → nothing to point at');
});

// ── extra knowledge bases: appended, local read in place, offline-safe ───────

test('slugForRepo takes the last segment and drops .git', () => {
  assert.equal(slugForRepo('rgm/rgm-e2e-knowledge'), 'rgm-e2e-knowledge');
  assert.equal(slugForRepo('https://github.tools.sap/rgm/rgm-e2e-knowledge.git'), 'rgm-e2e-knowledge');
  assert.equal(slugForRepo('git@github.com:owner/name.git'), 'name');
});

test('classifyExtra treats an existing directory as local, read where it sits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-kb-'));
  const c = classifyExtra(dir);
  assert.equal(c.kind, 'local');
  assert.equal(c.dir, dir, 'local dir is read in place, not moved under external/');
  rmSync(dir, { recursive: true, force: true });
});

test('classifyExtra treats owner/name as a repo under external/', () => {
  const c = classifyExtra('owner/some-kb');
  assert.equal(c.kind, 'repo');
  assert.equal(c.slug, 'some-kb');
  assert.ok(c.dir.endsWith(join('external', 'some-kb')), 'repo resolves under external/<slug>');
});

test('selectKnowledge appends a local extra base, pointing at its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-kb-'));
  const { text, sources } = selectKnowledge('features/anything/x.feature', { extra: [dir] });
  assert.ok(sources.some(s => s.kind === 'local' && s.dir === dir), 'local extra is a source');
  assert.ok(text.includes(dir), 'the pointer names the local path');
  rmSync(dir, { recursive: true, force: true });
});

test('a repo extra that is not synced is skipped silently (offline-safe)', () => {
  const { sources, text } = selectKnowledge('features/anything/x.feature',
    { extra: ['owner/never-synced-kb'] });
  assert.ok(!sources.some(s => s.origin === 'owner/never-synced-kb'),
    'an unsynced repo has no clone on disk → not pointed at');
  assert.ok(!text.includes('never-synced-kb'), 'and does not leak into the prompt');
});

test('project default and an extra coexist, default first', () => {
  const projDir = mkdtempSync(join(tmpdir(), 'fe2e-kb-proj-'));
  const extraDir = mkdtempSync(join(tmpdir(), 'fe2e-kb-extra-'));
  const links = { projects: { demo: { repo: 'x/demo-kb', areas: [], conventions: true } } };
  const { sources } = selectKnowledge('features/demo/x.feature',
    { linksOverride: links, destOverride: projDir, extra: [extraDir] });
  assert.deepEqual(sources.map(s => s.dir), [projDir, extraDir],
    'the project default leads, the extra follows');
});

test('a base named twice is listed once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-kb-'));
  const links = { projects: { demo: { repo: 'x/demo-kb', areas: [], conventions: true } } };
  const { sources } = selectKnowledge('features/demo/x.feature',
    { linksOverride: links, destOverride: dir, extra: [dir] });
  assert.equal(sources.length, 1, 'the default and the extra point at one dir → one source');
  rmSync(dir, { recursive: true, force: true });
});

// ── external: opt-in by project, offline-safe ────────────────────────────────

test('linkForProject returns null for an unlinked project', () => {
  const links = { projects: { rgm: { repo: 'rgm/rgm-e2e-knowledge', areas: ['kpi'] } } };
  assert.equal(linkForProject('other', links), null);
  const rgm = linkForProject('rgm', links);
  assert.equal(rgm.repo, 'rgm/rgm-e2e-knowledge');
  assert.deepEqual(rgm.areas, ['kpi']);
  assert.equal(rgm.conventions, true);   // default on
});

test('loadExternalKnowledge returns [] when the clone is absent', () => {
  const links = { projects: { ghost: { repo: 'x/ghost', areas: ['a'] } } };
  assert.deepEqual(loadExternalKnowledge('ghost', { linksOverride: links }), []);
});

test('loadExternalKnowledge reads conventions and area docs from a synced clone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-kb-'));
  const clone = join(dir, 'demo-kb');
  mkdirSync(join(clone, 'conventions'), { recursive: true });
  mkdirSync(join(clone, 'areas', 'billing', 'manuals'), { recursive: true });
  mkdirSync(join(clone, 'areas', 'shipping', 'workflows'), { recursive: true });
  writeFileSync(join(clone, 'conventions', 'waits.md'), 'wait for networkidle');
  writeFileSync(join(clone, 'areas', 'billing', 'manuals', 'invoice.md'), 'invoice testids');
  writeFileSync(join(clone, 'areas', 'shipping', 'workflows', 'dispatch.md'), 'dispatch flow');

  const links = { projects: { demo: { repo: 'x/demo-kb', areas: ['billing'], conventions: true } } };
  const docs = loadExternalKnowledge('demo', { linksOverride: links, destOverride: clone });

  const topics = docs.map(d => (d.area ? `${d.area}/${d.topic}` : d.topic)).sort();
  // conventions pulled; billing (declared) pulled; shipping (not declared) skipped.
  assert.deepEqual(topics, ['billing/invoice', 'waits']);
  rmSync(dir, { recursive: true, force: true });
});

test('loadExternalKnowledge can skip conventions when disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-kb-'));
  const clone = join(dir, 'demo-kb');
  mkdirSync(join(clone, 'conventions'), { recursive: true });
  writeFileSync(join(clone, 'conventions', 'waits.md'), 'wait');
  const links = { projects: { demo: { repo: 'x/demo-kb', areas: [], conventions: false } } };
  assert.deepEqual(loadExternalKnowledge('demo', { linksOverride: links, destOverride: clone }), []);
  rmSync(dir, { recursive: true, force: true });
});

test('readLinks tolerates a missing file', () => {
  // Real project may or may not ship links.json; either way this must not throw.
  assert.doesNotThrow(() => readLinks());
});

// ── injection contract: the pointer lands in the prompts, correctly placed ───

test('buildPrompt injects the pointer after the two foregrounded rules', () => {
  const knowledge = '--- KNOWLEDGE (reference; your agent definition still governs) ---\nX\n--- END KNOWLEDGE ---';
  const p = buildPrompt({
    featurePath: 'features/x/y.feature', specPath: 'run/x/y.spec.ts',
    featureText: 'Feature: F', baseURL: 'https://example.com', knowledge,
  });
  assert.ok(p.includes(knowledge), 'knowledge pointer present');
  // Must sit after the two rejection-magnet rules, not before them.
  assert.ok(p.indexOf('No `.first()`') < p.indexOf(knowledge), 'pointer follows the two rules');
});

test('buildPrompt omits the block when there is no pointer', () => {
  const p = buildPrompt({
    featurePath: 'features/x/y.feature', specPath: 'run/x/y.spec.ts',
    featureText: 'Feature: F', baseURL: 'https://example.com', knowledge: '',
  });
  assert.ok(!p.includes('--- KNOWLEDGE'), 'no empty fence when there is nothing to inject');
});

// ── end-to-end: a real record prompt carries the index pointer ───────────────

test('a real recorder prompt names the index and tells the agent to read it', () => {
  const knowledge = selectKnowledge('features/anything/x.feature').text;
  const p = buildPrompt({
    featurePath: 'features/anything/x.feature', specPath: 'run/anything/x.spec.ts',
    featureText: 'Feature: F', baseURL: 'https://example.com', knowledge,
  });
  assert.ok(p.includes('INDEX.md'), 'the index path reaches the prompt');
  assert.match(p, /Read that index first/, 'and the instruction to read it on demand');
});
