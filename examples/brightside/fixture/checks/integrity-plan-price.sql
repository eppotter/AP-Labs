-- price_cents is the price on end_date (or at as_of while active): the new price
-- of the latest change effective by then, or start_price_cents with no change.
-- Each change also falls inside the plan's life (start_date to end_date, or to
-- as_of while active), and its old_price_cents is the previous change's
-- new_price_cents, or start_price_cents for the first (issue #77).
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
),
chained AS (
  SELECT ch.plan_id, ch.change_id, ch.effective_date, ch.old_price_cents,
         COALESCE(LAG(ch.new_price_cents) OVER (PARTITION BY ch.plan_id ORDER BY ch.effective_date), pl.start_price_cents) AS expected_old_cents,
         pl.start_date, COALESCE(pl.end_date, meta.as_of) AS last_day
  FROM plan_price_changes ch
  JOIN plans pl ON pl.plan_id = ch.plan_id
  CROSS JOIN meta
)
SELECT 'price_cents is not the latest change' AS problem, pl.plan_id, NULL AS change_id
FROM plans pl
LEFT JOIN latest ON latest.plan_id = pl.plan_id
LEFT JOIN plan_price_changes ch
  ON ch.plan_id = latest.plan_id
 AND ch.effective_date = latest.effective_date
WHERE pl.price_cents <> COALESCE(ch.new_price_cents, pl.start_price_cents)
UNION ALL
SELECT 'change outside the plan''s life', plan_id, change_id
FROM chained
WHERE effective_date < start_date OR effective_date > last_day
UNION ALL
SELECT 'old price is not the previous new price', plan_id, change_id
FROM chained
WHERE old_price_cents <> expected_old_cents
