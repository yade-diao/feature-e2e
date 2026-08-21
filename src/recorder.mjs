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
import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
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
  return `Record a Playwright test from the Gherkin feature below.

Source feature file: ${featurePath}
Target spec file:    ${specPath}
Seed file:           ${SEED_FILE}
Start path:          ${where.path}   (relative to baseURL ${where.origin})

--- FEATURE ---
${featureText}
--- END FEATURE ---

Follow the generator workflow, with verification as the goal:
1. generator_setup_page — pass the feature text above verbatim as \`plan\`, and "${SEED_FILE}" as \`seedFile\`.
2. Work through the scenario one step at a time in the real browser using the browser_* tools.
   Use each step's text as the intent of the tool call, and confirm each step's
   business logic actually holds before moving on.
3. generator_read_log
4. If every step verified, generator_write_test — write to exactly ${specPath}.
   If any step could not be verified, write the diagnosis report instead (below).

Shape of the generated file:
- describe title = the Feature name; test title = the Scenario name.
- Wrap the work of each feature step in
  \`await test.step('<the step text verbatim>', async () => { ... })\`.
  This overrides your agent definition, which asks for a comment above each step:
  a comment is invisible at runtime, so a step that silently did nothing cannot be
  told apart from one that worked. Use test.step, and put the step text in the
  title exactly as the feature words it — that binding is what lets a failure name
  the business step it came from.
- Give every step something to do. Where a step only asks for something to be
  looked at, attach the evidence:
  \`await testInfo.attach('<name>', { body: await page.screenshot(), contentType: 'image/png' })\`.
- Navigate with the path only: \`await page.goto('${where.path}')\`. The origin comes
  from baseURL, so the same recording runs against another environment unchanged.

Look first, then act once:
- browser_find({ text }), browser_snapshot and browser_generate_locator take no
  \`intent\` and stay out of the recording. Work out what to do with those.
- Every action tool requires an \`intent\` and lands in the recording, so decide
  before you act rather than by trying.
- A full-page snapshot of a data-dense page runs to 80-150 KB and has stalled a
  recording outright. Scope it with { target } or { depth }, or use browser_find.

Locators — pick them to survive a rebuild, in this order of preference:
1. Role + accessible name — \`page.getByRole('button', { name: '...' })\`. Role is
   accessibility semantics, not markup, so it survives DOM reshuffles, class
   hashes and framework upgrades.
2. Form semantics — \`getByLabel\`, \`getByPlaceholder\`, \`getByTitle\`.
3. \`getByTestId\` — only when the value is a stable, hand-written literal. Never
   a testid that embeds an id, index or hash.
4. Visible text — prefer a substring or regex over an exact full string so a
   wording tweak does not break it: \`getByText(/search/i)\`.
5. CSS — last resort, and only a semantic class. Never record a generated class:
   CSS modules (\`.Module_x__ab12cd\`), styled-components (\`sc-...\`), emotion
   (\`css-...\`). They change on every build and are the single most common reason
   a recorded test goes red the next morning.

Make locators redundant rather than clever:
- Chain from a stable anchor instead of a positional nth():
  \`page.getByTestId('job-table').getByRole('button', { name: '...' })\`.
- Where a trait can drift (a renamed testid, a reworded label), record a backup
  chain with \`.or()\` — the first locator that still matches wins:
  \`page.getByTestId('search-input').or(page.getByRole('textbox', { name: /搜索/ }))\`.

Assertions say what the feature says:
- For "every remaining row mentions X":
  \`await expect(rows.filter({ hasNotText: 'X' })).toHaveCount(0)\`.
- Assert structure rather than the data that happened to be on screen. A headline
  or a product name read off the page during recording expires; that a heading
  exists does not. \`toMatchAriaSnapshot\` takes regular expressions for values
  that move.
- Use web-first assertions throughout — they wait and retry, which is how
  readiness is expressed.
- Never prove "the list is showing things" with a positional locator — \`.first()\`,
  \`.nth()\`, \`.last()\` are rejected. Use a count assertion
  (\`await expect(rows).toHaveCount(n)\` / \`.toBeGreaterThanOrEqual(n)\`) or name a
  specific row with role/text.
- Where a step claims something is absent or bounded above ("no error", "at most
  N"), assert in the same step that something which should be present is present.
  Zero satisfies "at most N", so on its own such a step passes on a blank page.

Verification comes first — the spec is what is left when every step holds:
- Work through every step and confirm its business logic actually holds. A step
  that verifies is recorded; a step that does not is diagnosed, never faked.
- When a step cannot be verified, exhaust every means before concluding: try an
  alternative locator, wait and retry, inspect the network responses and console
  messages. Only then record a diagnosis for that step.
- If any step fails, write a diagnosis report instead of the spec: one JSON
  object at ${reportJson}, conforming to schemas/diagnosis.schema.json. The
  fields and their closed enums are all spelled out there — in particular
  \`verdict.category\` is one of frontend|backend|environment|unverifiable and
  every \`evidence.type\` is one of network|console|snapshot|dom|assertion.
  Choose the category from evidence you actually observed (a network status, a
  console error, a snapshot), never from a guess, and fill the attempt field to
  show how far you got.

The recording is checked automatically and sent back with specific reasons if it
does not hold up, so aim for the shape above rather than trying to guess every
rule.

Do not write the spec file by hand. If the generator tools are unavailable, stop
and say so rather than producing a file some other way.${critique ? `

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
