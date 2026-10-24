-- Synthetic only: every client email ends in .invalid.
SELECT client_id
FROM clients
WHERE email NOT LIKE '%.invalid'
