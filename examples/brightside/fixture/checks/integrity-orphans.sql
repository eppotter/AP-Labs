-- No orphans: every client has at least one property and every invoice has at
-- least one line. (A child row with no parent is integrity-foreign-keys.)
SELECT 'client without a property' AS orphan, c.client_id AS id
FROM clients c
WHERE NOT EXISTS (SELECT 1 FROM properties p WHERE p.client_id = c.client_id)
UNION ALL
SELECT 'invoice without a line', i.invoice_id
FROM invoices i
WHERE NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.invoice_id)
