/**
 * Where the application under test lives, split the way Playwright wants it.
 *
 * BASE_URL is given as the full address of the entry page, because that is what
 * a person has in hand. Playwright wants those as two things:
 *
 *   baseURL   the origin, set once in the config and swapped per environment
 *   path      what the spec passes to page.goto()
 *
 * Splitting them is what lets one recording run against test, staging and a
 * local server without editing the code — the spec carries the path, the config
 * carries the environment.
 */

const DEFAULT = 'http://127.0.0.1:8123/';

/** @returns {{ origin: string, path: string, href: string }} */
export function target(raw = process.env.BASE_URL) {
  const url = new URL(raw || DEFAULT);
  return {
    origin: url.origin,
    path: `${url.pathname}${url.search}` || '/',
    href: url.href,
  };
}
