/**
 * Recording layer: hand a feature file to the agent, get a trace back.
 *
 * This layer is thin. It does not drive the browser and does not write code. It
 * invokes the verify agent, which walks each feature step in a real browser
 * (Playwright's MCP tools) and, per step, records one structured trace record
 * through the `record_step` tool. The deterministic renderer (render-spec.mjs) compiles
 * that trace into the spec afterwards, off the recording path.
 *
 * The split keeps two responsibilities apart: the agent supplies data a live
 * page proved (a locator that hit a real element, a value it read), and the
 * renderer owns the spec's shape, so the code the agent never writes cannot
 * carry a banned pattern or an unstable locator.
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync, appendFileSync } from 'fs';
import { dirname, resolve, relative, join } from 'path';
import { featureToSpec, projectOf, SEED_SPEC, SPEC_DIR } from './paths.mjs';
import { featureToTrace, readTrace } from './trace.mjs';
import { target } from './target.mjs';
import { reportPaths, finalizeDiagnosis, renderDiagnosis, validateDiagnosis } from './diagnose.mjs';
import { selectKnowledge } from './knowledge.mjs';
import { invokeProgressJudge } from './judger.mjs';
import { makeLineBuffer, parseEventLine, eventToActivity, finalTextFromEvent } from './stream-json.mjs';

/**
 * The generator opens the application through this seed test, so Playwright has
 * to be able to run it — which means it must sit inside `testDir`. Putting it
 * outside looks tidier but silently fails: the generator cannot find it and
 * quietly creates a default one instead. Replay skips it by naming the recorded
 * specs explicitly (see cmdReplay). The path itself lives in paths.mjs so there
 * is one definition of where it is.
 */
const SEED_FILE = SEED_SPEC.split('\\').join('/');
const AGENT = 'verify';
const MCP_CONFIG = '.mcp.json';

/**
 * The instruction handed to the agent.
 *
 * The feature text goes in verbatim as the `plan`. Verified by experiment: the
 * generator's `plan` parameter is a plain string that no code parses — it is
 * stored in the journal and read back by the model — so Gherkin needs no
 * translation into the planner's markdown dialect.
 *
 * The agent drives the browser and records one structured trace record per step
 * through the `record_step` tool (served by the proxy, which counts every action
 * locator on the live page before appending); the renderer compiles the trace into
 * the spec. So this prompt names the feature path (passed as `feature` in each
 * record_step call) — how to build a record is in the agent definition and does
 * not change between runs.
 *
 * The prompt has two shapes, matching the agent's two modes:
 *   - Mode A (from scratch): no prior artifact to lean on — record every step.
 *   - Mode B (from an existing spec/trace): the run has a recorded spec and/or
 *     trace to work from. There are two sub-shapes:
 *       - `resumeFromStep` given → the orchestrator has already confirmed the
 *         prefix renders and staged it, so the agent's seed replays it cleanly
 *         and the agent picks up at that step. This is the resume/repair path.
 *       - no `resumeFromStep`, but an existing spec/trace → the orchestrator
 *         could not confirm a clean prefix; the agent follows the existing
 *         artifact step by step against the live page, decides where it stops
 *         holding, and takes over there (`## Mode B` in the agent definition).
 * `replayFailure`, when a replay went red, is passed as a starting hint — the
 * step titles the gate reported, for the agent to check first, not to trust.
 */
export function buildPrompt({
  featurePath, featureText, baseURL, critique = null, resumeFromStep = null, resumeSeed = null,
  knowledge = '', existingSpecPath = null, existingTracePath = null, replayFailure = null,
}) {
  const where = target(baseURL);
  const reportJson = reportPaths(featurePath).json;
  // A resume run replays a rendered PREFIX as its seed: generator_setup_page runs
  // that spec for real, landing the browser at step K's starting state — no agent
  // re-does the prefix. Absent a resume seed, the blank seed just opens the app.
  // The server reads these as posix paths whatever `join` produced.
  const seed = (resumeSeed ?? SEED_FILE).split('\\').join('/');
  // Mode B is any run with something to lean on: a confirmed prefix to resume
  // from, or an existing spec/trace to follow. Everything else is Mode A.
  const modeB = resumeFromStep != null || existingSpecPath != null || existingTracePath != null;
  return `Verify the business logic in the feature below against the live page, and
record what held as a trace — one structured record per step.

Source feature:  ${featurePath}   (pass this as \`feature\` in every record_step call)
Seed file:       ${seed}
Start path:      ${where.path}   (relative to baseURL ${where.origin})
Record each verified step by calling the \`record_step\` tool with one trace record
                                         plus \`feature: "${featurePath}"\` in its arguments.
Write a diagnosis instead, if a step cannot be verified:
                                         ${reportJson}

--- FEATURE ---
${featureText}
--- END FEATURE ---

Pass the feature text above verbatim as the \`plan\` to generator_setup_page, and
"${seed}" as \`seedFile\`.

How to work is in your agent definition and does not change between runs: the
workflow, how to record a step, how to choose and stack locator candidates, what
a value's dynamic/fixed marking means, the shape of a trace record, and what a
diagnosis must contain. Follow it.

The one thing worth repeating here, because it is what a missing step is scored
on: the \`step\` field of every record is the feature step **verbatim, Gherkin
keyword and all** — "Given the applicant is on the entry page", not "the applicant
is on the entry page". Every feature step must become exactly one record.

The trace is checked automatically — every feature step must have a record, and
the rendered spec must replay green against the live page — and sent back with
specific reasons if it does not hold up.${knowledge ? `

${knowledge}` : ''}${modeB ? `

## This is a Mode B run — you have an existing spec/trace to work from

Follow "## Mode B" in your agent definition. In short: use the existing artifact
as a reference, reuse the steps that still hold, take over at the first step that
does not, and re-record from there. A locator in the existing spec/trace is a
lead, not proof — every candidate you record must still be counted to exactly one
match against the current page, the same as recording from scratch.
${existingSpecPath ? `
Existing spec:   ${existingSpecPath}` : ''}${existingTracePath ? `
Existing trace:  ${existingTracePath}` : ''}${resumeFromStep != null ? `

### A confirmed prefix is already staged — resume from step ${resumeFromStep}

The steps before this run, up to step ${resumeFromStep - 1}, are ALREADY recorded on
disk as trace records. The seed file above is that prefix rendered as a spec:
calling generator_setup_page runs it for real, so the browser lands at step
${resumeFromStep}'s starting state — you do NOT re-drive or re-record any earlier step.
\`generator_read_log\` shows you the seed's source under "# Seed file".

When the seed replays cleanly and lands you at step ${resumeFromStep}'s starting state,
pick up there and \`record_step\` onward through the end of the feature. Do NOT record
steps 1..${resumeFromStep - 1} again — they are on disk; a second record would duplicate
the trace.

**But the prefix is a lead, not a guarantee.** It was recorded earlier; the page or
its data may have changed. If generator_setup_page ERRORS, or you are NOT at step
${resumeFromStep}'s expected starting state afterward (confirm with the read-only tools —
the heading/URL/element the next step needs is not there), then a prefix step no
longer holds on the live page. Do NOT force a record_step onto a wrong page. Switch
to taking over (see "## Mode B" in your agent definition): follow the trace as a
reference, find the FIRST step that no longer holds, run
\`node src/cli.mjs retrace ${featurePath} K\` to keep the K-1 that still hold, and
re-record from step K. A broken prefix is a takeover, not a dead end.` : `

### No confirmed prefix — follow the existing artifact step by step

The orchestrator could not stage a clean prefix, so do not assume any step is
still good. Follow the existing spec/trace as a checklist: for each step, confirm
against the live page (read-only) that its locator still points at exactly one
correct element and its assertion still holds; if it does, do the action yourself
and record the step afresh; at the first step that does not hold, stop — that is
your takeover point. Do NOT hand the whole existing spec to generator_setup_page
to replay in one shot: a spec with a bad step ends in failure, not paused at the
bad step, and leaves the page in a failed state.

When you know your takeover point is step K, run
\`node src/cli.mjs retrace ${featurePath} K\` first — the orchestrator backs up the
trace and truncates it to the K-1 clean records — then record from step K onward.
If the existing artifact is useless from the start (the page or feature changed
beyond re-location), that is \`retrace ${featurePath} 1\`, and you record the whole
feature. You never delete or rewrite the trace file yourself.`}${replayFailure ? `

### A previous replay went red — start your checking here

${replayFailure}

These are the step titles the replay reported. Treat them as where to look first,
not as the verdict — confirm against the live page what you actually see.` : ''}` : ''}${critique ? `

## A previous attempt was rejected

${critique}${resumeFromStep == null && !modeB ? `

Record the scenario again from the start. The rejection above is the acceptance
criteria — the same checks run again on whatever you produce. The trace is rebuilt
from scratch this run.` : ''}` : ''}`;
}

/**
 * Where this feature's browser scratch output (snapshots, console logs) goes.
 *
 * Left unset, every concurrent or sequential recording writes into the same
 * flat `.playwright-mcp/`, and telling one feature's snapshots from another's
 * means grepping file contents for which environment they mention. Mirroring
 * the spec's own path — the same convention `featureToSpec` already uses —
 * gives each feature its own subtree for free.
 *
 * `logs/` sits next to `reports/`: both are generated, project/feature-shaped,
 * and hold nothing a spec file does — the seed and the specs stay the only
 * things under `run`.
 */
export function mcpOutputDir(specPath) {
  return join('logs', relative(SPEC_DIR, specPath).replace(/\.spec\.ts$/, ''));
}

/**
 * Invoke the agent.
 *
 * Three things here are not stylistic — each one cost a failed run to learn:
 *
 * 1. `--mcp-config` must be passed explicitly. A project-scoped `.mcp.json` sits
 *    in "pending approval" until a human approves it interactively; in headless
 *    mode the tools then silently do not exist and the agent simply reports that
 *    it cannot help. Passing the config as a flag bypasses that.
 * 2. The prompt goes in over stdin, never as a shell string. A shell expands `$`
 *    and backticks, quietly rewriting the instructions.
 * 3. The whole toolchain must run on one operating system. Across a WSL/Windows
 *    boundary the client sends a POSIX cwd that the server resolves against a
 *    drive letter (`C:\mnt\c\...`); `--config` cannot repair it, because the
 *    server takes its root from the client's cwd first.
 */
export function invokeAgent(prompt, { agent = AGENT, allowedTools = 'mcp__playwright-test', outputDir = null, watchdog = null, activityLog = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', [
      '-p',
      // Stream the agent's work as line-delimited JSON events instead of an opaque
      // text blob. This is what makes the run observable: each tool call (which
      // knowledge file it Read, which element it clicked, which step it recorded)
      // arrives as its own event, so a readable activity log can be written live
      // and a stall can be pinned to the exact tool it wedged on. `--verbose` is
      // required by the CLI for stream-json.
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', MCP_CONFIG,
      '--agent', agent,
      '--permission-mode', 'acceptEdits',
      '--allowed-tools', allowedTools,
      // Opt-in only: debugging a hang needs to see what the agent was doing
      // when it stopped, not just that it stopped. Off by default — these
      // logs are verbose and unrelated to normal recording.
      ...(process.env.RECORDER_DEBUG_FILE ? ['--debug-file', process.env.RECORDER_DEBUG_FILE] : []),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: outputDir ? { ...process.env, PLAYWRIGHT_MCP_OUTPUT_DIR: resolve(outputDir) } : process.env,
    });

    let err = '';

    // The agent's final text, kept as the terminal `result` event arrives — the
    // equivalent of the old `stdout.trim()`, so everything downstream (agentSaid,
    // the progress Judge's agentTail) is unchanged.
    let finalText = '';
    // A rolling tail of readable activity lines (tool calls, agent text), capped
    // so a long or chatty run cannot grow it without bound. This is what the
    // progress Judge sees as `agentTail` — a sequence of what the agent did,
    // which pins a stall far better than raw text ever did.
    const activityTail = [];
    const ACTIVITY_TAIL_MAX = 200;
    const recordActivity = line => {
      const stamped = `${new Date().toISOString()}  ${line}`;
      activityTail.push(line);
      if (activityTail.length > ACTIVITY_TAIL_MAX) activityTail.shift();
      if (activityLog) {
        try { appendFileSync(activityLog, stamped + '\n'); }
        catch { /* the activity log is best-effort; never fail a recording over it */ }
      }
    };

    // Parse stdout as a stream-json event stream: buffer partial lines, parse each
    // whole line, turn events into activity, and keep the final result text.
    // Returns true when the line was a *meaningful* progress event (a tool call,
    // agent text, init or result) — NOT for the low-level noise the CLI also emits
    // (tool_result echoes, heartbeats, partial frames). The watchdog uses this, so
    // it must reflect real forward motion: a run wedged inside one long tool call
    // (e.g. a seed replay that hangs) emits stdout noise but produces no progress
    // event, and must therefore be seen as stalled — not kept alive by the noise.
    const lineBuf = makeLineBuffer();
    const consume = line => {
      const ev = parseEventLine(line);
      if (!ev) return false;
      const activity = eventToActivity(ev);
      for (const a of activity) recordActivity(a);
      const ft = finalTextFromEvent(ev);
      if (ft != null) finalText = ft;
      // Progress = we produced a readable activity line for this event. That is
      // exactly the set of events (tool_use / text / init / result) that mean the
      // agent moved; everything else returns [] and does not count as progress.
      return activity.length > 0;
    };

    // Stop the child on an abandon verdict: ask politely (SIGTERM), then, if it is
    // still alive after a grace period, force it (SIGKILL). A `claude` child wedged
    // in a native browser call can ignore SIGTERM; without the escalation the
    // promise below (which only resolves on 'close') would hang forever — defeating
    // the very watchdog that decided to abandon. The grace timer is unref'd so it
    // never keeps the event loop alive on its own.
    const hardStop = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 5_000);
      t.unref?.();
    };
    // A structured *progress* event is real activity; use it (not raw bytes, not
    // every stdout line) as the "agent is still working" signal, so the low-level
    // noise the CLI streams while wedged inside one long tool call cannot
    // masquerade as progress and keep the stall watchdog from ever firing.
    let lastEventAt = Date.now();
    child.stdout.on('data', d => {
      for (const line of lineBuf.push(d.toString())) {
        if (consume(line)) lastEventAt = Date.now();
      }
    });
    child.stderr.on('data', d => { err += d; });

    // The progress watchdog (opt-in). The user's rule: never hard-kill on a timer —
    // a timer cannot tell a slow-but-fine step from a genuinely stuck run. Instead,
    // when there is NO progress for a while — no new trace record AND no fresh agent
    // output (the two-signal check: a growing trace is real progress, live stdout is
    // the agent still working, either one resets the clock) — summon the Judger to
    // rule on the stall. It answers 'wait' (keep going) or 'abandon' (write a
    // diagnosis and stop). Only an 'abandon' verdict kills the child — the kill
    // decision is the Judger's, not a timer's.
    let watchTimer = null, abandoned = null, judging = false;
    if (watchdog) {
      const { tracePath, featurePath, scenario, stallMs, onAbandon, checkEveryMs = 30_000, maxWaits = 3 } = watchdog;
      const traceMtime = () => { try { return statSync(tracePath).mtimeMs; } catch { return 0; } };
      const stepsNow = () => { try { return readTrace(featurePath).length; } catch { return 0; } };
      let lastMtime = traceMtime();
      let progressAt = Date.now();   // last time we saw progress (trace grew or a new event arrived)
      let waitsUsed = 0;
      let judgeSeq = 0;
      watchTimer = setInterval(async () => {
        if (judging || abandoned) return;
        const mt = traceMtime();
        const progressed = mt !== lastMtime || lastEventAt > progressAt;
        if (progressed) { lastMtime = mt; progressAt = Date.now(); return; }
        if (Date.now() - progressAt < stallMs) return;   // not stalled long enough yet

        // Stalled: summon the progress Judger on the meta-facts.
        judging = true;
        const steps = stepsNow();
        let verdict;
        try {
          verdict = await invokeProgressJudge({
            featurePath, scenario,
            stalledForMs: Date.now() - progressAt,
            phase: steps === 0 ? 'setup' : 'recording',
            stepsRecorded: steps,
            agentTail: activityTail.join('\n'),
            seq: ++judgeSeq,
          });
        } catch (e) {
          verdict = { decision: 'wait', inconclusive: `progress judge threw: ${e?.message ?? e}` };
        }
        if (verdict.decision === 'abandon') {
          abandoned = { class: verdict.class, summary: verdict.summary, report: verdict.report ?? [] };
          try { onAbandon?.(abandoned); } catch { /* diagnosis write is best-effort */ }
          process.stderr.write(`[watchdog] progress judge ruled ABANDON (${verdict.class}): ${verdict.summary} — stopping the agent\n`);
          clearInterval(watchTimer); watchTimer = null;
          hardStop();
        } else {
          waitsUsed++;
          process.stderr.write(`[watchdog] progress judge ruled WAIT (${waitsUsed}/${maxWaits})${verdict.inconclusive ? ` [${verdict.inconclusive}]` : ''}\n`);
          progressAt = Date.now();   // grant another full stall window
          judging = false;
          if (waitsUsed >= maxWaits) {
            // The Judger has said "wait" maxWaits times and still nothing moves. Stop
            // deferring forever: abandon as an environment stall a human should see.
            abandoned = { class: 'environment', summary: `no progress after ${maxWaits} progress-judge checks`, report: [{ problem: 'the recording never resumed progress across repeated checks', suggestion: 'check the network/environment/login and re-run' }] };
            try { onAbandon?.(abandoned); } catch { /* best effort */ }
            process.stderr.write(`[watchdog] ${maxWaits} WAIT verdicts with no progress — abandoning as environment\n`);
            clearInterval(watchTimer); watchTimer = null;
            hardStop();
          }
        }
      }, checkEveryMs);
      watchTimer.unref?.();
    }

    child.on('error', e => { if (watchTimer) clearInterval(watchTimer); reject(e); });
    child.on('close', () => {
      if (watchTimer) clearInterval(watchTimer);
      // Drain any final partial line the stream ended on.
      for (const line of lineBuf.flush()) consume(line);
      resolvePromise({ stdout: finalText.trim(), stderr: err.trim(), abandoned });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Write a diagnosis for a run the progress Judge ruled ABANDON (a stall the watchdog
 * escalated). The step Writer never got to write its own diagnosis — it was stuck —
 * so this composes one from the Judge's verdict, in the same closed schema a Writer
 * diagnosis uses, and renders the markdown. `class` from the progress Judge
 * (environment|feature|backend|data) maps onto the diagnosis schema's four
 * categories (frontend|backend|environment|unverifiable): feature/data have no exact
 * category there, so they land as `unverifiable` with the real class in the summary.
 *
 * @param nowIso  the created_at timestamp — passed in so this stays a pure writer
 *                (the caller stamps the time; Date.now is fine in recorder itself).
 */
export function writeStallDiagnosis(featurePath, { klass, summary, report = [], stepsRecorded = 0, scenario = null, nowIso }) {
  const category = klass === 'environment' ? 'environment' : klass === 'backend' ? 'backend' : 'unverifiable';
  const obstacle = stepsRecorded === 0
    ? 'the run stalled during setup — no step was recorded before progress stopped'
    : `the run stalled after ${stepsRecorded} step(s) with no further progress`;
  const evidence = (report.length ? report : [{ problem: summary || 'no progress', suggestion: 'check the environment and re-run' }])
    .map(r => ({ type: 'snapshot', finding: `${r.problem ?? ''}${r.suggestion ? ` — ${r.suggestion}` : ''}`.slice(0, 500) }));
  const feature = readFileSync(featurePath, 'utf8');
  const firstScenario = scenario ?? (feature.match(/^\s*Scenario:\s*(.+)$/m)?.[1]?.trim() ?? '(recording)');
  const report_ = {
    report_version: '1.0',
    id: `stall-${basenameNoExt(featurePath)}-${nowIso}`,
    created_at: nowIso,
    stage: 'verify',
    feature: featurePath,
    diagnoses: [{
      scenario: firstScenario,
      step: stepsRecorded === 0 ? '(setup — before the first recorded step)' : `(after step ${stepsRecorded})`,
      verdict: { category, summary: `${klass}: ${summary || 'the recording made no progress'}`.slice(0, 300), confidence: 'medium' },
      attempt: { steps_completed: stepsRecorded, obstacle, last_action: 'progress watchdog escalated to the Judger, which ruled abandon' },
      evidence,
    }],
  };
  const { ok, errors } = validateDiagnosis(report_);
  const { json, md, dir } = reportPaths(featurePath);
  mkdirSync(dir, { recursive: true });
  if (!ok) {
    // Should not happen (we build to the schema), but never let a schema slip lose
    // the finding — write the raw object so a human still sees why it stopped.
    writeFileSync(json, JSON.stringify({ ...report_, _schemaErrors: errors }, null, 2));
    return { json, md: null, ok: false };
  }
  writeFileSync(json, JSON.stringify(report_, null, 2));
  writeFileSync(md, renderDiagnosis(report_));
  return { json, md, ok: true };
}

/** A feature file's base name without the .feature extension (for a diagnosis id). */
function basenameNoExt(featurePath) {
  return featurePath.split(/[\\/]/).pop().replace(/\.feature$/, '');
}

/**
 * Undo a recording the gates would not accept.
 *
 * A rejected spec must not be left on disk. `pairing()` decides a feature has
 * been recorded by finding a spec file where one belongs, so a file the gates
 * turned away still reads as a recorded feature — and CI runs `status` first
 * precisely because an unrecorded feature is otherwise indistinguishable from a
 * passing one. Leaving the reject there is the same failure the gates exist to
 * prevent: a file on disk standing in for a verified one.
 *
 * Restoring matters as much as deleting. Re-recording a feature that already had
 * a working spec must not cost that spec when the new attempt is turned away.
 *
 * @param specPath  where the recording would have gone
 * @param previous  the file's bytes before the run, or null if there was none
 * @returns 'restored' when an earlier spec was put back, 'discarded' when the
 *          reject was removed, 'nothing' when the run left no file behind
 */
export function discardRejectedSpec(specPath, previous) {
  if (previous !== null) {
    writeFileSync(specPath, previous);
    return 'restored';
  }
  if (existsSync(specPath)) {
    unlinkSync(specPath);
    return 'discarded';
  }
  return 'nothing';
}

/**
 * Record one feature. Returns what happened; the caller decides the exit code.
 *
 * `resumeFromStep`, when given, is the 1-based index of the first step to
 * re-record — the steps before it are already on disk in the trace. `resumeSeed`,
 * when given, is a path to a rendered PREFIX spec: generator_setup_page runs it for
 * real so the browser reaches step K's starting state without the agent re-driving
 * the prefix (the two travel together — cmdRecord renders the prefix and passes both).
 *
 * `existingSpecPath` / `existingTracePath`, when given, switch the agent to Mode
 * B: it follows the existing artifact as a reference and takes over at the first
 * step that no longer holds (see buildPrompt / the agent's `## Mode B`).
 * `replayFailure` is the critique from a red replay, passed as a starting hint.
 */
export async function recordFeature({
  featurePath, baseURL = null, critique = null, resumeFromStep = null, resumeSeed = null, extraKnowledge = [],
  existingSpecPath = null, existingTracePath = null, replayFailure = null,
}) {
  if (!existsSync(featurePath)) throw new Error(`no such feature: ${featurePath}`);
  if (!existsSync(MCP_CONFIG)) {
    throw new Error(`${MCP_CONFIG} is missing — run: npx playwright init-agents --loop=claude`);
  }
  const specPath = featureToSpec(featurePath);
  const tracePath = featureToTrace(featurePath);
  const diagnosisJson = reportPaths(featurePath).json;
  mkdirSync(dirname(resolve(tracePath)), { recursive: true });

  const prompt = buildPrompt({
    featurePath,
    featureText: readFileSync(featurePath, 'utf8'),
    baseURL,
    critique,
    resumeFromStep,
    resumeSeed,
    existingSpecPath,
    existingTracePath,
    replayFailure,
    knowledge: selectKnowledge(featurePath, { extra: extraKnowledge }).text,
  });

  // Remember the trace as it stands. The agent's success is a trace it grew this
  // run — `existsSync` alone cannot tell "the agent appended to this" from "a
  // trace from an earlier run was still lying there", and that mistake reads as
  // success, the worst way to be wrong. A resume run appends to an existing
  // trace, so the mtime moving is what says the agent did something.
  const before = existsSync(tracePath) ? statSync(tracePath).mtimeMs : null;
  const diagnosisBefore = existsSync(diagnosisJson) ? statSync(diagnosisJson).mtimeMs : null;

  const startedAt = Date.now();
  // Progress watchdog: no hard kill on a timer. When the run makes no progress
  // (no new trace record AND no fresh agent output) for STALL_MINUTES, the Judger
  // is summoned to rule wait/abandon; only an abandon verdict stops the agent, and
  // it writes a diagnosis first. STALL_MINUTES is configurable (default 5).
  const stallMs = Number(process.env.STALL_MINUTES ?? 5) * 60_000;
  // Where the readable, live record of what the agent did this run is written —
  // one line per tool call / message, so a stall or a slow step can be seen and
  // pinned to the exact tool. Reset at the start of each run so it reflects this
  // attempt, not a stale earlier one. Best-effort: never fail a recording over it.
  const activityLog = join(reportPaths(featurePath).dir, `${basenameNoExt(featurePath)}.activity.log`);
  try {
    mkdirSync(dirname(activityLog), { recursive: true });
    writeFileSync(activityLog, '');
    // A resume run's first visible act is the agent replaying the prefix seed — a
    // single blocking generator_setup_page call that can take a minute or two and
    // emits nothing readable while it runs. Note it up front so a watcher of this
    // log knows the quiet stretch is an expected replay, not a hang.
    if (resumeFromStep != null) {
      appendFileSync(activityLog,
        `${new Date().toISOString()}  [resume] replaying ${resumeFromStep - 1} recorded step(s) as the seed, then taking over at step ${resumeFromStep} (the replay is one blocking call — expect a quiet stretch)\n`);
    }
  } catch { /* best-effort */ }
  const { stdout, stderr, abandoned } = await invokeAgent(prompt, {
    // record_step is an MCP tool (via the proxy under mcp__playwright-test); it,
    // not Bash, is how a step is recorded now. Bash remains for `node src/cli.mjs
    // retrace` (a Mode B takeover); Write for staging the diagnosis report.
    allowedTools: 'mcp__playwright-test,Read,Write,Bash',
    outputDir: mcpOutputDir(specPath),
    activityLog,
    watchdog: {
      tracePath, featurePath, scenario: null, stallMs,
      onAbandon: ({ class: klass, summary, report }) => {
        // The Judger ruled the stall unrecoverable. Compose the diagnosis the stuck
        // Writer never got to write, so the outcome is a proper diagnosis (human
        // acts), not a silent hang.
        try {
          writeStallDiagnosis(featurePath, {
            klass, summary, report,
            stepsRecorded: (() => { try { return readTrace(featurePath).length; } catch { return 0; } })(),
            nowIso: new Date().toISOString(),
          });
        } catch (e) { process.stderr.write(`[watchdog] failed to write stall diagnosis: ${e?.message ?? e}\n`); }
      },
    },
  });

  const after = existsSync(tracePath) ? statSync(tracePath).mtimeMs : null;
  const diagnosisAfter = existsSync(diagnosisJson) ? statSync(diagnosisJson).mtimeMs : null;
  const diagnosisWritten = diagnosisAfter !== null && diagnosisAfter !== diagnosisBefore;
  const diagnosis = diagnosisWritten ? finalizeDiagnosis(featurePath) : null;

  return {
    featurePath,
    specPath,
    tracePath,
    project: projectOf(featurePath),
    ms: Date.now() - startedAt,
    written: after !== null && after !== before,
    stale: after !== null && after === before,
    diagnosisWritten,
    diagnosisOk: diagnosis ? diagnosis.ok : null,
    diagnosisErrors: diagnosis ? diagnosis.errors : null,
    diagnosisCascadeNote: diagnosis ? diagnosis.cascadeNote : null,
    diagnosisJson,
    // Set when the progress watchdog's Judge ruled the run a stall to abandon (a
    // diagnosis was written by onAbandon). Lets the caller report it as a stall
    // rather than a normal rejection.
    stalled: abandoned ? { class: abandoned.class, summary: abandoned.summary } : null,
    agentOutput: [stdout, stderr].filter(Boolean).join('\n'),
    agentSaid: stdout.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400),
  };
}
