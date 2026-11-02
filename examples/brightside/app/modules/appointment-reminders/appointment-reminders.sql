-- Appointment reminders (Story 20.2, plan brightside-v1 D14, GRD-010): the
-- visits booked on $day for the zone or crew $zone_or_crew, each the input of
-- one reminder email, and whether it is held. The one query of this module;
-- SQLsmith reviews it.
--
-- Grain: one row per scheduled visit, scheduled_visits.scheduled_visit_id
-- (the module's row id), status 'scheduled' (a cancelled booking gets no
-- reminder). One email per visit, not per customer: a customer with two
-- visits that day gets two emails. Every join is to a primary key, so none
-- can multiply a visit: properties on property_id, then clients on client_id
-- (the customer: first name, email, home zone), crews on crew_id, packages on
-- package_id. crew_day holds at most one row per crew (GROUP BY crew_id), so
-- its LEFT JOIN can't multiply one either.
--
-- Held (SQLsmith P2-11, GRD-010): a visit whose crew has a member absent on
-- $day is held, not emailed. A member on $day: a crew_memberships row for
-- the crew covering $day (start_date <= day, and end_date NULL or >= day:
-- end_date is inclusive, as app/routing/crews.sql reads it). Absent: a
-- staff_absences row on $day for that staff member, reported by as_of (an
-- absence reported later isn't known yet). held is NULL for a visit that is
-- emailed, else the reason the preview shows, one of two (SQLsmith P2-1):
--   - the crew is out under GRD-008, worked out as crews.sql and the routing
--     adapter do: no crew lead present (the lead absent, or no lead that
--     day), or nobody present. "... Check Crew out first."
--   - otherwise the crew works short-handed. "...; the crew works
--     short-handed."
-- A fork whose data records part-day absences or stand-in leads must map
-- them as GRD-008 says (a stand-in lead or a part-day member counts as
-- present) before this query can tell the two cases apart; the fixture
-- records neither.
--
-- Zone or crew: $zone_or_crew is a zone id (the customer's home zone,
-- clients.zone_id: every property sits in its client's zone) or a crew's
-- name (crews.name: that crew's stops). The manifest's allowed values keep
-- the two apart (zone ids are lower case, crew names are not), so a value
-- matches only one way.
--
-- Dates, no clock, no time zone: dates are DATE in the business's local
-- calendar; $day is bound as 'YYYY-MM-DD' text and cast to DATE, never to a
-- timestamp. "Today" is fixture_meta's as_of, never CURRENT_DATE, and $day
-- must be after it (scheduled_visits holds only days after as_of). A day on
-- or before it returns no rows, and the person sees the engine's "no rows
-- matched these values": a scoped pull has no per-module empty message, so
-- "pick a day after <as_of>" can't be said from here (the form's hint says
-- it instead). visit_date goes out as ISO text, the template's input.
--
-- What leaves (GRD-010): first name, email, date, arrival window (the
-- booking's own, morning or afternoon), crew id and name, package name. Never
-- an address, postal code, coordinate, price, phone, last name or a staff
-- name. A fixed template: only the declared inputs bind.
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
),
members AS (
  SELECT cm.crew_id, cm.staff_id, s.role
  FROM crew_memberships cm
  JOIN staff s ON s.staff_id = cm.staff_id
  WHERE cm.start_date <= CAST($day AS DATE)
    AND (cm.end_date IS NULL OR cm.end_date >= CAST($day AS DATE))
),
absent AS (
  SELECT DISTINCT sa.staff_id
  FROM staff_absences sa
  CROSS JOIN meta
  WHERE sa.absence_date = CAST($day AS DATE)
    AND sa.reported_on <= meta.as_of
),
crew_day AS (
  SELECT m.crew_id,
    COUNT(a.staff_id) AS absent_members,
    COUNT(CASE WHEN a.staff_id IS NULL THEN 1 END) AS present_members,
    COUNT(CASE WHEN m.role = 'crew_lead' AND a.staff_id IS NULL THEN 1 END) AS present_leads
  FROM members m
  LEFT JOIN absent a ON a.staff_id = m.staff_id
  GROUP BY m.crew_id
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
  CASE
    WHEN COALESCE(cd.absent_members, 0) = 0 THEN NULL
    WHEN cd.present_leads = 0 OR cd.present_members = 0
      THEN 'Held: a member of ' || cr.name || ' is absent that day. Check Crew out first.'
    ELSE 'Held: a member of ' || cr.name || ' is absent that day; the crew works short-handed.'
  END AS held
FROM scheduled_visits sv
JOIN properties p ON p.property_id = sv.property_id
JOIN clients cl ON cl.client_id = p.client_id
JOIN crews cr ON cr.crew_id = sv.crew_id
JOIN packages pk ON pk.package_id = sv.package_id
LEFT JOIN crew_day cd ON cd.crew_id = sv.crew_id
CROSS JOIN meta
WHERE sv.status = 'scheduled'
  AND sv.visit_date = CAST($day AS DATE)
  AND sv.visit_date > meta.as_of
  AND (cl.zone_id = $zone_or_crew OR cr.name = $zone_or_crew)
ORDER BY sv.crew_id, sv.route_order, sv.scheduled_visit_id
