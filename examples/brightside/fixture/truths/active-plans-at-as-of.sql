-- active-plans-at-as-of: plans active at as_of, by the definition in
-- fixture-tables.md: start_date <= as_of AND (end_date IS NULL OR end_date >= as_of).
-- Never use status = 'active' here: end_date is inclusive, so a plan whose last
-- active day is as_of is active at as_of but already has status 'cancelled'.
-- The planted data has one such plan, so the status column would undercount by one.
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
)
SELECT COUNT(pl.plan_id) AS active_plans
FROM plans pl, meta
WHERE pl.start_date <= meta.as_of
  AND (pl.end_date IS NULL OR pl.end_date >= meta.as_of)
