-- winback-north-90d-price-rise: of the North win-back candidates
-- (winback-north-90d), those with at least one lapsed plan that had a price
-- rise (new_price_cents > old_price_cents) effective in the 60 days up to the
-- lapse (end_date - 59 days to end_date). Grain: one row per client.
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
)
SELECT COUNT(c.client_id) AS candidates_with_rise
FROM clients c, meta
WHERE c.zone_id = 'north'
  AND EXISTS (
    SELECT 1 FROM plans pl JOIN properties p ON p.property_id = pl.property_id
    WHERE p.client_id = c.client_id
      AND pl.status = 'cancelled'
      AND pl.end_date > meta.as_of - INTERVAL 90 DAY
      AND pl.end_date <= meta.as_of
      AND EXISTS (
        SELECT 1 FROM plan_price_changes ch
        WHERE ch.plan_id = pl.plan_id
          AND ch.new_price_cents > ch.old_price_cents
          AND ch.effective_date >= pl.end_date - INTERVAL 59 DAY
          AND ch.effective_date <= pl.end_date
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM plans pl JOIN properties p ON p.property_id = pl.property_id
    WHERE p.client_id = c.client_id
      AND pl.start_date <= meta.as_of
      AND (pl.end_date IS NULL OR pl.end_date >= meta.as_of)
  )
