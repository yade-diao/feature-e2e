# Search boxes and comboboxes

Typing into a search box or combobox is not the same as running the search.
`fill()` sets the field's text, but the server-side filter — or the dropdown
selection — usually fires on a commit event, not on input. A step that fills and
then immediately asserts on results tends to read the *old*, unfiltered page.

The reliable sequence is fill, then commit, then wait for the result:

```
await box.fill('term')
await box.press('Enter')          // commit — triggers the filter / selection
await expect(results).toBeVisible()  // wait for the filtered result, not a fixed sleep
```

Prefer waiting on the expected result over a fixed delay. **When a combobox reveals a
dropdown of options, prefer committing by keyboard — fill the full option text, then
`press('Enter')` — over clicking the option row.** The dropdown option is async popover
content: it is not on the page at the instant a clean replay reaches it, so a recorded
"click the option" waits out the timeout and fails on replay, while a keyboard commit is
deterministic. Only click the option if keyboard commit genuinely does not select it, and
then guard that click with an assertion that the option is visible first (make the wait a
recorded state, per `wizard-async-elements.md`). Either way, read back the committed value
to prove it bound.

Keep the fill, the commit, and the assertion on the result in the **same** step.
A search whose result is only checked in a later step reads as if the search
itself was never verified.

## When the options live in a shadow DOM

Some custom comboboxes render their options inside a shadow DOM, so
`getByRole('option', { name })` finds nothing — the option is not an accessible
`option` in the light DOM. Don't reach into the shadow DOM to click the item by
hand (a scripted click there doesn't record). Type the option's text into the
inner input and commit with a key instead — the control does its own matching:

```
const box = page.getByTestId('someCombobox').locator('#inner')  // the app's own testid
await box.fill(optionText)
await box.press('Enter')              // the control selects the match
await expect(box).toHaveValue(optionText)  // prove the selection
```

The option text is a runtime fact — it depends on the environment and what the
earlier steps set up — so read it off the live control when you get there, then
fill that value. The pattern (fill the inner input → commit with a key → assert
the committed value) stays the same whatever the option is; only the value you
type is discovered live.
