-- outstanding-at-as-of: total outstanding at as_of in cents. Per invoice,
-- total_cents minus its payments with paid_on <= as_of, counted only where
-- positive. Payments are summed per invoice first, so nothing fans out.
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
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
