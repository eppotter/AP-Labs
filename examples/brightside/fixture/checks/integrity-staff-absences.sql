-- Every staff absence is after as_of, reported by then, by someone on a crew that day.
-- absence_date is after as_of and on or before schedule_horizon_end
-- (fixture_meta); reported_on is on or before as_of; the staff member has a
-- crew membership covering absence_date (end_date inclusive). With no as_of
-- or no schedule_horizon_end row, one guard row fails the check rather than
-- letting it pass on no rows. One row per absence at fault.
WITH a AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
),
h AS (
  SELECT CAST(value AS DATE) AS horizon_end FROM fixture_meta WHERE key = 'schedule_horizon_end'
)
SELECT 'absence_date' AS problem, x.absence_id AS id
FROM staff_absences x, a, h
WHERE x.absence_date <= a.as_of OR x.absence_date > h.horizon_end
UNION ALL
SELECT 'reported_on', x.absence_id
FROM staff_absences x, a
WHERE x.reported_on > a.as_of
UNION ALL
SELECT 'no membership that day', x.absence_id
FROM staff_absences x
WHERE NOT EXISTS (
  SELECT 1 FROM crew_memberships m
  WHERE m.staff_id = x.staff_id
    AND m.start_date <= x.absence_date
    AND (m.end_date IS NULL OR m.end_date >= x.absence_date))
UNION ALL
SELECT 'fixture_meta: no as_of or schedule_horizon_end', NULL
WHERE NOT EXISTS (SELECT 1 FROM a WHERE as_of IS NOT NULL)
   OR NOT EXISTS (SELECT 1 FROM h WHERE horizon_end IS NOT NULL)
