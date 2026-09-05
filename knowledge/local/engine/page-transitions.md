# Moving between pages: wait for the destination to be ready before acting

A step often leaves one page and works on another — a create flow lands on a detail
page, then a later step goes back to a list to search; a save navigates away; a menu
opens a new view. A single-page app swaps content asynchronously: the URL changes (or
`goto` returns) before the destination has actually rendered. Acting immediately then
targets the old page or a half-built one — the locator resolves to nothing and the
action waits out its full timeout, which reads as a hang, not an obvious error.

Do this on every page transition:

1. **Navigate explicitly** — do not rely on being left on the right page by a previous
   action. If the step operates on a list/dashboard but the previous step ended on a
   detail page, `goto` the list's own path (a path, never a full URL — origin comes
   from baseURL). Record that `goto` as part of the step, so a replay reproduces it
   instead of assuming the browser is already there.
2. **Wait for a stable marker of the destination** before the first action on it —
   assert/await an element that only exists once the page is ready (a heading, a known
   control, the toolbar). `browser_wait_for` on that marker, not a fixed sleep.
3. **Then act.** Now the list rows, the filter input, the target control are present.

Why it matters for replay specifically: the recorder's own browser may be fast enough
that acting-without-waiting happens to work once, but the independent replay starts the
destination cold and the missing wait makes it fail. The wait is not defensive padding
— it is the step honestly saying "this page must be ready here", which is exactly what
makes it replay on a slower or freshly-started browser. Pair this with asserting the
step's own effect (see `write-checkpoint`): arrive, confirm you arrived, then act.
