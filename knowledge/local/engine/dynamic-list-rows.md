# Locating a row in a dynamic list

A list whose rows come from live data — search results, a grid of records you
just created, a value-help table — has no fixed row order. The row you want is
identified by **what it contains**, not by where it sits, so locate it by its
own text and let Playwright find whichever row currently holds it:

```
const row = page.getByRole('row').filter({ hasText: rowText })
await expect(row).toBeVisible()
await row.getByRole('button', { name: 'Edit' }).click()
```

`filter({ hasText })` scopes to the one row carrying that text; the action or
assertion then chains off that scoped row. This survives re-ordering, paging and
new data — the row that holds `rowText` is the target no matter which position
it lands in. Reaching for "the first row" or "the third cell" instead binds the
step to an ordering the next run may not reproduce, so it isn't recorded.

## The just-created row

When a step acts on the item an earlier step created, the identifying text is a
value the run generated — carry that value as a named reference and filter on it,
so the value the create step used is exactly the one this step finds:

```
const row = page.getByRole('row').filter({ hasText: CREATED_NAME })
```

## Selecting the row itself

To select or open the row (not a control inside it), click a stable target on
the scoped row — a named cell, a checkbox, a navigation control — rather than a
positional cell:

```
await row.getByRole('gridcell', { name: rowText }).click()
```

If the grid marks its selection cell with a stable attribute or the row exposes
an accessible name, prefer that. When the only thing distinguishing the cell is
its position, that identity has to be discovered live — find a text or role on
the row you can scope to, and select through it.
