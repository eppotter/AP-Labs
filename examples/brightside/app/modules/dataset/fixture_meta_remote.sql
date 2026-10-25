-- The MotherDuck copy's record of itself, in one query: the fixture's own
-- fixture_meta (version, as-of date, rows_<table>) and what fixture:publish
-- recorded in fixture_publish (fixture_version, published_at, ...).
SELECT 'meta' AS src, key, value FROM fixture_meta
UNION ALL
SELECT 'publish' AS src, key, value FROM fixture_publish
ORDER BY src, key
