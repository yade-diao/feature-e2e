# Knowledge index

You are reading the index, not the knowledge. This file lists what exists and
when each piece applies; it does **not** repeat the content. Read the one topic
that fits the situation in front of you — do not read them all up front.

## Core knowledge — general technique

Built-in, engine-general, product-neutral. Always present. Each entry: when it
applies → the file to read.

| When you are… | Read |
| --- | --- |
| choosing how to locate an element for an action or an assertion (role/label/testid/text/CSS priority, when a `.or()` fallback is required, why assertions must not have one) | [`locator-priority.md`](./locator-priority.md) |
| filling a field that seems to do nothing, or a custom-element control that wraps a native `<input>`/`<textarea>`/`<select>` in a shadow DOM | [`web-components-shadow-dom.md`](./web-components-shadow-dom.md) |
| waiting on content from an external tool or an `<iframe>` you don't own — slow first paint, no testids, only ARIA roles or structural CSS to grab | [`slow-third-party-components.md`](./slow-third-party-components.md) |
| driving a search box or combobox — why `fill()` alone doesn't run the search, and the fill→commit→wait-for-result sequence (including options that live in a shadow DOM) | [`search-combobox.md`](./search-combobox.md) |
| acting on a row in a data-driven list — search results, a grid, the row you just created — locating it by its content (`filter({ hasText })`) instead of position | [`dynamic-list-rows.md`](./dynamic-list-rows.md) |
| toggling one switch/checkbox among many — targeting it by name or its row, and asserting the resulting checked state | [`toggle-by-name.md`](./toggle-by-name.md) |
| a locator that matches more than one element — narrowing by scope/text/visibility instead of a numbered match | [`disambiguating-duplicates.md`](./disambiguating-duplicates.md) |
| triaging a run where many steps failed — how to tell one root cause from the pile of downstream consequences, and diagnose only the first | [`cascading-failure.md`](./cascading-failure.md) |
| writing a step that creates/updates/deletes something — why it must assert its own effect in the same step, and which assertion is a strong vs. weak checkpoint | [`write-checkpoint.md`](./write-checkpoint.md) |

## Project-specific knowledge

When the project has a linked knowledge repo, the prompt names its directory
under `knowledge/external/<slug>/` — read **its** own index there, the same
on-demand way. That repo owns and maintains its own contents and index; this
index does not mirror them.

## Maintaining this index

Maintained alongside the engine files, in the same directory — one unit. Add,
rename, or remove an engine topic → fix its row here (an `engine/*.md` with no row is
invisible to the agent, which only sees this index) and any cross-reference in
the other engine files. Keep every entry product-neutral; a lint test enforces it
on `engine/*.md` and this index is held to the same bar.
