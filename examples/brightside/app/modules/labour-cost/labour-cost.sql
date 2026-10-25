-- Labour cost: what staff time on completed visits cost in pay in month
-- $month, the latest such month on or before the data's as-of date (on
-- as_of 2026-09-30, "September" is September 2026 and "October" is October
-- 2025). Definitions: "Pay rate on day d" and "Labour cost of a visit" in
-- fixture-tables.md, and MET-007 in data.md: for each timesheet whose visit's
-- visit_date is in the month, minutes x the hourly_rate_cents of the one
-- pay_rates row in effect on visit_date (never staff.hourly_rate_cents,
-- today's rate). Rounded once, at the end: the exact minutes x cents products
-- are summed as integers, divided by 60 and rounded half up to whole cents
-- only then, never per timesheet. Integer arithmetic throughout (DuckDB's
-- decimal division gives a DOUBLE); cents become dollars as DECIMAL(18, 0)
-- times 0.01, giving DECIMAL(18, 2). Hours are rounded the same way, once.
-- Totals only (GRD-006): one row for the month, never a person's name, id or
-- rate. A month with no timesheets gives no row. When as_of falls inside the
-- month, the month runs to as_of and last_day says so.
-- A fixed template: only the declared parameters bind, never pasted text.
WITH meta AS (
  SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of'
),
chosen_month AS (
  SELECT CASE $month
      WHEN 'January' THEN 1 WHEN 'February' THEN 2 WHEN 'March' THEN 3
      WHEN 'April' THEN 4 WHEN 'May' THEN 5 WHEN 'June' THEN 6
      WHEN 'July' THEN 7 WHEN 'August' THEN 8 WHEN 'September' THEN 9
      WHEN 'October' THEN 10 WHEN 'November' THEN 11 WHEN 'December' THEN 12
    END AS month_number
),
chosen AS (
  SELECT make_date(
      CASE WHEN m.month_number <= month(meta.as_of) THEN year(meta.as_of) ELSE year(meta.as_of) - 1 END,
      m.month_number, 1) AS month_start,
    meta.as_of
  FROM chosen_month m
  CROSS JOIN meta
  WHERE m.month_number IS NOT NULL
),
priced AS (
  SELECT ch.month_start, ch.as_of, v.visit_id, t.minutes,
    CAST(t.minutes AS BIGINT) * r.hourly_rate_cents AS cent_minutes
  FROM chosen ch
  JOIN visits v
    ON v.visit_date >= ch.month_start
    AND v.visit_date < CAST(ch.month_start + INTERVAL 1 MONTH AS DATE)
    AND v.visit_date <= ch.as_of
  JOIN timesheets t ON t.visit_id = v.visit_id
  JOIN pay_rates r
    ON r.staff_id = t.staff_id
    AND r.start_date <= v.visit_date
    AND (r.end_date IS NULL OR r.end_date >= v.visit_date)
  WHERE v.status = 'completed'
),
totals AS (
  SELECT month_start,
    LEAST(CAST(month_start + INTERVAL 1 MONTH - INTERVAL 1 DAY AS DATE), MAX(as_of)) AS last_day,
    COUNT(DISTINCT visit_id) AS visit_count,
    COUNT(*) AS timesheet_count,
    SUM(CAST(minutes AS BIGINT)) AS minutes_worked,
    SUM(cent_minutes) AS cent_minutes
  FROM priced
  GROUP BY month_start
)
SELECT strftime(month_start, '%B %Y') AS month,
  month_start AS first_day,
  last_day,
  visit_count, timesheet_count, minutes_worked,
  CAST((minutes_worked * 100 + 30) // 60 AS DECIMAL(18, 0)) * 0.01 AS hours_worked,
  CAST((cent_minutes + 30) // 60 AS DECIMAL(18, 0)) * 0.01 AS labour_cost
FROM totals
