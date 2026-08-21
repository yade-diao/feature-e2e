/**
 * Recording layer: hand a feature file to the agent, get a Playwright spec back.
 *
 * This layer is deliberately thin. It does NOT drive the browser and does NOT
 * generate code — Playwright's own test agents do both:
 *
 *   generator_setup_page  opens the app on a seed test, paused
 *   browser_* tools       the agent performs each step for real
 *   GeneratorJournal      records {step title, generated code} as it goes
 *   generator_read_log    hands the journal back to the agent
 *   generator_write_test  writes the spec
 *
 * That is the whole point: the selectors in the produced spec are selectors that
 * actually hit an element on the live page, not selectors a model imagined. The
 * previous incarnation of this project prompted a model to *write* a spec and
 * then only checked that a file existed — which proves nothing.
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import { featureToSpec, projectOf, SEED_SPEC } from './paths.mjs';
import { target } from './target.mjs';
import { reportPaths, finalizeDiagnosis } from './diagnose.mjs';

/**
 * The generator opens the application through this seed test, so Playwright has
 * to be able to run it — which means it must sit inside `testDir`. Putting it
 * outside looks tidier but silently fails: the generator cannot find it and
 * quietly creates a default one instead. Replay skips it by naming the recorded
 * specs explicitly (see cmdReplay). The path itself lives in paths.mjs so there
 * is one definition of where it is.
 */
export const SEED_FILE = SEED_SPEC.split('\\').join('/');
const AGENT = 'verify';
const MCP_CONFIG = '.mcp.json';

/**
 * The instruction handed to the agent.
 *
 * The feature text goes in verbatim as the `plan`. Verified by experiment: the
 * generator's `plan` parameter is a plain string that no code parses — it is
 * stored in the journal and read back by the model — so Gherkin needs no
 * translation into the planner's markdown dialect.
 */
export function buildPrompt({ featurePath, specPath, featureText, baseURL, critique = null }) {
  const where = target(baseURL);
  const reportJson = reportPaths(featurePath).json;
  return `Verify the business logic in the feature below against the live page, and
have the generator record what held.

Source feature:  ${featurePath}
Seed file:       ${SEED_FILE}
Start path:      ${where.path}   (relative to baseURL ${where.origin})
Write the spec to:                       ${specPath}
Write a diagnosis there instead, if a step cannot be verified:
                                         ${reportJson}

--- FEATURE ---
${featureText}
--- END FEATURE ---

Pass the feature text above verbatim as the \`plan\` to generator_setup_page, and
"${SEED_FILE}" as \`seedFile\`.

How to work is in your agent definition and does not change between runs: the
workflow, which tools land in the recording, what you may not do to the page,
how to choose and stack locators, what an assertion has to claim, the shape of
the file, and what a diagnosis must contain. Follow it.

Two rules are worth repeating here because they are the two that actually get
recordings rejected:

1. Every feature step becomes \`await test.step('<step text>', ...)\` with the
   text **exactly** as the feature words it, Gherkin keyword and all — "Given the
   applicant is on the recruitment entry page", not "the applicant is on the
   recruitment entry page". A title that drops the keyword counts as a missing
   step.
2. No \`.first()\`, \`.nth()\` or \`.last()\`, anywhere, including in an assertion
   written only to prove the list is alive. Use \`toHaveCount(n)\` or
   \`.toBeGreaterThanOrEqual(n)\` instead.

The recording is checked automatically and sent back with specific reasons if it
does not hold up, so aim for the shape your definition describes rather than
trying to guess every rule.${critique ? `

## A previous attempt was rejected

${critique}

Record the scenario again from the start. The rejection above is not advice, it is
the acceptance criteria — the same checks run again on whatever you produce.` : ''}`;
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
/**
 * Successful recordings have taken 7-12 minutes. Thirty minutes was not a
 * timeout, it was an invitation: a stalled run burned 25 of them before anyone
 * noticed. Fifteen is long enough for a real recording and short enough that a
 * hang is cheap.
 */
export const RECORD_TIMEOUT_MS = 900_000;

export function invokeAgent(prompt, { timeoutMs = RECORD_TIMEOUT_MS, agent = AGENT, allowedTools = 'mcp__playwright-test' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', [
      '-p',
      '--mcp-config', MCP_CONFIG,
      '--agent', agent,
      '--permission-mode', 'acceptEdits',
      '--allowed-tools', allowedTools,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('agent timed out')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      resolvePromise({ stdout: out.trim(), stderr: err.trim() });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
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

/** Record one feature. Returns what happened; the caller decides the exit code. */
export async function recordFeature({ featurePath, baseURL = null, critique = null }) {
  if (!existsSync(featurePath)) throw new Error(`no such feature: ${featurePath}`);
  if (!existsSync(MCP_CONFIG)) {
    throw new Error(`${MCP_CONFIG} is missing — run: npx playwright init-agents --loop=claude`);
  }
  const specPath = featureToSpec(featurePath);
  const diagnosisJson = reportPaths(featurePath).json;
  mkdirSync(dirname(resolve(specPath)), { recursive: true });

  const prompt = buildPrompt({
    featurePath,
    specPath,
    featureText: readFileSync(featurePath, 'utf8'),
    baseURL,
    critique,
  });

  // Remember the file as it stands. `existsSync` alone cannot tell "the agent
  // wrote this" from "a file from an earlier run was still lying there" — and
  // that mistake reads as success, which is the worst way to be wrong.
  const before = existsSync(specPath) ? statSync(specPath).mtimeMs : null;
  const diagnosisBefore = existsSync(diagnosisJson) ? statSync(diagnosisJson).mtimeMs : null;

  const startedAt = Date.now();
  const { stdout, stderr } = await invokeAgent(prompt, { allowedTools: 'mcp__playwright-test,Write' });

  const after = existsSync(specPath) ? statSync(specPath).mtimeMs : null;
  const diagnosisAfter = existsSync(diagnosisJson) ? statSync(diagnosisJson).mtimeMs : null;
  const diagnosisWritten = diagnosisAfter !== null && diagnosisAfter !== diagnosisBefore;
  const diagnosis = diagnosisWritten ? finalizeDiagnosis(featurePath) : null;

  return {
    featurePath,
    specPath,
    project: projectOf(featurePath),
    ms: Date.now() - startedAt,
    written: after !== null && after !== before,
    stale: after !== null && after === before,
    diagnosisWritten,
    diagnosisOk: diagnosis ? diagnosis.ok : null,
    diagnosisErrors: diagnosis ? diagnosis.errors : null,
    diagnosisJson,
    agentOutput: [stdout, stderr].filter(Boolean).join('\n'),
    agentSaid: stdout.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400),
  };
}
