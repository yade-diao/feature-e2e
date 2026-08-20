/**
 * Run Playwright as a child process, without going through a shell.
 *
 * Not `npx`, not `cmd /c`: a shell layer costs correctness. It mangles non-ASCII
 * arguments on Windows (Playwright then reports "No tests found", which is
 * indistinguishable from a genuinely empty run), it treats backslashes in path
 * arguments as regex escapes, and it forces every argument through quoting rules
 * we would have to reimplement. Spawning the current node binary against
 * Playwright's own CLI entry avoids all of it.
 */

import { createRequire } from 'module';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);

/**
 * `playwright/cli.js` is not an exported subpath, so requiring it directly fails
 * with ERR_PACKAGE_PATH_NOT_EXPORTED on Node >= 20. `@playwright/test` does
 * export `./cli`. If neither resolves we throw rather than falling back to
 * `npx` — a fallback would quietly reintroduce the shell we just removed.
 */
function resolveCli() {
  try {
    return require.resolve('@playwright/test/cli');
  } catch {
    throw new Error('cannot locate the Playwright CLI — is @playwright/test installed?');
  }
}

export const PLAYWRIGHT_CLI = resolveCli();

export function playwright(args, options = {}) {
  return spawnSync(process.execPath, [PLAYWRIGHT_CLI, ...args], { stdio: 'inherit', ...options });
}
