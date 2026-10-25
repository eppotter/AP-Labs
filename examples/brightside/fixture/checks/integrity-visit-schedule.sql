-- Each visit's schedule holds together.
-- arrival_window agrees with
-- scheduled_start (morning before 12:00), scheduled_minutes is whole
-- 15-minute slots from 30, travel is 5-35 minutes, the first stop starts at
-- 06:00 or later and each later stop no earlier than the previous one ends
-- plus the travel between them. One row per visit at fault.
WITH ordered AS (
  SELECT v.visit_id, v.arrival_window, v.scheduled_start, v.scheduled_minutes, v.travel_minutes_from_previous AS travel,
         LAG(v.scheduled_start + to_minutes(v.scheduled_minutes)) OVER (PARTITION BY v.crew_id, v.visit_date ORDER BY v.route_order) AS prev_end
  FROM visits v
)
SELECT o.visit_id
FROM ordered o
WHERE o.arrival_window <> CASE WHEN o.scheduled_start < TIME '12:00:00' THEN 'morning' ELSE 'afternoon' END
   OR o.scheduled_minutes < 30
   OR o.scheduled_minutes % 15 <> 0
   OR o.travel NOT BETWEEN 5 AND 35
   OR (o.prev_end IS NULL AND o.scheduled_start < TIME '06:00:00')
   OR (o.prev_end IS NOT NULL AND o.scheduled_start < o.prev_end + to_minutes(o.travel))
