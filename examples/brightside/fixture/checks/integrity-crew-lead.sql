-- Every crew has exactly one crew lead at a time.
-- By pay_rates role, on every date one of its memberships starts; roles change only on those dates. One row per crew
-- at fault, with the number of dates it is wrong.
WITH event_days AS (
  SELECT DISTINCT crew_id, start_date AS d FROM crew_memberships
),
leads AS (
  SELECT e.crew_id, e.d,
         COUNT(m.membership_id) FILTER (WHERE r.role = 'crew_lead') AS lead_count
  FROM event_days e
  JOIN crew_memberships m
    ON m.crew_id = e.crew_id
   AND m.start_date <= e.d
   AND (m.end_date IS NULL OR m.end_date >= e.d)
  LEFT JOIN pay_rates r
    ON r.staff_id = m.staff_id
   AND r.start_date <= e.d
   AND (r.end_date IS NULL OR r.end_date >= e.d)
  GROUP BY e.crew_id, e.d
)
SELECT crew_id, COUNT(*) AS bad_days
FROM leads
WHERE lead_count <> 1
GROUP BY crew_id
