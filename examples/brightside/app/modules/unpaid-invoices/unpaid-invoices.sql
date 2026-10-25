-- Unpaid invoices: every invoice with money still owed at the data's as-of
-- date, in zone $zone ('all' for every zone), and when $min_days_past_due is
-- given only those at least that many days past their due date. Oldest due
-- date first. Definition: "Outstanding at as_of" in fixture-tables.md (the
-- outstanding-at-as-of truth): per invoice, total_cents minus its payments
-- with paid_on <= as_of, kept only where positive. Payments are summed per
-- invoice first, so nothing fans out. Amounts are in dollars.
-- Columns: only what chasing an invoice needs (the client's name and zone,
-- never their email, phone or address).
-- A fixed template: only the declared parameters bind, never pasted text.
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
),
paid AS (
  SELECT y.invoice_id, SUM(y.amount_cents) AS paid_cents
  FROM payments y, meta
  WHERE y.paid_on <= meta.as_of
  GROUP BY y.invoice_id
),
owed AS (
  SELECT i.invoice_id, i.client_id, i.issued_on, i.due_on, i.total_cents,
    COALESCE(paid.paid_cents, 0) AS paid_cents,
    i.total_cents - COALESCE(paid.paid_cents, 0) AS outstanding_cents,
    meta.as_of - i.due_on AS days_past_due
  FROM invoices i
  LEFT JOIN paid ON paid.invoice_id = i.invoice_id
  CROSS JOIN meta
  WHERE i.total_cents - COALESCE(paid.paid_cents, 0) > 0
)
SELECT o.invoice_id, o.client_id, c.first_name, c.last_name, c.zone_id,
  o.issued_on, o.due_on, o.days_past_due,
  CAST(o.total_cents / 100 AS DECIMAL(14, 2)) AS total,
  CAST(o.paid_cents / 100 AS DECIMAL(14, 2)) AS paid,
  CAST(o.outstanding_cents / 100 AS DECIMAL(14, 2)) AS outstanding
FROM owed o
JOIN clients c ON c.client_id = o.client_id
WHERE ($zone = 'all' OR c.zone_id = $zone)
  AND (CAST($min_days_past_due AS INTEGER) IS NULL OR o.days_past_due >= CAST($min_days_past_due AS INTEGER))
ORDER BY o.due_on, o.invoice_id
