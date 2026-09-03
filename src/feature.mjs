/**
 * Read the steps out of a feature file.
 *
 * Uses the official Gherkin parser rather than a hand-rolled keyword table.
 * The reason is not tidiness: this feeds the step-coverage check, and a parser
 * that silently misses a step would make that check pass when it should fail —
 * a check must never be looser than the thing it checks. The official parser
 * also handles localised keywords, Background, Scenario Outline and tables.
 */

import { readFileSync } from 'fs';
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';

function parse(text) {
  const parser = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher());
  return parser.parse(text);
}

/**
 * A Scenario Outline is a template, not a scenario: its steps carry
 * <placeholders> that mean nothing until an Examples row fills them in.
 *
 * Reading the template as though it were a scenario made every check downstream
 * demand a `test.step` whose title still had the placeholder in it — a title no
 * recording can produce. A feature written with an Outline could therefore never
 * be recorded at all, and the reason would have read as the agent's failure.
 *
 * Expanding here means nothing downstream has to know Outlines exist.
 */
function expandOutline(scenario) {
  const tags = (scenario.tags ?? []).map(t => t.name);
  const examples = scenario.examples ?? [];
  if (!examples.length) return [{ name: scenario.name, tags, steps: scenario.steps ?? [] }];

  const out = [];
  for (const table of examples) {
    const headers = (table.tableHeader?.cells ?? []).map(c => c.value);
    const tableTags = [...tags, ...(table.tags ?? []).map(t => t.name)];
    for (const row of table.tableBody ?? []) {
      const values = row.cells.map(c => c.value);
      const fill = text => headers.reduce(
        (acc, header, i) => acc.split(`<${header}>`).join(values[i] ?? ''), text ?? '');
      out.push({
        name: fill(scenario.name),
        tags: tableTags,
        steps: (scenario.steps ?? []).map(st => ({ ...st, text: fill(st.text) })),
      });
    }
  }
  return out;
}

/**
 * @returns {{ name: string, scenarios: Array<{ name: string, tags: string[],
 *             steps: Array<{ keyword: string, text: string, full: string }> }> }}
 */
export function readFeature(featurePath) {
  const doc = parse(readFileSync(featurePath, 'utf8'));
  const feature = doc.feature;
  if (!feature) throw new Error(`no Feature block in ${featurePath}`);

  const background = [];
  const scenarios = [];

  for (const child of feature.children ?? []) {
    if (child.background) background.push(...(child.background.steps ?? []));
    if (!child.scenario) continue;
    for (const s of expandOutline(child.scenario)) {
      scenarios.push({
        name: s.name,
        tags: s.tags,
        steps: [...background, ...s.steps].map(st => ({
          keyword: st.keyword.trim(),
          text: st.text,
          full: `${st.keyword.trim()} ${st.text}`,
        })),
      });
    }
  }

  return { name: feature.name, scenarios };
}

/** Every step of every scenario, flattened — what the recorded spec has to cover. */
export function allSteps(featurePath) {
  return readFeature(featurePath).scenarios.flatMap(s => s.steps);
}

/**
 * The environment origin a feature already names, or null.
 *
 * A login feature carries the entry page URL in its data table (the `Url` column
 * of the "login with authorized user" step). That URL *is* the environment under
 * test, so BASE_URL should come from it rather than from an env var a caller has
 * to remember to set — a forgotten BASE_URL used to point the whole run at an
 * unrelated public site. `cli` reads this as the fallback when BASE_URL is unset.
 *
 * We scan the raw feature text (not the parsed steps) because the URL lives in a
 * table cell, which `readFeature` does not expose, and take the first http(s)
 * URL's origin — the entry page is the first URL a feature mentions. Returns null
 * when the feature names no URL, so the caller can fall back to erroring.
 */
export function baseUrlFromFeature(featurePath) {
  const text = readFileSync(featurePath, 'utf8');
  const m = text.match(/https?:\/\/[^\s|)'"]+/);
  if (!m) return null;
  try {
    return new URL(m[0]).origin;
  } catch {
    return null;
  }
}
