# Local knowledge index

Committed knowledge that ships with this repo. `engine/` is engine-general
technique (always pointed at during recording); the rest are per-domain business
knowledge for the moved features, mounted with `--knowledge=knowledge/local/<domain>`.

You are reading the index, not the knowledge. Read the one module that fits the
feature in front of you, then that module's own INDEX on demand.

## Engine technique (always injected)

`engine/` — engine-general, product-neutral recording technique. Indexed by
[`engine/INDEX.md`](engine/INDEX.md): locator priority, shadow-DOM inputs, slow
third-party content, search/combobox, cascading failure, write checkpoints. This
is injected automatically on every record; do **not** mount it with `--knowledge`.

## Shared references

`_common/` — cross-domain references every business module points at: shared
per-element locating notes, plus whatever else your team wants every domain to
see (login credentials, run-time placeholders). Empty out of the box.

## Business domains

Each maps to a `features/<domain>/` project; mount its directory with
`--knowledge` when recording that project. Empty out of the box — as you record
a project, add `local/<domain>/INDEX.md` plus one file per topic (when-to-read →
which file). Values in these docs should be rules and boundaries, not fixed
answers — the agent chooses concrete values from what the page offers.
