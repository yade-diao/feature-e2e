# Keep a creating step idempotent — a created name is unique per run

A feature that **creates** something (a record, a plan, a config entity) and later
searches / edits / asserts on it has a replayability trap: if the created entity's
name is a fixed literal, the recording works the first time and breaks every time
after. The first run creates `Foo`; the second run's create collides with the `Foo`
that is already there, or a precondition like "there is no X named Foo" is now false
and the step hangs waiting for a state that will never come. A spec that only replays
once is not a regression test.

The rule: **a name the run brings into existence is a dynamic value with a run-unique
suffix, never a fixed literal.**

- The feature table often spells a fixed-looking creation name. Treat it as a
  **template**, not a literal to type. Record it as
  `{ kind: 'dynamic', expr: "`<template>_${Date.now()}`" }` — the base is the
  feature's name, the suffix makes it unique this run.
- **Reference it by the same `{ ref }` everywhere it recurs** — the later search,
  edit, delete, and assertion all use the ref, so they target *this* run's item, not
  a frozen literal. Never bake the runtime value into a locator `expr` (see the
  dynamic rule in the agent definition §7).
- A **"there is no X named …" precondition is satisfied for free** when the name is
  run-unique — there is nothing to clean up, because the name is new every run. Do
  NOT satisfy it by deleting a leftover: deletion is a fragile terminal action, it
  depends on the leftover actually being there, and it does not make the spec
  idempotent. The durable fix is the unique name.
- **Keep the generated value valid for the field.** A name input often caps at some
  length or rejects some characters; a suffix that overflows the limit makes the
  create fail (and the failure looks like a hang or a timeout, not an obvious error).
  Shorten the base or truncate the suffix to fit. The project knowledge base names
  any specific limit for a given entity.

This is what lets a create-and-verify feature be re-recorded and re-run against the
same environment as many times as CI needs. Assert the create took effect in the same
step (see `write-checkpoint`); make the created name unique so the next run can do it
again.
