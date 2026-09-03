# Toggling a switch or checkbox by name

A page often has several switches or checkboxes — one per setting, per row, per
feature. Target the one you mean by an accessible name or by the row/section it
belongs to, never by its position in the list:

```
// by accessible name
await page.getByRole('switch', { name: toggleName }).click()

// scoped to the row/section that identifies it
const row = page.getByRole('row').filter({ hasText: rowText })
await row.getByRole('switch').click()
```

"The i-th switch" changes meaning the moment a setting is added, removed or
reordered, so it isn't recorded. The name or the containing row is what stays
constant. When the switches carry no accessible name, the identifying text is
usually in the same row or label — scope to that and reach the control through
it. That identifying text can be a runtime fact; read it off the page when you
get there, then scope by it.

## Prove the toggle landed in the state you wanted

A switch is only meaningfully "set" if it ends in the intended state. Assert the
resulting state in the same step, so a toggle that was already on (and your click
turned *off*) is caught rather than silently leaving the opposite of what the
step intended:

```
const sw = page.getByRole('switch', { name: toggleName })
await sw.click()
await expect(sw).toBeChecked()          // or .not.toBeChecked() for the off case
```

Assert `toBeChecked` / `aria-selected` rather than assuming the click flipped it
the way you wanted — that turns a blind toggle into a checkpoint.
