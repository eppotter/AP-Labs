-- winback-north-90d: win-back candidates in the North zone. A client in zone
-- north with at least one plan lapsed in the last 90 days (status 'cancelled',
-- as_of - 90 < end_date <= as_of: 90 dates, as_of included) and no plan active
-- at as_of on any property. Grain: one row per client (EXISTS, so a client with
-- several plans or properties is counted once).
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
)
SELECT COUNT(c.client_id) AS candidates
FROM clients c, meta
WHERE c.zone_id = 'north'
  AND EXISTS (
    SELECT 1 FROM plans pl JOIN properties p ON p.property_id = pl.property_id
    WHERE p.client_id = c.client_id
      AND pl.status = 'cancelled'
      AND pl.end_date > meta.as_of - INTERVAL 90 DAY
      AND pl.end_date <= meta.as_of
  )
  AND NOT EXISTS (
    SELECT 1 FROM plans pl JOIN properties p ON p.property_id = pl.property_id
    WHERE p.client_id = c.client_id
      AND pl.start_date <= meta.as_of
      AND (pl.end_date IS NULL OR pl.end_date >= meta.as_of)
  )
