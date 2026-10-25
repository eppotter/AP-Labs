-- clock_out is after clock_in, and minutes is the time between them.
SELECT t.timesheet_id
FROM timesheets t
WHERE t.clock_out <= t.clock_in
   OR t.minutes <> date_diff('minute', t.clock_in, t.clock_out)
