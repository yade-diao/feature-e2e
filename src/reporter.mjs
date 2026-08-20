/**
 * Playwright reporter that records the shape of every `test.step`.
 *
 * Replay has to happen anyway, so the structural evidence is free: no second
 * browser run, and no parsing of source text to guess what a step did. What
 * comes back is what actually executed.
 *
 * `children` holds the categories of the step's child steps:
 *   []             the step did nothing at all
 *   ['pw:api']     it drove the browser
 *   ['expect']     it asserted
 *   ['test.attach'] it attached evidence, e.g. a screenshot
 *
 * Output goes to the file named by STEP_REPORT.
 */
import { writeFileSync } from 'fs';

export default class StepReporter {
  constructor() { this.steps = []; }

  onStepEnd(test, result, step) {
    if (step.category !== 'test.step') return;
    this.steps.push({
      test: test.title,
      title: step.title,
      file: step.location?.file ?? null,
      line: step.location?.line ?? null,
      ok: !step.error,
      children: step.steps.map(child => child.category),
    });
  }

  onEnd() {
    const out = process.env.STEP_REPORT;
    if (out) writeFileSync(out, JSON.stringify(this.steps), 'utf8');
  }
}
