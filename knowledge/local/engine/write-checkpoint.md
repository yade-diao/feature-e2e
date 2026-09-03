# Prove a write took effect, in the same step

A step that changes state — creates, updates, or deletes something — must assert
that the change actually happened, in that same step. A write can appear to
succeed (the click landed, no error was thrown) while the operation silently
failed on the server. Without a direct assertion, the step reads as done, and the
failure only surfaces later when a downstream step tries to use data that was
never really created — a confusing, misattributed cascade (see
`cascading-failure`).

Assert the effect directly, closest to the operation:

- **Create** — the new item is now present: `toBeVisible`, or a row count that
  went up, or a success confirmation.
- **Update** — the field now holds the new value: `toHaveValue` / `toHaveText`
  of the value you wrote (a strong checkpoint), or at least a visible state
  change (a weaker one).
- **Delete** — the item is gone: `toHaveCount` reduced, or the row no longer
  visible.

Graded strength: asserting the **written value** (`toHaveText`/`toHaveValue`) is
stronger than asserting mere visibility, because it proves *what* was written,
not just that *something* rendered. Prefer the strong form when the value is
observable. Either way, the assertion belongs in the same step as the write, not
deferred to a later reload or search.
