-- Pay periods are contiguous, within role bounds, and end on staff's current rate.
-- Periods run from hire_date to end_date (inclusive; NULL = current), each rate is within its role's bounds (cleaner $17.00-24.00,
-- crew_lead $22.00-30.00), and staff.role and staff.hourly_rate_cents are the
-- latest period's. One row per pay period or staff member at fault.
WITH ordered AS (
  SELECT r.rate_id, r.staff_id, r.start_date, r.end_date, r.role, r.hourly_rate_cents,
         LAG(r.end_date) OVER (PARTITION BY r.staff_id ORDER BY r.start_date) AS prev_end,
         ROW_NUMBER() OVER (PARTITION BY r.staff_id ORDER BY r.start_date) AS n,
         ROW_NUMBER() OVER (PARTITION BY r.staff_id ORDER BY r.start_date DESC) AS from_last
  FROM pay_rates r
)
SELECT 'pay period' AS fault, o.rate_id AS id
FROM ordered o
JOIN staff s ON s.staff_id = o.staff_id
WHERE o.role NOT IN ('cleaner', 'crew_lead')
   OR (o.role = 'cleaner' AND o.hourly_rate_cents NOT BETWEEN 1700 AND 2400)
   OR (o.role = 'crew_lead' AND o.hourly_rate_cents NOT BETWEEN 2200 AND 3000)
   OR (o.end_date IS NOT NULL AND o.end_date < o.start_date)
   OR (o.n = 1 AND o.start_date <> s.hire_date)
   OR (o.n > 1 AND (o.prev_end IS NULL OR o.start_date <> o.prev_end + INTERVAL 1 DAY))
UNION ALL
SELECT 'staff', s.staff_id
FROM staff s
LEFT JOIN ordered o ON o.staff_id = s.staff_id AND o.from_last = 1
WHERE o.rate_id IS NULL
   OR o.end_date IS DISTINCT FROM s.end_date
   OR o.role <> s.role
   OR o.hourly_rate_cents <> s.hourly_rate_cents
