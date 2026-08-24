import { defineConfig, devices } from '@playwright/test';

/**
 * Config for the playwright-test MCP server only (record/heal), never for
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
  testDir: './tests/run',
  timeout: 120_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: new URL(process.env.BASE_URL ?? 'http://www.people.com.cn/').origin,
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
