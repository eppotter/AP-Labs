-- Every invoice line bills exactly one of package_id or add_on_id (issue #77).
SELECT line_id, invoice_id
FROM invoice_lines
WHERE (package_id IS NULL) = (add_on_id IS NULL)
