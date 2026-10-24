-- billed-revenue-2026-09: billed revenue for September 2026 in cents: invoice
-- totals with issued_on in the month. Grain: one row per invoice.
SELECT COALESCE(SUM(i.total_cents), 0) AS billed_cents
FROM invoices i
WHERE i.issued_on >= DATE '2026-09-01'
  AND i.issued_on < DATE '2026-10-01'
