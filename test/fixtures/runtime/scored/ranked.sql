-- A scored fixture list: every candidate, ordered by the row id, then the
-- engine's cap plus one. The engine scores them and keeps the top few the
-- person asked for (that input is never named here).
SELECT person_id, name, tenure, spend, idle, rise
FROM people
WHERE zone = $zone
ORDER BY person_id
LIMIT 5001
