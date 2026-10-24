-- Synthetic only: every client phone is 555-0100 to 555-0199.
-- protected-columns: clients.phone
-- clients.phone is a forbidden column; this check may name it because the
-- validator never prints a row's values, only how many rows came back.
SELECT client_id
FROM clients
WHERE NOT regexp_full_match(phone, '555-01[0-9][0-9]')
