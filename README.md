# feature-e2e

Record Playwright end-to-end tests from plain-language feature files.
You write the intent; an agent walks it in a real browser; Playwright's own
generator writes the code; CI replays it with no model in the loop.

```
tests/features/people/channel-navigation.feature      you write this
        │
        │   npm run record
        │   an agent reads the feature and performs each step in a live browser;
        │   Playwright's test generator records the actions and the selectors
        ▼
tests/run/people/channel-navigation.spec.ts           recorded, not hand-written
        │
        │   npm run replay          pure Playwright, zero model calls
        ▼
E2E regression in CI
```

## Why record instead of generate

A selector that came out of a recorder is one that *hit a real element on the
live page*. A selector a model typed into a file is a guess that happens to look
plausible. Read side by side the two are indistinguishable — only their
provenance differs, and only one of them still works tomorrow.

So this project never asks a model to write a spec. It hands the feature to
Playwright's official test agents and lets the generator write the file:

| Concern | Owner |
|---|---|
| Driving the browser, choosing selectors, emitting code | Playwright's test agents (`generator_setup_page`, `browser_*`, `generator_write_test`) |
| feature ↔ spec mirroring, suite completeness | `src/paths.mjs` |
| Acceptance gates | `src/checks.mjs`, `src/reporter.mjs` |
| Orchestration and exit codes | `src/cli.mjs` |
| Replay | Playwright |

The cost lands where it belongs: recording is slow and costs model calls once;
replay is a plain Playwright run, and its cost never grows.

## Acceptance gates

A file on disk proves nothing, so `record` is not finished until every gate
passes, cheapest first:

| # | Gate | Cost | Rejects |
|---|---|---|---|
| 1 | Step coverage | text, ms | a recording that skipped a feature step |
| 2 | Lint | text, ms | shapes that pass today and lie later (see below) |
| 3 | Liveness | text, ms | a step that only asserts absence, which a blank page satisfies |
| 4 | Replay | one real run | selectors that were never on the page |
| 5 | Step substance | free, rides on 4 | a `test.step` that ran and did nothing |

Gate 2 is `eslint-plugin-playwright`, configured in `eslint.config.mjs`. The rules
enabled are the ones that catch something *silent*: an assertion that was never
awaited never fails, a test with no assertions passes by definition, `.only`
shrinks the suite while still exiting 0. Style rules are off — a recorded file is
not hand-maintained. Because it is ordinary ESLint, the same rules light up in an
editor as the ones that reject a recording.

`no-raw-locators` is deliberately **not** enabled: it would ban
`page.locator('some-custom-element')`, and measurements on a real site put
custom-element tags ahead of role-based locators for precision.

Gate 3 exists because "at most 10 rows" is satisfied by zero rows and "no row
lacks the keyword" is satisfied by no rows at all. A step built only from
absences passes on a blank page — the thing it was written to catch. Absence and
presence are told apart by matcher rather than by wording, so it holds for a
feature in any language.

Gate 5 exists because an empty step reads as coverage while proving nothing.
Steps are *not* required to assert: a step that only asks for something to be
looked at can satisfy it by attaching the evidence.

```ts
await test.step('Then the article page shows a headline', async () => {
  await testInfo.attach('headline', { body: await page.screenshot(), contentType: 'image/png' });
});
```

**`replay` runs gates 4 and 5 too.** An exit code alone is too weak: a skipped
test, a test with no assertions, and an empty `test.step` all exit 0.

### When a gate rejects

The recording is not simply refused. The reason — which rule, which line, what to
do instead — is fed back and the scenario is recorded again, up to three attempts.
Retrying is only safe because the text gates run first: "retry until green" would
otherwise select for the emptiest possible recording, since a spec that asserts
nothing always replays green.

`.recordings.jsonl` keeps a line per attempt, and `record` prints the
first-attempt pass rate. A prompt edit that quietly halves it looks exactly like
one that helped, right up until somebody counts.

## Setup

```bash
npm install
npx playwright install chromium
npm run setup:agents          # writes .claude/agents/* and .mcp.json
```

`setup:agents` installs Playwright's official planner / generator / healer agent
definitions and the MCP server they talk to. This project does not ship its own.

## Environments

Record and replay must run against the **same environment**. A spec recorded
against one data set says nothing about another: the articles it opened, the
counts it saw and the labels it clicked all belong to that data.

Point `BASE_URL` at the environment under test. For more than one, the docs'
pattern is a project per environment:

```ts
projects: [
  { name: 'test',    use: { baseURL: process.env.TEST_URL },    retries: 0 },
  { name: 'staging', use: { baseURL: process.env.STAGING_URL }, retries: 2 },
]
```

The natural home for this is a test environment with a controlled data set that
is reset on deploy — that is what makes a regression suite meaningful in the
first place. Recording against production data produces assertions that expire.

## Use

```bash
npm run status                      # which features have been recorded
npm run check                       # text gates over the specs as they stand
npm run record -- <feature|project> # agent + browser
npm run replay -- [feature|project] # no model calls
npm test                            # counterexamples for the gates themselves
```

`check` matters because recording applies the gates once, when a spec is made. A
rule added later would never revisit anything already committed.

Exit codes: `0` fine · `1` failed or missing · `2` the tool could not conclude.

## Writing a feature

Business intent only. Never name a selector, a CSS class or a DOM structure —
deciding how to reach an element is the recorder's job.

```gherkin
Feature: Channel navigation on People's Daily Online

  @smoke
  Scenario: Open the Education channel and read its top story
    Given the reader is on the People's Daily Online homepage
    When the reader opens the "教育" channel from the top navigation
    Then the Education channel page is shown
```

Quoting an on-screen label verbatim (`"教育"`) is fine and helps the agent find
it; naming `#rm_topnav` is not.

## Layout

```
tests/features/<project>/*.feature   input, written by a human
tests/run/<project>/*.spec.ts        output, written by the recorder
tests/run/seed.spec.ts               the page the generator starts from
eslint.config.mjs                    gate 2 — the lint rules, also used by editors
src/cli.mjs                          status | check | record | replay
src/paths.mjs                        feature ↔ spec mapping, pairing check
src/feature.mjs                      Gherkin parsing (official parser)
src/target.mjs                       BASE_URL split into origin + path
src/recorder.mjs                     builds the prompt, invokes the agent
src/gates.mjs                        the gates, and the critique each produces
src/checks.mjs                       coverage, lint, liveness, substance
src/reporter.mjs                     collects step structure during replay
src/journal.mjs                      per-attempt measurements
src/playwright.mjs                   runs Playwright without a shell
src/__tests__/                       a counterexample for every gate
```

## CI

`.github/workflows/e2e.yml` replays and never records. Recording needs a model,
takes minutes and is not deterministic — none of which belongs on a pull request.
The workflow runs `status` first, because a feature with no recorded spec is
simply absent from the run, and an absent test is indistinguishable from a
passing one.

The config follows the docs for CI: `forbidOnly` so a stray `test.only` fails the
build instead of quietly shrinking the suite, `retries: 2` with
`failOnFlakyTests` so a recovered failure is still reported as a failure, and
`trace: 'on-first-retry'` rather than `'on'`, which the docs call out as too
expensive to run on every test.

## Known limitation

The generator writes assertions against whatever was on the page while it was
recording. On a news site that means today's headline ends up in the spec:

```ts
// the feature said "the channel page lists multiple articles"
await expect(page.getByRole('link', { name: '三部门发文优化城乡社区岗位…' })).toBeVisible();
```

The feature asked for *multiple articles*; the recording pinned *these two
articles*. Such a spec goes red tomorrow because the news changed, not because
anything regressed. Judging whether a recorded assertion actually constrains what
the feature asked for is the next piece of work.

## Troubleshooting

**The agent reports that the generator tools are unavailable.**
The MCP config must be passed explicitly. A project-scoped `.mcp.json` waits for
interactive approval; in headless mode the tools then simply do not exist and the
agent says it cannot help. `src/recorder.mjs` always passes `--mcp-config`.

**`playwright: not found`, or `node_modules/.bin` is empty.**
Do not run `npm install` from a different operating system than the one you run
from. Installing from Windows into a tree used from WSL replaces the POSIX
symlinks in `.bin` with `.cmd` shims, and everything that shells out to
`npx playwright` stops working. Pick one system and stay there.

**The recorder cannot find the project (`C:\mnt\c\...`).**
Same cause, worse symptom: the whole toolchain has to run on one operating
system. Across a WSL/Windows boundary the client sends a POSIX cwd that the
server resolves against a drive letter, and `--config` cannot repair it — the
server takes its root from the client's cwd first.

**The browser will not start (`libnspr4.so: cannot open shared object file`).**
`npx playwright install-deps chromium` needs root. Without it, download the
packages and extract them into your home directory, then point
`LD_LIBRARY_PATH` at them before running. Chinese text rendering as boxes is the
same problem one layer up — install a CJK font such as `fonts-wqy-zenhei`.

**`npm install` times out while `curl` to the same URL works.**
The resolver is returning AAAA records for a host whose IPv6 path is dead, and
`--dns-result-order=ipv4first` cannot help because there is no IPv4 answer to
prefer. Use a registry whose DNS answers with IPv4.
