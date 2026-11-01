-- Brightside's Add a stop (Story 19.5, plan brightside-v1 D8): the clients
-- the client search offers for a crew's day, and the check Add makes again
-- before it places one. A client of the crew's own zone (clients.zone_id)
-- whose name holds $query (any case; '' for any name), one row per property,
-- leaving out every property with a visit booked on $day (it would visit the
-- same place twice). $property_id ('' for any) narrows it to one property,
-- for Add's check. At most 20 rows. Only a client's name and a property's
-- city: never an address, postal code or coordinate.
SELECT p.property_id,
       cl.first_name || ' ' || cl.last_name AS client_name,
       p.city
FROM clients cl
JOIN properties p ON p.client_id = cl.client_id
JOIN crews c ON c.zone_id = cl.zone_id
WHERE CAST(c.crew_id AS VARCHAR) = $crew_id
  AND ($query = '' OR strpos(lower(cl.first_name || ' ' || cl.last_name), lower($query)) > 0)
  AND ($property_id = '' OR CAST(p.property_id AS VARCHAR) = $property_id)
  AND p.property_id NOT IN (
    SELECT sv.property_id
    FROM scheduled_visits sv
    WHERE sv.visit_date = CAST($day AS DATE)
      AND sv.status = 'scheduled'
  )
ORDER BY cl.last_name, cl.first_name, p.property_id
LIMIT 20
