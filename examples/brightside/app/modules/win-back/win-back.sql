-- Win-back list: clients in zone $zone with a plan that lapsed in the last
-- $lapsed_days days and no plan active at the data's as-of date, with the
-- five columns the engine scores them on (Story 10.1, the manifest's
-- "scoring"). Definitions in fixture-tables.md: "Plan lapsed in the last N
-- days" and "Win-back candidate in zone Z" (as_of - N < end_date <= as_of;
-- one row per client, lapse date = the latest such end_date), "Lifetime paid
-- spend per client" and "Price change before lapse".
--   months_as_client    complete months from clients.created_on to as_of
--                       (date_sub, so a month counts only once it has passed)
--   paid_dollars        lifetime paid spend up to as_of, in whole dollars
--                       (0 for a client who never paid); integer cents
--                       rounded half up, never floating point
--   days_since_visit    days from the last completed visit to as_of (365 for
--                       a client with no completed visit: as far back as the
--                       score's range reaches)
--   plan_price_dollars  the lapsed plan's price_cents (the plan that ended
--                       on the lapse date; the highest if two did), in whole
--                       dollars, rounded the same way
--   price_rise          a plan lapsed in the window had a price rise effective
--                       in the 60 days up to its end
-- Every scoring column is COALESCEd or never null: a null stops the run.
-- The engine scores every candidate and keeps the top few the person asked
-- for, so the SQL never names that input: it orders by the row id last and
-- ends with the engine's cap plus one. A fixed template: only the declared
-- parameters bind, never pasted text.
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
),
lapsed_plans AS (
  SELECT p.client_id, pl.end_date, pl.price_cents,
    EXISTS (
      SELECT 1 FROM plan_price_changes ch
      WHERE ch.plan_id = pl.plan_id
        AND ch.new_price_cents > ch.old_price_cents
        AND ch.effective_date >= pl.end_date - INTERVAL 59 DAY
        AND ch.effective_date <= pl.end_date
    ) AS rose
  FROM plans pl
  JOIN properties p ON p.property_id = pl.property_id
  CROSS JOIN meta
  WHERE pl.status = 'cancelled'
    AND pl.end_date > meta.as_of - CAST($lapsed_days AS INTEGER)
    AND pl.end_date <= meta.as_of
),
lapsed AS (
  SELECT client_id, MAX(end_date) AS lapsed_on, BOOL_OR(rose) AS price_rise
  FROM lapsed_plans
  GROUP BY client_id
),
lapsed_price AS (
  SELECT lp.client_id, MAX(lp.price_cents) AS price_cents
  FROM lapsed_plans lp
  JOIN lapsed l ON l.client_id = lp.client_id AND lp.end_date = l.lapsed_on
  GROUP BY lp.client_id
),
spend AS (
  SELECT i.client_id, SUM(pay.amount_cents) AS paid_cents
  FROM payments pay
  JOIN invoices i ON i.invoice_id = pay.invoice_id
  CROSS JOIN meta
  WHERE pay.paid_on <= meta.as_of
  GROUP BY i.client_id
),
last_visit AS (
  SELECT p.client_id, MAX(v.visit_date) AS last_on
  FROM visits v
  JOIN properties p ON p.property_id = v.property_id
  CROSS JOIN meta
  WHERE v.status = 'completed'
    AND v.visit_date <= meta.as_of
  GROUP BY p.client_id
)
SELECT c.client_id, c.first_name, c.last_name, c.email, l.lapsed_on,
  date_sub('month', c.created_on, meta.as_of) AS months_as_client,
  CAST((COALESCE(s.paid_cents, 0) + 50) // 100 AS BIGINT) AS paid_dollars,
  COALESCE(meta.as_of - lv.last_on, 365) AS days_since_visit,
  CAST((lp.price_cents + 50) // 100 AS BIGINT) AS plan_price_dollars,
  l.price_rise
FROM clients c
JOIN lapsed l ON l.client_id = c.client_id
JOIN lapsed_price lp ON lp.client_id = c.client_id
LEFT JOIN spend s ON s.client_id = c.client_id
LEFT JOIN last_visit lv ON lv.client_id = c.client_id
CROSS JOIN meta
WHERE c.zone_id = $zone
  AND NOT EXISTS (
    SELECT 1 FROM plans pl2 JOIN properties p2 ON p2.property_id = pl2.property_id
    WHERE p2.client_id = c.client_id
      AND pl2.start_date <= meta.as_of
      AND (pl2.end_date IS NULL OR pl2.end_date >= meta.as_of)
  )
ORDER BY l.lapsed_on DESC, c.client_id
LIMIT 5001
