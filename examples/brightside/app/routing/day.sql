-- Brightside's routing adapter (Story 14.3, data-design §4): one row per
-- booked visit on $day, scheduled or cancelled, with its property's rules.
-- The rules are pivoted to one row per property first (UNIQUE property_id,
-- rule_type), so the join cannot fan out. No coordinate, address or postal
-- code: drive times come only from travelMatrix. Times are wall-clock minutes
-- after local midnight; dates are ISO text.
WITH r AS (
  SELECT sr.property_id,
         MAX(CASE WHEN sr.rule_type = 'preferred_crew' THEN sr.value END) AS preferred_crew,
         MAX(CASE WHEN sr.rule_type = 'preferred_crew' THEN sr.strength END) AS preferred_crew_strength,
         MAX(CASE WHEN sr.rule_type = 'day_of_week' THEN sr.value END) AS allowed_days,
         MAX(CASE WHEN sr.rule_type = 'day_of_week' THEN sr.strength END) AS allowed_days_strength,
         MAX(CASE WHEN sr.rule_type = 'time_of_day' THEN sr.value END) AS time_window,
         MAX(CASE WHEN sr.rule_type = 'time_of_day' THEN sr.strength END) AS time_window_strength
  FROM service_rules sr
  GROUP BY sr.property_id
)
SELECT sv.scheduled_visit_id,
       sv.property_id,
       sv.crew_id,
       sv.status,
       CAST(sv.visit_date AS VARCHAR) AS visit_date,
       sv.route_order,
       CAST(EXTRACT(hour FROM sv.scheduled_start) * 60 + EXTRACT(minute FROM sv.scheduled_start) AS INTEGER) AS start_minutes,
       sv.scheduled_minutes,
       sv.labour_minutes,
       r.preferred_crew,
       r.preferred_crew_strength,
       r.allowed_days,
       r.allowed_days_strength,
       r.time_window,
       r.time_window_strength
FROM scheduled_visits sv
LEFT JOIN r ON r.property_id = sv.property_id
WHERE sv.visit_date = CAST($day AS DATE)
  AND sv.status IN ('scheduled', 'cancelled')
ORDER BY sv.crew_id, sv.route_order, sv.scheduled_visit_id
