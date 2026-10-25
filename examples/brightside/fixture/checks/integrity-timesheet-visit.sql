-- Timesheets are for completed visits, by that day's crew members, on the visit date.
-- They are by staff who were members of the visit's crew that day; every completed
-- visit has at least one. One row per timesheet or visit at fault.
SELECT 'timesheet' AS fault, t.timesheet_id AS id
FROM timesheets t
JOIN visits v ON v.visit_id = t.visit_id
WHERE v.status <> 'completed'
   OR CAST(t.clock_in AS DATE) <> v.visit_date
   OR NOT EXISTS (
     SELECT 1 FROM crew_memberships m
     WHERE m.staff_id = t.staff_id
       AND m.crew_id = v.crew_id
       AND m.start_date <= v.visit_date
       AND (m.end_date IS NULL OR m.end_date >= v.visit_date)
   )
UNION ALL
SELECT 'completed visit without a timesheet', v.visit_id
FROM visits v
WHERE v.status = 'completed'
  AND NOT EXISTS (SELECT 1 FROM timesheets t WHERE t.visit_id = v.visit_id)
