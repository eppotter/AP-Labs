-- scheduled-stops-next-14d: booked (not cancelled) stops after as_of through
-- as_of + 14, inclusive of the 14th day (data-design §5, Story 14.4).
-- Grain: one row per scheduled visit; prints one count.
WITH meta AS (SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of')
SELECT COUNT(sv.scheduled_visit_id) AS stops
FROM scheduled_visits sv, meta
WHERE sv.status = 'scheduled'
  AND sv.visit_date > meta.as_of
  AND sv.visit_date <= CAST(meta.as_of + INTERVAL 14 DAY AS DATE)
