---
owner: Dana Reyes          # the named client person who owns this file
signed_off: pending  # pending, or the ISO date (YYYY-MM-DD) the owner signed off
signed_off_by: ""  # who signed off: the owner, recorded by a facilitator
updated: 2026-10-24        # ISO date of the last edit
---

# Data canon

Written by the Onboarder for SQLsmith. Everything here was said by the client's people, proved by
a check, and signed by the owner above. Anything not yet checked or signed is marked
`unverified` with the gap stated.

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

## Metric definitions

<!--
One rule card per metric (docs/reference/05-discovery-process.md §3), types metric_definition or derived_metric:

### RULE-ID: name
- rule: plain-language definition a non-technical person agrees with; the formula below it
- owner: client person who confirms it
- evidence: the source, session or document it came from, and its tests (min 2 worked examples)
- status: draft | challenged | approved | retired (approved only with the owner's sign-off and date)
-->

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
owner: Dana Reyes
signed_off: pending
```
-->

The figures below are Brightside fixture truths (Story 7.6). Each `expect` is the generator's planted target in `examples/brightside/fixture/targets.json`, never a number read back from the query, and each `run` executes its SQL through the query runner (`kit/fixture/query.js`). Build the fixture first: `npm run fixture:build`. Money is in cents. Dana Reyes signs them off in the onboarding proof (Orchestrator Story 4.3).

```truth
id: clients-total
statement: "Brightside has 2,000 clients at as_of (2026-09-30)."
run: [node, kit/fixture/query.js, --profile, profiles/brightside/profile.yml, examples/brightside/fixture/truths/clients-total.sql]
expect: 2000
tolerance: 0
owner: Dana Reyes
signed_off: pending
```

```truth
id: active-plans-at-as-of
statement: "815 plans are active at as_of: start_date <= as_of and (end_date IS NULL or end_date >= as_of). Not status = active, which gives 814 because one plan ends on as_of."
run: [node, kit/fixture/query.js, --profile, profiles/brightside/profile.yml, examples/brightside/fixture/truths/active-plans-at-as-of.sql]
expect: 815
tolerance: 0
owner: Dana Reyes
signed_off: pending
```

```truth
id: winback-north-90d
statement: "38 North-zone clients are win-back candidates: a plan lapsed in the last 90 days and no plan active at as_of."
run: [node, kit/fixture/query.js, --profile, profiles/brightside/profile.yml, examples/brightside/fixture/truths/winback-north-90d.sql]
expect: 38
tolerance: 0
owner: Dana Reyes
signed_off: pending
```

```truth
id: winback-north-90d-price-rise
statement: "17 of the North win-back candidates had a price rise in the 60 days before a lapse."
run: [node, kit/fixture/query.js, --profile, profiles/brightside/profile.yml, examples/brightside/fixture/truths/winback-north-90d-price-rise.sql]
expect: 17
tolerance: 0
owner: Dana Reyes
signed_off: pending
```

```truth
id: paid-revenue-2026-09
statement: "Paid revenue (payments by paid_on) for September 2026 is $350,186.40 (35,018,640 cents)."
run: [node, kit/fixture/query.js, --profile, profiles/brightside/profile.yml, examples/brightside/fixture/truths/paid-revenue-2026-09.sql]
expect: 35018640
tolerance: 0
owner: Dana Reyes
signed_off: pending
```

```truth
id: billed-revenue-2026-09
statement: "Billed revenue (invoice totals by issued_on) for September 2026 is $364,023.50 (36,402,350 cents)."
run: [node, kit/fixture/query.js, --profile, profiles/brightside/profile.yml, examples/brightside/fixture/truths/billed-revenue-2026-09.sql]
expect: 36402350
tolerance: 0
owner: Dana Reyes
signed_off: pending
```

```truth
id: outstanding-at-as-of
statement: "Outstanding at as_of (per invoice, total minus payments up to as_of, where positive) is $198,753.25 (19,875,325 cents)."
run: [node, kit/fixture/query.js, --profile, profiles/brightside/profile.yml, examples/brightside/fixture/truths/outstanding-at-as-of.sql]
expect: 19875325
tolerance: 0
owner: Dana Reyes
signed_off: pending
```
