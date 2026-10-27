-- Each active plan's booked visits follow its cadence on its own property, package and zone.
-- A booked visit is on the plan's crew (its last history visit's), or on
-- another crew of that crew's zone: a dispatcher may move a visit within its
-- zone on its own day (the planted routing scenarios do, and generator v8
-- does so every crew-day fits). The generator's rules go further and allow
-- that only for the visits it moved; SQL cannot tell which those are. The
-- plan's cadence dates are one step (7 days, 14 days or a month) after its
-- last history visit, then a step after each other; the plan's n-th booked
-- visit is on its n-th cadence date, or at most half a cadence (3, 7 or 15
-- days) either side of it when generator v8 moved it so a crew-day fits, and
-- is at least half a cadence (7, 14 or 30 days) after the visit before it,
-- as the routing engine requires of a moved visit. An active plan whose next
-- cadence date falls on or before schedule_horizon_end has it booked; a
-- plan that ended (on or before as_of, the plan ending on as_of included) has
-- none. A monthly plan's dates are on day 28 or earlier, so a month step is
-- exact. One row per visit or plan at fault; with no schedule_horizon_end
-- row, one guard row.
WITH h AS (
  SELECT CAST(value AS DATE) AS horizon_end FROM fixture_meta WHERE key = 'schedule_horizon_end'
),
last_visit AS (
  SELECT v.plan_id, MAX(v.visit_date) AS last_date, arg_max(v.crew_id, v.visit_date) AS crew_id
  FROM visits v
  WHERE v.plan_id IS NOT NULL
  GROUP BY v.plan_id
),
step AS (
  SELECT p.plan_id, p.property_id, p.package_id, p.end_date,
         CASE p.frequency WHEN 'weekly' THEN INTERVAL 7 DAY WHEN 'biweekly' THEN INTERVAL 14 DAY ELSE INTERVAL 1 MONTH END AS gap,
         CASE p.frequency WHEN 'weekly' THEN 7 WHEN 'biweekly' THEN 14 ELSE 30 END AS cadence_days,
         CASE p.frequency WHEN 'weekly' THEN 3 WHEN 'biweekly' THEN 7 ELSE 15 END AS max_shift
  FROM plans p
),
booked AS (
  SELECT s.scheduled_visit_id, s.plan_id, s.property_id, s.package_id, s.crew_id, s.visit_date,
         ROW_NUMBER() OVER (PARTITION BY s.plan_id ORDER BY s.visit_date, s.scheduled_visit_id) AS n,
         LAG(s.visit_date) OVER (PARTITION BY s.plan_id ORDER BY s.visit_date, s.scheduled_visit_id) AS prev_date
  FROM scheduled_visits s
),
booked_count AS (
  SELECT s.plan_id, COUNT(*) AS n
  FROM scheduled_visits s
  GROUP BY s.plan_id
)
SELECT 'booked on an ended plan' AS problem, b.scheduled_visit_id AS id
FROM booked b
JOIN step p ON p.plan_id = b.plan_id
WHERE p.end_date IS NOT NULL
UNION ALL
SELECT 'not the plan''s property, package or zone', b.scheduled_visit_id
FROM booked b
JOIN step p ON p.plan_id = b.plan_id
LEFT JOIN last_visit l ON l.plan_id = b.plan_id
LEFT JOIN crews bc ON bc.crew_id = b.crew_id
LEFT JOIN crews lc ON lc.crew_id = l.crew_id
WHERE l.plan_id IS NULL
   OR b.property_id <> p.property_id
   OR b.package_id <> p.package_id
   OR (b.crew_id <> l.crew_id AND (bc.zone_id IS NULL OR lc.zone_id IS NULL OR bc.zone_id <> lc.zone_id))
UNION ALL
SELECT 'off cadence', b.scheduled_visit_id
FROM booked b
JOIN step p ON p.plan_id = b.plan_id
JOIN last_visit l ON l.plan_id = b.plan_id
WHERE abs(date_diff('day', CAST(l.last_date + b.n * p.gap AS DATE), b.visit_date)) > p.max_shift
UNION ALL
SELECT 'under half a cadence after the visit before', b.scheduled_visit_id
FROM booked b
JOIN step p ON p.plan_id = b.plan_id
JOIN last_visit l ON l.plan_id = b.plan_id
WHERE 2 * date_diff('day', COALESCE(b.prev_date, l.last_date), b.visit_date) < p.cadence_days
UNION ALL
SELECT 'next cadence date not booked', p.plan_id
FROM step p
JOIN last_visit l ON l.plan_id = p.plan_id
LEFT JOIN booked_count m ON m.plan_id = p.plan_id
CROSS JOIN h
WHERE p.end_date IS NULL
  AND CAST(l.last_date + (COALESCE(m.n, 0) + 1) * p.gap AS DATE) <= h.horizon_end
UNION ALL
SELECT 'fixture_meta: no schedule_horizon_end', NULL
WHERE NOT EXISTS (SELECT 1 FROM h WHERE horizon_end IS NOT NULL)
