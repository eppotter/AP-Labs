-- Every booked crew-day fits a normal day: 08:00 to 18:00 from the crew's base.
-- Generator v8. Per (crew_id, visit_date) in scheduled_visits, cancelled
-- visits included (they keep their booked slot): the drives (from the
-- crew's base to stop 1, then stop to stop; the drive home is not counted)
-- plus the service minutes are at most 600, and the last stop ends by 18:00.
-- Times are minutes after local midnight. One row per crew-day at fault.
SELECT s.crew_id, s.visit_date
FROM scheduled_visits s
GROUP BY s.crew_id, s.visit_date
HAVING SUM(s.travel_minutes_from_previous + s.scheduled_minutes) > 600
    OR MAX(CAST(EXTRACT(hour FROM s.scheduled_start) * 60 + EXTRACT(minute FROM s.scheduled_start) AS INTEGER) + s.scheduled_minutes) > 1080
