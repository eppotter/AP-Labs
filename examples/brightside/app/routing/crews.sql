-- Brightside's routing adapter (Story 14.3, data-design §4, §6): every crew on
-- $day with its zone and headcount. Planned = memberships covering $day
-- (end_date inclusive); present = planned less that day's staff_absences.
-- Leads are counted the same way, so the adapter can mark a crew out when its
-- lead is absent or nobody is present (GRD-008, approved 2026-10-31).
-- No coordinate: the crew's base is a node id, and its drives come only from
-- travelMatrix.
WITH m AS (
  SELECT cm.crew_id, cm.staff_id, s.role
  FROM crew_memberships cm
  JOIN staff s ON s.staff_id = cm.staff_id
  WHERE cm.start_date <= CAST($day AS DATE)
    AND (cm.end_date IS NULL OR cm.end_date >= CAST($day AS DATE))
),
a AS (
  SELECT DISTINCT sa.staff_id
  FROM staff_absences sa
  WHERE sa.absence_date = CAST($day AS DATE)
)
SELECT c.crew_id,
       c.zone_id,
       CAST(COUNT(m.staff_id) AS INTEGER) AS headcount_planned,
       CAST(COUNT(CASE WHEN m.staff_id IS NOT NULL AND a.staff_id IS NULL THEN 1 END) AS INTEGER) AS headcount_present,
       CAST(COUNT(CASE WHEN m.role = 'crew_lead' THEN 1 END) AS INTEGER) AS leads_planned,
       CAST(COUNT(CASE WHEN m.role = 'crew_lead' AND a.staff_id IS NULL THEN 1 END) AS INTEGER) AS leads_present
FROM crews c
LEFT JOIN m ON m.crew_id = c.crew_id
LEFT JOIN a ON a.staff_id = m.staff_id
GROUP BY c.crew_id, c.zone_id
ORDER BY c.crew_id
