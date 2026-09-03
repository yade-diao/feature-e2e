#!/usr/bin/env node
/**
 * feature-e2e — turn a plain-language feature into a replayable Playwright spec.
 *
 *   node src/cli.mjs status                   pairing between features and specs
 *   node src/cli.mjs check  [feature|project] static gates over already-recorded specs
 *   node src/cli.mjs record [feature|project] verify each step; recorder writes the spec
 *   node src/cli.mjs retrace <feature> <K>    truncate a trace to K-1 records (agent takeover)
 *   node src/cli.mjs replay [feature|project] run the recorded specs
 *
 * `record` has one agent, two modes, chosen automatically from what is on disk:
 *   - Mode A (from scratch): no spec and no trace — verify and record every step.
 *   - Mode B (from an existing spec/trace): a recorded spec or a non-empty trace
 *     exists — the agent follows it as a reference, reuses the steps that still
 *     hold, and takes over at the first that does not (see recorder buildPrompt
 *     and the agent's `## Mode B`). This is also how a spec that went red at
 *     replay is repaired — no separate `heal` command.
 *
 * record accepts these optional flags:
 *   --knowledge=<repo|path>[,...]  append extra knowledge bases for the agent to
 *                                  consult (a synced repo slug, or a local dir)
 *   --refresh                      pull the links.json-declared bases up to date
 *                                  before running (record is otherwise offline;
 *                                  sync is the standalone equivalent)
 *   --restart                      discard any trace on disk and record from the
 *                                  start (backed up to .bak first)
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
import { dirname, join } from 'path';
import { FEATURE_DIR, RESUME_SEED, featureToSpec, listFeatures, pairing, specToFeature } from './paths.mjs';
import { recordFeature, discardRejectedSpec } from './recorder.mjs';
import { readTrace, truncateTrace, backupTrace, featureToTrace } from './trace.mjs';
import { renderSpec } from './render-spec.mjs';
import { runGates, staticGates, replayGate } from './gates.mjs';
import { checkSemanticStability, checkLocatorRobustness, checkWriteCheckpoint } from './checks.mjs';
import { logAttempt, summary } from './journal.mjs';
import { syncExternal } from './knowledge.mjs';
import { projectOf } from './paths.mjs';
import { allSteps, baseUrlFromFeature } from './feature.mjs';

const [command = 'status', target = null, third = null] = process.argv.slice(2).filter(a => !a.startsWith('--'));

/**
 * Optional flags, parsed off the same argv the positional split above ignores.
 *
 *   --knowledge=<repo|path>[,<repo|path>...]   append extra knowledge bases,
 *       repeatable and comma-separated. A repo ref must already be synced under
 *       external/<slug>/; a local directory path is read where it sits.
 *   --refresh   before recording, pull the links.json-declared bases for the
 *       targeted projects up to date. record is otherwise offline.
 *   --restart   discard any trace already on disk for the targeted feature and
 *       record from the start (backed up to .bak first). Without it, a feature
 *       whose spec or trace holds an earlier (interrupted, failed or red) run is
 *       recorded in Mode B: the agent follows the existing artifact and takes
 *       over where it stops holding, instead of re-driving the whole feature.
 */
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const extraKnowledge = flags
  .filter(a => a.startsWith('--knowledge='))
  .flatMap(a => a.slice('--knowledge='.length).split(','))
  .map(s => s.trim()).filter(Boolean);
const REFRESH = flags.includes('--refresh');
const RESTART = flags.includes('--restart');

/**
 * Where a failed replay leaves the list of red spec files for `record` to pick
 * up. Written on red, cleared at the start of every replay — so it never goes
 * stale and a repair run never re-records a spec that is already green.
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

/**
 * Pull the links.json-declared knowledge bases for the targeted features'
 * projects up to date, when `--refresh` is given. Deliberately best-effort: a
 * failed fetch is printed, not thrown, so a network hiccup degrades to whatever
 * is already on disk (core-only at worst) rather than aborting the run. Extras
 * named on the command line are not touched — refresh only knows links.json.
 */
function refreshFor(features) {
  if (!REFRESH) return;
  const projects = [...new Set(features.map(projectOf).filter(Boolean))];
  if (!projects.length) return;
  console.log('refreshing knowledge bases…');
  for (const p of projects) {
    for (const r of syncExternal(p)) {
      console.log(r.sha
        ? `  refreshed  ${r.project}  ${r.repo}@${r.sha}`
        : `  FAILED     ${r.project}  ${r.repo ?? '(no repo)'} — ${r.error} (using what is on disk)`);
    }
  }
  console.log('');
}

async function cmdRecord() {
  // A replay that just went red leaves a list of red specs. With no explicit
  // target, repair only those — the run is Mode B against each red spec. An
  // explicit target always wins; the red list only guides the unattended CI run.
  // Without a red list (nothing went red, or `record` run by hand) fall back to
  // every feature.
  const red = target ? null : readRedSpecs();
  const redSet = red ? new Set(red.map(specToFeature)) : null;
  const features = red ? red.map(specToFeature) : resolveTargets(target);
  refreshFor(features);
  console.log(`recording ${features.length} feature(s)${red ? ' (the specs that went red — repairing in Mode B)' : ''}\n`);
  let failed = 0;

  const runId = Date.now().toString(36);

  // The BASE_URL the caller exported, captured once before the loop. A run records
  // one feature at a time and sets process.env.BASE_URL per feature (below) so the
  // child process sees the right origin — but that write must not leak into the
  // next feature. Reading process.env.BASE_URL inside the loop would let feature 1
  // (which named its own URL) dictate the origin for feature 2 (which named none),
  // silently recording feature 2 against feature 1's environment. So decide from
  // this snapshot, never from the value we ourselves wrote last iteration.
  const envBaseUrl = process.env.BASE_URL || null;

  // A killed process (Ctrl+C, a CI job cancelled, a supervisor timeout above
  // this one) skips the ordinary end-of-feature cleanup below, and a spec an
  // attempt was still writing when the signal landed is left on disk exactly
  // as a passing recording would be. The next run then reads it as "the spec
  // as it stood before this run" and either restores or discards *that*,
  // silently laundering a half-written file into "the previous good spec".
  // Whatever is pending when a signal arrives is exactly what the ordinary
  // path would have cleaned up, so run the same function and exit the same
  // way a normal rejection would have.
  let pendingCleanup = null;
  const onSignal = () => { pendingCleanup?.(); process.exit(1); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  for (const feature of features) {
    console.log(`  ${feature}`);

    // The environment under test. An explicit BASE_URL (the caller exported one)
    // wins as an override; otherwise take it from the feature itself — the login
    // step's Url column names the entry page. Set it on the environment so the
    // child recorder/replay process, which loads the Playwright config and reads
    // BASE_URL from env, sees the same origin the trace was recorded against. A
    // feature that names no URL and no env override leaves it unset: the config's
    // baseOrigin() then errors loudly rather than pointing at a placeholder host.
    // Decide from envBaseUrl (the caller's value, snapshotted before the loop),
    // never from process.env.BASE_URL, which we overwrite each feature — reading
    // it back would let one feature's URL leak into the next.
    const featureBaseUrl = envBaseUrl ?? baseUrlFromFeature(feature);
    if (featureBaseUrl) {
      process.env.BASE_URL = featureBaseUrl;
      console.log(`    environment: ${featureBaseUrl}${envBaseUrl ? ' (from BASE_URL)' : ' (from the feature)'}`);
    } else {
      // Neither an override nor a URL in the feature. Clear any value a previous
      // feature set so the child does not inherit the wrong origin; the config
      // will then error loudly, which is the honest outcome.
      delete process.env.BASE_URL;
    }

    let critique = null;
    let done = false;

    // The spec as it stands before this run, so a run that ends with nothing the
    // gates accept can be undone. Leaving a rejected spec on disk would let it
    // count as a recording in `status`, and re-recording a working feature must
    // not cost the spec that worked.
    const specPath = featureToSpec(feature);
    const tracePath = featureToTrace(feature);
    const specBefore = existsSync(specPath) ? readFileSync(specPath) : null;

    // 1-based index of the first step to record, or null. When set, the prefix
    // lives in the trace and is rendered as `resumeSeed` (a spec) below, which
    // generator_setup_page replays to land the browser at that step before the
    // agent records onward — a confirmed-prefix resume.
    let resumeFromStep = null;
    let resumeSeed = null;
    const resumeSeedPath = join(dirname(specPath), RESUME_SEED);
    // A stale resume seed from an interrupted earlier run must never be reused as
    // this run's prefix — remove it up front; it is re-rendered only if this run
    // stages a resume.
    if (existsSync(resumeSeedPath)) unlinkSync(resumeSeedPath);

    // Stage a confirmed-prefix resume from whatever the trace on disk now holds:
    // render its records as a spec, write that as the resume seed, and point the
    // next run at step (prefix length + 1). generator_setup_page replays the seed
    // for real so the browser lands at that step's starting state and the agent
    // records onward without re-driving the prefix. Returns the 1-based resume
    // step, or null when the trace is empty, unrenderable, or already covers every
    // feature step (nothing left to resume onto). Used both for the initial resume
    // (below) and to resume after a coverage-only failure (the agent stopped short
    // of the end but every step it did record is sound — replay them, don't re-walk
    // them from step 1).
    const stageResumeFromTrace = () => {
      let recs = [];
      try { recs = readTrace(feature); } catch { return null; }
      if (recs.length === 0 || recs.length >= totalSteps) return null;
      try { writeFileSync(resumeSeedPath, renderSpec(recs)); }
      catch { return null; }   // an unrenderable prefix cannot seed a replay
      resumeSeed = resumeSeedPath;
      existingTracePath = tracePath;
      if (existsSync(specPath)) existingSpecPath = specPath;
      return recs.length + 1;
    };

    // Mode B inputs. The agent works from whatever existing artifact is on disk:
    // a recorded spec and/or a trace. Set below once we know they are present and
    // not being discarded. `replayFailure` is a starting hint when this feature's
    // spec is one a replay just marked red.
    let existingSpecPath = null;
    let existingTracePath = null;
    const replayFailure = redSet?.has(feature)
      ? `The spec ${specPath} went red at the last replay. Re-verify it against the live page.`
      : null;

    // How this run treats a trace already on disk from an earlier (interrupted,
    // failed or red) run. `--restart` throws it away and records from scratch. By
    // default the trace is a Mode B reference: keep it, and either resume from a
    // confirmed prefix or let the agent follow it and take over where it stops
    // holding — so a long feature that ran out of time, or a Ctrl-C, or a red
    // replay, does not cost the steps already recorded.
    // A trace on disk that no longer reads as legal records — a dangling ref, or
    // a shape the write-time checks now refuse (readTrace validates every line) —
    // is not a resumable prefix, but the raw .trace.jsonl is still a Mode B
    // reference the agent follows step by step. Treat an unreadable trace as "no
    // usable prefix" here; the file is kept (only --restart discards it) and the
    // Mode B branch below points the agent at it.
    let existing = [];
    try { existing = readTrace(feature); }
    catch { existing = []; }
    const totalSteps = allSteps(feature).length;
    // The prefix must render on its own for a resume to replay it as the seed. A
    // trace with a dangling value ref or a shape the renderer refuses cannot be
    // resumed onto — but it is still a usable Mode B reference the agent follows
    // step by step, so we keep it and just do not stage it as a confirmed prefix.
    let prefixUsable = existing.length > 0;
    if (prefixUsable) {
      try { renderSpec(existing); }
      catch { prefixUsable = false; }
    }

    if (RESTART) {
      // Explicit "start over". Back up the trace before discarding it — a wrong
      // --restart on a long recording is exactly the loss the .bak guards.
      if (existsSync(tracePath)) { backupTrace(feature); unlinkSync(tracePath); }
    } else if (existing.length > totalSteps) {
      // The trace holds more steps than the feature now has — the feature was
      // shortened since it was recorded, so the prefix no longer lines up. This
      // is a genuine mismatch, not a Mode B reference; discard it (backed up).
      console.log(`    the trace has ${existing.length} step(s) but the feature now has ${totalSteps} — recording from the start`);
      if (existsSync(tracePath)) { backupTrace(feature); unlinkSync(tracePath); }
    } else if (prefixUsable && existing.length < totalSteps) {
      // A clean, renderable prefix shorter than the feature: stage a confirmed
      // resume. Render the prefix trace as a spec and write it as the resume seed;
      // generator_setup_page replays it for real so the browser lands at step
      // existing.length+1's starting state, and the agent records onward without
      // re-driving the prefix (prefixUsable already proved this renders, line ~241).
      resumeFromStep = existing.length + 1;
      writeFileSync(resumeSeedPath, renderSpec(existing));
      resumeSeed = resumeSeedPath;
      existingTracePath = tracePath;
      if (existsSync(specPath)) existingSpecPath = specPath;
      console.log(`    resuming ${feature} from step ${resumeFromStep} (${existing.length} clean trace record(s) on disk, replaying them as the seed)`);
    } else if (existing.length > 0 || existsSync(specPath)) {
      // Mode B without a confirmed prefix: there is a spec and/or a trace to work
      // from, but no clean prefix to stage (the trace does not render, or already
      // covers every step and something downstream is wrong). The agent follows
      // the existing artifact, confirms each step against the live page, and uses
      // `retrace` to take over at the first step that no longer holds. Do NOT
      // discard the trace here — it is the reference.
      if (existsSync(tracePath)) existingTracePath = tracePath;
      if (existsSync(specPath)) existingSpecPath = specPath;
      console.log(`    ${feature} has an existing ${existingSpecPath && existingTracePath ? 'spec and trace' : existingSpecPath ? 'spec' : 'trace'} — recording in Mode B (agent follows it and takes over where it stops holding)`);
    }
    // else: nothing on disk — Mode A, record from the start.

    // Undo the spec this run rendered if it ends rejected — a half-written spec
    // left on disk would count as a recording in `status`. The trace is left
    // alone: it is the Mode B reference / resumable progress log, not a paired
    // artifact, and `pairing()` never reads it, so keeping it cannot launder a
    // bad recording.
    pendingCleanup = () => {
      discardRejectedSpec(specPath, specBefore);
      // On a signal (Ctrl-C) mid-run, also drop the transient resume seed.
      if (existsSync(resumeSeedPath)) unlinkSync(resumeSeedPath);
    };

    // The trace already covers every feature step and renders (a prior run
    // recorded it all but was interrupted before the spec was rendered or the
    // gates ran). There is nothing for the agent to record, so skip straight to
    // rendering the spec and running the gates. If they pass, the feature is done
    // without spending a browser session. If they don't, fall through to the Mode
    // B attempt loop below: the agent follows the trace and takes over at the
    // failing step via `retrace` — the orchestrator no longer guesses the bad
    // step from failedTitles.
    if (!RESTART && prefixUsable && existing.length === totalSteps) {
      console.log(`    trace already covers all ${totalSteps} step(s) — rendering and checking without re-recording`);
      let renderError = null;
      try { writeFileSync(specPath, renderSpec(readTrace(feature))); }
      catch (e) { renderError = e.message; }
      if (!renderError) {
        const verdict = await runGates(feature, specPath);
        for (const p of verdict.passed) console.log(`      ok  ${p}`);
        logAttempt({ run: runId, feature, attempt: 0, ms: 0, ok: verdict.ok, passed: verdict.passed.length, gates: verdict.ok ? [] : (verdict.failed ?? []) });
        if (verdict.ok) { done = true; }
        else if (!verdict.inconclusive) {
          // Hand the failure to the agent as a Mode B repair: it follows the
          // trace, confirms against the live page, and `retrace`s to its takeover
          // point. The orchestrator does not truncate the trace here.
          critique = verdict.critique;
          existingTracePath = tracePath;
          existingSpecPath = specPath;
        }
      }
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
      if (attempt > 1) console.log(`    retry ${attempt}/${MAX_ATTEMPTS} with the critique above${resumeFromStep != null ? ` (resuming from step ${resumeFromStep})` : ''}`);

      let result;
      try {
        result = await recordFeature({
          featurePath: feature, baseURL: featureBaseUrl, critique, resumeFromStep, resumeSeed, extraKnowledge,
          existingSpecPath, existingTracePath, replayFailure,
        });
      } catch (e) {
        console.log(`    FAILED  ${e.message.split('\n')[0]}`);
        break;   // an exception here is the harness failing, not the recording
      }

      if (!result.written) {
        if (result.diagnosisWritten) {
          if (result.diagnosisOk) {
            console.log(`    UNVERIFIED  ${result.diagnosisJson}`);
            console.log('    the business logic could not be verified — read the diagnosis report');
            if (result.diagnosisCascadeNote) console.log(`    note: ${result.diagnosisCascadeNote}`);
          } else {
            console.log(`    INVALID REPORT  ${result.diagnosisJson} — the agent produced a report the schema rejects:`);
            for (const e of result.diagnosisErrors) console.log(`      - ${e}`);
          }
        } else {
          console.log(result.stale
            ? `    FAILED  ${result.tracePath} was not touched - this is a leftover from an earlier run`
            : `    FAILED  the agent produced no trace at ${result.tracePath}`);
          console.log(`    agent said: ${result.agentSaid || '(nothing)'}`);
        }
        logAttempt({
          run: runId, feature, attempt, ms: result.ms ?? 0, ok: false,
          passed: 0, gates: [],
          outcome: result.diagnosisWritten
            ? (result.diagnosisOk ? 'diagnosis' : 'invalid diagnosis')
            : 'no artifact',
        });
        // An attempt that added nothing to the trace, in a run that had a Mode B
        // reference (a resume prefix, or an existing spec/trace). Keep the trace —
        // it is the reference, and a run out of attempts should still leave it on
        // disk to work from next time — and retry rather than throwing it away.
        if ((resumeFromStep != null || existingTracePath != null) && !result.diagnosisWritten) {
          console.log('    nothing came back this attempt — the trace on disk is kept; retrying');
          continue;
        }
        break;   // no trace: a diagnosis is a result, not a retry, and no artifact has nothing to critique
      }

      // The agent grew the trace; the renderer — not the agent — turns it into
      // the spec. This is where the quality guarantee lands: whatever the agent
      // recorded, the spec's shape is the renderer's, so it cannot carry a banned
      // pattern or a bare action locator.
      let renderError = null;
      try {
        writeFileSync(specPath, renderSpec(readTrace(feature)));
      } catch (e) {
        renderError = e.message;
      }
      if (renderError) {
        // A trace the renderer refuses is a recorder bug (a dangling value ref, a
        // shape validateRecord let through) — not something a retry fixes by
        // re-driving the browser. Surface it and stop.
        console.log(`    FAILED  the trace did not render: ${renderError}`);
        logAttempt({ run: runId, feature, attempt, ms: result.ms, ok: false, passed: 0, gates: [], outcome: 'render error' });
        break;
      }
      console.log(`    rendered ${specPath} from ${readTrace(feature).length} trace step(s) (${(result.ms / 1000).toFixed(0)}s)`);

      const verdict = await runGates(feature, specPath);
      for (const p of verdict.passed) console.log(`      ok  ${p}`);

      logAttempt({
        run: runId, feature, attempt, ms: result.ms, ok: verdict.ok,
        passed: verdict.passed.length,
        gates: verdict.ok ? [] : (verdict.inconclusive ? ['inconclusive'] : (verdict.failed ?? [])),
      });

      if (verdict.ok) { done = true; break; }

      if (verdict.inconclusive) {
        console.log(`    INCONCLUSIVE  ${verdict.inconclusive}`);
        break;
      }

      console.log(`    rejected:\n${verdict.critique.split('\n').map(l => '      ' + l).join('\n')}`);
      critique = verdict.critique;

      // How the next attempt resumes depends on WHY this one failed.
      //
      // Coverage-only failure — the agent stopped short of the end (ran out of
      // context/time), but every step it DID record is sound (coverage runs first
      // in runGates and short-circuits, so replay never even ran to fault a step).
      // Re-walking the recorded prefix from step 1 is exactly the waste we must
      // avoid: replay the confirmed prefix as the seed and have the agent record
      // onward from where it stopped. Only fall back to the "agent re-verifies and
      // retraces" path when there is a genuine step rejection (replay faulted a
      // step), or when the prefix cannot be staged (empty/unrenderable/complete).
      const coverageOnly = Array.isArray(verdict.failed)
        && verdict.failed.length === 1 && verdict.failed[0] === 'step coverage';
      const resumeStep = coverageOnly ? stageResumeFromTrace() : null;
      if (resumeStep != null) {
        resumeFromStep = resumeStep;
        console.log(`    coverage short of the end — replaying the ${resumeStep - 1} recorded step(s) as the seed and resuming from step ${resumeStep} (not re-recording from the start)`);
      } else {
        // A genuine step rejection (or no stageable prefix): the rejected spec and
        // the trace become the reference the agent follows — it re-verifies each
        // step against the live page and, at the first that no longer holds, calls
        // `retrace` to take over there. The orchestrator never guesses the bad step
        // or truncates the trace itself; the trace is only ever shortened through
        // the controlled `retrace` command (which backs it up first). Drop any
        // confirmed-prefix resume so the agent decides its own takeover point.
        resumeFromStep = null;
        resumeSeed = null;
        existingTracePath = existsSync(tracePath) ? tracePath : null;
        existingSpecPath = existsSync(specPath) ? specPath : null;
      }
    }

    if (!done) {
      failed++;
      const undo = discardRejectedSpec(specPath, specBefore);
      if (undo === 'restored') {
        console.log(`    kept the previous ${specPath} — every attempt in this run was turned away`);
      } else if (undo === 'discarded') {
        console.log(`    discarded ${specPath} — a spec the gates turned away is not a recording`);
      }
      // The trace is a Mode B reference, not a paired artifact: keep it on disk so
      // the next `record` follows it and takes over where it stops holding.
      // `pairing` never reads it, so a kept trace cannot launder a rejected run
      // into a recorded one. Re-run with --restart to discard it (backed up to
      // .bak) and record from scratch.
      const kept = readTrace(feature).length;
      if (kept > 0) {
        console.log(`    kept the trace (${kept} step(s)) at ${tracePath} — re-run to repair in Mode B, or add --restart to record from scratch`);
      }
    }
    // The resume seed was a transient staging artifact for this run — drop it
    // whatever the outcome (done or failed), so it is never mistaken for a recorded
    // spec or reused stale by a later run. (pairing()/listFeatures already skip a
    // dotfile, but leaving generated scratch around is its own untidiness.)
    if (existsSync(resumeSeedPath)) unlinkSync(resumeSeedPath);
    pendingCleanup = null;
  }

  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  // Every recording ever made, not this run. The number is a trend — one run is
  // an anecdote, which is the reason the journal exists — but printed bare at
  // the end of a run it reads as this run's result, and a run that recorded
  // nothing would still report a rate.
  const s = summary();
  if (s.runs) {
    console.log(`\nall recordings so far — first-attempt pass rate: ${s.firstTry}/${s.runs}`
      + ` (${(s.rate * 100).toFixed(0)}%) over ${s.attempts} attempt(s)`);
    if (s.rejections.length) {
      console.log(`  rejections by gate: ${s.rejections.map(([g, n]) => `${g} ${n}`).join(', ')}`);
    }
    if (s.outcomes.length) {
      console.log(`  attempts that produced no spec: ${s.outcomes.map(([o, n]) => `${o} ${n}`).join(', ')}`);
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
  if (!specs.length) {
    // An explicit target that matches nothing is a question with no answer, and
    // stays an error. Nothing recorded at all is not: `status` is the command
    // that fails on a feature with no spec, and CI runs it first for exactly
    // that reason. Failing here as well only means a checkout that carries the
    // tool without a suite can never go green, while adding nothing `status`
    // did not already say.
    if (target) { console.log(`no recorded specs for "${target}"`); return 1; }
    const { missingSpec } = pairing();
    console.log(missingSpec.length
      ? `no recorded specs to check — ${missingSpec.length} feature(s) are waiting to be recorded (run: status)`
      : 'no recorded specs to check');
    return 0;
  }

  console.log(`checking ${specs.length} spec(s) — static gates only, no browser\n`);
  let bad = 0;
  let stale = 0;
  let brittle = 0;
  let nakedWrites = 0;
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
    const wc = checkWriteCheckpoint(spec);
    if (wc.naked.length) {
      nakedWrites++;
      console.log(`  note  ${spec} — ${wc.naked.length} write step(s) with no checkpoint assertion, may hide a silent write failure:`);
      for (const n of wc.naked) console.log(`          - line ${n.line}: ${n.title}`);
    }
  }
  console.log(bad ? `\n${bad} spec(s) would be rejected by the current rules` : '\nall specs pass the static gates');
  if (stale) console.log(`${stale} spec(s) contain potentially stale data assertions — review the "note" lines above`);
  if (brittle) console.log(`${brittle} spec(s) use generated-class locators — they will break on the next build`);
  if (nakedWrites) console.log(`${nakedWrites} spec(s) have write steps without a checkpoint — review the "note" lines above`);
  return bad ? 1 : 0;
}

/**
 * Replay the recorded specs.
 *
 * Specs are named explicitly rather than pointing Playwright at the directory:
 * `run` also holds the generator's seed file, which has to live inside
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
    // The same split as `check`, and here it costs more to get wrong. CI runs
    // replay with continue-on-error, so its exit code is not a verdict — it is
    // the signal that a spec went red and a Mode B repair (`record`) should be
    // woken. An empty suite exiting 1 sends every run down that path: install the
    // CLI, regenerate the agents, spend a key, repair nothing. A named target with
    // nothing behind it stays an error, as it does everywhere else.
    if (target) { console.log(`no recorded specs for "${target}"`); return 1; }
    const { missingSpec } = pairing();
    console.log(missingSpec.length
      ? `nothing to replay — ${missingSpec.length} feature(s) are waiting to be recorded (run: status)`
      : 'nothing to replay');
    return 0;
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

/** The specs a previous replay marked red, if any — read once by `record`. */
function readRedSpecs() {
  if (!existsSync(RED_SPECS_FILE)) return null;
  try {
    const list = JSON.parse(readFileSync(RED_SPECS_FILE, 'utf8'));
    if (Array.isArray(list) && list.length) return list;
  } catch { /* stale or malformed — ignore and fall back to every feature */ }
  return null;
}

/**
 * Truncate a feature's trace to its first K-1 records — the agent's controlled
 * way to say "I am taking over at step K".
 *
 *   node src/cli.mjs retrace <feature> <K>
 *
 * Mode B hands the agent an existing spec/trace as a reference. When the agent
 * follows it and finds the first step that no longer holds, it takes over there
 * and re-records from that step. But recording only appends — so the records
 * from the takeover step onward have to be dropped first, and the agent must not
 * do that itself: letting the model rewrite the trace file is exactly how a long
 * recording once collapsed to one step. So the agent names its takeover point K,
 * and this — deterministic code — backs the trace up to `.bak` and truncates it
 * to the K-1 clean records the agent kept. K=1 truncates to nothing (a full
 * re-record when the existing artifact is useless). The agent then records
 * from step K onward (via the record_step tool), appending onto exactly this prefix.
 */
function cmdRetrace() {
  if (!target || third == null) {
    console.error('usage: node src/cli.mjs retrace <feature.feature> <K>');
    return 2;
  }
  if (!existsSync(target)) { console.error(`no such feature: ${target}`); return 1; }
  const k = Number(third);
  if (!Number.isInteger(k) || k < 1) {
    console.error(`K must be a positive integer (the 1-based step to take over at), got: ${third}`);
    return 1;
  }
  const tracePath = featureToTrace(target);
  const before = readTrace(target).length;
  // Keep the K-1 records before the takeover step. truncateTrace backs up to
  // .bak first, so an overshoot never loses the records it drops.
  const kept = truncateTrace(target, k - 1);
  console.log(`retraced ${target}: kept ${kept} record(s) (was ${before}); backed up to ${tracePath}.bak`);
  console.log(`  record step ${k} onward with the record_step tool`);
  return 0;
}

/**
 * Sync external knowledge bases into knowledge/external/. An explicit step,
 * deliberately separate from record so a recording never depends on the
 * network. `target` may be a project name or a feature path (whose project is
 * derived); with no target, every linked project is synced.
 */
async function cmdSync() {
  const project = target ? (target.endsWith('.feature') ? projectOf(target) : target) : null;
  const results = syncExternal(project);
  if (!results.length) {
    console.log('  nothing to sync — no projects declared in knowledge/links.json');
    return 0;
  }
  let failed = 0;
  for (const r of results) {
    if (r.sha) {
      console.log(`  synced  ${r.project}  ${r.repo}@${r.sha}`);
    } else {
      console.log(`  FAILED  ${r.project}  ${r.repo ?? '(no repo)'} — ${r.error}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

const commands = {
  status: cmdStatus,
  check: cmdCheck,
  record: cmdRecord,
  retrace: cmdRetrace,
  replay: cmdReplay,
  sync: cmdSync,
};

if (!commands[command]) {
  console.log('usage: node src/cli.mjs <status|check|record|retrace|replay|sync> [feature or project] [--knowledge=repo|path,...] [--refresh] [--restart]');
  process.exit(2);
}
process.exit((await commands[command]()) ?? 0);
