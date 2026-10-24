-- A plan's visits fall inside the plan's active period: on or after start_date,
-- and on or before end_date when the plan has ended (end_date is inclusive).
SELECT v.visit_id, v.plan_id, v.visit_date, pl.start_date, pl.end_date
FROM visits v
JOIN plans pl ON pl.plan_id = v.plan_id
WHERE v.visit_date < pl.start_date
   OR (pl.end_date IS NOT NULL AND v.visit_date > pl.end_date)
