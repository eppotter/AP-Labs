-- Staff match their crew memberships.
-- The same name on every membership, hired on or before the first one, and end_date NULL while a membership is open,
-- else the last membership's end_date. One row per staff member at fault.
WITH spans AS (
  SELECT m.staff_id,
         MIN(m.start_date) AS first_start,
         MAX(m.end_date) AS last_end,
         BOOL_OR(m.end_date IS NULL) AS has_open,
         BOOL_OR(m.staff_name <> s.name) AS name_differs
  FROM crew_memberships m
  JOIN staff s ON s.staff_id = m.staff_id
  GROUP BY m.staff_id
)
SELECT s.staff_id
FROM staff s
LEFT JOIN spans ON spans.staff_id = s.staff_id
WHERE spans.staff_id IS NULL
   OR spans.name_differs
   OR s.role NOT IN ('cleaner', 'crew_lead')
   OR s.hire_date > spans.first_start
   OR (spans.has_open AND s.end_date IS NOT NULL)
   OR (NOT spans.has_open AND s.end_date IS DISTINCT FROM spans.last_end)
