-- A fixture approval-write list: the people in one zone.
SELECT person_id, first, address
FROM people
WHERE zone = $zone
ORDER BY person_id
