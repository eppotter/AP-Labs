-- A fixture scoped pull: the visits in one zone.
SELECT visit_id, zone
FROM visits
WHERE zone = $zone
ORDER BY visit_id
