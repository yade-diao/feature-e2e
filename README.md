# feature-e2e

A pipeline that turns business-logic feature files into self-maintaining
end-to-end tests. An agent verifies the business logic in a real browser,
distills what it did into a stable replay, and — when a piece of logic cannot be
verified — writes a diagnosis that says *why*, and whose fault it is.

## The requirement

We start from a feature file that states business logic, because what an
end-to-end test verifies **is** business logic. The pipeline is:

1. **Verify.** An agent opens the browser and verifies each piece of business
   logic in the feature file, one step at a time.
2. **Report what cannot be verified.** When a piece of business logic cannot be
   verified, the agent writes a diagnosis: *why* it cannot be verified, and
   whether the fault is in the frontend or the backend — a missing component,
   the backend returning wrong data. Those two are examples; the real causes are
   many.
3. **Distill.** The agent records everything it does while verifying. Playwright
   already produces a trace, but the trace cannot be replayed as-is: the agent
   explored, made invalid operations, and may have pinned a component with a
   single random id that breaks the moment the source changes. The replay
   therefore keeps only the effective operations.
4. **Locate stably.** Every component is located through several strategies at
   once, so that when one stops matching, the rest still cover it.
5. **Heal.** When every strategy fails, a healing agent repairs the locator. If
   the repair succeeds, the locator is rewritten the same way — multiple
   strategies with fallbacks. If the repair fails, the same diagnosis is
   written: why the business logic cannot be verified, and whether the fault is
   frontend or backend.

In short: **we care only about business logic.** Everything else — ids, classes,
DOM shape — merely hangs off the business logic, and we do not care about it.

## The pipeline

```
tests/features/recruit/search.feature        business intent, written by a human
        │
        │   npm run record
        │   the verify agent walks each step in a live browser and checks that
        │   the business logic holds; the generator distills the effective
        │   actions (not the exploration) into a spec with redundant locators
        ▼
tests/run/recruit/search.spec.ts             distilled, not a raw trace
        │
        │   npm run replay        pure Playwright, zero model calls
        ▼
E2E regression in CI

        │   when a locator no longer matches anything on the page
        │   npm run heal          the healer agent re-locates it, redundantly
        ▼
the same spec, self-repaired — or a diagnosis if the page itself changed
```

Two failure paths converge on the same artifact, a **diagnosis**:

- The verify agent cannot verify a piece of business logic → it writes a
  diagnosis naming the fault and attributing it to frontend or backend.
- The healer cannot repair a locator (because the page itself changed) → it
  writes the same diagnosis.

## Why record instead of generate

A selector that came out of a recorder is one that *hit a real element on the
live page*. A selector a model typed into a file is a guess that happens to look
plausible. Read side by side the two are indistinguishable — only their
provenance differs, and only one of them still works tomorrow.

So this project never asks a model to write a spec. It hands the feature to
Playwright's official test agents and lets the generator write the file:

| Concern | Owner |
|---|---|
| Driving the browser, verifying each step, choosing selectors, emitting code | Playwright's test agents (`generator_setup_page`, `browser_*`, `generator_write_test`) |
| Distilling the trace into effective operations | the generator journal — exploration tools stay out of it by design |
| Diagnosing an unverifiable step (frontend vs backend) | the verify agent, guided by `src/recorder.mjs` |
| Repairing a stale locator | the healer agent (`browser_generate_locator`), via `npm run heal` |
| feature ↔ spec mirroring, suite completeness | `src/paths.mjs` |
| Acceptance gates | `src/checks.mjs`, `src/reporter.mjs` |
| Orchestration and exit codes | `src/cli.mjs` |
| Replay | Playwright |

The cost lands where it belongs: recording is slow and costs model calls once;
replay is a plain Playwright run, and its cost never grows.

## Locating stably

A component is never located one way. The recorder prefers role and accessible
name first, then form semantics, then a stable hand-written testid, then visible
text, and CSS last — and it records a backup chain with `.or()` so a drifted
trait does not red the run:

```ts
page.getByTestId('search-input')
   .or(page.getByRole('textbox', { name: /搜索/ }))
```

The first locator that still matches wins. This is self-healing that is
**deterministic and baked into the spec** — it runs in CI with no model in the
loop. The intelligence was spent once, at recording time; replay just executes.

Generated class names — CSS-module hashes (`__ab12cd`), styled-components
(`sc-...`), emotion (`css-...`) — are banned from recordings. They change on
every build and are the single most common reason a recorded test goes red the
next morning.

## Diagnosis

A piece of business logic that cannot be verified is not a silent failure. The
agent writes a diagnosis report naming:

- **which** business logic — the feature, scenario and step;
- **what it observed** — the network responses, console errors and page state it
  collected while trying;
- **why** it could not be verified;
- **whose fault** — frontend (a missing or broken component, a wrong client-side
  computation) or backend (wrong data, a failing or empty response), with the
  evidence that supports the attribution.

The two examples in the requirement are not the catalogue; the agent is told the
real causes are many, and to attribute from evidence rather than from a fixed
list.

## Acceptance gates

A file on disk proves nothing, so `record` is not finished until every gate
passes, cheapest first:

| # | Gate | Cost | Rejects |
|---|---|---|---|
| 1 | Step coverage | text, ms | a recording that skipped a feature step |
| 2 | Lint | text, ms | shapes that pass today and lie later (see below) |
| 3 | Liveness | text, ms | a step that only asserts absence, which a blank page satisfies |
| 4 | Locator redundancy | text, ms | an action locator with no fallback chain |
| 5 | Replay | one real run | selectors that were never on the page |
| 6 | Step substance | free, rides on 5 | a `test.step` that ran and did nothing |

Gate 2 is `eslint-plugin-playwright`, configured in `eslint.config.mjs`. The
rules enabled are the ones that catch something *silent*: an assertion that was
never awaited never fails, a test with no assertions passes by definition,
`.only` shrinks the suite while still exiting 0.

`no-raw-locators` is deliberately **not** enabled: it would ban
`page.locator('some-custom-element')`, and measurements on a real site put
custom-element tags ahead of role-based locators for precision.

Gate 3 exists because "at most 10 rows" is satisfied by zero rows and "no row
lacks the keyword" is satisfied by no rows at all. A step built only from
absences passes on a blank page — the thing it was written to catch.

Gate 4 exists because a locator that survives only one way fails the first time
that one way changes. An action that clicks, types or navigates must carry a
fallback; an assertion may still assert.

Gate 6 exists because an empty step reads as coverage while proving nothing.
Steps are *not* required to assert: a step that only asks for something to be
looked at can satisfy it by attaching the evidence.

```ts
await test.step('Then the article page shows a headline', async () => {
  await testInfo.attach('headline', { body: await page.screenshot(), contentType: 'image/png' });
});
```

**`replay` runs gates 5 and 6 too.** An exit code alone is too weak: a skipped
test, a test with no assertions, and an empty `test.step` all exit 0.

### When a gate rejects

The recording is not simply refused. The reason — which rule, which line, what
to do instead — is fed back and the scenario is recorded again, up to three
attempts. Retrying is only safe because the text gates run first: "retry until
green" would otherwise select for the emptiest possible recording, since a spec
that asserts nothing always replays green.

`.recordings.jsonl` keeps a line per attempt, and `record` prints the
first-attempt pass rate.

## Setup

```bash
npm install
npx playwright install chromium
npm run setup:agents          # writes .claude/agents/* and .mcp.json
```

`setup:agents` installs Playwright's official planner / generator / healer agent
definitions and the MCP server they talk to. Only the healer is used by this
project; the verify agent (`.claude/agents/verify.md`) is hand-written and
committed, and the planner / generator are unused.

## Environments

Record and replay must run against the **same environment**. A spec recorded
against one data set says nothing about another: the articles it opened, the
counts it saw and the labels it clicked all belong to that data.

Point `BASE_URL` at the environment under test. The natural home is a test
environment with a controlled data set that is reset on deploy — that is what
makes a regression suite meaningful in the first place, and what makes a
diagnosis of "the backend returned wrong data" a claim about the environment
under test rather than about yesterday's data.

## Use

```bash
npm run status                      # which features have been recorded
npm run check                       # text gates over the specs as they stand
npm run record -- <feature|project> # verify + distill + gates
npm run heal -- <feature|project>   # repair a spec whose locators stopped matching
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
Feature: Searching the autumn recruitment list

  @smoke
  Scenario: Narrow the list with a keyword and clear it again
    Given the applicant is on the recruitment entry page
    Then the list shows at least 300 openings
    When the applicant searches for "腾讯"
    Then the list shows at most 10 openings
    And every remaining row mentions "腾讯"
```

Quoting an on-screen label verbatim (`"腾讯"`) is fine and helps the agent find
it; naming `#search-input` is not.

## Layout

```
tests/features/<project>/*.feature   input, written by a human
tests/run/<project>/*.spec.ts        distilled output, written by the generator
tests/run/seed.spec.ts               the page the generator starts from
reports/<project>/*.diagnosis.json   structured diagnosis (the validated truth)
reports/<project>/*.diagnosis.md     the same report, rendered for a human
eslint.config.mjs                    gate 2 — the lint rules, also used by editors
src/cli.mjs                          status | check | record | heal | replay
src/paths.mjs                        feature ↔ spec mapping, pairing check
src/feature.mjs                      Gherkin parsing (official parser)
src/target.mjs                       BASE_URL split into origin + path
src/recorder.mjs                     builds the verify prompt, invokes the agent
src/healer.mjs                       invokes the healer agent to repair a locator
src/gates.mjs                        the gates, and the critique each produces
src/checks.mjs                       coverage, lint, liveness, redundancy, substance
src/reporter.mjs                     collects step structure during replay
src/journal.mjs                      per-attempt measurements
src/playwright.mjs                   runs Playwright without a shell
src/__tests__/                       a counterexample for every gate
```

## CI

`.github/workflows/e2e.yml` replays and never records. Replay is plain
Playwright: same input, same result, no API calls — so a red run is an honest
regression signal. A red run is not the end, though. Replay runs with
`continue-on-error`; on failure it writes the list of red specs, and `heal`
re-locates each failing element and re-runs only those specs — the green ones
are not run a second time. A repair counts only when it replays green; it is
then committed with `[skip ci]` so the whole workflow does not run again. A spec
the page has changed beyond re-location becomes a diagnosis report and the job
stays red.

So the job's colour carries the verdict: green means the business logic held (or
was repaired — only a locator had drifted), red means it broke and a human has a
diagnosis to read.

The workflow runs `status` first, because a feature with no recorded spec is
simply absent from the run, and an absent test is indistinguishable from a
passing one.

## Known limitation

Distillation keeps only what the agent *effectively did*, but what it *asserted*
is still whatever was on the page at the time. On a news site that means today's
headline ends up in the spec:

```ts
// the feature said "the channel page lists multiple articles"
await expect(page.getByRole('link', { name: '三部门发文优化城乡社区岗位…' })).toBeVisible();
```

The feature asked for *multiple articles*; the recording pinned *these two
articles*. Such a spec goes red tomorrow because the news changed, not because
anything regressed. Judging whether a recorded assertion actually constrains what
the feature asked for — and turning the pinned data into a business invariant —
is the next piece of work.

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
packages and extract them into your home directory, then point `LD_LIBRARY_PATH`
at them before running. Chinese text rendering as boxes is the same problem one
layer up — install a CJK font such as `fonts-wqy-zenhei`.

**`npm install` times out while `curl` to the same URL works.**
The resolver is returning AAAA records for a host whose IPv6 path is dead, and
`--dns-result-order=ipv4first` cannot help because there is no IPv4 answer to
prefer. Use a registry whose DNS answers with IPv4.
