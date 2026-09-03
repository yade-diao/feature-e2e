# knowledge/

Reference material the verify agent may lean on while it verifies business logic
in a live browser. It does not replace its agent definition.

**Progressive disclosure.** The prompt does *not* carry the knowledge itself — it
carries a short pointer to the indexes, and the agent reads the one topic it
needs, when it needs it (it has the `Read` tool for exactly this). This keeps the
prompt light and the agent's context uncluttered instead of front-loading every
topic on every run.

## Two layers

See [`INDEX.md`](INDEX.md) for the full map. In short:

- **`local/`** — committed, ships with this repo. Two kinds:
  - **`local/engine/`** — built-in, always pointed at. Engine-general technique
    that holds for any application under test, indexed by
    [`local/engine/INDEX.md`](local/engine/INDEX.md). **Neutral wording is a rule,
    not a preference:** no product, feature or framework proper nouns (no company
    names, no "KPI", no "SAC", no "UI5", etc.). A lint test in
    `src/__tests__/knowledge.test.mjs` enforces this on every `engine/*.md` **and
    on its `INDEX.md`** — name a product here and the suite fails. Product-specific
    detail belongs in a business module or an external base.
  - **`local/<domain>/`** — per-domain business knowledge, mounted per project with
    `--knowledge`. Product-specific wording is expected here.

- **`external/`** — working copies of external knowledge repositories, one
  subdirectory per remote. Either synced by `npm run sync` (the remote is the
  source of truth) or copied in from a local checkout. Each external repo carries
  **its own** index (an `INDEX.md` or `README`) so the agent navigates it the same
  on-demand way it navigates `local/engine/`.

## Wiring

`links.json` maps a **project** (the first directory under `tests/features`, per
`src/paths.mjs`) to the external repository and areas it draws on. It is the only
committed file that names a specific external repository, and it names only a repo
URL and area folder names — never the product detail those areas contain. This is
the project's **default** base.

`src/knowledge.mjs` finds `local/engine/INDEX.md`, resolves the project's default
base from `links.json`, and builds the pointer that names each base that exists on
disk. Selection is keyed on the feature's project. Loading is offline-safe: a
missing `external/` clone is skipped rather than erroring, so a recording never
depends on the network.

## Choosing bases at run time

`record` takes two optional flags. Bases are **appended** to the
project default, flat and unordered — the agent reads each one's index on demand.

- `--knowledge=<repo|path>[,<repo|path>...]` — append extra bases. Repeatable and
  comma-separated. A value is treated as:
  - a **local directory** if it exists on disk (or looks like a path — starts with
    `/`, `./`, `../`, `~`, or a drive letter). Read **where it sits** — never
    cloned or copied. Point at your own working copy directly.
  - otherwise a **repo** (`owner/name` or a URL), resolved to `external/<slug>/`.
- `--refresh` — before running, pull the `links.json`-declared bases for the
  targeted projects up to date. `record` is otherwise fully offline;
  `npm run sync` is the standalone equivalent. A failed fetch is reported, not
  fatal — the run falls back to whatever is already on disk.

### One trade-off worth knowing

`--refresh` only refreshes what `links.json` declares, and `record` never
clones an arbitrary repo on its own. So a **repo passed on the command line**
takes effect only if it is *already* synced under `external/<slug>/`. If it is
not, either pass a **local path** instead (no such limit — it is read in place),
or add it to `links.json` and run `npm run sync` once.

## Examples

```bash
# default base only (from links.json), fully offline
node src/cli.mjs record tests/features/promotion/Promotion.feature

# append your own local knowledge base, read in place
node src/cli.mjs record <feature> --knowledge=~/kb/my-notes

# append two bases; pull the project's declared base up to date first
node src/cli.mjs record <feature> --refresh --knowledge=~/kb/a,owner/already-synced-kb
```
