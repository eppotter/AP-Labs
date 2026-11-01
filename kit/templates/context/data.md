---
owner: ""          # the named client person who owns this file
signed_off: pending  # pending, or the ISO date (YYYY-MM-DD) the owner signed off
signed_off_by: ""  # who signed off: the owner, recorded by a facilitator
updated: ""        # ISO date of the last edit
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
owner: <the owner's name>
signed_off: pending
```
-->

## Query rules

SQLsmith's signed canon of reviewed queries: what Ask may run on a hub that sees data and rules.
Each rule is a fenced block with the info string `query-rule`, holding YAML. `npm run verify` (and
the end-of-turn hook) runs each as the check `query-rule:<id>` (`npm run query-rules -- --check
<id>`): it checks every table and column the SQL names (DuckDB's own parse) against the rule's
`reads` and the allow-list (the profile's `ask` block, `ask.tables`), checks it with Ask's own
query guard, runs the SQL with `check.params`, and passes when the figure equals the linked signed
truth's `expect` (or `check.expect`). A rule linked to a pending truth can't pass. Ask uses only
signed rules: `status: approved`, `signed_off` a date, `signed_off_by` a named client person, and
the last check passed. The AI's context never holds these blocks.

Start with `QR-000` (`kind: traps`, the traps every query must avoid) and one rule per signed
metric that has a known truth. New rules come from the questions Ask declined:
`npm run query-rules -- --queue`, then `--new QR-NNN --from <queue id>`.

<!--
Example (inside this comment it never runs; copy it out of the comment to use it):

```query-rule
id: QR-001
kind: metric
metric: MET-001
question_patterns:
  - "paid revenue in <month>"
definition: "Cash received in the month: payments by paid_on. Never billed revenue."
sql: |
  SELECT COALESCE(SUM(p.amount_cents), 0) AS paid_cents
  FROM payments p
  WHERE p.paid_on >= CAST($month_start AS DATE) AND p.paid_on < CAST($month_end AS DATE)
params:
  month_start: { type: date }
  month_end: { type: date }
grain: "one row, one number"
unit: cents
traps:
  - "never join payments to invoice lines"
reads:
  payments: [amount_cents, paid_on]
check:
  truth: revenue-2026-09
  params: { month_start: "2026-09-01", month_end: "2026-10-01" }
owner: <the owner's name>
status: draft
signed_off: pending
signed_off_by: pending
```
-->
