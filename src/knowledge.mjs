/**
 * Knowledge injected into the verify agent.
 *
 * Two layers, merged into one block the prompt builders concatenate:
 *
 *   - local/engine/    built-in, always included, engine-general, product-neutral.
 *   - external/<slug>/  a synced clone of an external knowledge repo, pulled in
 *                       only for projects that declare a link in links.json.
 *
 * The producer the rest of the codebase calls is selectKnowledge(): given a
 * feature path it returns one string, keyed on the feature's project. It is a
 * pure read — it never spawns git or touches the network, so a recording can
 * never hang or fail on connectivity. Syncing the external clone is a separate,
 * explicit step (syncExternal, wired to `npm run sync`).
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, basename, resolve } from 'path';

import { projectOf } from './paths.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KNOWLEDGE_DIR = join(ROOT, 'knowledge');
const LOCAL_DIR = join(KNOWLEDGE_DIR, 'local');
export const CORE_DIR = join(LOCAL_DIR, 'engine');
export const CORE_INDEX = join(CORE_DIR, 'INDEX.md');
export const EXTERNAL_DIR = join(KNOWLEDGE_DIR, 'external');
export const LINKS_FILE = join(KNOWLEDGE_DIR, 'links.json');

/** All markdown files under a directory, sorted, as { topic, path, text }. */
function readMarkdown(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) continue;
    if (!name.endsWith('.md')) continue;
    out.push({ topic: basename(name, '.md'), path: full, text: readFileSync(full, 'utf8').trim() });
  }
  return out;
}

/** Built-in core knowledge topics, index file excluded. */
export function loadCoreKnowledge() {
  return readMarkdown(CORE_DIR).filter(d => d.topic !== 'INDEX');
}

/** Parse links.json; an absent or unreadable file is not an error — no links. */
export function readLinks() {
  if (!existsSync(LINKS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LINKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** The clone-directory slug for a repo ref — the last path segment, `.git` dropped. */
export function slugForRepo(repo) {
  return repo.replace(/\.git$/, '').split(/[/:]/).pop();
}

/**
 * The external repo a project draws on, or null. Keyed on project name — the
 * first directory under features, the only "project" the engine knows.
 */
export function linkForProject(project, links = readLinks()) {
  if (!project) return null;
  const entry = links.projects?.[project];
  if (!entry) return null;
  const slug = entry.repo ? slugForRepo(entry.repo) : project;
  return {
    project,
    repo: entry.repo ?? null,
    url: entry.url ?? null,
    areas: entry.areas ?? [],
    conventions: entry.conventions !== false,   // default on
    dest: join(EXTERNAL_DIR, slug),
  };
}

/**
 * External knowledge for a project, read from an already-synced clone. A missing
 * clone yields [] — offline-safe: the caller falls back to core-only rather than
 * failing a run. Pulls conventions/*.md (cross-cutting) and areas/<area>/** for
 * each declared area.
 */
export function loadExternalKnowledge(project, { linksOverride, destOverride } = {}) {
  const link = linkForProject(project, linksOverride ?? readLinks());
  if (!link) return [];
  if (destOverride) link.dest = destOverride;
  if (!existsSync(link.dest)) return [];

  const out = [];
  if (link.conventions) {
    for (const m of readMarkdown(join(link.dest, 'conventions'))) {
      out.push({ area: null, ...m });
    }
  }
  for (const area of link.areas) {
    const areaRoot = join(link.dest, 'areas', area);
    for (const sub of ['manuals', 'workflows']) {
      for (const m of readMarkdown(join(areaRoot, sub))) {
        out.push({ area, ...m });
      }
    }
  }
  return out;
}

/**
 * Classify one extra knowledge base the caller named on the command line.
 * A local directory is read where it sits — never cloned or copied; a repo ref
 * resolves to the clone directory under external/ where a sync would land it.
 *
 * Disk wins the tie: "owner/name" and a relative path "sub/dir" look alike, so
 * anything that exists on disk as a directory is treated as local first, and the
 * repo patterns are only consulted when nothing is there.
 *
 * @returns {{ kind: 'local'|'repo', dir: string, slug?: string }}
 */
export function classifyExtra(origin) {
  const expanded = origin.startsWith('~')
    ? join(homedir(), origin.slice(1))
    : origin;

  const looksLocal = /^([./~]|[A-Za-z]:[\\/])/.test(origin);
  const onDisk = existsSync(expanded) && statSync(expanded).isDirectory();
  if (looksLocal || onDisk) {
    return { kind: 'local', dir: resolve(expanded) };
  }

  // A repo: a URL, a scp-style host:path, or a plain owner/name.
  const slug = slugForRepo(origin);
  return { kind: 'repo', dir: join(EXTERNAL_DIR, slug), slug };
}

/**
 * The knowledge-base directories to point the agent at, in order: the project's
 * default (from links.json), then the caller's extras in the order given. Each
 * must exist on disk to be included — a declared-but-unsynced repo is skipped
 * silently, so a run stays offline-safe and falls back to core-only. Deduped by
 * directory, so a default and an extra naming the same place are listed once.
 *
 * @returns {Array<{ dir: string, kind: 'project'|'local'|'repo', origin: string }>}
 */
export function resolveSources(project, extra = [], { linksOverride, destOverride } = {}) {
  const sources = [];
  const seen = new Set();
  const add = (dir, kind, origin) => {
    if (!dir || seen.has(dir) || !existsSync(dir)) return;
    seen.add(dir);
    sources.push({ dir, kind, origin });
  };

  const link = linkForProject(project, linksOverride ?? readLinks());
  if (link) add(destOverride ?? link.dest, 'project', link.repo ?? link.url ?? project);

  for (const origin of extra) {
    const c = classifyExtra(origin);
    add(c.dir, c.kind, origin);
  }
  return sources;
}

/**
 * A short pointer telling the agent where the knowledge lives, injected into the
 * prompt. Progressive disclosure: the prompt does NOT carry the knowledge itself
 * — it names the index and lets the agent read the one topic it needs, when it
 * needs it, keeping the prompt light and the context uncluttered.
 *
 * Core knowledge and its index live together in knowledge/local/engine/ (INDEX.md).
 * Project-specific knowledge lives in one or more external bases: the project's
 * default (declared in links.json) plus any the caller appended via `extra`
 * (repo refs already synced under external/<slug>/, or local directories read
 * where they sit). The pointer names each base that exists; the agent reads each
 * base's own index on demand, the same way it reads the core index.
 *
 * @param {string} featurePath
 * @param {{ linksOverride?: object, destOverride?: string, extra?: string[] }} [opts]
 * @returns {{ text: string, index: string|null,
 *             sources: Array<{dir,kind,origin}>, external: string|null }}
 *          text is '' when there is nothing to point at. `external` is the first
 *          project/repo source dir (or null) — a compatibility handle for the
 *          common single-base case.
 */
export function selectKnowledge(featurePath, { linksOverride, destOverride, extra = [] } = {}) {
  const project = projectOf(featurePath);

  const index = existsSync(CORE_INDEX) ? CORE_INDEX : null;
  const sources = resolveSources(project, extra, { linksOverride, destOverride });
  const external = sources.find(s => s.kind !== 'local')?.dir ?? null;

  if (!index && !sources.length) return { text: '', index: null, sources: [], external: null };

  const lines = ['--- KNOWLEDGE (reference; your agent definition still governs) ---'];
  if (index) {
    lines.push(
      `Reference technique is indexed in ${index} — locator strategy, shadow-DOM`,
      `inputs, slow third-party content, search/combobox, cascades, write`,
      `checkpoints. Read that index first; when a topic applies to what you are`,
      `doing, read that one file for the detail. Do not read them all up front.`);
  }
  if (sources.length) {
    lines.push(
      `Additional knowledge bases (read each one's index/README/conventions the`,
      `same way, on demand — do not read them all up front):`);
    for (const s of sources) lines.push(`  - ${s.dir}/`);
  }
  lines.push('--- END KNOWLEDGE ---');

  return { text: lines.join('\n'), index, sources, external };
}

/**
 * Clone-or-pull the external knowledge repo(s) into knowledge/external/.
 * Explicit step, never called from record. Mirrors the reference sync.sh:
 * gh clone with a plain-git fallback, then report the synced SHA.
 *
 * @param {string|null} project  a single project, or null for every linked one
 * @returns {Array<{ repo: string, project: string, sha: string|null, error?: string }>}
 */
export function syncExternal(project = null) {
  const links = readLinks();
  const names = project ? [project] : Object.keys(links.projects ?? {});
  const results = [];

  for (const name of names) {
    const link = linkForProject(name, links);
    if (!link || (!link.repo && !link.url)) {
      results.push({ repo: null, project: name, sha: null, error: 'no repo/url in links.json' });
      continue;
    }
    const r = cloneOrPull(link);
    results.push({ repo: link.repo ?? link.url, project: name, ...r });
  }
  return results;
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function cloneOrPull(link) {
  const gitDir = join(link.dest, '.git');
  if (existsSync(gitDir)) {
    const f = run('git', ['-C', link.dest, 'fetch', 'origin', '--quiet']);
    if (f.code !== 0) return { sha: null, error: f.err || 'fetch failed' };
    const p = run('git', ['-C', link.dest, 'pull', '--ff-only', '--quiet']);
    if (p.code !== 0) return { sha: null, error: p.err || 'pull failed' };
  } else {
    // Prefer gh (honours the user's github.tools.sap auth), fall back to git.
    let c = link.repo ? run('gh', ['repo', 'clone', link.repo, link.dest]) : { code: 1 };
    if (c.code !== 0 && link.url) c = run('git', ['clone', link.url, link.dest]);
    if (c.code !== 0) return { sha: null, error: c.err || 'clone failed' };
  }
  const rev = run('git', ['-C', link.dest, 'rev-parse', 'HEAD']);
  return { sha: rev.code === 0 ? rev.out : null };
}
