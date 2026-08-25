/**
 * Counterexamples for cutting a spec into a resume seed.
 *
 * `truncateBeforeLine` used to slice the source and append a fixed `});\n});`,
 * because that is how a recorded spec is nested. The shape is an assumption, and
 * the assumption was wrong in both directions: a cut landing inside a nested
 * `test.step` came out one closer short, and a spec with no `test.describe` came
 * out one too many. Either way the seed did not parse, Playwright refused to
 * load it, and the attempt was spent finding that out.
 *
 * The other assumption was that a seed may hold whatever the cut leaves behind.
 * It may not: Playwright pauses at the end of every test function and the
 * generator attaches at the first pause, so a seed carrying two tests hands it
 * the page as it stood at the end of the first one.
 *
 * A gate that has never rejected anything is indistinguishable from no gate at
 * all, and the same is true of a cut that has never refused to make one. Most of
 * what follows is a counterexample in that sense — it fails against the version
 * before this one. Three are not, and are marked: they pin behaviour that was
 * already right, so that a later rewrite cannot quietly drop it.
 *
 * Run with: node --test src
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '@typescript-eslint/parser';

import { truncateBeforeLine } from '../spec-ast.mjs';

function specFile(source) {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-ast-'));
  const file = join(dir, 'x.spec.ts');
  writeFileSync(file, source);
  return { file, source, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The 1-based line a fragment first appears on. */
const lineOf = (source, fragment) => source.slice(0, source.indexOf(fragment)).split('\n').length;

const parses = (code) => {
  try { parse(code, { range: true, loc: true }); return true; } catch { return false; }
};

const NESTED = `import { test, expect } from '@playwright/test';
test.describe('F', () => {
  test('S', async ({ page }) => {
    await test.step('Given the page is open', async () => {
      await test.step('a detail the generator wrapped', async () => {
        await page.goto('/');
      });
      await expect(page.getByRole('heading')).toBeVisible();
    });
    await test.step('Then the rows are shown', async () => {
      await expect(page.getByRole('row')).toHaveCount(3);
    });
  });
});
`;

const NO_DESCRIBE = `import { test, expect } from '@playwright/test';
test('S', async ({ page }) => {
  await test.step('Given the page is open', async () => {
    await page.goto('/');
  });
  await test.step('Then the rows are shown', async () => {
    await expect(page.getByRole('row')).toHaveCount(3);
  });
});
`;

const TWO_TESTS = `import { test, expect } from '@playwright/test';
test.describe('F', () => {
  test('One', async ({ page }) => {
    await test.step('Given the page is open', async () => {
      await page.goto('/');
    });
  });
  test('Two', async ({ page }) => {
    await test.step('Then the rows are shown', async () => {
      await expect(page.getByRole('row')).toHaveCount(3);
    });
    await test.step('And the count is shown', async () => {
      await expect(page.getByTestId('count')).toHaveText('3');
    });
  });
});
`;

test('a cut inside a nested step keeps nothing, rather than half its parent', () => {
  const s = specFile(NESTED);
  // The cut falls on the assertion that follows the nested step, so the nested
  // step ends before it and the enclosing one does not.
  const cut = lineOf(s.source, "await expect(page.getByRole('heading'))");

  assert.equal(truncateBeforeLine(s.file, cut), null,
    'the only step that ends before the cut is nested inside one that does not — '
    + 'keeping it would cut its parent in half');
  s.cleanup();
});

// Regression guard, not a counterexample: this is the exact shape the old
// hardcoded closer was written for, so it passed before too.
test('a cut past the outer step closes every call it sits inside', () => {
  const s = specFile(NESTED);
  const cut = lineOf(s.source, "await test.step('Then the rows are shown'");
  const out = truncateBeforeLine(s.file, cut);

  assert.ok(out, 'the first feature step ends before the cut');
  assert.ok(parses(out), `three levels are open here — describe, test, step:\n${out}`);
  assert.ok(out.includes("await test.step('Given the page is open'"));
  assert.ok(!out.includes("await test.step('Then the rows are shown'"),
    'the step the cut names must not survive into the seed');
  s.cleanup();
});

test('a spec with no describe wrapper closes one level, not two', () => {
  const s = specFile(NO_DESCRIBE);
  const cut = lineOf(s.source, "await test.step('Then the rows are shown'");
  const out = truncateBeforeLine(s.file, cut);

  assert.ok(out);
  assert.ok(parses(out), `only test and step are open here:\n${out}`);
  s.cleanup();
});

test('a spec with more than one test produces no seed at all', () => {
  const s = specFile(TWO_TESTS);
  // A cut inside the second test: there is a complete step before it, so the
  // old version happily emitted a seed holding both tests.
  const cut = lineOf(s.source, "await test.step('And the count is shown'");

  assert.equal(truncateBeforeLine(s.file, cut), null,
    'Playwright pauses at the end of every test, so a two-test seed hands the '
    + 'generator the end of the first one');
  s.cleanup();
});

test('the seed bounds its own runtime', () => {
  const s = specFile(NO_DESCRIBE);
  const out = truncateBeforeLine(s.file, lineOf(s.source, "await test.step('Then the rows are shown'"));

  assert.match(out, /test\.setTimeout\(\d+\)/,
    'the MCP server runs a seed with timeout 0, and a replayed prefix is not the '
    + 'trivial seed that was written for');
  s.cleanup();
});

// Regression guard: the straddle rule predates this rewrite.
test('a step that straddles the cut is not kept', () => {
  const s = specFile(NO_DESCRIBE);
  // Inside the first step's body: it starts before the cut and ends after it.
  const cut = lineOf(s.source, "await page.goto('/')");

  assert.equal(truncateBeforeLine(s.file, cut), null,
    'the offending line usually sits inside the step, so keeping a step by where '
    + 'it starts would freeze the fault into the seed');
  s.cleanup();
});

// Regression guard: so does returning null with nothing to keep.
test('nothing complete before the cut means no seed', () => {
  const s = specFile(NO_DESCRIBE);
  assert.equal(truncateBeforeLine(s.file, 1), null);
  s.cleanup();
});

const ONLY_THEN_TEST = `import { test, expect } from '@playwright/test';
test.describe('F', () => {
  test.only('Focused scenario', async ({ page }) => {
    await test.step('Given the focused page is open', async () => {
      await page.goto('/focused');
    });
  });
  test('S', async ({ page }) => {
    await test.step('Given the page is open', async () => {
      await page.goto('/');
    });
    await test.step('Then the rows are shown', async () => {
      await expect(page.getByRole('row')).toHaveCount(3);
    });
  });
});
`;

test('a modified test counts as a test', () => {
  const s = specFile(ONLY_THEN_TEST);
  const cut = lineOf(s.source, "await test.step('Then the rows are shown'");

  // Counting only the bare `test(` form saw one test here and kept both, which
  // parses — so the self-parse guard cannot catch it. With `.only` in play it is
  // worse than two pauses: Playwright runs the focused test and skips the one
  // holding the prefix, and the agent is told it landed where it left off.
  assert.equal(truncateBeforeLine(s.file, cut), null,
    'test.only / test.skip / test.fixme are tests the seed would carry');
  s.cleanup();
});
