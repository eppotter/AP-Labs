-- Synthetic only: random points in a real metro, never from an address; the Office is a rounded point Ely chose.
-- Every coordinate lies inside the fixture's box around Columbus, Ohio. One
-- point is not random: the Office (depots, generator v7), a point Ely chose
-- in Westerville, rounded to 0.002 degrees (lib/routing.js OFFICE).
-- protected-columns: properties.geo_lat_e6, properties.geo_lon_e6, crews.base_geo_lat_e6, crews.base_geo_lon_e6, depots.geo_lat_e6, depots.geo_lon_e6
-- The six are forbidden columns; this check may name them because the
-- validator never prints a row's values, only how many rows came back. The
-- box (micro-degrees) is lib/routing.js BOX. One row per place at fault.
SELECT 'properties' AS source, CAST(p.property_id AS VARCHAR) AS id
FROM properties p
WHERE p.geo_lat_e6 IS NULL
   OR p.geo_lon_e6 IS NULL
   OR p.geo_lat_e6 NOT BETWEEN 39700000 AND 40300000
   OR p.geo_lon_e6 NOT BETWEEN -83400000 AND -82600000
UNION ALL
SELECT 'crews', CAST(c.crew_id AS VARCHAR)
FROM crews c
WHERE c.base_geo_lat_e6 IS NULL
   OR c.base_geo_lon_e6 IS NULL
   OR c.base_geo_lat_e6 NOT BETWEEN 39700000 AND 40300000
   OR c.base_geo_lon_e6 NOT BETWEEN -83400000 AND -82600000
UNION ALL
SELECT 'depots', d.depot_id
FROM depots d
WHERE d.geo_lat_e6 IS NULL
   OR d.geo_lon_e6 IS NULL
   OR d.geo_lat_e6 NOT BETWEEN 39700000 AND 40300000
   OR d.geo_lon_e6 NOT BETWEEN -83400000 AND -82600000
