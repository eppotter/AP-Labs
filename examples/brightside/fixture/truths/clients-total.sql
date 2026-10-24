-- clients-total: clients at as_of (client since on or before as_of).
-- Grain: one row per client; prints one count.
SELECT COUNT(c.client_id) AS clients
FROM clients c
WHERE c.created_on <= (SELECT CAST(value AS DATE) FROM fixture_meta WHERE key = 'as_of')
