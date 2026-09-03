/**
 * Diagnosis reports — the structured artifact produced when a piece of business
 * logic cannot be verified.
 *
 * The verify agent writes these whenever a piece of business logic cannot be
 * verified — on a first recording (Mode A) or while repairing an existing
 * spec/trace (Mode B), the same shape either way, so one failure exit serves
 * both. `stage` is always `verify`; `heal` remains a legal stage only so that
 * diagnosis reports written by the old healer agent still validate.
 *
 * The shape is closed on purpose. `category` and `evidence.type` are enums, not
 * free text — an agent that could write any verdict would write a plausible one
 * instead of a true one. The schema lives in schemas/diagnosis.schema.json;
 * this file is its executable form. It does not load that file (which would
 * pull in a JSON-Schema evaluator for one small fixed shape) — it re-states the
 * constraints, and the counterexamples in src/__tests__ keep the two in step.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve, join, basename } from 'path';
import { projectOf } from './paths.mjs';

const STAGES = ['verify', 'heal'];
const CATEGORIES = ['frontend', 'backend', 'environment', 'unverifiable'];
const CONFIDENCES = ['high', 'medium', 'low'];
const EVIDENCE_TYPES = ['network', 'console', 'snapshot', 'dom', 'assertion'];

/**
 * Validate a report against the shape above.
 *
 * Returns a list of every violation, not the first one — a report with six
 * problems should not have to be bounced five times to name them all. The list
 * is what a producer–critic loop feeds back to the agent.
 *
 * @param {unknown} report
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDiagnosis(report) {
  const errors = [];
  const push = (path, msg) => errors.push(`${path}: ${msg}`);

  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, errors: ['report must be a JSON object'] };
  }

  if (report.report_version !== '1.0') push('report_version', 'must be "1.0"');
  if (typeof report.id !== 'string' || !report.id.trim()) push('id', 'must be a non-empty string');
  if (typeof report.created_at !== 'string' || !report.created_at.trim()) push('created_at', 'must be an ISO string');
  if (!STAGES.includes(report.stage)) push('stage', `must be one of: ${STAGES.join(', ')}`);
  if (typeof report.feature !== 'string' || !report.feature.trim()) push('feature', 'must be a non-empty path');

  if (!Array.isArray(report.diagnoses) || report.diagnoses.length === 0) {
    push('diagnoses', 'must be a non-empty array');
  } else {
    report.diagnoses.forEach((d, i) => validateDiagnosisEntry(d, i, push));
  }

  return { ok: errors.length === 0, errors };
}

function validateDiagnosisEntry(d, i, push) {
  const at = `diagnoses[${i}]`;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) {
    push(at, 'must be an object');
    return;
  }

  if (typeof d.scenario !== 'string' || !d.scenario.trim()) push(`${at}.scenario`, 'must be a non-empty string');
  if (typeof d.step !== 'string' || !d.step.trim()) push(`${at}.step`, 'must be the feature step verbatim');

  // verdict
  const v = d.verdict;
  if (v === null || typeof v !== 'object') {
    push(`${at}.verdict`, 'is required');
  } else {
    if (!CATEGORIES.includes(v.category)) push(`${at}.verdict.category`, `must be one of: ${CATEGORIES.join(', ')}`);
    if (typeof v.summary !== 'string' || !v.summary.trim()) push(`${at}.verdict.summary`, 'must be a non-empty sentence');
    if (!CONFIDENCES.includes(v.confidence)) push(`${at}.verdict.confidence`, `must be one of: ${CONFIDENCES.join(', ')}`);
  }

  // attempt — the "I actually tried" field
  const a = d.attempt;
  if (a === null || typeof a !== 'object') {
    push(`${at}.attempt`, 'is required');
  } else {
    if (!Number.isInteger(a.steps_completed) || a.steps_completed < 0) {
      push(`${at}.attempt.steps_completed`, 'must be a non-negative integer');
    }
    if (typeof a.obstacle !== 'string' || !a.obstacle.trim()) push(`${at}.attempt.obstacle`, 'must describe where it got stuck');
  }

  // evidence
  if (!Array.isArray(d.evidence)) {
    push(`${at}.evidence`, 'must be an array');
  } else {
    d.evidence.forEach((e, j) => {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) {
        push(`${at}.evidence[${j}]`, 'must be an object');
        return;
      }
      if (!EVIDENCE_TYPES.includes(e.type)) push(`${at}.evidence[${j}].type`, `must be one of: ${EVIDENCE_TYPES.join(', ')}`);
    });
  }
}

/**
 * Advisory — does this report look like a cascade rather than several faults?
 *
 * When steps run in order and one leaves the page broken, every later step fails
 * too, but those are consequences, not independent problems. A report that emits
 * an independent verdict for each buries the one that matters. This does not
 * reject anything — causation cannot be proven from JSON, and some features have
 * genuinely independent failures — it only surfaces a note, the same "list, do
 * not reject" posture as the audit checks. See knowledge/local/engine/cascading-failure.md.
 *
 * The signal: more than one diagnosis, and every one after the first reads as a
 * bare consequence — its obstacle/summary is a timeout / not-found / detached,
 * with no substantive evidence (a network, console or assertion finding) of its
 * own. The first, by contrast, is where the substantive cause sits.
 *
 * @returns {{ likelyCascade: boolean, note: string|null }}
 */
const CONSEQUENCE = /\b(time(d)?\s*out|timeout|not\s+found|no\s+such\s+element|detached|not\s+visible|never\s+appeared)\b/i;
const SUBSTANTIVE_EVIDENCE = ['network', 'console', 'assertion'];

export function detectCascade(report) {
  const diags = Array.isArray(report?.diagnoses) ? report.diagnoses : [];
  if (diags.length < 2) return { likelyCascade: false, note: null };

  const downstream = diags.slice(1);
  const allConsequences = downstream.every(d => {
    const text = `${d?.attempt?.obstacle ?? ''} ${d?.verdict?.summary ?? ''}`;
    const hasSubstantive = Array.isArray(d?.evidence)
      && d.evidence.some(e => SUBSTANTIVE_EVIDENCE.includes(e?.type));
    return CONSEQUENCE.test(text) && !hasSubstantive;
  });

  if (!allConsequences) return { likelyCascade: false, note: null };
  const first = diags[0]?.step ?? diags[0]?.scenario ?? 'the first';
  return {
    likelyCascade: true,
    note: `${downstream.length} of ${diags.length} diagnoses read as downstream timeouts — this looks like a cascade from the first failure ("${first}"). Consider attributing the root cause to it alone.`,
  };
}

/**
 * Render a valid report as human-readable markdown.
 *
 * Deliberately mechanical — no prose of its own. The agent's only free-form
 * surfaces are the summary and the evidence `finding`/`observation` fields, and
 * this renderer presents them without adding anything that could be mistaken
 * for a verdict of its own.
 *
 * @param {object} report a report that already passed validateDiagnosis
 * @returns {string}
 */
export function renderDiagnosis(report) {
  const out = [];
  out.push(`# Diagnosis — ${report.feature}`);
  out.push('');
  out.push(`- **stage**: \`${report.stage}\``);
  out.push(`- **id**: \`${report.id}\``);
  out.push(`- **at**: ${report.created_at}`);
  out.push('');

  for (const [i, d] of report.diagnoses.entries()) {
    out.push(`## ${d.scenario}`);
    out.push('');
    out.push(`> step: ${d.step}`);
    out.push('');
    out.push(`### Verdict — ${d.verdict.category} (confidence: ${d.verdict.confidence})`);
    out.push('');
    out.push(d.verdict.summary);
    out.push('');
    out.push('### Attempt');
    out.push('');
    out.push(`- completed ${d.attempt.steps_completed} step(s)`);
    if (d.attempt.last_action) out.push(`- last action: ${d.attempt.last_action}`);
    out.push(`- obstacle: ${d.attempt.obstacle}`);
    out.push('');

    if (d.evidence.length) {
      out.push('### Evidence');
      out.push('');
      for (const e of d.evidence) {
        const detail = [
          e.target ? `target: \`${e.target}\`` : null,
          e.status != null ? `status: ${e.status}` : null,
          e.finding,
          e.observation,
          e.captured ? `captured: \`${e.captured}\`` : null,
        ].filter(Boolean).join(' · ');
        out.push(`- **${e.type}** — ${detail}`);
      }
      out.push('');
    }

    if (d.suggested_fix) {
      out.push('### Suggested fix');
      out.push('');
      out.push(d.suggested_fix);
      out.push('');
    }
  }

  return out.join('\n');
}

/**
 * Where a feature's report lives. One JSON (the structured truth) and one
 * markdown (its rendering) per feature, under reports/<project>/.
 */
export function reportPaths(featurePath) {
  const project = projectOf(featurePath) ?? '(root)';
  const base = basename(featurePath).replace(/\.feature$/, '');
  const dir = join('reports', project);
  return {
    dir,
    json: join(dir, `${base}.diagnosis.json`),
    md: join(dir, `${base}.diagnosis.md`),
  };
}

/**
 * Finalise a report the agent has already written.
 *
 * The agent writes the JSON with its own Write tool; this file is the critic
 * that runs afterwards. It reads the JSON back, validates it against the closed
 * shape, and — only when it passes — renders the markdown a human reads. A
 * report that does not pass is left as-is on disk with the violations named, so
 * a free-form report is visible rather than silently accepted.
 *
 * @returns {{ ok: boolean, errors: string[], json: string, md: string }}
 */
export function finalizeDiagnosis(featurePath) {
  const { json, md } = reportPaths(featurePath);
  if (!existsSync(json)) return { ok: false, errors: ['no diagnosis report was written'], json, md };

  let report;
  try {
    report = JSON.parse(readFileSync(json, 'utf8'));
  } catch {
    return { ok: false, errors: ['the diagnosis report is not valid JSON'], json, md };
  }

  const verdict = validateDiagnosis(report);
  if (verdict.ok) {
    mkdirSync(resolve(dirname(md)), { recursive: true });
    writeFileSync(md, renderDiagnosis(report));
  }
  // Advisory, additive: never flips ok, never blocks. Callers may surface it.
  const { note: cascadeNote } = verdict.ok ? detectCascade(report) : { note: null };
  return { ...verdict, cascadeNote, json, md };
}
