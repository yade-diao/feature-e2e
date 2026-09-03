# Slow, third-party embedded content

Content rendered by an external tool — an embedded analytics view, a report
widget, anything inside an `<iframe>` you do not control — has two properties
that break naive locators:

- **It is slow.** First paint can take tens of seconds, sometimes minutes. Use a
  generous, explicit timeout when waiting for such content to appear, rather than
  the default. A short timeout here reports a failure that is really just latency.

- **It exposes no testids.** You cannot add attributes to markup you do not own.
  Fall back to what the embed does expose:
  - **ARIA role + name** — `getByRole('treegrid', { name: '…' })`. The most stable
    handle on third-party content.
  - **Stable CSS class** — a structural container class the tool renders
    consistently. Less stable than a role, but often the only anchor available.

Treat these views as a black box: assert on what is visible to the user, not on
internal structure, and give each assertion room to wait.
