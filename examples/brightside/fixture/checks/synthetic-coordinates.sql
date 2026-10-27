-- Synthetic only: random points in a real metro, never taken from an address.
-- Every coordinate lies inside the fixture's box around Columbus, Ohio.
-- protected-columns: properties.geo_lat_e6, properties.geo_lon_e6, crews.base_geo_lat_e6, crews.base_geo_lon_e6
-- The four are forbidden columns; this check may name them because the
-- validator never prints a row's values, only how many rows came back. The
-- box (micro-degrees) is lib/routing.js BOX. One row per place at fault.
SELECT 'properties' AS source, p.property_id AS id
FROM properties p
WHERE p.geo_lat_e6 IS NULL
   OR p.geo_lon_e6 IS NULL
   OR p.geo_lat_e6 NOT BETWEEN 39700000 AND 40300000
   OR p.geo_lon_e6 NOT BETWEEN -83400000 AND -82600000
UNION ALL
SELECT 'crews', c.crew_id
FROM crews c
WHERE c.base_geo_lat_e6 IS NULL
   OR c.base_geo_lon_e6 IS NULL
   OR c.base_geo_lat_e6 NOT BETWEEN 39700000 AND 40300000
   OR c.base_geo_lon_e6 NOT BETWEEN -83400000 AND -82600000
