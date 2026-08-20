/**
 * Path mapping between feature files and the specs recorded from them.
 *
 * Convention: a recorded spec mirrors its feature one-for-one, same directory shape.
 *
 *   tests/features/people/channel-navigation.feature
 *     ->  tests/run/people/channel-navigation.spec.ts
 *
 * The first directory under `tests/features` is the project (one directory per
 * system under test); below that the layout is free and mirrored verbatim.
 *
 * Deriving one side from the other means there is no index file to maintain.
 * An index that drifts out of sync produces the worst kind of failure: verifying
 * a test that no longer exists, silently.
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { join, relative, sep } from 'path';

export const FEATURE_DIR = join('tests', 'features');
export const SPEC_DIR = join('tests', 'run');

const toNative = p => p.split(/[\\/]/).join(sep);

/** feature path -> spec path */
export function featureToSpec(featurePath) {
  const rel = relative(FEATURE_DIR, toNative(featurePath));
  if (rel.startsWith('..')) throw new Error(`feature must live under ${FEATURE_DIR}: ${featurePath}`);
  return join(SPEC_DIR, rel.replace(/\.feature$/, '.spec.ts'));
}

/** spec path -> feature path */
export function specToFeature(specPath) {
  const rel = relative(SPEC_DIR, toNative(specPath));
  if (rel.startsWith('..')) throw new Error(`spec must live under ${SPEC_DIR}: ${specPath}`);
  return join(FEATURE_DIR, rel.replace(/\.spec\.ts$/, '.feature'));
}

/** Project name = first directory below tests/features */
export function projectOf(featurePath) {
  const rel = relative(FEATURE_DIR, toNative(featurePath));
  const parts = rel.split(sep);
  return parts.length > 1 ? parts[0] : null;
}

function walk(dir, match) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(name)) out.push(full);
  }
  return out;
}

/** All feature files, optionally narrowed to one project */
export function listFeatures(project = null) {
  const root = project ? join(FEATURE_DIR, project) : FEATURE_DIR;
  return walk(root, n => n.endsWith('.feature')).sort();
}

/**
 * The generator's seed file. It lives under SPEC_DIR because Playwright has to be
 * able to run it while recording, but it is infrastructure rather than a recorded
 * spec: it pairs with no feature and must not be reported as an orphan.
 */
export const SEED_SPEC = join(SPEC_DIR, 'seed.spec.ts');

/** All recorded specs, optionally narrowed to one project. Excludes the seed. */
export function listSpecs(project = null) {
  const root = project ? join(SPEC_DIR, project) : SPEC_DIR;
  return walk(root, n => n.endsWith('.spec.ts'))
    .filter(p => p !== SEED_SPEC)
    .sort();
}

/**
 * Cross-check both sides.
 *
 * `missingSpec` is a failure, not a warning: a feature with no recorded spec is
 * silently absent from the CI run, which reads as "everything passed".
 */
export function pairing() {
  const paired = [], missingSpec = [], orphanSpec = [];
  for (const feature of listFeatures()) {
    const spec = featureToSpec(feature);
    (existsSync(spec) ? paired : missingSpec).push({ feature, spec, project: projectOf(feature) });
  }
  for (const spec of listSpecs()) {
    const feature = specToFeature(spec);
    if (!existsSync(feature)) orphanSpec.push({ spec, expectedFeature: feature });
  }
  return { paired, missingSpec, orphanSpec };
}
