# Web components with a shadow DOM

Some component libraries wrap a native control inside a custom element with its
own shadow DOM. The outer custom element is not the thing you type into — it
delegates to a native `<input>` (or `<textarea>`, `<select>`) nested inside.

Filling the wrapper directly often does nothing, or throws, because the wrapper
is not an editable element. Chain to the inner native control first:

```
page.getByTestId('quantity').locator('input').fill(value)
```

The exact inner selector depends on the library; `input`, `textarea`, or a
documented internal id are the usual shapes. Not every field is wrapped — a
plain HTML `<input>` needs no chaining. When a fill silently has no effect,
suspect a wrapper and look for the inner control before assuming the value took.

## The inner control has a stable id — reach it by id, not by position

Many component libraries give the inner native control a predictable id derived
from the wrapper — a plain input wrapper may expose its editable element as
`#inner`, a combobox as a documented `…-input` id. Prefer that id: it is stable
across renders and unique within the wrapper:

```
page.getByTestId('quantity').locator('#inner').fill(value)
```

This reads the field through its testid (the developer's contract) and then the
inner control through a named id, so nothing depends on how many inputs happen
to be on the page or in what order they render. When the wrapper's own testid
already scopes to one control, `.locator('#inner')` (or `.locator('input')`) is
enough — you do not need to disambiguate further.

Setting the value another way — assigning `.value` and dispatching an event by
hand — can make the field *look* filled without the framework's reactive state
updating, so the write does not persist. A real `.fill()` on the inner control
drives the same path a user does and is the one that records and replays.
