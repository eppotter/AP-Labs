-- Booked route_order runs 1..n without gaps or repeats within each crew-day.
-- (crew_id, visit_date) in scheduled_visits, cancelled visits included. One
-- row per crew-day at fault.
SELECT s.crew_id, s.visit_date
FROM scheduled_visits s
GROUP BY s.crew_id, s.visit_date
HAVING MIN(s.route_order) <> 1
    OR MAX(s.route_order) <> COUNT(*)
    OR COUNT(DISTINCT s.route_order) <> COUNT(*)
