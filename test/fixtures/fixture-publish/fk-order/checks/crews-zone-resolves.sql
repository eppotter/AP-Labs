-- Every crew's zone exists.
SELECT c.crew_id FROM crews c LEFT JOIN zones z ON z.zone_id = c.zone_id WHERE z.zone_id IS NULL
