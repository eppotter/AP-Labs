-- Win-back list: clients in zone $zone with a plan that lapsed in the last
-- $lapsed_days days and no plan active at the data's as-of date, most recent
-- lapse first, at most $limit. Definitions: "Plan lapsed in the last N days"
-- and "Win-back candidate in zone Z" in fixture-tables.md (as_of - N < end_date
-- <= as_of; one row per client, lapse date = the latest such end_date).
-- A fixed template: only the declared parameters bind, never pasted text.
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
),
lapsed AS (
  SELECT p.client_id, MAX(pl.end_date) AS lapsed_on
  FROM plans pl
  JOIN properties p ON p.property_id = pl.property_id
  CROSS JOIN meta
  WHERE pl.status = 'cancelled'
    AND pl.end_date > meta.as_of - CAST($lapsed_days AS INTEGER)
    AND pl.end_date <= meta.as_of
  GROUP BY p.client_id
)
SELECT c.client_id, c.first_name, c.last_name, c.email, l.lapsed_on
FROM clients c
JOIN lapsed l ON l.client_id = c.client_id
CROSS JOIN meta
WHERE c.zone_id = $zone
  AND NOT EXISTS (
    SELECT 1 FROM plans pl2 JOIN properties p2 ON p2.property_id = pl2.property_id
    WHERE p2.client_id = c.client_id
      AND pl2.start_date <= meta.as_of
      AND (pl2.end_date IS NULL OR pl2.end_date >= meta.as_of)
  )
ORDER BY l.lapsed_on DESC, c.client_id
LIMIT $limit
