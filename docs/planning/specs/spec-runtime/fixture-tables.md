# Brightside fixture: Tier-1 tables

Brightside Home Cleaning is a fictional multi-branch residential cleaner. The dataset exists to drive the runtime blocks and the demo flow; grow it only when a demo scenario needs a table (PLAN-v1 §3). Data definitions below were set by a SQLsmith pass (round 2): grain, keys, the date that defines each period, and the known truths each number reconciles against.

## Rules

- Synthetic only. Names are generated; emails end in `.invalid`; phones are 555-0100 to 555-0199.
- Deterministic. One generator version plus one seed gives byte-identical seed files (own seeded PRNG, no random source from the OS or clock).
- Money is integer cents. Dates are ISO `DATE` in Brightside's local business calendar (no time zone); the only timestamps are UTC and none drive a period filter.
- History runs 2024-10-01 to `as_of` = 2026-09-30, recorded in `fixture_meta`. Every "now" in a query is `as_of` from `fixture_meta`, never `CURRENT_DATE`, so known truths never drift.
- Sizes are Tier 1: about 2,000 clients. Committed seed files stay under 10 MB.
- Protected columns (Brightside's `sql.forbidden_columns`): `clients.phone`, `properties.street_address`, `properties.postal_code`. Email is allowed: the win-back push needs it. Queries name their columns; `SELECT *` is blocked while any column is forbidden.

## Tables

Story 7.1 generates the reference tables; Story 7.2 the time series, `fixture_meta` and the size budget.

| Table | Story | Grain (one row per) | Key columns |
|---|---|---|---|
| `zones` | 7.1 | service zone | `zone_id` PK (text, e.g. `north`), `name` |
| `packages` | 7.1 | cleaning package (standard, deep, move-out) | `package_id` PK, `name`, `base_price_cents` |
| `add_ons` | 7.1 | optional extra (oven, windows) | `add_on_id` PK, `name`, `price_cents` |
| `crews` | 7.1 | cleaning crew | `crew_id` PK, `zone_id` FK, `name` |
| `crew_memberships` | 7.1 | one staff member's period in one crew | `membership_id` PK, `crew_id` FK, `staff_name`, `start_date`, `end_date` (inclusive, NULL = current). A staff member's periods never overlap |
| `clients` | 7.1 | household account | `client_id` PK, `zone_id` FK (home zone), `first_name`, `last_name`, `email` (unique), `phone` (forbidden), `created_on` (client since) |
| `properties` | 7.1 | serviced address | `property_id` PK, `client_id` FK, `street_address` (forbidden), `city`, `postal_code` (forbidden). A property is in its client's zone |
| `plans` | 7.2 | recurring service plan on one property | `plan_id` PK, `property_id` FK, `package_id` FK, `frequency` (`weekly`, `biweekly`, `monthly`), `start_date`, `end_date` (last active day, inclusive; NULL while active), `status` (`active` iff `end_date` IS NULL, else `cancelled`), `start_price_cents`, `price_cents` (price on `end_date`, or at `as_of` if active) |
| `plan_price_changes` | 7.2 | one price change on one plan | `change_id` PK, `plan_id` FK, `effective_date`, `old_price_cents`, `new_price_cents`; unique (`plan_id`, `effective_date`) |
| `visits` | 7.2 | one scheduled visit | `visit_id` PK, `property_id` FK, `plan_id` FK (NULL = one-off), `crew_id` FK, `package_id` FK, `visit_date`, `status` (`completed`, `cancelled`) |
| `invoices` | 7.2 | one invoice per completed visit | `invoice_id` PK, `client_id` FK, `visit_id` FK (unique, not null), `issued_on`, `due_on`, `total_cents` |
| `invoice_lines` | 7.2 | one line on an invoice | `line_id` PK, `invoice_id` FK, exactly one of `package_id` / `add_on_id`, `quantity`, `amount_cents` |
| `payments` | 7.2 | one payment against one invoice (partial payments allowed) | `payment_id` PK, `invoice_id` FK, `paid_on`, `amount_cents`, `method` (`card`, `ach`) |
| `fixture_meta` | 7.2 | key/value | `key` PK, `value`: generator version, seed, `as_of`, row count per table |

## Definitions

- **Plan active at date d:** `start_date <= d AND (end_date IS NULL OR end_date >= d)`.
- **Plan lapsed in the last N days:** `status = 'cancelled' AND end_date > as_of - N days AND end_date <= as_of` (N = 90 for the demo: 90 dates, `as_of` included).
- **Win-back candidate in zone Z:** a client whose `zone_id = Z`, who has at least one plan lapsed in the last 90 days, and who has no plan active at `as_of` on any property. Result grain: one row per client; the client's lapse date is the latest `end_date` among those plans.
- **Price change before lapse:** the lapsed plan has a `plan_price_changes` row with `new_price_cents > old_price_cents` and `effective_date` between `end_date - 59 days` and `end_date` (the 60 days up to the lapse).
- **Paid revenue in month M:** `SUM(payments.amount_cents)` with `paid_on` in M (cash basis). **Billed revenue in M:** `SUM(invoices.total_cents)` with `issued_on` in M. Never sum payments across a join to `invoice_lines` (one-to-many: fans out).
- **Lifetime paid spend per client:** payments joined to invoices (invoice is unique per payment) up to `as_of`, summed by `invoices.client_id`.
- **Outstanding at `as_of`:** per invoice, `total_cents` minus payments with `paid_on <= as_of`, where positive.

## Validation (fixture checks, Story 7.6)

Each is a SQL file in `examples/brightside/fixture/checks/` that must return zero rows; `npm run fixture:validate` runs them through the query runner.

- **Integrity:** every foreign key resolves; no orphans; invoice total equals the sum of its lines; every invoice line has exactly one of `package_id` / `add_on_id` (added in #77); payments never exceed their invoice; one invoice per completed visit and none for cancelled visits; plan visits fall inside the plan's active period; `status` agrees with `end_date`; no `end_date` after `as_of`, and no `as_of` row fails (added in #77); no `issued_on`, `paid_on`, `visit_date` or `created_on` after `as_of` (added in #77); `price_cents` equals the latest change's new price (or `start_price_cents` with no change); every price change falls inside its plan's life and its `old_price_cents` is the previous change's `new_price_cents`, or `start_price_cents` for the first (added in #77); crew membership periods don't overlap per staff member.
- **Synthetic-only:** every email ends in `.invalid`; every phone matches 555-01xx.

## Known truths (Story 7.6, consumed by Orchestrator Story 4.3)

Known truths are `truth` blocks in `profiles/brightside/context/data.md`, run by `kit/lib/truths` through `npm run verify`. Each `run` command executes a SQL file in `examples/brightside/fixture/truths/` through the query runner and prints one number. The expected values are the generator's **planted targets** (a targets file the generator builds the data to hit), never a number pasted from running the query, so the check stays independent. All in cents or counts, tolerance 0.

| id | Statement | Feeds |
|---|---|---|
| `clients-total` | Number of clients at `as_of` | sanity |
| `active-plans-at-as-of` | Plans active at `as_of` | onboarding proof |
| `winback-north-90d` | Win-back candidates in the North zone | demo step 2–4 |
| `winback-north-90d-price-rise` | Of those, how many had a price change before lapse | scoring reason |
| `paid-revenue-2026-09` | Paid revenue for September 2026, in cents | onboarding proof |
| `billed-revenue-2026-09` | Billed revenue for September 2026, in cents | grain test (billed vs paid) |
| `outstanding-at-as-of` | Total outstanding at `as_of`, in cents | "Unpaid invoices" module |
