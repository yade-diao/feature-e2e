#!/usr/bin/env node
/**
 * feature-e2e — turn a plain-language feature into a replayable Playwright spec.
 *
 *   node src/cli.mjs status                   pairing between features and specs
 *   node src/cli.mjs check  [feature|project] static gates over already-recorded specs
 *   node src/cli.mjs record [feature|project] verify each step; recorder writes the spec
 *   node src/cli.mjs heal   [feature|project] repair a spec whose locators stopped matching
 *   node src/cli.mjs replay [feature|project] run the recorded specs
 *
 * Exit codes:
 *   0  fine
 *   1  something failed or is missing
 *   2  this tool could not reach a conclusion (its own fault, not the suite's)
 *
 * Recording and replaying are separate commands with separate exit codes on
 * purpose. Replay must stay a pure Playwright run with no model in the loop,
 * otherwise a red CI result stops meaning "the application regressed".
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { FEATURE_DIR, listFeatures, pairing, specToFeature } from './paths.mjs';
import { recordFeature } from './recorder.mjs';
import { healFeature } from './healer.mjs';
import { runGates, staticGates, replayGate } from './gates.mjs';
import { checkSemanticStability, checkLocatorRobustness } from './checks.mjs';
import { logAttempt, summary } from './journal.mjs';

const [command = 'status', target = null] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const BASE_URL = process.env.BASE_URL ?? null;

/**
 * Where a failed replay leaves the list of red spec files for `heal` to read.
 * Written on red, cleared at the start of every replay — so it never goes stale
 * and healing never re-runs a spec that is already green.
 */
const RED_SPECS_FILE = '.red-specs.json';

/** A target is a feature path, a project name, or nothing (meaning: all). */
function resolveTargets(t) {
  if (!t) return listFeatures();
  if (t.endsWith('.feature')) {
    if (!existsSync(t)) throw new Error(`no such feature: ${t}`);
    return [t];
  }
  const asProject = listFeatures(t);
  if (asProject.length) return asProject;
  throw new Error(`"${t}" is neither a feature file nor a project under ${FEATURE_DIR}`);
}

function cmdStatus() {
  const { paired, missingSpec, orphanSpec } = pairing();
  console.log('feature <-> spec pairing\n');

  const byProject = new Map();
  for (const p of paired) {
    const key = p.project ?? '(root)';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(p);
  }
  for (const [project, items] of byProject) {
    console.log(`  ${project}`);
    for (const it of items) console.log(`    ok  ${it.feature}  ->  ${it.spec}`);
  }

  if (missingSpec.length) {
    console.log(`\n  ${missingSpec.length} feature(s) never recorded:`);
    for (const m of missingSpec) console.log(`    --  ${m.feature}  (missing ${m.spec})`);
    console.log('    run: node src/cli.mjs record <feature>');
  }
  if (orphanSpec.length) {
    console.log(`\n  ${orphanSpec.length} spec(s) with no feature (renamed or deleted?):`);
    for (const o of orphanSpec) console.log(`    --  ${o.spec}  (expected ${o.expectedFeature})`);
  }
  if (!paired.length && !missingSpec.length) console.log(`  (no features under ${FEATURE_DIR})`);

  // An unrecorded feature is skipped silently by CI, which reads as success.
  return missingSpec.length || orphanSpec.length ? 1 : 0;
}

/**
 * Maximum recording attempts.
 *
 * Each attempt costs a browser session and several minutes, so this is small on
 * purpose. It is not a lottery: every retry carries the critique from the
 * previous rejection, so the second attempt knows exactly what was wrong with
 * the first.
 *
 * Retrying is only safe because the cheap gates run first. "Retry until green"
 * would otherwise select for the emptiest possible recording — a spec that
 * asserts nothing always replays green. It cannot, however, get past step
 * coverage, so a recording that skipped a step is turned away before a browser
 * is touched.
 */
const MAX_ATTEMPTS = 3;

/** Gate names in the order runGates applies them — used to label a rejection. */
const GATE_ORDER = [
  'step coverage', 'banned patterns', 'liveness', 'locator redundancy', 'replay', 'step substance',
];

async function cmdRecord() {
  const features = resolveTargets(target);
  console.log(`recording ${features.length} feature(s)\n`);
  let failed = 0;

  const runId = Date.now().toString(36);

  for (const feature of features) {
    console.log(`  ${feature}`);
    let critique = null;
    let done = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
      if (attempt > 1) console.log(`    retry ${attempt}/${MAX_ATTEMPTS} with the critique above`);

      let result;
      try {
        result = await recordFeature({ featurePath: feature, baseURL: BASE_URL, critique });
      } catch (e) {
        console.log(`    FAILED  ${e.message.split('\n')[0]}`);
        break;   // an exception here is the harness failing, not the recording
      }

      if (!result.written) {
        if (result.diagnosisWritten) {
          if (result.diagnosisOk) {
            console.log(`    UNVERIFIED  ${result.diagnosisJson}`);
            console.log('    the business logic could not be verified — read the diagnosis report');
          } else {
            console.log(`    INVALID REPORT  ${result.diagnosisJson} — the agent produced a report the schema rejects:`);
            for (const e of result.diagnosisErrors) console.log(`      - ${e}`);
          }
        } else {
          console.log(result.stale
            ? `    FAILED  ${result.specPath} was not touched - this is a leftover from an earlier run`
            : `    FAILED  the agent produced no ${result.specPath}`);
          console.log(`    agent said: ${result.agentSaid || '(nothing)'}`);
        }
        break;   // no spec: a diagnosis is a result, not a retry, and no artifact has nothing to critique
      }
      console.log(`    wrote ${result.specPath} (${(result.ms / 1000).toFixed(0)}s)`);

      const verdict = await runGates(feature, result.specPath);
      for (const p of verdict.passed) console.log(`      ok  ${p}`);

      // The gate that stopped it is the one after the last that passed.
      logAttempt({
        run: runId, feature, attempt, ms: result.ms, ok: verdict.ok,
        passed: verdict.passed.length,
        gate: verdict.ok ? null : (verdict.inconclusive ? 'inconclusive' : GATE_ORDER[verdict.passed.length] ?? 'unknown'),
      });

      if (verdict.ok) { done = true; break; }

      if (verdict.inconclusive) {
        // The tool could not reach a verdict. Retrying cannot fix that, and
        // pretending otherwise would burn attempts on a broken harness.
        console.log(`    INCONCLUSIVE  ${verdict.inconclusive}`);
        break;
      }

      console.log(`    rejected:\n${verdict.critique.split('\n').map(l => '      ' + l).join('\n')}`);
      critique = verdict.critique;
    }

    if (!done) failed++;
  }

  const s = summary();
  if (s.runs) {
    console.log(`\nfirst-attempt pass rate: ${s.firstTry}/${s.runs} (${(s.rate * 100).toFixed(0)}%)`
      + `  over ${s.attempts} attempt(s)`);
    if (s.rejections.length) {
      console.log(`rejections by gate: ${s.rejections.map(([g, n]) => `${g} ${n}`).join(', ')}`);
    }
  }

  if (failed) console.log(`\n${failed} feature(s) failed to record`);
  else console.log('\nnext: npm run replay');
  return failed ? 1 : 0;
}

/** Recorded specs matching the target (a feature path, a project, or all). */
function targetSpecs() {
  const { paired } = pairing();
  if (!target) return paired;
  if (target.endsWith('.feature')) return paired.filter(p => p.feature === target);
  return paired.filter(p => p.project === target);
}

/**
 * Static gates over specs that already exist.
 *
 * Recording applies the gates once, at the moment a spec is made. A rule added
 * afterwards would never revisit anything already in the repository, so the
 * suite quietly accumulates specs that the current rules would reject. This
 * command is how that stays visible, and it costs milliseconds.
 */
async function cmdCheck() {
  const specs = targetSpecs();
  if (!specs.length) { console.log('no recorded specs to check'); return 1; }

  console.log(`checking ${specs.length} spec(s) — static gates only, no browser\n`);
  let bad = 0;
  let stale = 0;
  let brittle = 0;
  for (const { feature, spec } of specs) {
    const verdict = await staticGates(feature, spec);
    if (verdict.ok) {
      console.log(`  ok    ${spec}  (${verdict.passed.join(', ')})`);
    } else {
      bad++;
      console.log(`  FAIL  ${spec}`);
      console.log(verdict.critique.split('\n').map(l => '          ' + l).join('\n'));
    }
    const sem = checkSemanticStability(feature, spec);
    if (sem.flagged.length) {
      stale++;
      console.log(`  note  ${spec} — ${sem.flagged.length} unauthorised data string(s), may go stale with the content:`);
      for (const f of sem.flagged) console.log(`          - ${f}`);
    }
    const loc = checkLocatorRobustness(spec);
    if (loc.flagged.length) {
      brittle++;
      console.log(`  note  ${spec} — ${loc.flagged.length} generated-class locator(s), will break on the next build:`);
      for (const f of loc.flagged) console.log(`          - ${f}`);
    }
  }
  console.log(bad ? `\n${bad} spec(s) would be rejected by the current rules` : '\nall specs pass the static gates');
  if (stale) console.log(`${stale} spec(s) contain potentially stale data assertions — review the "note" lines above`);
  if (brittle) console.log(`${brittle} spec(s) use generated-class locators — they will break on the next build`);
  return bad ? 1 : 0;
}

/**
 * Replay the recorded specs.
 *
 * Specs are named explicitly rather than pointing Playwright at the directory:
 * `tests/run` also holds the generator's seed file, which has to live inside
 * testDir so Playwright can run it while recording, but is an empty placeholder
 * with no business in a regression run. A testIgnore rule would have hidden it
 * from the recorder too.
 *
 * The verdict comes from the same replayGate the recorder uses, so a spec cannot
 * be judged one way when it is made and another way when it runs.
 */
function cmdReplay() {
  const specs = targetSpecs().map(p => p.spec);
  if (!specs.length) {
    console.log(target ? `no recorded specs for "${target}"` : 'no recorded specs yet');
    return 1;
  }
  console.log(`replaying ${specs.length} spec(s) (pure Playwright, no model calls)\n`);

  // A fresh run supersedes whatever the last one left behind.
  if (existsSync(RED_SPECS_FILE)) unlinkSync(RED_SPECS_FILE);

  const verdict = replayGate(specs);
  if (verdict.inconclusive) {
    console.log(`\nINCONCLUSIVE  ${verdict.inconclusive}`);
    return 2;
  }
  if (!verdict.ok) {
    const red = verdict.redSpecs ?? [];
    if (red.length) writeFileSync(RED_SPECS_FILE, JSON.stringify(red) + '\n');
    console.log(`\nFAILED\n${verdict.critique}`);
    return 1;
  }
  console.log(`\nok: ${specs.length} spec(s), ${verdict.stepCount} step(s), none empty`);
  return 0;
}

/**
 * Heal specs whose locators stopped matching.
 *
 * The healer agent re-locates each failing element against the live page and
 * rewrites the locator redundantly, then the spec is replayed deterministically
 * to confirm. A spec the page has changed beyond re-location becomes a diagnosis
 * report — the same artifact a verification failure produces.
 */
/** The specs a previous replay marked red, if any — read once, then gone. */
function readRedSpecs() {
  if (!existsSync(RED_SPECS_FILE)) return null;
  try {
    const list = JSON.parse(readFileSync(RED_SPECS_FILE, 'utf8'));
    if (Array.isArray(list) && list.length) return list;
  } catch { /* stale or malformed — ignore and fall back to every feature */ }
  return null;
}

async function cmdHeal() {
  // A replay that just went red leaves a list of red specs; heal only those,
  // rather than replaying every spec again to find the one that broke. Without
  // that list (e.g. `heal` run by hand) fall back to every feature.
  // An explicit target always wins; the red list only guides the unattended CI run.
  const red = target ? null : readRedSpecs();
  const features = red ? red.map(specToFeature) : resolveTargets(target);
  console.log(`healing ${features.length} feature(s)${red ? ' (the specs that went red)' : ''}\n`);
  let failed = 0;

  for (const feature of features) {
    console.log(`  ${feature}`);
    const result = await healFeature({ featurePath: feature, baseURL: BASE_URL });
    if (result.alreadyGreen) {
      console.log(`    ok  ${result.specPath} already replays green`);
      continue;
    }
    if (result.ok) {
      console.log(`    healed  ${result.specPath}`);
    } else if (result.diagnosisJson) {
      if (result.diagnosisOk) {
        console.log(`    UNHEALABLE  ${result.diagnosisJson}`);
        console.log('    the page changed beyond re-location — read the diagnosis report');
      } else {
        console.log(`    INVALID REPORT  ${result.diagnosisJson} — the agent produced a report the schema rejects:`);
        for (const e of result.diagnosisErrors) console.log(`      - ${e}`);
      }
    } else if (result.specChanged) {
      console.log(`    STILL RED  ${result.specPath} changed but still does not replay`);
    } else {
      console.log(`    FAILED  the healer produced no change`);
      if (result.agentSaid) console.log(`    agent said: ${result.agentSaid}`);
    }
    if (!result.ok) failed++;
  }

  return failed ? 1 : 0;
}

const commands = {
  status: cmdStatus,
  check: cmdCheck,
  record: cmdRecord,
  heal: cmdHeal,
  replay: cmdReplay,
};

if (!commands[command]) {
  console.log('usage: node src/cli.mjs <status|check|record|heal|replay> [feature or project]');
  process.exit(2);
}
process.exit((await commands[command]()) ?? 0);
