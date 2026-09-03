import { defineConfig, devices } from '@playwright/test';

/**
 * The origin under test, from BASE_URL. Fail loudly if it is unset rather than fall
 * back to some placeholder host: a missing BASE_URL used to default to a real,
 * unrelated public site, so a run silently opened the wrong page and looked broken.
 * An explicit error names the fix instead of pretending to work.
 */
function baseOrigin(): string {
  const raw = process.env.BASE_URL;
  if (!raw) {
    throw new Error('BASE_URL is not set — export BASE_URL=<entry page URL> (e.g. https://your-env.example.com/) before recording.');
  }
  return new URL(raw).origin;
}

/**
 * Config for the playwright-test MCP server only (record), never for
 * replay. This environment requires a client certificate; bundled Chromium
 * cannot read it from the macOS Keychain and blocks every navigation on a
 * "select a certificate" dialog. Real Chrome (`channel: 'chrome'`) can read
 * the Keychain, and auto-select-certificate-for-urls answers the prompt
 * automatically instead of waiting on it.
 *
 * Kept out of playwright.config.ts on purpose — that file stays free of
 * anything recording-specific so CI replay remains pure Playwright, and the
 * Keychain issue is local-machine-only: CI runners have no such certificate.
 */
export default defineConfig({
  testDir: './run',
  timeout: 120_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: baseOrigin(),
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        launchOptions: {
          args: ['--auto-select-certificate-for-urls=[{"pattern":"*","filter":{}}]'],
        },
      },
    },
  ],
});
