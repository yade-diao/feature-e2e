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

**Assertion locators are the easiest to make too broad.** Asserting on a short,
common word — a status like "Setup in Progress", "Draft", "Active" — with a bare
`getByText('Setup in Progress')` often matches more than one node: a summary/legend
label AND the actual value on the row or card. A multi-match assertion is rejected
(and, unlike an action, an assertion may NOT carry a `.or()` fallback to paper over
it — a fallback would let it match a near element and pass while the real thing is
gone). Scope the assertion to the one element that carries the meaning: the specific
row/card filtered by its own identifying text, then the status within it — e.g. the
card for *this* run's created item, asserting its status cell. Narrow the assertion
the same way you narrow an action; never settle for a locator that matches two.

**A name that is a PREFIX of another name double-matches a `hasText` filter.** When one
item's name is a prefix of another's (e.g. `Foo` vs `FooEdit`, or a created name vs the
same name plus a suffix), `filter({ hasText: 'Foo' })` matches BOTH rows, because
`hasText` is a substring/contains test, not equality. Scope by the exact, whole
identifying text (or an enclosing container that holds only the one you mean), so the
filter cannot also catch the longer name. This bites most when a run creates `Name` and
a later step edits it to `NameEdit` and both exist on the page at once.
