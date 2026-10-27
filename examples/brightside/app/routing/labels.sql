-- Brightside's routing map labels (Story 15.5, AD-R16, AD-R17): the words the
-- map's text list shows for each node id the archetype asks about, and
-- nothing else. A crew node gets its crew name; a property node gets its
-- client's name and its city. Never an address, postal code or coordinate.
--
-- $crew_ids and $property_ids are the asked ids without their kind prefix,
-- comma-separated. $crew_id is the person's scope (AD-R17): '' for a
-- dispatcher (every crew), else the crew lead's crew, so a lead's labels name
-- no other crew. Places are not cut here: the archetype asks only for the
-- places that scope may see (its own stops, stops moved onto it, its own gap
-- candidates), before this runs.
SELECT 'crew:' || CAST(c.crew_id AS VARCHAR) AS node,
       c.name AS crew_name,
       CAST(NULL AS VARCHAR) AS client_name,
       CAST(NULL AS VARCHAR) AS city
FROM crews c
WHERE list_contains(string_split($crew_ids, ','), CAST(c.crew_id AS VARCHAR))
  AND ($crew_id = '' OR CAST(c.crew_id AS VARCHAR) = $crew_id)
UNION ALL
SELECT 'property:' || CAST(p.property_id AS VARCHAR) AS node,
       CAST(NULL AS VARCHAR) AS crew_name,
       cl.first_name || ' ' || cl.last_name AS client_name,
       p.city
FROM properties p
JOIN clients cl ON cl.client_id = p.client_id
WHERE list_contains(string_split($property_ids, ','), CAST(p.property_id AS VARCHAR))
ORDER BY node
