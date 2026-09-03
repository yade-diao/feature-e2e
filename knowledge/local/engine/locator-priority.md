# Locating elements

Prefer, in order:

1. **Role + accessible name** — `getByRole('button', { name: '…' })`. Independent
   of ids, classes and DOM shape; survives a rebuild.
2. **Form semantics** — `getByLabel`, `getByPlaceholder`.
3. **A stable, hand-written testid** — `getByTestId`. A developer's deliberate
   contract with the suite, not a build artifact.
4. **Visible text** — `getByText`. Drifts when copy changes.
5. **CSS** — last resort. Breaks on the next refactor.

An action (click, fill, select…) fails the whole test when its locator stops
matching, so an action locator must survive a rebuild. The redundancy gate
(`checkLocatorRedundancy`) enforces exactly this: an action located by anything
drifting — visible text, alt text, title, or raw CSS — is rejected unless it
carries a `.or()` fallback chain. Pure accessibility semantics (role / label /
placeholder) and a stable testid stand on their own and need no fallback.

Assertion locators are the opposite case: do **not** give them a fallback. An
assertion that fails is the signal that the business logic no longer holds;
a fallback would let it match some near element and go green while the thing it
was watching is gone.
