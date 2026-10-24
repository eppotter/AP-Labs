-- price_cents is the price on end_date (or at as_of while active): the new price
-- of the latest change effective by then, or start_price_cents with no change.
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
),
latest AS (
  SELECT pl.plan_id, MAX(ch.effective_date) AS effective_date
  FROM plans pl
  CROSS JOIN meta
  JOIN plan_price_changes ch
    ON ch.plan_id = pl.plan_id
   AND ch.effective_date <= COALESCE(pl.end_date, meta.as_of)
  GROUP BY pl.plan_id
)
SELECT pl.plan_id, pl.price_cents, COALESCE(ch.new_price_cents, pl.start_price_cents) AS expected_cents
FROM plans pl
LEFT JOIN latest ON latest.plan_id = pl.plan_id
LEFT JOIN plan_price_changes ch
  ON ch.plan_id = latest.plan_id
 AND ch.effective_date = latest.effective_date
WHERE pl.price_cents <> COALESCE(ch.new_price_cents, pl.start_price_cents)
