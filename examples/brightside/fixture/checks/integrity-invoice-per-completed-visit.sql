-- One invoice per completed visit, and none for a visit that is not completed.
WITH invoice_counts AS (
  SELECT visit_id, COUNT(invoice_id) AS invoice_count
  FROM invoices
  GROUP BY visit_id
)
SELECT v.visit_id, v.status, COALESCE(ic.invoice_count, 0) AS invoice_count
FROM visits v
LEFT JOIN invoice_counts ic ON ic.visit_id = v.visit_id
WHERE (v.status = 'completed' AND COALESCE(ic.invoice_count, 0) <> 1)
   OR (v.status <> 'completed' AND COALESCE(ic.invoice_count, 0) > 0)
