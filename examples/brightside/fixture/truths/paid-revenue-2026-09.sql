-- paid-revenue-2026-09: paid revenue for September 2026 in cents (cash basis):
-- payments with paid_on in the month. Payments only, never joined to
-- invoice_lines (one-to-many: it would fan out).
SELECT COALESCE(SUM(y.amount_cents), 0) AS paid_cents
FROM payments y
WHERE y.paid_on >= DATE '2026-09-01'
  AND y.paid_on < DATE '2026-10-01'
