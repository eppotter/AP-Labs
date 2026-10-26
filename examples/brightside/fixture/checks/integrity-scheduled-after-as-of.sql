-- Every booked visit is after as_of and on or before schedule_horizon_end (fixture_meta).
-- Its status is scheduled or cancelled, set on or before as_of. With no as_of
-- or no schedule_horizon_end row, one guard row fails the check rather than
-- letting it pass on no rows.
WITH a AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
),
h AS (
  SELECT CAST(value AS DATE) AS horizon_end FROM fixture_meta WHERE key = 'schedule_horizon_end'
)
SELECT 'visit_date' AS problem, s.scheduled_visit_id AS id
FROM scheduled_visits s, a, h
WHERE s.visit_date <= a.as_of OR s.visit_date > h.horizon_end
UNION ALL
SELECT 'status_changed_on', s.scheduled_visit_id
FROM scheduled_visits s, a
WHERE s.status_changed_on > a.as_of
UNION ALL
SELECT 'status', s.scheduled_visit_id
FROM scheduled_visits s
WHERE s.status NOT IN ('scheduled', 'cancelled')
UNION ALL
SELECT 'fixture_meta: no as_of or schedule_horizon_end', NULL
WHERE NOT EXISTS (SELECT 1 FROM a WHERE as_of IS NOT NULL)
   OR NOT EXISTS (SELECT 1 FROM h WHERE horizon_end IS NOT NULL)
