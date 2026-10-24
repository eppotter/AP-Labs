-- No end_date after as_of (fixture_meta), on plans or crew memberships.
-- With no as_of row there is nothing to compare against, so one guard row
-- fails the check rather than letting it pass on no rows (issue #77).
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
)
SELECT 'plans' AS source_table, pl.plan_id AS id, pl.end_date
FROM plans pl, meta
WHERE pl.end_date > meta.as_of
UNION ALL
SELECT 'crew_memberships', m.membership_id, m.end_date
FROM crew_memberships m, meta
WHERE m.end_date > meta.as_of
UNION ALL
SELECT 'fixture_meta: no as_of', NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM meta WHERE as_of IS NOT NULL)
