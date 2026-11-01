---
owner: Ely Potter          # the named client person who owns this file
signed_off: 2026-10-31  # pending, or the ISO date (YYYY-MM-DD) the owner signed off
signed_off_by: "Ely Potter (2026-10-31)"  # who signed off: the owner, recorded by a facilitator
updated: 2026-10-31        # ISO date of the last edit
---

# Data canon

Written by the Onboarder for SQLsmith. Everything here was said by the client's people, proved by
a check, and signed by the owner above. Anything not yet checked or signed is marked
`unverified` with the gap stated.

Until 2026-10-31 these files named a fictional owner, Dana Reyes, played by Ely; lines that say
"Ely as Dana Reyes" are kept as history. Ely Potter owns and signs them since 2026-10-31 (plan
brightside-v1, Story 18.1).

## Data model

<!-- The systems that hold data, and how the main entities relate. -->

## Approved sources

<!-- One entry per table or view a build may use: name, what it holds, its owner. -->

## Grain notes

<!-- For each approved source: one row per what? Note any duplicates, soft deletes or late-arriving rows. -->

## Join patterns

<!-- The approved join between each pair of sources: keys, whether the key is unique on each side, and fan-out risks. -->

## Terminology

<!-- Each business term mapped to its columns and filters, and what it explicitly excludes. -->

Status of every term below: **approved**, from the fixture's data definitions
(`docs/planning/specs/spec-runtime/fixture-tables.md`, "Definitions") and the truth queries in
`examples/brightside/fixture/truths/`. Confirmed by Dana Reyes (Ely as Dana Reyes, 2026-10-25).

- **as_of:** the "today" of every query: `fixture_meta.value` where `key = 'as_of'` (2026-09-30).
  Never `CURRENT_DATE`, so a number does not drift from one day to the next.
- **Money:** every amount is integer cents (`*_cents`). $1.00 is 100. Divide by 100 only for display.
- **Client:** one household account (`clients`, one row per client). A client's zone is its home
  zone, `clients.zone_id`; every property sits in its client's zone.
- **Plan active at a date d:** `start_date <= d AND (end_date IS NULL OR end_date >= d)`.
  `end_date` is the plan's last active day, inclusive.
  NOT `status = 'active'`. `status` is `active` only while `end_date IS NULL`, so a plan whose last
  day is as_of is active at as_of but already shows `cancelled`. The data has one such plan:
  815 plans are active at as_of, while `status = 'active'` gives 814 (truth
  `active-plans-at-as-of`).
- **Lapsed in the last N days:** a plan with `status = 'cancelled'` and
  `as_of - N days < end_date <= as_of`. For the demo N is 90: 90 dates, as_of included.
  A lapse is a plan ending, not a client leaving: a client can lapse on one plan and still have
  another one active.
- **Win-back candidate (in zone Z):** a client with `zone_id = Z`, at least one plan lapsed in the
  last 90 days, and no plan active at as_of on any of their properties. One row per client. The
  client's lapse date is the latest `end_date` among those lapsed plans.
  NOT every client with a cancelled plan: a client with any active plan is excluded, and so is a
  client whose last plan ended more than 90 days ago.
- **Price rise before lapse:** the lapsed plan has a `plan_price_changes` row with
  `new_price_cents > old_price_cents` and `effective_date` from `end_date - 59 days` to `end_date`
  (the 60 days up to the lapse). A price cut does not count.
- **Completed visit:** `visits.status = 'completed'`. Only completed visits are invoiced (one
  invoice each) and only they have timesheets. A **one-off visit** has `plan_id IS NULL`.
- **Billed vs paid:** billed means invoiced (`invoices.total_cents`, dated by `issued_on`). Paid
  means cash received (`payments.amount_cents`, dated by `paid_on`). They are different numbers for
  the same month and must never be swapped.
- **Outstanding:** what clients still owe at as_of, per invoice (see the metric below).
- **Labour minutes:** minutes a staff member was clocked in on a completed visit
  (`timesheets.minutes`, one row per staff member per visit). A three-person crew on a two-hour
  job gives about 360 labour minutes. NOT the visit's planned time on site
  (`visits.scheduled_minutes`) and NOT travel (`visits.travel_minutes_from_previous`).
- **Pay rate on a day d:** the one `pay_rates` row for the staff member with
  `start_date <= d AND (end_date IS NULL OR end_date >= d)`. NOT `staff.hourly_rate_cents`, which is
  only the latest rate and would price past work at today's pay.
- **Crew-day:** one crew on one date (`crew_id`, `visit_date`). Its worked span runs from the first
  `clock_in` to the last `clock_out`.
- **Protected fields:** `clients.phone`, `properties.street_address` and `properties.postal_code`
  are forbidden columns (profile `sql.forbidden_columns`): no query may name them, and `SELECT *`
  is refused. Email is allowed (the win-back push needs it). `properties.access_method` says how
  the crew gets in, never a code.

## Metric definitions

<!--
One rule card per metric (docs/reference/05-discovery-process.md §3), types metric_definition or derived_metric:

### RULE-ID: name
- rule: plain-language definition a non-technical person agrees with; the formula below it
- owner: client person who confirms it
- evidence: the source, session or document it came from, and its tests (min 2 worked examples)
- status: draft | challenged | approved | retired (approved only with the owner's sign-off and date)
-->

Every card below is **approved**: the definition comes from the fixture's data definitions, and
Ely Potter signed it off on 2026-10-31 (first signed on 2026-10-25, Ely as Dana Reyes). The worked examples are made-up records that
show where the rule bites, not rows from the data.

### MET-001: Plans active at as_of
- type: metric_definition
- rule: the number of plans that are running on as_of. A plan that ends on as_of still counts.
  Formula: `COUNT(plan_id)` from `plans` where `start_date <= as_of AND (end_date IS NULL OR end_date >= as_of)`.
- audience: anyone who may use the Dataset entry; not sensitive on its own. Confirmed by Dana Reyes
  (Ely as Dana Reyes, 2026-10-25).
- exclusions: not `status = 'active'`; not plans that start after as_of.
- owner: Ely Potter
- evidence: `fixture-tables.md` "Plan active at date d"; truth `active-plans-at-as-of` (expect 815,
  planted target). Tests: (1) a plan with `end_date` = 2026-09-30 counts, though its status is
  `cancelled`; (2) a plan with `end_date` = 2026-09-29 does not count.
- status: approved

### MET-002: Win-back candidates
- type: classification
- rule: clients worth asking back: a plan of theirs lapsed in the last 90 days and they have no
  plan running at as_of. One row per client. Formula: see "Win-back candidate" in Terminology.
- edge_cases: a client whose plan ends on as_of is still active at as_of, so is not a candidate;
  a client with two properties, one plan lapsed and one active, is not a candidate.
- audience: whoever runs the win-back push (Epic 10). The list holds names and emails, so not open
  to everyone. Confirmed by Dana Reyes (Ely as Dana Reyes, 2026-10-25).
- owner: Ely Potter
- evidence: `fixture-tables.md` "Win-back candidate"; truths `winback-north-90d` (38) and
  `winback-north-90d-price-rise` (17), planted targets. Tests: (1) a North client whose only plan
  ended 2026-08-15 is a candidate; (2) a North client whose plan ended 2026-06-01 (more than 90
  days before as_of) is not.
- status: approved

### MET-003: Paid revenue for a month
- type: metric_definition
- rule: cash received in the month. Formula: `SUM(payments.amount_cents)` where `paid_on` is in the
  month. Payments only: never summed across a join to `invoice_lines` (one invoice has many
  lines, so the sum would multiply).
- audience: owner and admin only. Answered by Dana Reyes (Ely as Dana Reyes, 2026-10-25).
- exclusions: not billed revenue; not invoices issued in the month but paid later.
- owner: Ely Potter
- evidence: `fixture-tables.md` "Paid revenue in month M"; truth `paid-revenue-2026-09`
  (35,018,640 cents). Tests: (1) a $140.00 invoice issued 2026-08-30 and paid 2026-09-02 counts in
  September; (2) a $140.00 invoice issued 2026-09-29 and not yet paid adds nothing to September.
- status: approved

### MET-004: Billed revenue for a month
- type: metric_definition
- rule: what was invoiced in the month. Formula: `SUM(invoices.total_cents)` where `issued_on` is in
  the month. One invoice per completed visit.
- audience: owner and admin only, as MET-003. Answered by Dana Reyes (Ely as Dana Reyes,
  2026-10-25).
- exclusions: not cash received; not cancelled visits (they have no invoice).
- owner: Ely Potter
- evidence: `fixture-tables.md` "Billed revenue in M"; truth `billed-revenue-2026-09`
  (36,402,350 cents). Tests: the same two invoices as MET-003 give the opposite answers: the
  2026-08-30 invoice counts in August, the 2026-09-29 invoice counts in September.
- status: approved

### MET-005: Outstanding at as_of
- type: metric_definition
- rule: what clients still owe at as_of. Per invoice: the invoice total minus its payments made on
  or before as_of, counted only when that is above zero; then summed. Payments are summed per
  invoice first, so nothing multiplies.
- audience: the "Unpaid invoices" entry (Story 9.5, resource `UNPAID_INVOICES`, not in the profile
  yet). Confirmed by Dana Reyes (Ely as Dana Reyes, 2026-10-25).
- exclusions: not "overdue" (`due_on` plays no part); an overpaid invoice does not reduce the total.
- invoices issued after as_of: moot. The fixture check `integrity-no-date-after-as-of` guarantees
  none exist. Answered by Dana Reyes (Ely as Dana Reyes, 2026-10-25).
- owner: Ely Potter
- evidence: `fixture-tables.md` "Outstanding at as_of"; truth `outstanding-at-as-of`
  (19,875,325 cents). Tests: (1) a $260.00 invoice with $100.00 paid adds $160.00; (2) a fully paid
  invoice adds $0.
- status: approved

### MET-006: Labour minutes over a date range
- type: metric_definition
- rule: total minutes staff were clocked in on visits in the range. Formula:
  `SUM(timesheets.minutes)` joined to `visits` on `visit_id`, where `visits.visit_date` is in the
  range. Every timesheet belongs to a completed visit.
- audience: owner and admin only, with Labour cost (GRD-006 in guardrails.md). Confirmed by Dana
  Reyes (Ely as Dana Reyes, 2026-10-25).
- exclusions: not scheduled minutes, not travel minutes, not cancelled visits.
- owner: Ely Potter
- evidence: `fixture-tables.md` (timesheets grain). Tests: (1) a completed visit with three
  timesheets of 120, 118 and 121 minutes adds 359; (2) a cancelled visit adds 0.
- status: approved. **unverified:** no known truth yet. A `labour-minutes-2026-09` truth needs a
  planted generator target first (follow-up story).

### MET-007: Labour cost over a date range
- type: derived_metric
- rule: what the staff time on visits in the range cost in pay. Formula: for each timesheet whose
  visit's `visit_date` is in the range, `timesheets.minutes × pay_rates.hourly_rate_cents`, with the
  pay rate on the visit date (Terminology); summed, then divided by 60, in cents.
- time: dated by `visits.visit_date` in the business calendar; the rate is the one on that date.
- audience: owner and admin only (resource `LABOUR_COST`, Story 9.7, not in the profile yet).
  Totals only: never one person's rate or name. Ely's decision on the Epic 9 plan (2026-10-25).
  Confirmed by Dana Reyes (Ely as Dana Reyes, 2026-10-25).
- exclusions: not `staff.hourly_rate_cents`; not payroll taxes, benefits or travel time.
- failure_modes: joining on `staff.hourly_rate_cents` silently prices history at today's rate (too
  high after raises); a rate join without the date window double-counts a staff member who had a
  raise. Detected by a planted truth (not yet built).
- rounding: once, at the end. Sum the exact minutes × cents products, divide by 60 and round only
  the final figure, never per timesheet. Answered by Dana Reyes (Ely as Dana Reyes, 2026-10-25).
- owner: Ely Potter
- evidence: `fixture-tables.md` "Labour cost of a visit"; Epic 9 plan Story 9.7. Tests: (1) one
  60-minute timesheet at 2,000 cents an hour costs 2,000 cents; (2) a staff member raised from
  2,000 to 2,075 cents on 2026-09-15 is priced at 2,000 for a 2026-09-14 visit and 2,075 for a
  2026-09-15 visit.
- status: approved. **unverified:** no known truth yet. A `labour-cost-2026-09` truth needs a planted
  generator target first (follow-up story).

## Deprecated sources

<!-- Each source a build must not use, why, and what replaces it. -->

## Known truths

Each known truth is a fenced block with the info string `truth`, holding YAML. `npm run verify`
(and the end-of-turn hook) runs its `run` command as the check `truth:<id>`: the command must
print one number as its last line (commas allowed), and the check passes when that number is
within `tolerance` of `expect`. A truth with a validation problem, no owner or a pending sign-off
is flagged at session start and is `unverified`: SQLsmith must not rely on it.

- `id`: a slug, unique in this file
- `statement`: the fact, in plain language
- `run`: the command as an argv list, run without a shell from the repo root
- `expect`: the number the client's own source shows
- `tolerance`: an absolute number or a percent such as `"0.5%"` (default 0)
- `owner`: the client person who owns the number
- `signed_off`: the date the owner confirmed it (YYYY-MM-DD), or `pending`
- `timeout_seconds`: optional, default 300

<!--
Example (inside this comment it never runs; copy it out of the comment to use it):

```truth
id: revenue-2026-09
statement: Total paid revenue for September 2026 is $412,300, matching the finance report.
run: [node, scripts/truths/revenue.js, "2026-09"]
expect: 412300
tolerance: 0.5%
owner: Ely Potter
signed_off: pending
```
-->

The figures below are Brightside fixture truths (Story 7.6). Each `expect` is the generator's planted target in `examples/brightside/fixture/targets.json`, never a number read back from the query, and each `run` executes its SQL through the query runner (`kit/fixture/query.js`). Build the fixture first: `npm run fixture:build`. Money is in cents. They were signed off in the onboarding proof (Orchestrator Story 4.3, 2026-10-25, Ely as Dana Reyes); their owner is Ely Potter since 2026-10-31.

```truth
id: clients-total
statement: "Brightside has 2,000 clients at as_of (2026-09-30)."
run: [node, kit/fixture/query.js, examples/brightside/fixture/truths/clients-total.sql]
expect: 2000
tolerance: 0
owner: Ely Potter
signed_off: 2026-10-25
```

```truth
id: active-plans-at-as-of
statement: "815 plans are active at as_of: start_date <= as_of and (end_date IS NULL or end_date >= as_of). Not status = active, which gives 814 because one plan ends on as_of."
run: [node, kit/fixture/query.js, examples/brightside/fixture/truths/active-plans-at-as-of.sql]
expect: 815
tolerance: 0
owner: Ely Potter
signed_off: 2026-10-25
```

```truth
id: winback-north-90d
statement: "38 North-zone clients are win-back candidates: a plan lapsed in the last 90 days and no plan active at as_of."
run: [node, kit/fixture/query.js, examples/brightside/fixture/truths/winback-north-90d.sql]
expect: 38
tolerance: 0
owner: Ely Potter
signed_off: 2026-10-25
```

```truth
id: winback-north-90d-price-rise
statement: "17 of the North win-back candidates had a price rise in the 60 days before a lapse."
run: [node, kit/fixture/query.js, examples/brightside/fixture/truths/winback-north-90d-price-rise.sql]
expect: 17
tolerance: 0
owner: Ely Potter
signed_off: 2026-10-25
```

```truth
id: paid-revenue-2026-09
statement: "Paid revenue (payments by paid_on) for September 2026 is $350,186.40 (35,018,640 cents)."
run: [node, kit/fixture/query.js, examples/brightside/fixture/truths/paid-revenue-2026-09.sql]
expect: 35018640
tolerance: 0
owner: Ely Potter
signed_off: 2026-10-25
```

```truth
id: billed-revenue-2026-09
statement: "Billed revenue (invoice totals by issued_on) for September 2026 is $364,023.50 (36,402,350 cents)."
run: [node, kit/fixture/query.js, examples/brightside/fixture/truths/billed-revenue-2026-09.sql]
expect: 36402350
tolerance: 0
owner: Ely Potter
signed_off: 2026-10-25
```

```truth
id: outstanding-at-as-of
statement: "Outstanding at as_of (per invoice, total minus payments up to as_of, where positive) is $198,753.25 (19,875,325 cents)."
run: [node, kit/fixture/query.js, examples/brightside/fixture/truths/outstanding-at-as-of.sql]
expect: 19875325
tolerance: 0
owner: Ely Potter
signed_off: 2026-10-25
```

The routing truths below (Story 14.4, data-design §5) check the planted routing scenarios. Each
`expect` is the generator's planted answer in `targets.json` `routing`. The first runs its SQL
through the query runner; the other four run the scenario through Brightside's routing adapter
and the routing engine (`examples/brightside/fixture/truths/routing.js`), reading drive times only
through `travelMatrix`, which returns whole minutes and never a coordinate (GRD-002). "as_of+n"
is n days after as_of. They are not signed off yet: until Ely Potter confirms them they are
`unverified` and SQLsmith must not rely on them (plan brightside-v1, gate item 6).

Every property and crew base sits at a random synthetic point in the Columbus, Ohio area
(generator v5, Story 15.7): none is or comes from a real address. Since generator v6 none sits on
the area's big water either (the reservoirs and the Scioto and Olentangy, from rough hand-drawn
outlines with a margin, not map data). A drive time is the straight-line
(haversine) distance × the profile's detour factor ÷ its speed, rounded up to a whole minute and
never below its minimum: an estimate, not road time. Moving the points from the open ocean (v4)
to Columbus changed some booked drive times and start times; the five figures below were worked
out again from `travelMatrix` for v5 and came out as v4's. Moving them off water (v6) changed
S1's booked drive from 139 to 140 minutes; the other four came out as v5's.

The `depots` table (generator v7, Story 15.15) holds one row, the Office: where every crew starts
and ends in Plan a route. It is the one point that is not random (a point Ely chose in Westerville,
rounded to 0.002°, GRD-007), its two coordinate columns are forbidden like the others (GRD-002), and
it is only ever called "Office". Routing's four views and the five routing truths still start from
each crew's base, so v7 changed no other table and no truth.

Every booked crew-day fits a normal day (generator v8): starting at 08:00 from the crew's base,
its drives plus service minutes end by 18:00 (the drive home not counted; cancelled stops keep
their slot). Before v8 each plan's visits stayed on its own crew with no limit, so 44 of 410
crew-days ran past 18:00 (crew 1 on 2026-10-03 to 23:47). v8 gives a full day's extra stops to
another crew of its zone that day, else moves them to the nearest later day (earlier only near the
horizon's end) at most half a cadence away. No visit is dropped. This changed S1's stops (two
short stops joined, two long ones left) and its booked drive from 140 to 134 minutes, and dropped
31 preferred-crew rules whose visits now sit on two crews; the other four figures stayed.

```truth
id: scheduled-stops-next-14d
statement: "825 stops are booked (status scheduled, not cancelled) from the day after as_of through as_of + 14, the 14th day included."
run: [node, kit/fixture/query.js, examples/brightside/fixture/truths/scheduled-stops-next-14d.sql]
expect: 825
tolerance: 0
owner: Ely Potter
signed_off: pending
```

```truth
id: route-optimize-s1-drive
statement: "S1, crew 4 on as_of+1 (seven stops booked back and forth between cities): the booked day drives 134 minutes. The check fails unless the suggested day drives no longer, and neither day breaks a hard rule or leaves a stop unplaced."
run: [node, examples/brightside/fixture/truths/routing.js, route-optimize-s1-drive]
expect: 134
tolerance: 0
owner: Ely Potter
signed_off: pending
```

```truth
id: route-change-s2-top
statement: "S2, the afternoon stop crew 2 lost on as_of+2 to a cancellation: the top-ranked fill is property 762 (same city, next visit 3 days later)."
run: [node, examples/brightside/fixture/truths/routing.js, route-change-s2-top]
expect: 762
tolerance: 0
owner: Ely Potter
signed_off: pending
```

```truth
id: route-change-s2-count
statement: "S2: exactly 2 candidates can fill the gap. The closer morning-only decoy and the decoy visited too recently for its cadence are both left out."
run: [node, examples/brightside/fixture/truths/routing.js, route-change-s2-count]
expect: 2
tolerance: 0
owner: Ely Potter
signed_off: pending
```

```truth
id: route-change-s3-crosszone
statement: "S3, crew 7 out on as_of+3 (its lead and a cleaner absent): of its 6 stops, 5 move to crews in its zone, 1 is recommended to a crew in another zone (a recommendation, not placed), and 0 are left unplaced. Printed as one number, 100 x in-zone + 10 x cross-zone + unplaced: 510."
run: [node, examples/brightside/fixture/truths/routing.js, route-change-s3-crosszone]
expect: 510
tolerance: 0
owner: Ely Potter
signed_off: pending
```

## Query rules

SQLsmith's signed canon of reviewed queries (plan brightside-v1, D11, Story 19.6). Each rule is a
fenced block with the info string `query-rule`, holding YAML. Ask uses only **signed** rules
(Stories 19.7 and 19.8): `status: approved`, `signed_off` a date, `signed_off_by` named, and its
last `npm run verify` check passed. The context prompt never holds these blocks
(`kit/runtime/llm/context.js` strips them, as it strips truths).

`npm run verify` (and the end-of-turn hook) runs each rule as the check `query-rule:<id>`
(`npm run query-rules -- --check <id>`): it checks the rule's fields, checks that every table and
column its SQL names (DuckDB's own parse) is in the rule's `reads` and that `reads` is inside the
allow-list (`ask-tables.yml` beside this file, until Story 19.7 moves it into the profile's `ask`
block), runs the SQL with `check.params` through the query runner, and passes when the figure
equals the linked signed truth's `expect` within its tolerance (or `check.expect`). A rule linked
to a pending truth can't pass.

- `id`: QR-NNN. `kind`: `metric`, or `traps` (QR-000 only holds the traps every query avoids).
- `metric`: the signed MET rule or Terminology term it restates. `question_patterns`: what it
  answers. `definition`: what the number means. `grain` and `unit` (`cents`, `count` or `number`).
- `sql`: the reviewed, read-only SQL. Parameters are `$name`, each declared in `params` with a type
  (`date`, `integer`, `zone`, or `enum` with `values`).
- `reads`: every table and column the SQL reads. `traps`: the traps it avoids.
- `check`: `truth` (a signed known truth above) or `expect` (a stated figure), with `params`. By
  default one row and one number; `sum: <column>` adds a column over the rows and `rows: N` requires
  N rows.
- `owner`, `status` (`draft`, `approved`, `retired`), `signed_off` (`pending` or the date),
  `signed_off_by` (`pending` or who signed). In a fork the signer is a named client person.

New rules come from the review queue (the questions Ask declined): `npm run query-rules -- --queue`,
then `--new QR-NNN --from <queue id>` drafts one here for SQLsmith, the Verifier pastes its
`query-rule:QR-NNN` result in the PR, Ely Potter or Steven Auslander signs it in the PR, and
`--done <queue id>` clears the question. `npm run query-rules -- --status` lists every rule, its
sign-off and its last check.

The seven rules below restate the signed MET rules and Terminology above. Drafted by SQLsmith,
each is checked against a signed truth. They were signed by the plan's gate approval (Ely Potter,
`approve plan brightside-v1`, 2026-10-31, gate item 8).

```query-rule
id: QR-000
kind: traps
traps:
  - "visits holds history up to as_of; scheduled_visits holds the dates after as_of."
  - "Count completed visits only (visits.status = 'completed') unless the question says otherwise."
  - "Count clients with COUNT(DISTINCT client_id)."
  - "Never join payments to invoice_lines: one invoice has many lines, so the sum multiplies."
  - "For outstanding, sum payments per invoice first, then compare with the invoice total."
  - "Today is fixture_meta's as_of (key = 'as_of'), never the clock (CURRENT_DATE, now())."
owner: Ely Potter
status: approved
signed_off: 2026-10-31
signed_off_by: "Ely Potter"
```

```query-rule
id: QR-001
kind: metric
metric: MET-001
question_patterns:
  - "how many plans are active today"
  - "active plans at as_of"
  - "how many plans are running"
definition: "Plans running on as_of: start_date on or before as_of and no end_date, or an end_date on or after it. A plan that ends on as_of still counts. Not status = 'active', which gives 814 because one plan ends on as_of."
sql: |
  WITH meta AS (
    SELECT CAST(m.value AS DATE) AS as_of FROM fixture_meta m WHERE m.key = 'as_of'
  )
  SELECT COUNT(pl.plan_id) AS active_plans
  FROM plans pl, meta
  WHERE pl.start_date <= meta.as_of
    AND (pl.end_date IS NULL OR pl.end_date >= meta.as_of)
params: {}
grain: "one row, one number: a count of plans"
unit: count
traps:
  - "not status = 'active'"
  - "today is fixture_meta's as_of"
reads:
  fixture_meta: [key, value]
  plans: [plan_id, start_date, end_date]
check:
  truth: active-plans-at-as-of
  params: {}
owner: Ely Potter
status: approved
signed_off: 2026-10-31
signed_off_by: "Ely Potter"
```

```query-rule
id: QR-002
kind: metric
metric: "Client (Terminology)"
question_patterns:
  - "how many clients do we have"
  - "total clients"
definition: "Clients at as_of: every client account created on or before as_of. One row per client in clients, so no DISTINCT is needed."
sql: |
  WITH meta AS (
    SELECT CAST(m.value AS DATE) AS as_of FROM fixture_meta m WHERE m.key = 'as_of'
  )
  SELECT COUNT(c.client_id) AS clients
  FROM clients c, meta
  WHERE c.created_on <= meta.as_of
params: {}
grain: "one row, one number: a count of clients"
unit: count
traps:
  - "today is fixture_meta's as_of"
reads:
  fixture_meta: [key, value]
  clients: [client_id, created_on]
check:
  truth: clients-total
  params: {}
owner: Ely Potter
status: approved
signed_off: 2026-10-31
signed_off_by: "Ely Potter"
```

```query-rule
id: QR-003
kind: metric
metric: MET-003
question_patterns:
  - "paid revenue in <month>"
  - "cash received in <month>"
  - "how much did we collect in <month>"
definition: "Cash received in the month: payments by paid_on, from the first day of the month up to but not including the first day of the next. Never billed revenue."
sql: |
  SELECT COALESCE(SUM(p.amount_cents), 0) AS paid_cents
  FROM payments p
  WHERE p.paid_on >= CAST($month_start AS DATE)
    AND p.paid_on < CAST($month_end AS DATE)
params:
  month_start: { type: date }
  month_end: { type: date }
grain: "one row, one number: cents"
unit: cents
traps:
  - "never join payments to invoice_lines"
  - "not billed revenue (invoices by issued_on)"
reads:
  payments: [amount_cents, paid_on]
check:
  truth: paid-revenue-2026-09
  params: { month_start: "2026-09-01", month_end: "2026-10-01" }
owner: Ely Potter
status: approved
signed_off: 2026-10-31
signed_off_by: "Ely Potter"
```

```query-rule
id: QR-004
kind: metric
metric: MET-004
question_patterns:
  - "billed revenue in <month>"
  - "how much did we invoice in <month>"
definition: "What was invoiced in the month: invoice totals by issued_on, from the first day of the month up to but not including the first day of the next. One invoice per completed visit. Never cash received."
sql: |
  SELECT COALESCE(SUM(i.total_cents), 0) AS billed_cents
  FROM invoices i
  WHERE i.issued_on >= CAST($month_start AS DATE)
    AND i.issued_on < CAST($month_end AS DATE)
params:
  month_start: { type: date }
  month_end: { type: date }
grain: "one row, one number: cents"
unit: cents
traps:
  - "not paid revenue (payments by paid_on)"
  - "invoices.total_cents, never a sum over invoice_lines joined to payments"
reads:
  invoices: [total_cents, issued_on]
check:
  truth: billed-revenue-2026-09
  params: { month_start: "2026-09-01", month_end: "2026-10-01" }
owner: Ely Potter
status: approved
signed_off: 2026-10-31
signed_off_by: "Ely Potter"
```

```query-rule
id: QR-005
kind: metric
metric: MET-005
question_patterns:
  - "what do clients owe us right now"
  - "outstanding balance at as_of"
  - "how much is unpaid"
definition: "What clients still owe at as_of. Per invoice: the total minus its payments made on or before as_of, counted only when above zero; then summed. Payments are summed per invoice first. Not overdue: due_on plays no part."
sql: |
  WITH meta AS (
    SELECT CAST(m.value AS DATE) AS as_of FROM fixture_meta m WHERE m.key = 'as_of'
  ),
  paid AS (
    SELECT y.invoice_id, SUM(y.amount_cents) AS paid_cents
    FROM payments y, meta
    WHERE y.paid_on <= meta.as_of
    GROUP BY y.invoice_id
  )
  SELECT COALESCE(SUM(GREATEST(i.total_cents - COALESCE(paid.paid_cents, 0), 0)), 0) AS outstanding_cents
  FROM invoices i
  LEFT JOIN paid ON paid.invoice_id = i.invoice_id
params: {}
grain: "one row, one number: cents"
unit: cents
traps:
  - "sum payments per invoice first"
  - "an overpaid invoice does not reduce the total"
  - "today is fixture_meta's as_of"
reads:
  fixture_meta: [key, value]
  payments: [invoice_id, amount_cents, paid_on]
  invoices: [invoice_id, total_cents]
check:
  truth: outstanding-at-as-of
  params: {}
owner: Ely Potter
status: approved
signed_off: 2026-10-31
signed_off_by: "Ely Potter"
```

```query-rule
id: QR-006
kind: metric
metric: MET-001
question_patterns:
  - "active plans by zone"
  - "how many plans are active today, by zone"
definition: "Plans active at as_of (MET-001), by the zone of the plan's client: plans to properties on property_id, properties to clients on client_id, clients.zone_id to zones. Each join is to a unique key, so nothing multiplies; the zones' counts sum to QR-001's figure."
sql: |
  WITH meta AS (
    SELECT CAST(m.value AS DATE) AS as_of FROM fixture_meta m WHERE m.key = 'as_of'
  )
  SELECT z.zone_id, z.name AS zone, COUNT(pl.plan_id) AS active_plans
  FROM plans pl
  JOIN properties p ON p.property_id = pl.property_id
  JOIN clients c ON c.client_id = p.client_id
  JOIN zones z ON z.zone_id = c.zone_id
  CROSS JOIN meta
  WHERE pl.start_date <= meta.as_of
    AND (pl.end_date IS NULL OR pl.end_date >= meta.as_of)
  GROUP BY z.zone_id, z.name
  ORDER BY z.zone_id
params: {}
grain: "one row per zone: the zone and its count of active plans"
unit: count
traps:
  - "not status = 'active'"
  - "a client's zone is clients.zone_id; properties has no zone"
  - "today is fixture_meta's as_of"
reads:
  fixture_meta: [key, value]
  plans: [plan_id, property_id, start_date, end_date]
  properties: [property_id, client_id]
  clients: [client_id, zone_id]
  zones: [zone_id, name]
check:
  truth: active-plans-at-as-of
  params: {}
  rows: 5
  sum: active_plans
owner: Ely Potter
status: approved
signed_off: 2026-10-31
signed_off_by: "Ely Potter"
```
