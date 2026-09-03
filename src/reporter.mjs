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
import { relative } from 'path';

export default class StepReporter {
  constructor() { this.steps = []; this.tests = []; }

  onTestEnd(test, result) {
    // Normalise to a repo-relative path (run/...) so the red-spec list can
    // be mapped back to a feature no matter how Playwright resolved the file.
    // The separator is forced to `/` so the recorded path is stable whether the
    // node binary is the Windows one or the POSIX one.
    this.tests.push({
      file: test.location?.file ? relative(process.cwd(), test.location.file).split('\\').join('/') : null,
      status: result.status ?? 'unknown',
      error: result.error?.message ?? null,
    });
  }

  onStepEnd(test, result, step) {
    if (step.category !== 'test.step') return;
    this.steps.push({
      test: test.title,
      title: step.title,
      file: step.location?.file ?? null,
      line: step.location?.line ?? null,
      ok: !step.error,
      error: step.error?.message ?? null,
      children: step.steps.map(child => child.category),
    });
  }

  onEnd() {
    const out = process.env.STEP_REPORT;
    if (out) writeFileSync(out, JSON.stringify({ steps: this.steps, tests: this.tests }), 'utf8');
  }
}
