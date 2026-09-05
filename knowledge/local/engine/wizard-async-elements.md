# Wizard / async elements: use an assertion as the wait, never a bare wait

A multi-step create wizard (or any flow where a control appears only after an
async load — a grid that populates after a selection, a dialog that renders a beat
late) has a replay trap that is easy to hit and hard to see:

**A `browser_wait_for` is NOT a recordable action.** You may use it live to let an
element show up before you drive it — but it does not become a step in the trace, so
the deterministic replay (and the shadow's clean re-run) has NO wait there. The next
action then fires the instant the page is reached, before the async element exists,
and fails with "target absent on the loaded page" — every replay, forever. This is
the single reason a wizard step that you can drive by hand keeps failing on replay:
the waits that made it work live are invisible to the recording.

## The fix: make the wait part of the recorded step, as an assertion

Record an **assertion that the element (or its container's ready state) is present**
right before the action that needs it. A web-first `expect(locator).toBeVisible()` /
`toHaveCount(n)` retries until the condition holds — so it IS a wait, but one that
lives in the trace and replays. Concretely, for an async control the next action
depends on:

- assert the thing you are about to act on is there first —
  `expect(<the row/cell/button>).toBeVisible()` (or `toHaveCount(1)` for a specific
  row) — then drive the action;
- for a grid that fills after a prior selection (e.g. product categories that only
  load once a customer is bound), assert a known row of the loaded grid is visible
  before selecting in it.

The assertion carries the waiting into the recorded step, so the clean replay waits
exactly where you did. A `browser_wait_for` alone does not; a recorded assertion does.

## Confirm each selection BOUND before advancing the wizard

In a multi-page wizard, a click that visually highlights a row/option often has not
actually BOUND the value — the selection is async, and the next page's Next/Finish/
Create control only enables once the value truly took. If you advance on an unbound
selection, the later control never enables and the replay waits out the timeout. So
after each selection, and before moving to the next page, **assert the selection landed
in its target state**, not just that you clicked it:

- a value chosen into a form should READ BACK — assert the grid/field now shows it
  (e.g. the selected row appears in the bound list, the combobox reads the chosen value),
  not that a row is merely highlighted;
- only then drive Next/Finish/Create.

This "selected ≠ bound, read it back" check is the same idea as using an assertion for a
wait: it makes the wizard's real state a recorded, replayable fact.

**If a wizard step is rejected and you re-record it, re-drive the WHOLE action sequence
from the first page.** A fresh replay opens a brand-new modal wizard with none of the
previous run's partial selections, so re-doing only the sub-action that failed records
against a wizard state that does not exist and fails again. Re-record the entire
page-1-through-final sequence as the one step.

## Corollary — record shapes that bite here

- **`press` takes its key in the action's `key` field**, e.g. `press('Enter')`. Do
  NOT put the key in `arg` as `{ literal: 'Enter' }` — that is a `malformed arg` /
  "press needs a non-empty key" refusal.
- **`fill`'s `arg` is `{ literal: ... }` or `{ ref: ... }`** — never a raw value and
  never a dynamic-kind object inline.
- A custom-element field whose inner input is the candidate's `inner` property
  (`{ kind: 'testid', id: '…', inner: '#inner' }`), not a separate `.locator('#inner')`
  pasted into the expression.
