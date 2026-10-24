-- The fixture's own record of itself: version, as-of date and each table's
-- row count (rows_<table>; the build checks each one against the table).
SELECT key, value FROM fixture_meta ORDER BY key
