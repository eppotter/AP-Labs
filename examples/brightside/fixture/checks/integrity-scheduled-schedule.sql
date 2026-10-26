-- Each booked visit's times hold together.
-- arrival_window agrees with scheduled_start (morning before 12:00),
-- scheduled_minutes is whole 15-minute slots from 30, labour_minutes is
-- positive, travel is at least 5 minutes, the first stop starts no earlier
-- than 06:00 plus the drive from the crew's base, each later stop no earlier
-- than the previous one ends plus the drive, and every stop ends by 23:00.
-- Times are minutes after local midnight, so nothing wraps past midnight.
-- One row per visit at fault.
WITH timed AS (
  SELECT s.scheduled_visit_id, s.crew_id, s.visit_date, s.route_order, s.arrival_window,
         s.scheduled_minutes, s.labour_minutes, s.travel_minutes_from_previous AS travel,
         CAST(EXTRACT(hour FROM s.scheduled_start) * 60 + EXTRACT(minute FROM s.scheduled_start) AS INTEGER) AS start_min
  FROM scheduled_visits s
),
ordered AS (
  SELECT t.scheduled_visit_id, t.arrival_window, t.scheduled_minutes, t.labour_minutes, t.travel, t.start_min,
         LAG(t.start_min + t.scheduled_minutes) OVER (PARTITION BY t.crew_id, t.visit_date ORDER BY t.route_order) AS prev_end
  FROM timed t
)
SELECT o.scheduled_visit_id
FROM ordered o
WHERE o.arrival_window <> CASE WHEN o.start_min < 720 THEN 'morning' ELSE 'afternoon' END
   OR o.scheduled_minutes < 30
   OR o.scheduled_minutes % 15 <> 0
   OR o.labour_minutes <= 0
   OR o.travel < 5
   OR (o.prev_end IS NULL AND o.start_min < 360 + o.travel)
   OR (o.prev_end IS NOT NULL AND o.start_min < o.prev_end + o.travel)
   OR o.start_min + o.scheduled_minutes > 1380
