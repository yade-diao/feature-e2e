/**
 * Healing — repair a spec whose locators no longer match the live page.
 *
 * Where verification is "does the business logic hold on first sight", healing
 * is "it held when we recorded it, but the page moved under the locators". The
 * healer re-locates each failing element against the live page and rewrites the
 * locator redundantly — role first, then semantics, then a stable testid, then
 * text, CSS last, and always a .or() fallback — then the spec is replayed
 * deterministically to confirm.
 *
 * A spec the page has changed beyond re-location becomes a diagnosis report:
 * the same artifact a verification failure produces, because at that point the
 * reason it cannot be verified is a business reason, not a stale locator.
 */

import { existsSync, statSync } from 'fs';
import { featureToSpec } from './paths.mjs';
import { reportPaths, finalizeDiagnosis } from './diagnose.mjs';
import { replayGate } from './gates.mjs';
import { invokeAgent, mcpOutputDir } from './recorder.mjs';

const AGENT = 'playwright-test-healer';
const MCP_CONFIG = '.mcp.json';

export function buildHealPrompt({ featurePath, specPath, failure }) {
  const reportJson = reportPaths(featurePath).json;
  return `Repair the recorded spec below.

Spec file:       ${specPath}
Source feature:  ${featurePath}

The spec failed to replay. The failure:

${failure}

Heal it the way the recorder would have recorded it:
1. Run the spec (test_run) to reproduce the failure.
2. For each failing locator, use browser_generate_locator against the live page
   to find the element again, then rewrite the locator so it survives a rebuild:
   role + accessible name first, then form semantics, then a stable testid, then
   visible text, CSS last. Give every action a redundant fallback chain with
   .or(), so one trait drifting does not break it again.
3. Re-run to confirm the fix.
4. If you repaired it, leave the spec fixed. The healed locator must satisfy the
   same rule as a fresh recording: role / label / placeholder / a stable testid
   are stable on their own; an action located by visible text, alt text, title
   or CSS needs a .or() fallback.
5. If the page itself changed and the business logic can no longer be verified —
   the element is gone, or the data is wrong — do not force a locator onto it.
   Write a diagnosis report instead, at ${reportJson}, conforming to
   schemas/diagnosis.schema.json. It is an envelope, not a flat object —
   \`scenario\`/\`step\`/\`verdict\`/\`attempt\`/\`evidence\` each live one level
   down, inside a \`diagnoses\` array, alongside top-level \`report_version\`
   ("1.0"), \`id\`, \`created_at\` and \`stage\` ("heal"):
   \`{ report_version, id, created_at, stage: "heal", feature, diagnoses: [
   { scenario, step, verdict: { category, summary, confidence }, attempt:
   { steps_completed, obstacle, last_action? }, evidence: [...] } ] }\`.
   \`attempt\` is an object — \`steps_completed\` and \`obstacle\` are both
   required, not a paragraph describing what you tried. The closed enums are
   the same as a verification report: verdict.category is one of
   frontend|backend|environment|unverifiable, each evidence.type one of
   network|console|snapshot|dom|assertion. Attribute from evidence you actually
   observed.
`;
}

/**
 * Heal one feature. Returns what happened; the caller decides the exit code.
 *
 * "Healed" is not the agent's word — after the agent touches the spec it is
 * replayed deterministically, and only a green replay counts as healed. The
 * agent's own test_run is a hint, not a verdict.
 */
export async function healFeature({ featurePath, baseURL = null, failure = null }) {
  if (!existsSync(featurePath)) throw new Error(`no such feature: ${featurePath}`);
  if (!existsSync(MCP_CONFIG)) {
    throw new Error(`${MCP_CONFIG} is missing — run: npx playwright init-agents --loop=claude`);
  }

  const specPath = featureToSpec(featurePath);
  if (!existsSync(specPath)) throw new Error(`no spec to heal: ${specPath} — record it first`);

  // Nothing to heal if it already passes. Replay first so the agent sees the
  // concrete failure rather than re-deriving it.
  if (failure == null) {
    const verdict = replayGate([specPath]);
    if (verdict.ok) return { ok: true, healed: false, alreadyGreen: true, specPath, ms: 0 };
    failure = verdict.critique ?? '(replay failed)';
  }

  const diagnosisJson = reportPaths(featurePath).json;
  const before = statSync(specPath).mtimeMs;
  const diagnosisBefore = existsSync(diagnosisJson) ? statSync(diagnosisJson).mtimeMs : null;

  const prompt = buildHealPrompt({ featurePath, specPath, failure });
  const startedAt = Date.now();
  const { stdout, stderr } = await invokeAgent(prompt, {
    agent: AGENT,
    allowedTools: 'mcp__playwright-test,Edit,Write',
    outputDir: mcpOutputDir(specPath),
  });

  const after = statSync(specPath).mtimeMs;
  const diagnosisAfter = existsSync(diagnosisJson) ? statSync(diagnosisJson).mtimeMs : null;
  const specChanged = after !== before;
  const diagnosisWritten = diagnosisAfter !== null && diagnosisAfter !== diagnosisBefore;
  const ms = Date.now() - startedAt;

  if (specChanged) {
    const verdict = replayGate([specPath]);
    if (verdict.ok) return { ok: true, healed: true, specPath, ms };
    return { ok: false, healed: false, specChanged: true, specPath, ms,
      agentOutput: [stdout, stderr].filter(Boolean).join('\n') };
  }

  if (diagnosisWritten) {
    const diagnosis = finalizeDiagnosis(featurePath);
    return { ok: false, healed: false, diagnosisJson,
      diagnosisOk: diagnosis.ok, diagnosisErrors: diagnosis.errors, ms };
  }

  return { ok: false, healed: false, noResult: true, ms,
    agentSaid: stdout.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400) };
}
