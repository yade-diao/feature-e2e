import { defineConfig, devices } from '@playwright/test';

/**
 * The origin under test, from BASE_URL. Fails loudly if unset rather than falling
 * back to a placeholder host — a missing BASE_URL must not silently point a replay
 * at some unrelated real site.
 */
function baseOrigin(): string {
  const raw = process.env.BASE_URL;
  if (!raw) {
    throw new Error('BASE_URL is not set — export BASE_URL=<entry page URL> (e.g. https://your-env.example.com/) before replaying.');
  }
  return new URL(raw).origin;
}

/**
 * Replay configuration.
 *
 * `testDir` is `run`, which holds both the recorded specs and the
 * generator's seed file. The seed has to live here — Playwright runs it during
 * recording — but it is an empty placeholder that does not belong in a
 * regression run, so `replay` names the recorded specs explicitly rather than
 * pointing at the directory. A testIgnore rule would have excluded it from
 * recording too.
 *
 * Nothing model-related is configured here on purpose. Replay must be pure
 * Playwright so that a red run in CI is an honest regression signal. The one
 * local-only exception is the client-certificate handling in `projects` below,
 * gated on `!CI`: it is needed to replay against a cert-protected environment on
 * a developer machine, and skipped on CI where no such certificate exists.
 */
export default defineConfig({
  testDir: './run',
  timeout: 120_000,
  expect: { timeout: 15_000 },

  // A `test.only` left in the source would silently shrink the suite to one
  // test while still exiting 0. Fail the build instead. (Playwright docs:
  // "Fail the build on CI if you accidentally left test.only in the source code.")
  forbidOnly: !!process.env.CI,

  // Retries turn a one-off network hiccup into a "flaky" label rather than a
  // red build — but by default a run whose failures all recovered still exits 0,
  // which hides real instability. `failOnFlakyTests` makes flaky mean failed.
  retries: process.env.CI ? 2 : 0,
  failOnFlakyTests: true,

  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    // Point this at the environment under test. Recording and replay must run
    // against the same environment: a spec recorded against one data set says
    // nothing about another.
    // Origin only. BASE_URL may name the entry page in full; the path belongs in
    // the spec's goto() so the same recording can run against another
    // environment by changing nothing but this.
    baseURL: baseOrigin(),
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },

    // The docs advise against `'on'` — tracing every test is expensive. On a
    // retry we already know something is wrong, so that is when it is worth it.
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Local replay against an environment that requires a client certificate
        // hits the same "select a certificate" dialog recording does. Off CI,
        // use real Chrome (reads the macOS Keychain) and auto-answer the prompt —
        // the same fix as playwright.record.config.ts. On CI this is skipped: the
        // runner has no such certificate, and replay must stay pure Playwright so
        // a red run is an honest regression signal.
        ...(process.env.CI
          ? {}
          : {
              channel: 'chrome',
              launchOptions: {
                args: ['--auto-select-certificate-for-urls=[{"pattern":"*","filter":{}}]'],
              },
            }),
      },
    },
  ],

  /**
   * Optional static server, for recording against a page that is a file on disk.
   *
   * The recorder's browser refuses to navigate to `file://`, so a local page has
   * to be served over http before it can be recorded. Set STATIC_ROOT to the
   * directory holding it; Playwright starts and stops the server around the run.
   *
   * Left unset, this is skipped entirely and BASE_URL is used as-is — which is
   * the normal case, where the application under test is already deployed to an
   * environment.
   */
  webServer: process.env.STATIC_ROOT
    ? {
        command: `python3 -m http.server ${process.env.STATIC_PORT ?? 8123} --directory ${process.env.STATIC_ROOT}`,
        url: `http://127.0.0.1:${process.env.STATIC_PORT ?? 8123}/`,
        reuseExistingServer: true,
        stdout: 'ignore',
        timeout: 30_000,
      }
    : undefined,
});
