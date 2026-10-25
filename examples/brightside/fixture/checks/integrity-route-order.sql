-- route_order runs 1..n without gaps or repeats within each crew-day.
-- (crew_id, visit_date), cancelled visits included. One row per crew-day.
SELECT v.crew_id, v.visit_date
FROM visits v
GROUP BY v.crew_id, v.visit_date
HAVING MIN(v.route_order) <> 1
    OR MAX(v.route_order) <> COUNT(*)
    OR COUNT(DISTINCT v.route_order) <> COUNT(*)
