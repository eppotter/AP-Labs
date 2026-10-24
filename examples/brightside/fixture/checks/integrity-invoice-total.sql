-- Every invoice total equals the sum of its lines. Lines are summed per invoice
-- before the comparison, so nothing fans out.
WITH line_totals AS (
  SELECT invoice_id, SUM(amount_cents) AS lines_cents
  FROM invoice_lines
  GROUP BY invoice_id
)
SELECT i.invoice_id, i.total_cents, lt.lines_cents
FROM invoices i
JOIN line_totals lt ON lt.invoice_id = i.invoice_id
WHERE i.total_cents <> lt.lines_cents
