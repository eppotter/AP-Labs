# Brightside fixture: Tier-1 tables

Brightside Home Cleaning is a fictional multi-branch residential cleaner. The dataset exists to drive the runtime blocks and the demo flow; grow it only when a demo scenario needs a table (PLAN-v1 §3).

## Rules

- Synthetic only. Names are generated; emails end in `.invalid`; phones are 555-0100 to 555-0199.
- Deterministic. One generator version plus one seed gives byte-identical seed files.
- Money is stored in integer cents. Dates are ISO `DATE`; timestamps are UTC.
- About 24 months of history ending at a fixed `as_of` date recorded in `fixture_meta`, so known truths never drift with the calendar.
- Sizes are Tier 1: roughly 1–3k clients. Committed seed files stay under 10 MB.

## Tables

| Table | Grain (one row per) | Key relationships | Why the demo needs it |
|---|---|---|---|
| `zones` | service zone | — | Scope a pull by area |
| `clients` | household account | `zone_id` | The people being pulled, scored and pushed |
| `properties` | serviced address | `client_id` | A client can have more than one home |
| `packages` | cleaning package (standard, deep, move-out) | — | What a visit delivers |
| `add_ons` | optional extra (oven, windows) | — | Lifetime-value variety |
| `plans` | recurring service plan on a property | `property_id`, `package_id` | Active vs lapsed: the win-back signal |
| `plan_price_changes` | price change on a plan | `plan_id` | A reason clients lapse |
| `crews` | cleaning crew | `zone_id` | Operations context |
| `crew_memberships` | person-in-crew period | `crew_id` | Time-bounded joins (grain test for SQLsmith) |
| `visits` | completed or cancelled visit | `property_id`, `plan_id`, `crew_id` | Recency and frequency |
| `invoices` | invoice | `client_id` | Spend |
| `invoice_lines` | line on an invoice | `invoice_id`, `package_id` or `add_on_id` | Totals must reconcile to the invoice |
| `payments` | payment against an invoice | `invoice_id` | Paid vs outstanding |
| `fixture_meta` | key/value | — | Generator version, seed, `as_of`, row counts, known truths |

## Validation (CAP-13)

- **Integrity:** every foreign key resolves; no orphans; invoice total equals the sum of its lines; payments never exceed their invoice; visit dates fall inside their plan's active period or are flagged cancelled.
- **Synthetic-only:** every email ends in `.invalid`; every phone matches 555-01xx.
- **Known truths:** a small set of figures stored in `fixture_meta` (for example monthly revenue for a named month, active plans at `as_of`, lapsed plans in the last 90 days per zone) and checked by query. These are what the onboarding proof (Orchestrator Story 4.3) and the demo assertions read.
