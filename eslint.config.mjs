import playwright from 'eslint-plugin-playwright';
import tsParser from '@typescript-eslint/parser';

/**
 * Lint rules for recorded specs.
 *
 * These used to be a hand-written table of regexes in src/checks.mjs. Almost all
 * of them already existed here, maintained by the Playwright community and with
 * proper AST analysis rather than line matching — so the table is gone and this
 * is the single definition of "shapes a recording may not use".
 *
 * Only rules that catch something which *passes today and lies later* are on.
 * Style is not the point; a recorded file is not hand-maintained.
 */
export default [
  {
    // Any spec, wherever it sits — the gate lints fixtures in a scratch
    // directory too, and a config scoped to run/ would silently apply no
    // rules to those and report them clean.
    files: ['**/*.spec.ts'],
    ignores: ['**/seed.spec.ts'],
    plugins: { playwright },
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      // Assertions that do not retry, or do not exist at all.
      'playwright/expect-expect': 'error',
      'playwright/missing-playwright-await': 'error',
      'playwright/prefer-web-first-assertions': 'error',
      'playwright/no-unnecessary-assertions': 'error',
      'playwright/valid-expect': 'error',

      // Waiting for the wrong thing. Web-first assertions already retry.
      'playwright/no-networkidle': 'error',
      'playwright/no-wait-for-timeout': 'error',
      'playwright/no-wait-for-selector': 'error',
      'playwright/no-wait-for-navigation': 'error',

      // Positional and handle-based access: silently points elsewhere once the
      // page gains or reorders an element.
      'playwright/no-nth-methods': 'error',
      'playwright/no-element-handle': 'error',
      'playwright/no-eval': 'error',

      // Tests that quietly do not run, or quietly run alone.
      'playwright/no-focused-test': 'error',
      'playwright/no-skipped-test': 'error',
      'playwright/no-conditional-in-test': 'error',
      'playwright/no-conditional-expect': 'error',

      // Left-over debugging, and options that bypass the checks that keep a
      // click honest.
      'playwright/no-page-pause': 'error',
      'playwright/no-force-option': 'error',

      // No plugin rule covers this one. A goto() carrying a scheme and host pins
      // the recording to the environment it was made on; baseURL exists so the
      // same spec can run against another one without editing code.
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.property.name='goto'] Literal[value=/^https?:/]",
        message: 'Absolute URL in goto() locks this recording to one environment. '
          + "Navigate with the path only — page.goto('/some/path') — and let baseURL decide the origin.",
      }],
    },
  },
];
