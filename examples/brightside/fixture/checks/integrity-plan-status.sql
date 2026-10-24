-- status agrees with end_date: 'active' exactly when end_date IS NULL, else
-- 'cancelled'.
SELECT plan_id, status, end_date
FROM plans
WHERE status IS DISTINCT FROM (CASE WHEN end_date IS NULL THEN 'active' ELSE 'cancelled' END)
