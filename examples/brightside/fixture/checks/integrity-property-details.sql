-- Home details are in range.
-- A known home type and access method, 400-6000
-- square feet, 1-6 bedrooms, 1.0-5.5 bathrooms in halves and no more than two
-- over the bedrooms, and at least 250 square feet per bedroom.
SELECT p.property_id
FROM properties p
WHERE p.home_type NOT IN ('house', 'townhouse', 'condo', 'apartment')
   OR p.access_method NOT IN ('key', 'lockbox', 'client_home', 'door_code_on_file')
   OR p.square_feet NOT BETWEEN 400 AND 6000
   OR p.bedrooms NOT BETWEEN 1 AND 6
   OR p.bathrooms NOT BETWEEN 1.0 AND 5.5
   OR p.bathrooms * 2 <> FLOOR(p.bathrooms * 2)
   OR p.bathrooms > p.bedrooms + 2
   OR p.square_feet < p.bedrooms * 250
   OR p.has_pets IS NULL
