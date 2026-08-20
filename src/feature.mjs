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
    const s = child.scenario;
    scenarios.push({
      name: s.name,
      tags: (s.tags ?? []).map(t => t.name),
      steps: [...background, ...(s.steps ?? [])].map(st => ({
        keyword: st.keyword.trim(),
        text: st.text,
        full: `${st.keyword.trim()} ${st.text}`,
      })),
    });
  }

  return { name: feature.name, scenarios };
}

/** Every step of every scenario, flattened — what the recorded spec has to cover. */
export function allSteps(featurePath) {
  return readFeature(featurePath).scenarios.flatMap(s => s.steps);
}
