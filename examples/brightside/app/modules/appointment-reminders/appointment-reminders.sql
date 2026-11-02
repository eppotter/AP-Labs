-- Appointment reminders (Story 20.2, plan brightside-v1 D14, GRD-010): the
-- visits booked on $day for the zone or crew $zone_or_crew, each the input of
-- one reminder email, and whether it is held. The one query of this module;
-- SQLsmith reviews it.
--
-- Grain: one row per scheduled visit, scheduled_visits.scheduled_visit_id
-- (the module's row id), status 'scheduled' (a cancelled booking gets no
-- reminder). Every join is to a primary key, so none can multiply a visit:
-- properties on property_id, then clients on client_id (the customer: first
-- name, email, home zone), crews on crew_id, packages on package_id.
-- absent_crews holds at most one row per crew (DISTINCT), so its LEFT JOIN
-- can't multiply one either.
--
-- Held (SQLsmith P2-11): a visit whose crew has a member absent on $day is
-- held, not emailed. A member absent on $day: a staff_absences row on $day
-- for a staff member whose crew_memberships row for that crew covers $day
-- (start_date <= day, and end_date NULL or >= day: end_date is inclusive, as
-- app/routing/crews.sql reads it). held is NULL for a visit that is emailed,
-- else the reason the preview shows.
--
-- Zone or crew: $zone_or_crew is a zone id (the customer's home zone,
-- clients.zone_id: every property sits in its client's zone) or a crew's
-- name (crews.name). The manifest's allowed values keep the two apart (zone
-- ids are lower case, crew names are not), so a value matches only one way.
--
-- Dates, no clock, no time zone: dates are DATE in the business's local
-- calendar; $day is bound as 'YYYY-MM-DD' text and cast to DATE, never to a
-- timestamp. "Today" is fixture_meta's as_of, never CURRENT_DATE, and $day
-- must be after it (scheduled_visits holds only days after as_of; a day on or
-- before it returns no rows). visit_date goes out as ISO text, the template's
-- input.
--
-- What leaves (GRD-010): first name, email, date, arrival window (the
-- booking's own, morning or afternoon), crew id and name, package name. Never
-- an address, postal code, coordinate, price, phone, last name or a staff
-- name. A fixed template: only the declared inputs bind.
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
),
absent_crews AS (
  SELECT DISTINCT cm.crew_id
  FROM staff_absences sa
  JOIN crew_memberships cm ON cm.staff_id = sa.staff_id
  WHERE sa.absence_date = CAST($day AS DATE)
    AND cm.start_date <= sa.absence_date
    AND (cm.end_date IS NULL OR cm.end_date >= sa.absence_date)
)
SELECT sv.scheduled_visit_id,
  'reminder' AS kind,
  cl.first_name,
  cl.email,
  CAST(sv.visit_date AS VARCHAR) AS visit_date,
  sv.arrival_window,
  sv.crew_id,
  cr.name AS crew_name,
  pk.name AS package_name,
  CASE WHEN ac.crew_id IS NOT NULL
    THEN 'Held: a member of ' || cr.name || ' is absent that day. Check Crew out first.'
  END AS held
FROM scheduled_visits sv
JOIN properties p ON p.property_id = sv.property_id
JOIN clients cl ON cl.client_id = p.client_id
JOIN crews cr ON cr.crew_id = sv.crew_id
JOIN packages pk ON pk.package_id = sv.package_id
LEFT JOIN absent_crews ac ON ac.crew_id = sv.crew_id
CROSS JOIN meta
WHERE sv.status = 'scheduled'
  AND sv.visit_date = CAST($day AS DATE)
  AND sv.visit_date > meta.as_of
  AND (cl.zone_id = $zone_or_crew OR cr.name = $zone_or_crew)
ORDER BY sv.crew_id, sv.route_order, sv.scheduled_visit_id
