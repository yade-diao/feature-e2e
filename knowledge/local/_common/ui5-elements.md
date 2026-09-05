# UI5 elements — how to locate, drive, and record each kind

A per-element reference for the SAPUI5 / Web-Components controls this product is built
from. Every entry is a pattern that has been VERIFIED on the live app during recording —
each carries a real example (its testids/values are illustrations from a specific
feature, not a promise the same testid exists elsewhere; read the real one off the page).

General technique that is NOT element-specific lives in the engine index
(`../engine/INDEX.md`): locator priority, the shadow-DOM inner-input rule, disambiguating
duplicates, assertion matchers, using an assertion as a wait. This file says, per element,
which of those apply and the one right way to drive it.

The recurring root cause across UI5 controls: **a `getByTestId('x')` usually resolves to
the custom-element WRAPPER, not the native input/button inside it.** So most fillable/
committable controls need `.locator('#inner')` (or the control's specific inner id) to
reach the real element, and most "click the option/row" interactions are on async popover
content that must be waited for as a state (see `../engine/wizard-async-elements.md`).

---

## Button

- **Locate:** `getByRole('button', { name })` by its visible/accessible name. This is the
  first choice — buttons almost always expose an accessible name.
- **Drive:** `.click()`.
- **Record:** the role locator is stable; no inner-input needed. If a button has no
  accessible name (icon-only), fall back to its `testid`, not a positional match.
- **Verified example:** `getByRole('button', { name: 'Create Account Plan' }).click()`.

## Text input (name / plain field)

- **Locate:** the field's `testid`, then chain to the native input: 
  `getByTestId('…').locator('#inner')`. A bare `getByTestId('…')` is the wrapper and a
  `fill` on it silently does nothing (see `../engine/web-components-shadow-dom.md`).
- **Drive:** `.fill(value)`. In a record, the value is `{ literal: … }` or `{ ref: … }`.
- **Verified examples:** `getByTestId('accountPlanCreateDialogName').locator('#inner')`,
  `getByTestId('kpiNameInput').locator('#inner')`, `getByTestId('categoryInput').locator('#inner')`.

## Combobox (single-select dropdown)

- **Locate:** `getByTestId('…').locator('#ui5-combobox-input')` — the inner combobox input.
- **Drive:** **fill the full option text, then `press('Enter')` to commit — do NOT click
  the dropdown option** (the option is an async popover row that is absent at replay time).
  Then read back the committed value to confirm it bound. Full mechanism and shadow-DOM
  case in `../engine/search-combobox.md`.
- **Record:** `press`'s key goes in the action's `key` field (`press('Enter')`), not in `arg`.
- **Verified example:** `getByTestId('promotionManufacturerTradeSpends').locator('#ui5-combobox-input')`
  fill + Enter; and the account plan Year/Type comboboxes (`accountPlanCreateDialogYear`,
  `accountPlanCreateDialogAccountPlanType`, both `#ui5-combobox-input`).

## Multi-combobox / value-helper multi-input (chips/tokens)

- **Locate:** `getByTestId('…').locator('#ui5-multi-combobox-input')` (or the value-helper
  multi-input's inner `#…-input`).
- **Drive:** type the value into the inner input and `press('Enter')` to commit it as a
  token — `fill` alone does not add the token. Repeat per value; confirm the token chip
  appears. Same commit mechanism as `../engine/search-combobox.md`.
- **Verified example:** `getByTestId('filter-name').locator('#ui5-multi-combobox-input')`;
  a dashboard filter built on a value-helper multi-input still needs the inner-input
  chain above (a value-helper, not a plain textbox — a `getByLabel(...)`/`getByRole('textbox')`
  misses it).

## Value-help dialog (pick a row from a popup)

- **Open:** click the field's value-help button (e.g. a `…ValueHelperInputButton` testid).
- **Select the row:** the dialog's rows expose a selection cell — click the row's
  `[data-selection-cell="true"]`, scoped to the row filtered by its own text; do NOT click
  the row's text, and do NOT use `.first()`/position (`../engine/dynamic-list-rows.md`).
- **Async:** the dialog and its rows render after the click — wait for the target row as a
  state before clicking it (`../engine/wizard-async-elements.md`).
- **Confirm bound:** after selecting, assert the value actually landed in the form (the
  selected row shows in the bound grid), not just that it was highlighted — selected ≠ bound.
- **Verified example:** a create wizard's customer-selection step — open
  `wizardValueHelperInputButton`, click the row filtered by the target customer's
  `[data-selection-cell="true"]`, then verify it appears in the bound grid.

## Tree grid (expand to a leaf)

- **Expand a node:** click the row's `[title="Expand Node"]` — `row.locator('[title="Expand Node"]')`.
- **Lazy load:** children render only after expand; **wait for the child row to appear**
  (assert it visible) before expanding deeper or selecting — do not fixed-sleep
  (`../engine/wizard-async-elements.md`).
- **Select a leaf:** click the target row's `[data-selection-cell="true"]`, then confirm selected.
- **Verified example:** a product tree, expanding each level's `[title="Expand Node"]`
  down to the target leaf's `[data-selection-cell="true"]`.

## Radio / switch / checkbox (state toggles)

- **Locate:** `getByRole('radio'|'switch'|'checkbox', { name })` by its label; when there are
  many, scope by the row/section that identifies the one you mean (`../engine/toggle-by-name.md`).
- **Drive:** `.check()` / `.click()` as the control requires.
- **Confirm + record:** assert the resulting state (`toBeChecked()`) in the same step — a
  toggle whose result is not asserted reads as unverified. `toBeChecked` takes no value
  (`../engine/assertion-matchers.md`).
- **Verified usage:** `getByRole('switch', { name: toggleName })`, `getByRole('radio')`,
  `getByRole('checkbox')` appear across the recorded features.

## Menu button + menu item (per-row "More" / actions)

- **Locate the trigger:** the row/card's menu ("More") button by its `testid`, scoped to the
  container that holds the item you mean — not a flat `getByRole('listitem')`/`getByText`
  (the name lives in shadow DOM, so flat filters match 0 or many, `../engine/web-components-shadow-dom.md`).
- **Then the item:** open the menu, click the menu item by its `testid`; a confirm dialog
  (`getByRole('alertdialog')`) may follow.
- **Verified example:** a dashboard card — `menuButton` scoped to the card's
  `cardContainer`, then the card's own delete menu item, then the alertdialog's Delete.

## Link

- **Locate:** `getByRole('link', { name })` by its visible text.
- **Drive:** `.click()`; it usually navigates — treat the destination as a page transition
  (navigate/wait-for-marker, `../engine/page-transitions.md`).

## Dialog / message-strip / toast (transient UI)

- A `getByRole('dialog'|'alertdialog')` is the scope for its own buttons — find the dialog
  first, then its button, so a same-named button elsewhere is not matched.
- A message-strip / toast is a transient status: if a step's effect shows as one, assert it
  while it is present, but prefer a durable landmark (the created item on its detail page)
  as the checkpoint, since a toast disappears (`../engine/write-checkpoint.md`).
