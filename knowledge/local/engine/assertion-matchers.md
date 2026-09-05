# Assertion matchers — the value's type must match the matcher

An assertion pairs a locator with a matcher and a value. The matcher decides what
**type** the value must be, and a type mismatch is not a "soft" failure — it throws
on every replay before it even compares, so the step can never go green.

The recurring trap:

- **`toHaveCount` takes an integer, never a string.** `toHaveCount(0)` — not
  `toHaveCount('0')`. A string count throws `expected float, got string` on every
  run (the matcher tries to read it as a number and cannot). This is the single most
  common assertion-value bug: a step that means "there are none" recorded as
  `{ matcher: 'toHaveCount', value: '0' }` fails mechanically forever. Record the
  value as the number `0`, not the text `'0'`.

**The exact `value` shape in a record — get this right or `record_step` refuses it
with `malformed arg`.** The assertion's `value` is NOT a bare `0` or `"0"`; it is a
wrapper object with EXACTLY ONE key:
- a fixed value: `{ literal: <string|number> }` — a count is `{ literal: 0 }` (number),
  a text is `{ literal: 'Draft' }` (string);
- a dynamic value: `{ ref: <IDENTIFIER> }` — e.g. `{ ref: 'CREATED_ITEM_NAME' }`.
So "no card with this name exists" is recorded as an assertion whose
`matcher: 'toHaveCount'`, `value: { literal: 0 }`. A bare `0`, a string `'0'`, a
`{ literal: '0' }`, or a `value` with both/neither key are all `malformed arg`. When
in doubt, this is exactly the kind of thing to read here BEFORE recording, not after a
refusal.

- **Text / value matchers take a string.** `toHaveText`, `toContainText`,
  `toHaveValue` compare against a string (or a regex for `toHaveText`). A dynamic
  value goes through its `{ ref }`, not a frozen literal.

- **Visibility / state matchers take no value.** `toBeVisible`, `toBeEnabled`,
  `toBeChecked` assert a boolean state; they carry no comparison value.

Rule of thumb: a matcher about **how many** (`toHaveCount`) wants a number; a matcher
about **what it says** (`toHaveText`/`toHaveValue`) wants a string; a matcher about
**what state it is in** (`toBeVisible`/`toBeEnabled`) wants nothing. Getting the type
wrong is a mechanical failure the shadow replay catches immediately — get it right at
record time rather than being rejected on the type error.
