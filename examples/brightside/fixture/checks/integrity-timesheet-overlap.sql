-- Nobody is double-booked: a staff member's timesheets never overlap.
-- A row
-- whose clock_in is before the latest clock_out of that person's earlier
-- timesheets overlaps one of them. One row per overlapping timesheet.
WITH ordered AS (
  SELECT t.timesheet_id, t.clock_in,
         MAX(t.clock_out) OVER (
           PARTITION BY t.staff_id ORDER BY t.clock_in, t.timesheet_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ) AS latest_out
  FROM timesheets t
)
SELECT o.timesheet_id
FROM ordered o
WHERE o.clock_in < o.latest_out
