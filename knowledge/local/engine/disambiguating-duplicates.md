# When a locator matches more than one element

Sometimes a role+name or a testid matches several elements: a confirm button
that exists twice, a page with more than one search field, a hidden template
copy alongside the live one. The stable fix is to **narrow by what makes the one
you want distinct** — the section it lives in, the text near it, whether it is
the visible one — not to grab a numbered match.

Narrow by an enclosing scope:

```
page.getByRole('dialog', { name: 'Save changes' }).getByRole('button', { name: 'Save' })
```

Narrow by the row or section text (see `dynamic-list-rows`):

```
page.getByRole('row').filter({ hasText: rowText }).getByRole('button', { name: 'Edit' })
```

Narrow to the visible one, when duplicates are a hidden template plus the live
control:

```
page.getByRole('searchbox', { name: 'Search' }).filter({ visible: true })
```

Each of these still identifies the element by meaning, so it survives a rebuild.
"The first match" or "the second one" pins the step to today's DOM order, which
the next render may change — so it isn't recorded. If two matches are genuinely
indistinguishable by scope, text or visibility, that is a sign the locator is too
broad: find the container or label that tells them apart.
