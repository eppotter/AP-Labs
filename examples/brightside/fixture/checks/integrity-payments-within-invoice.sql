-- Payments never exceed their invoice: per invoice, the sum of all its payments
-- is at most its total.
WITH paid AS (
  SELECT invoice_id, SUM(amount_cents) AS paid_cents
  FROM payments
  GROUP BY invoice_id
)
SELECT i.invoice_id, i.total_cents, paid.paid_cents
FROM invoices i
JOIN paid ON paid.invoice_id = i.invoice_id
WHERE paid.paid_cents > i.total_cents
