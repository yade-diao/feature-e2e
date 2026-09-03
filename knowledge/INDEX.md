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
| `local/_common/` | Cross-domain references: [`credentials.md`](local/_common/credentials.md) (persona → login), [`placeholders.md`](local/_common/placeholders.md) (`${currentYear}`, `{yearCode}`, run-time IDs, `supa`). |
| `local/<domain>/` | Per-domain business knowledge (account-plan, assortment, funds, trade-spend-config, adapter-config, change-handling, responsibility-area). Mount with `--knowledge=knowledge/local/<domain>` when recording that project. |

Full module list: [`local/INDEX.md`](local/INDEX.md).

## `external/`

Synced clones — read each repo's own README/index; this project does not own or
maintain their contents.

### `external/rgm-e2e-knowledge/`

Clone of `rgm/rgm-e2e-knowledge`. Environment definitions (`environments/*.yaml`
— personas, URLs, roles) and per-area business manuals/workflows
(`areas/<area>/`), plus cross-cutting `conventions/`. Declared for the `promotion`
project in [`links.json`](links.json); synced with `npm run sync`.

### `external/rgm-wiki-super/`

Copy of the `wiki/` output of `rgm/rgm-wiki-super` — synthesized product knowledge
assembled from wiki / Jira / Aha / git sources. Grouped by business, not by
source. Start at [`external/rgm-wiki-super/index.md`](external/rgm-wiki-super/index.md):
- `requirements/` — initiative-family synthesis (feature intent, business rules).
- `codebase/` — code-derived notes.
- `implementations/` — how requirements map to implementation.

Useful when a moved feature needs deeper business context than its own domain
knowledge carries — the agent reads the relevant page on demand.

> Not committed (`external/` is gitignored) and not synced via `links.json` — it
> is a manual copy. To rebuild it: `cp -R ~/Documents/rgm-wiki-super/wiki/.
> knowledge/external/rgm-wiki-super/` (source repo: `rgm/rgm-wiki-super`, its
> `wiki/` output).

## Config files

- [`links.json`](links.json) — which external repo each project draws on.
- `links.schema.json` — schema for the above.
- [`README.md`](README.md) — how the knowledge subsystem is wired into recording.
