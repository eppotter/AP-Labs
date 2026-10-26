-- Brightside's routing adapter (Story 14.3, AD-R8, data-design §4, §6): the
-- gap-fill candidates for $day. Each property's next booked visit in
-- ($day, $day + $horizon_days], less every property with a visit on $day
-- (the one that cancelled, and the ones already visited). prev_visit_date is
-- the property's latest non-cancelled visit before $day across the history
-- (visits) and the schedule (scheduled_visits); the two are disjoint by date,
-- so UNION ALL. Rules are pivoted to one row per property, so no fan-out. No
-- coordinate: drive times come only from travelMatrix.
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
),
nv AS (
  SELECT sv.scheduled_visit_id,
         sv.property_id,
         sv.plan_id,
         sv.crew_id,
         sv.visit_date,
         sv.scheduled_minutes,
         sv.labour_minutes,
         ROW_NUMBER() OVER (PARTITION BY sv.property_id ORDER BY sv.visit_date, sv.scheduled_visit_id) AS rn
  FROM scheduled_visits sv
  WHERE sv.status = 'scheduled'
    AND sv.visit_date > CAST($day AS DATE)
    AND sv.visit_date <= CAST($day AS DATE) + CAST($horizon_days AS INTEGER)
),
today AS (
  SELECT DISTINCT t.property_id
  FROM scheduled_visits t
  WHERE t.visit_date = CAST($day AS DATE)
),
done AS (
  SELECT v.property_id, v.visit_date
  FROM visits v
  WHERE v.status <> 'cancelled' AND v.visit_date < CAST($day AS DATE)
  UNION ALL
  SELECT s.property_id, s.visit_date
  FROM scheduled_visits s
  WHERE s.status <> 'cancelled' AND s.visit_date < CAST($day AS DATE)
),
prev AS (
  SELECT d.property_id, MAX(d.visit_date) AS prev_visit_date
  FROM done d
  GROUP BY d.property_id
)
SELECT nv.scheduled_visit_id,
       nv.property_id,
       nv.crew_id,
       CAST(nv.visit_date AS VARCHAR) AS visit_date,
       nv.scheduled_minutes,
       nv.labour_minutes,
       p.frequency,
       CAST(prev.prev_visit_date AS VARCHAR) AS prev_visit_date,
       r.preferred_crew,
       r.preferred_crew_strength,
       r.allowed_days,
       r.allowed_days_strength,
       r.time_window,
       r.time_window_strength
FROM nv
JOIN plans p ON p.plan_id = nv.plan_id
LEFT JOIN r ON r.property_id = nv.property_id
LEFT JOIN prev ON prev.property_id = nv.property_id
LEFT JOIN today ON today.property_id = nv.property_id
WHERE nv.rn = 1
  AND today.property_id IS NULL
ORDER BY nv.property_id
