-- No event after as_of (fixture_meta): issued_on, paid_on, visit_date and
-- created_on are all on or before it, as the outstanding and clients-total
-- truths assume. due_on may fall after it. With no as_of row, one guard row
-- fails the check rather than letting it pass on no rows (issue #77).
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
)
SELECT 'invoices.issued_on' AS date_column, i.invoice_id AS id
FROM invoices i, meta
WHERE i.issued_on > meta.as_of
UNION ALL
SELECT 'payments.paid_on', y.payment_id
FROM payments y, meta
WHERE y.paid_on > meta.as_of
UNION ALL
SELECT 'visits.visit_date', v.visit_id
FROM visits v, meta
WHERE v.visit_date > meta.as_of
UNION ALL
SELECT 'clients.created_on', c.client_id
FROM clients c, meta
WHERE c.created_on > meta.as_of
UNION ALL
SELECT 'fixture_meta: no as_of', NULL
WHERE NOT EXISTS (SELECT 1 FROM meta WHERE as_of IS NOT NULL)
