---
owner: Ada Admin
signed_off: 2026-10-20
signed_off_by: Ada Admin
updated: 2026-10-20
---

# Data canon

DATA_PROSE_NEVER_IN_QUERY.

## Terminology

Status of every term below: approved. FIGURE_PROSE_NEVER_IN_QUERY.

- **as_of:** the "today" of every query: `fixture_meta.value` where `key = 'as_of'`.
  Never `CURRENT_DATE`.
- **Money:** every amount is integer cents. The data has 45456 cents paid in September.
- **Paid:** cash received (`payments.amount_cents`, dated by `paid_on`).

## Metric definitions

### MET-003: Paid revenue for a month
- type: metric_definition
- rule: cash received in the month. Formula: `SUM(payments.amount_cents)` by `paid_on`.
- owner: Ada Admin
- evidence: truth `paid-revenue-2026-09` (45456 cents). EVIDENCE_NEVER_IN_QUERY.
- status: approved

### MET-009: A draft metric
- rule: DRAFT_METRIC_NEVER_IN_QUERY.
- status: draft

## Known truths

```truth
id: paid-revenue-2026-09
statement: Paid revenue in September 2026.
run: ["node", "-e", "console.log(45456)"]
expect: 45456
owner: Ada Admin
signed_off: 2026-10-20
```

```truth
id: billed-pending
statement: A truth not signed off yet.
run: ["node", "-e", "console.log(98765)"]
expect: 98765
owner: Ada Admin
signed_off: pending
```

## Query rules

```query-rule
id: QR-000
kind: traps
traps:
  - "Never join payments to anything that has many rows per invoice."
  - "Today is fixture_meta's as_of, never the clock."
owner: Ada Admin
status: approved
signed_off: 2026-10-20
signed_off_by: "Ada Admin"
```

```query-rule
id: QR-003
kind: metric
metric: MET-003
question_patterns:
  - "paid revenue in <month>"
definition: "Cash received in the month, by paid_on. The September figure is 45456."
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
reads:
  payments: [amount_cents, paid_on]
check:
  truth: paid-revenue-2026-09
  params: { month_start: "2026-09-01", month_end: "2026-10-01" }
owner: Ada Admin
status: approved
signed_off: 2026-10-20
signed_off_by: "Ada Admin"
```

```query-rule
id: QR-006
kind: metric
metric: MET-003
question_patterns:
  - "paid revenue by zone in <month>"
definition: "Cash received in the month, by the zone of the invoice's client."
sql: |
  SELECT z.zone_id, z.name AS zone, COALESCE(SUM(p.amount_cents), 0) AS paid_cents
  FROM payments p
  JOIN invoices i ON i.invoice_id = p.invoice_id
  JOIN clients c ON c.client_id = i.client_id
  JOIN zones z ON z.zone_id = c.zone_id
  WHERE p.paid_on >= CAST($month_start AS DATE)
    AND p.paid_on < CAST($month_end AS DATE)
  GROUP BY z.zone_id, z.name
  ORDER BY z.zone_id
params:
  month_start: { type: date }
  month_end: { type: date }
grain: "one row per zone"
unit: cents
reads:
  payments: [amount_cents, paid_on, invoice_id]
  invoices: [invoice_id, client_id]
  clients: [client_id, zone_id]
  zones: [zone_id, name]
check:
  expect: 45456
  rows: 2
  sum: paid_cents
  params: { month_start: "2026-09-01", month_end: "2026-10-01" }
owner: Ada Admin
status: approved
signed_off: 2026-10-20
signed_off_by: "Ada Admin"
```

```query-rule
id: QR-007
kind: metric
metric: MET-003
question_patterns:
  - "paid revenue in <zone> in <month>"
definition: "Cash received in the month from one zone's clients."
sql: |
  SELECT COALESCE(SUM(p.amount_cents), 0) AS paid_cents
  FROM payments p
  JOIN invoices i ON i.invoice_id = p.invoice_id
  JOIN clients c ON c.client_id = i.client_id
  WHERE c.zone_id = $zone
    AND p.paid_on >= CAST($month_start AS DATE)
    AND p.paid_on < CAST($month_end AS DATE)
params:
  zone: { type: zone }
  month_start: { type: date }
  month_end: { type: date }
grain: "one row, one number: cents"
unit: cents
reads:
  payments: [amount_cents, paid_on, invoice_id]
  invoices: [invoice_id, client_id]
  clients: [client_id, zone_id]
check:
  expect: 35456
  params: { zone: north, month_start: "2026-09-01", month_end: "2026-10-01" }
owner: Ada Admin
status: approved
signed_off: 2026-10-20
signed_off_by: "Ada Admin"
```

```query-rule
id: QR-008
kind: metric
metric: MET-003
question_patterns:
  - "DRAFT_RULE_NEVER_IN_QUERY"
definition: "A draft rule Ask never sees."
sql: |
  SELECT COUNT(i.invoice_id) AS invoices FROM invoices i
params: {}
grain: "one row, one number"
unit: count
reads:
  invoices: [invoice_id]
check:
  expect: 4
  params: {}
owner: Ada Admin
status: draft
signed_off: pending
signed_off_by: pending
```
