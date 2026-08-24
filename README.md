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
   where the fault lies — a missing component, a backend returning wrong data.
   Those are examples; the real causes are many.
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
   written: why the business logic cannot be verified, and where the fault lies.

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
  diagnosis naming the fault and attributing it.
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
| How to verify, what a good locator is, what may not be done to the page | `.claude/agents/verify.md`, the hand-written agent definition |
| Diagnosing an unverifiable step | the verify agent; the per-run prompt is built in `src/recorder.mjs` |
| Repairing a stale locator | the healer agent (`browser_generate_locator`), via `npm run heal` |
| feature ↔ spec mirroring, suite completeness | `src/paths.mjs` |
| Acceptance gates | `src/gates.mjs`, `src/checks.mjs`, `src/spec-ast.mjs` |
| Orchestration and exit codes | `src/cli.mjs` |
| Replay | Playwright |

The cost lands where it belongs: recording is slow and costs model calls once;
replay is a plain Playwright run, and its cost never grows.

## Locating stably

A component is never located one way. The agent picks locators to survive a
rebuild, in this order — role and accessible name, then form semantics
(`getByLabel`, `getByPlaceholder`, `getByTitle`), then a stable hand-written
testid, then visible text, and CSS last — and where a trait can drift it records
a backup chain with `.or()`:

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

Positional locators (`.first()`, `.nth()`, `.last()`) are banned too, in both
roles they get reached for. To show a list is alive, a count assertion says it
without an index. To act on one of several similar rows, scope from what makes
it *that* row — the product it names, the label it carries — because which row
is first depends on sort state and filters that have nothing to do with the
feature:

```ts
const row = page.getByRole('row', { name: /PD100046|Shampoo silk gloss/ });
await row.getByRole('combobox', { name: 'Pricing Method' }).click();
```

## Acceptance gates

A file on disk proves nothing, so `record` is not finished until every gate
passes, cheapest first:

| # | Gate | Cost | Rejects |
|---|---|---|---|
| 1 | Step coverage | text, ms | a recording that skipped a feature step, or a feature that states none |
| 2 | Lint | text, ms | shapes that pass today and lie later (see below) |
| 3 | Liveness | text, ms | a step that only asserts absence, which a blank page satisfies |
| 4 | Locator redundancy | text, ms | an action locator with no fallback chain |
| 5 | Replay | one real run | selectors that were never on the page |
| 6 | Step substance | free, rides on 5 | a `test.step` that ran and did nothing |

Gates 1–4 are text-only and run together, not one at a time: all four report at
once so a single retry can fix everything that is wrong, instead of one fault per
round. Gates 5 and 6 need a browser and run only after the first four are clear.

Gate 1 matches each feature step against a `test.step` title, exactly, after
normalising whitespace and quotes. A fuzzy match would let a step drift away from
what the feature asked while still reporting coverage. A feature with no steps is
rejected by name — it would otherwise clear coverage at 0/0 and let through a
spec that verifies nothing.

Gate 2 is `eslint-plugin-playwright`, configured in `eslint.config.mjs` and
parsed with `@typescript-eslint/parser`. The rules enabled are the ones that
catch something *silent*: an assertion that was never awaited never fails, a test
with no assertions passes by definition, `.only` shrinks the suite while still
exiting 0.

One rule has no plugin equivalent and is written by hand: an absolute URL in
`goto()` is an error, because a scheme and host pin the recording to the
environment it was made on. Navigate with the path and let `baseURL` decide the
origin.

`no-raw-locators` is deliberately **not** enabled: it would ban
`page.locator('some-custom-element')`, and measurements on a real site put
custom-element tags ahead of role-based locators for precision.

Gate 3 exists because "at most 10 rows" is satisfied by zero rows and "no row
lacks the keyword" is satisfied by no rows at all. A step built only from
absences passes on a blank page — the thing it was written to catch. It is
classified by matcher rather than by wording, so it holds for a feature written
in any language.

Gate 4 exists because a locator that survives only one way fails the first time
that one way changes. An action that clicks, types or navigates must carry a
fallback, or be pure accessibility semantics. Assertions are deliberately not
checked: an assertion that fails is the point, and a fallback there would let it
match some near element and go green while the component it watched is gone.

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

Two further checks are **audits, not gates** — `check` lists them as notes and
never rejects on them, because both are strong signals rather than proof and a
false rejection would block a recording that did nothing wrong:

- **stale data** — strings the spec names that the feature never quoted, and that
  read as page content. See *Known limitation* below.
- **brittle locators** — generated class names that will break on the next build.

### When a gate rejects

The recording is not simply refused. The reason — which rule, which line, what to
do instead — is fed back as a critique and the scenario is recorded again, up to
three attempts. Every rejection also names what already passed, so a retry does
not fix the fault and drop what it had got right the round before.

Retrying is only safe because the text gates run first: "retry until green" would
otherwise select for the emptiest possible recording, since a spec that asserts
nothing always replays green. It cannot, however, get past step coverage.

A retry does not start from scratch. The gates report the line each objection
sits on, and the spec is cut at the last `test.step` that ends before the
earliest of them; that truncated spec becomes the next attempt's seed. Playwright
runs a seed for real, so the agent lands where the previous attempt left off and
picks up at the step the rejection names, instead of re-driving steps nobody
objected to. When no gate reported a line, or nothing survives the cut, the retry
falls back to the blank seed.

`.recordings.jsonl` keeps a line per attempt, and `record` prints the
first-attempt pass rate and a count of rejections per gate.

## Diagnosis

A piece of business logic that cannot be verified is not a silent failure. The
agent writes a structured report naming:

- **which** business logic — the feature, scenario and step;
- **what it attempted** — how many steps completed, the last action, where it
  stopped;
- **what it observed** — network responses, console messages, page snapshots,
  DOM and failed assertions;
- **whose fault** — one of `frontend`, `backend`, `environment` or
  `unverifiable`, with a confidence and the evidence that supports it.

```json
{
  "report_version": "1.0",
  "id": "search-2026-08-21-1",
  "created_at": "2026-08-21T03:06:45Z",
  "stage": "verify",
  "feature": "tests/features/recruit/search.feature",
  "diagnoses": [
    {
      "scenario": "Narrow the list with a keyword",
      "step": "Then the list shows at most 10 openings",
      "verdict": { "category": "backend", "summary": "the search endpoint returns the unfiltered list", "confidence": "high" },
      "attempt": { "steps_completed": 3, "last_action": "typed the keyword and submitted", "obstacle": "the row count never changed" },
      "evidence": [
        { "type": "network", "target": "/api/search?q=…", "status": 200, "finding": "490 rows in the response, keyword ignored" }
      ]
    }
  ]
}
```

The verdict categories and evidence types are **closed enums**: an agent that
could write any verdict would write a plausible one instead of a true one. The
shape is `schemas/diagnosis.schema.json`; `src/diagnose.mjs` is its executable
form, and a report the validator rejects is reported as invalid rather than filed
as truth. Both stages write the same shape — `stage` is `verify` or `heal` — which
is what lets one failure exit serve both. A report that validates is also
rendered to `.diagnosis.md` beside the JSON, for a human to read.

## Setup

```bash
npm install                   # postinstall applies patches/ via patch-package
npx playwright install chromium
npm run setup:agents          # writes .claude/agents/* and .mcp.json
```

`setup:agents` installs Playwright's official planner / generator / healer agent
definitions and the MCP server they talk to. Only the healer is used by this
project; the verify agent (`.claude/agents/verify.md`) is hand-written and
committed, and the planner / generator are unused.

`patches/playwright+1.62.1.patch` is applied automatically by `postinstall`. It
gives the test MCP server's browser backend explicit action, navigation and
expect timeouts — without them an interactive tool call has no timeout of its own
and can hang until the whole recording's budget is gone — and lets
`PLAYWRIGHT_MCP_OUTPUT_DIR` place each recording's browser scratch output under
its own path.

## Environments

Record and replay must run against the **same environment**. A spec recorded
against one data set says nothing about another: the articles it opened, the
counts it saw and the labels it clicked all belong to that data.

Point `BASE_URL` at the environment under test. The natural home is a test
environment with a controlled data set that is reset on deploy — that is what
makes a regression suite meaningful in the first place, and what makes a
diagnosis of "the backend returned wrong data" a claim about the environment
under test rather than about yesterday's data.

`playwright.config.ts` is the replay config and holds nothing model-related, so a
red CI run is an honest regression signal. `playwright.record.config.ts` is a
second config for the record/heal MCP server only: it runs real Chrome rather
than bundled Chromium, which is what an environment behind a client certificate
needs — Chromium cannot read the certificate from the OS keychain and blocks
every navigation on a "select a certificate" dialog. Point the server at it by
adding `--config playwright.record.config.ts` to the `playwright-test` entry in
`.mcp.json`, which `setup:agents` generates and which is gitignored because it is
OS-specific.

## Use

```bash
npm run status                      # which features have been recorded
npm run check                       # text gates over the specs as they stand
npm run record -- <feature|project> # verify + distill + gates
npm run heal -- <feature|project>   # repair a spec whose locators stopped matching
npm run replay -- [feature|project] # no model calls
npm test                            # counterexamples for the gates themselves
```

A target is a feature path, a project name (the first directory under
`tests/features`), or nothing at all, which means every feature.

`check` matters because recording applies the gates once, when a spec is made. A
rule added later would never revisit anything already committed.

Environment variables:

| Variable | Read by | Effect |
|---|---|---|
| `BASE_URL` | both configs, `src/target.mjs` | the environment under test; the origin goes to the config, the path to `page.goto()` |
| `STATIC_ROOT`, `STATIC_PORT` | `playwright.config.ts` | serve a directory over http, for recording a page that is a file on disk |
| `RECORDER_DEBUG_FILE` | `src/recorder.mjs` | passes `--debug-file` to the agent; off unless set |
| `CI` | `playwright.config.ts` | `forbidOnly`, retries, one worker, the html reporter |
| `ANTHROPIC_API_KEY` | the healer, in CI | the only step of the workflow that spends a model call |

Exit codes: `0` fine · `1` failed or missing · `2` the tool could not conclude.

`check` and `replay` exit 0 when there is simply nothing recorded yet, and say
what is waiting — `status` is the command that fails on an unrecorded feature,
which is why CI runs it first. A named target that matches nothing is still an
error.

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
it; naming `#search-input` is not. Scenario Outlines are supported: the Examples
rows are expanded into one scenario each before anything downstream sees them, so
no gate ever meets an unfilled `<placeholder>`.

Credentials do not belong in a feature. The suite is a corpus that stays local
(see below), but a feature is a plain text file like any other — put the login
behind the environment instead.

## Layout

```
tests/features/<project>/*.feature   input, written by a human
tests/run/<project>/*.spec.ts        distilled output, written by the generator
tests/run/seed.spec.ts               the page the generator starts from
reports/<project>/*.diagnosis.json   structured diagnosis (the validated truth)
reports/<project>/*.diagnosis.md     the same report, rendered for a human
logs/<project>/<feature>/            browser scratch output, one subtree per feature
schemas/diagnosis.schema.json        the shape both agents must write
eslint.config.mjs                    gate 2 — the lint rules, also used by editors
playwright.config.ts                 replay: no model, nothing recording-specific
playwright.record.config.ts          record/heal MCP server only
patches/                             applied on postinstall by patch-package
src/cli.mjs                          status | check | record | heal | replay
src/paths.mjs                        feature ↔ spec mapping, pairing check
src/feature.mjs                      Gherkin parsing (official parser)
src/target.mjs                       BASE_URL split into origin + path
src/recorder.mjs                     builds the verify prompt, invokes the agent
src/healer.mjs                       invokes the healer agent to repair a locator
src/gates.mjs                        the gates, and the critique each produces
src/checks.mjs                       coverage, lint, liveness, redundancy, substance
src/spec-ast.mjs                     reads a spec off its parse, never off its text
src/diagnose.mjs                     validates a diagnosis, renders it for a human
src/reporter.mjs                     collects step structure during replay
src/journal.mjs                      per-attempt measurements
src/playwright.mjs                   runs Playwright without a shell
src/__tests__/                       a counterexample for every gate
```

Only the tool is committed. The corpus — the `.feature` files and the specs
recorded from them — and everything a run produces — `reports/`, `logs/`,
`.recordings.jsonl` — stay local, because a recording only means something
against the environment it was made on. `tests/run/seed.spec.ts` is the one
exception: the generator needs it to open the application at all.

## CI

`.github/workflows/e2e.yml` replays and never records. Recording needs a model,
takes minutes and is not deterministic — none of which belongs on a pull request.
Replay is plain Playwright: same input, same result, no API calls.

The job runs `status`, then `npm test`, then `check`, then the replay. A red
replay is not the verdict — it runs with `continue-on-error` and writes the list
of red specs, and `heal` re-locates each failing element and re-runs only those;
the green ones are not run a second time. A repair counts only when it replays
green, and is then committed with `[skip ci]` so the whole workflow does not run
again. Staging is limited to what healing may touch — the specs it rewrites and
the diagnoses it writes — so the commit cannot claim more than happened. A spec
the page has changed beyond re-location becomes a diagnosis report and the job
stays red.

So the job's colour carries the verdict: green means the business logic held (or
was repaired — only a locator had drifted), red means it broke and a human has a
diagnosis to read, uploaded as an artifact alongside the Playwright report.

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
anything regressed. `check` flags it — every string the spec names that the
feature never quoted, and that reads as page content — but only as a note, since
telling a pinned headline from a legitimate on-screen label needs a human.
Turning that data into a business invariant is the next piece of work.

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

**Every navigation stops on a "select a certificate" dialog.**
Bundled Chromium cannot read a client certificate from the OS keychain. Record
through `playwright.record.config.ts`, which runs real Chrome and answers the
prompt with `--auto-select-certificate-for-urls`; see *Environments* for how to
point the MCP server at it.

**The agent hangs for the entire timeout on one step, CPU idle, no new snapshot.**
`patches/playwright+1.62.1.patch` was not applied — check that `postinstall` ran.
Without it, `run-test-mcp-server` builds its MCP backend config with no
`timeouts` field, so every interactive tool call runs with `timeout: undefined`.
Against a component that never settles the actionability wait does not come back,
and nothing below the per-feature budget in `recorder.mjs` is left to end it.
Set `RECORDER_DEBUG_FILE` to see what the agent was doing when it stopped.

**The browser will not start (`libnspr4.so: cannot open shared object file`).**
`npx playwright install-deps chromium` needs root. Without it, download the
packages and extract them into your home directory, then point `LD_LIBRARY_PATH`
at them before running. Chinese text rendering as boxes is the same problem one
layer up — install a CJK font such as `fonts-wqy-zenhei`.

**`npm install` times out while `curl` to the same URL works.**
The resolver is returning AAAA records for a host whose IPv6 path is dead, and
`--dns-result-order=ipv4first` cannot help because there is no IPv4 answer to
prefer. Use a registry whose DNS answers with IPv4.

## License

MIT — see [LICENSE](LICENSE).
