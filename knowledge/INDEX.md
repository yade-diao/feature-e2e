# Knowledge base index

The verify agent draws on two kinds of knowledge, under two
directories only:

- **`local/`** — committed, ships with this repo. Engine technique + per-domain
  business knowledge. See [`local/INDEX.md`](local/INDEX.md).
- **`external/`** — synced clones of external knowledge repos, pulled in per
  project via `links.json`. Introduced below.

Progressive disclosure: nothing here inlines the knowledge into the prompt — the
prompt names the relevant index and lets the agent read the one topic it needs.

## `local/`

| Path | What |
| --- | --- |
| [`local/engine/`](local/engine/INDEX.md) | Engine-general recording technique, product-neutral. Injected automatically on every record — never mounted with `--knowledge`. |
| `local/_common/` | Cross-domain references shared by every project — e.g. per-element locating notes, shared placeholder-resolution rules. Add your own here (credentials, run-time placeholders, etc). |
| `local/<domain>/` | Per-domain business knowledge, one directory per project. Mount with `--knowledge=knowledge/local/<domain>` when recording that project. Empty out of the box — add your own as you record. |

Full module list: [`local/INDEX.md`](local/INDEX.md).

## `external/`

Synced clones — read each repo's own README/index; this project does not own or
maintain their contents. Not shipped here: point `links.json` at your own
external knowledge repo(s) per project, then `npm run sync`. A repo can hold
whatever shape fits your team — environment definitions, per-area business
manuals, synthesized product knowledge, cross-cutting conventions. See
`links.schema.json` for the fields `links.json` supports.

## Config files

- [`links.json`](links.json) — which external repo each project draws on.
- `links.schema.json` — schema for the above.
- [`README.md`](README.md) — how the knowledge subsystem is wired into recording.
