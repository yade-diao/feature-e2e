# Cascading failures — diagnose the first cause, not its consequences

When steps run in order and one of them leaves the page in a broken state, every
step after it fails too — but those later failures are *consequences*, not
independent problems. Reporting each as its own fault buries the one that matters
under a pile of noise.

Three signals that a run is a cascade, not several separate faults:

1. **Many steps failed, but only the first has a substantive error** — an
   assertion mismatch, a non-2xx network response, a console error. The rest are
   bare `timeout`, `not found`, `no such element`, `detached` — the shape of a
   step that never got the state it depended on.
2. **The first failure is a write or a state change**, and the later failures are
   reads that needed what the write was supposed to produce.
3. **A step "passed" without proving its effect**, and something downstream broke
   trying to use a result that was never really there. (See `write-checkpoint`.)

When you see this, write **one** diagnosis attributing the root cause to the
first substantive failure. Do not emit independent verdicts for the downstream
timeouts — fix the first, and the rest resolve on their own.
