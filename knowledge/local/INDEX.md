# Local knowledge index

Committed knowledge that ships with this repo. `engine/` is engine-general
technique (always pointed at during recording); the rest are per-domain business
knowledge for the moved features, mounted with `--knowledge=knowledge/local/<domain>`.

You are reading the index, not the knowledge. Read the one module that fits the
feature in front of you, then that module's own INDEX on demand.

## Engine technique (always injected)

`engine/` — engine-general, product-neutral recording technique. Indexed by
[`engine/INDEX.md`](engine/INDEX.md): locator priority, shadow-DOM inputs, slow
third-party content, search/combobox, cascading failure, write checkpoints. This
is injected automatically on every record; do **not** mount it with `--knowledge`.

## Shared references

`_common/` — cross-domain references every business module points at:
- [`_common/credentials.md`](_common/credentials.md) — persona → login email/role.
- [`_common/placeholders.md`](_common/placeholders.md) — `${currentYear}`, `{yearCode}`, run-time IDs, the `supa` flag.

## Business domains

Each maps to a `features/<domain>/` project; mount its directory with
`--knowledge` when recording that project.

| Domain | Features | Read |
| --- | --- | --- |
| account-plan | AccountPlan, AccountPlanBaseline | [`account-plan/INDEX.md`](account-plan/INDEX.md) |
| assortment | Assortment | [`assortment/INDEX.md`](assortment/INDEX.md) |
| funds | FundsManagement, PromotionFunds | [`funds/INDEX.md`](funds/INDEX.md) |
| trade-spend-config | TradeSpendConfig | [`trade-spend-config/INDEX.md`](trade-spend-config/INDEX.md) |
| adapter-config | AdapterConfig | [`adapter-config/INDEX.md`](adapter-config/INDEX.md) |
| change-handling | ChangeHandling | [`change-handling/INDEX.md`](change-handling/INDEX.md) |
| responsibility-area | ResponsibilityAreaPerformance | [`responsibility-area/INDEX.md`](responsibility-area/INDEX.md) |

Each business module holds an `INDEX.md` (when-to-read → which file) and one or
more single-topic files. Values in these docs are rules and boundaries, not fixed
answers — the agent chooses concrete values from what the page offers.
