-- A staff member's crew periods never overlap. Periods are inclusive; a NULL
-- end_date is current (open-ended). One row per overlapping pair.
SELECT a.staff_name, a.membership_id AS first_id, b.membership_id AS second_id
FROM crew_memberships a
JOIN crew_memberships b
  ON b.staff_name = a.staff_name
 AND b.membership_id > a.membership_id
WHERE a.start_date <= COALESCE(b.end_date, DATE '9999-12-31')
  AND b.start_date <= COALESCE(a.end_date, DATE '9999-12-31')
