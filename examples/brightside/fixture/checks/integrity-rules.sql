-- Every customer rule is valid, and every booked visit keeps its property's rules.
-- rule_type is preferred_crew (soft), day_of_week or time_of_day (both hard).
-- preferred_crew names a crew of the property's zone (a crew whose zone is
-- not in zones is integrity-foreign-keys' finding, not this check's), and
-- every booked (scheduled) visit of the property is on it. day_of_week is ISO day names
-- in week order with no repeat, separated by | (MON|THU), and every booked
-- visit falls on one: ISO weekdays (isodow, Monday 1), never dayofweek
-- (Sunday 0).
-- time_of_day is morning or afternoon, and every booked visit is in it. A
-- cancelled visit keeps no rule. No planted scenario breaks a rule on
-- purpose. One row per rule or booked visit at fault.
WITH day_numbers AS (
  -- Each day_of_week value with its names as ISO day numbers ('MON|THU' is '1|4').
  SELECT r.rule_id,
         replace(replace(replace(replace(replace(replace(replace(r.value,
           'MON', '1'), 'TUE', '2'), 'WED', '3'), 'THU', '4'), 'FRI', '5'), 'SAT', '6'), 'SUN', '7') AS days
  FROM service_rules r
  WHERE r.rule_type = 'day_of_week'
),
canonical AS (
  -- The same numbers, sorted with no repeat: equal to days only when the
  -- value was in week order with no repeat.
  SELECT n.rule_id, n.days, array_to_string(list_sort(list_distinct(string_split(n.days, '|'))), '|') AS sorted
  FROM day_numbers n
),
property_zone AS (
  SELECT p.property_id, c.zone_id
  FROM properties p
  JOIN clients c ON c.client_id = p.client_id
)
SELECT 'rule' AS problem, r.rule_id AS id
FROM service_rules r
LEFT JOIN canonical k ON k.rule_id = r.rule_id
LEFT JOIN property_zone z ON z.property_id = r.property_id
WHERE r.rule_type NOT IN ('preferred_crew', 'day_of_week', 'time_of_day')
   OR r.strength <> CASE r.rule_type WHEN 'preferred_crew' THEN 'soft' ELSE 'hard' END
   OR (r.rule_type = 'time_of_day' AND r.value NOT IN ('morning', 'afternoon'))
   OR (r.rule_type = 'day_of_week'
       AND (NOT regexp_full_match(r.value, '(MON|TUE|WED|THU|FRI|SAT|SUN)(\|(MON|TUE|WED|THU|FRI|SAT|SUN))*') OR k.days <> k.sorted))
   OR (r.rule_type = 'preferred_crew' AND NOT EXISTS (
         SELECT 1 FROM crews c
         WHERE CAST(c.crew_id AS VARCHAR) = r.value
           AND (c.zone_id = z.zone_id OR c.zone_id NOT IN (SELECT zn.zone_id FROM zones zn))))
UNION ALL
SELECT 'booked visit', s.scheduled_visit_id
FROM scheduled_visits s
JOIN service_rules r ON r.property_id = s.property_id
WHERE s.status = 'scheduled'
  AND ((r.rule_type = 'preferred_crew' AND CAST(s.crew_id AS VARCHAR) <> r.value)
    OR (r.rule_type = 'time_of_day' AND s.arrival_window <> r.value)
    OR (r.rule_type = 'day_of_week'
        AND NOT list_contains(string_split(r.value, '|'), ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'][isodow(s.visit_date)])))
