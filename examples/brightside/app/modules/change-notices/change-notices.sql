-- Change notices (Story 20.3, plan brightside-v1 D14, D14a, GRD-010): for
-- the visits a route skill's result changed, who to email and what the
-- booking says now (the before values). The one query of this module;
-- SQLsmith reviews it.
--
-- Grain: one row per scheduled visit named in $visit_ids,
-- scheduled_visits.scheduled_visit_id (the module's row id), status
-- 'scheduled' only (SQLsmith P1-5: a cancelled booking gets no notice, and
-- the engine lists a visit this query doesn't return as no longer booked).
-- One email per visit, not per customer. Every join is to a primary key, so
-- none can multiply a visit: properties on property_id, then clients on
-- client_id (the customer: first name, email), crews on crew_id (the booked
-- crew's name), packages on package_id.
--
-- $visit_ids: the route record's visit ids as one string ("12,40,7"), bound
-- by the engine from the route record only, never from a form or a click
-- (approval-write/route-source.js), and checked against the input's pattern
-- (comma-separated whole numbers of at most 9 digits, so every one fits
-- INTEGER) before it binds. string_split gives a list, so unnest makes its
-- rows; each is cast to INTEGER, the id's type. An id that names no
-- scheduled visit simply matches nothing.
--
-- Before values (D14): the booked date, arrival window (the booking's own,
-- morning or afternoon) and crew, from scheduled_visits. The after values
-- (date, window, crew, crew name) and the reason line are the route's: the
-- engine adds them from the route record and compares them with these, so a
-- move within the same window is not a change.
--
-- Dates, no clock, no time zone: dates are DATE in the business's local
-- calendar. "Today" is fixture_meta's as_of, never CURRENT_DATE; only a
-- visit after it is booked (scheduled_visits holds the days after as_of).
-- visit_date goes out as ISO text, the template's input.
--
-- What leaves (GRD-010): first name, email, the booked date, window, crew id
-- and crew name, package name. Never an address, postal code, coordinate,
-- price, phone, last name or a staff name. held is always NULL here: the
-- engine sets it for a visit it lists but doesn't email.
WITH meta AS (
  SELECT CAST(m.value AS DATE) AS as_of FROM fixture_meta m WHERE m.key = 'as_of'
)
SELECT sv.scheduled_visit_id,
  'change' AS kind,
  cl.first_name,
  cl.email,
  pk.name AS package_name,
  CAST(sv.visit_date AS VARCHAR) AS before_date,
  sv.arrival_window AS before_window,
  sv.crew_id AS before_crew_id,
  cr.name AS before_crew_name,
  CAST(NULL AS VARCHAR) AS held
FROM scheduled_visits sv
JOIN properties p ON p.property_id = sv.property_id
JOIN clients cl ON cl.client_id = p.client_id
JOIN crews cr ON cr.crew_id = sv.crew_id
JOIN packages pk ON pk.package_id = sv.package_id
CROSS JOIN meta
WHERE sv.scheduled_visit_id IN (SELECT CAST(unnest(string_split($visit_ids, ',')) AS INTEGER))
  AND sv.status = 'scheduled'
  AND sv.visit_date > meta.as_of
ORDER BY sv.scheduled_visit_id
