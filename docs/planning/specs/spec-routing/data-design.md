# Route optimization: data design (SQLsmith)

Status: draft for the Orchestrator. Canon: profiles/brightside/context/data.md (signed 2026-10-25).
Nothing here has been run; every expected value is a generator-planted target, not an observed number.

## 1. Fixture additions (smallest set)

All from a new stream `createRng(deriveSeed(seed, 'routing'))`, run after `buildOperations`, reading
final tables only. Appended columns go last. Every existing column and seed keeps its values byte for
byte. Bump GENERATOR_VERSION to 4 and update seed.json. fixture_meta gains `rows_<new table>` and
`schedule_horizon_end`. No existing truth figure moves.

| Table / columns | Grain | Keys | How generated |
|---|---|---|---|
| properties + `geo_lat_e6`, `geo_lon_e6` INTEGER (micro-degrees) | 1 per property (unchanged) | PK property_id | Each of the 15 cities gets a fixed centroid in a fixed synthetic box; each property = city centroid + jitter (~1.5 km). Pick the spacing so that same-city drives are about 5-12 min and other-city drives about 10-35, as the history's travel bounds show. |
| crews + `base_geo_lat_e6`, `base_geo_lon_e6` INTEGER | 1 per crew (15) | PK crew_id | Each base sits near its zone's first city; no randomness needed (crews has no draws today). |
| `scheduled_visits` (new) | 1 per planned visit after as_of | PK scheduled_visit_id; FK plan_id, property_id, crew_id; route_order 1..n per (crew_id, visit_date) | For each plan with end_date IS NULL: continue `scheduleDays` cadence past as_of through as_of+28 on the plan's crew. Columns: package_id, visit_date, status ('scheduled'/'cancelled'), status_changed_on DATE (<= as_of), arrival_window, scheduled_start, scheduled_minutes, labour_minutes (whole-crew total; needed to rescale when a member is absent), route_order, travel_minutes_from_previous (haversine). The booked order follows the history's rule: cities in random order, stops shuffled within each city. It is deliberately not optimal. The day limits are the generator's (06:00 earliest, 08:00 default start, aim 18:00, 23:00 latest; squeeze rule as today). |
| `service_rules` (new, long form) | 1 per (property_id, rule_type) | PK rule_id; UNIQUE (property_id, rule_type) | rule_type: `preferred_crew` (value crew_id, strength soft), `day_of_week` (value 'MON,TUE', ISO day names, hard), `time_of_day` (value morning/afternoon, hard). About 60% of plan properties get preferred_crew = the plan's crew; about 20% day_of_week; about 25% time_of_day. Rules always match the property's own booked future slots. Long form means new rule types need no schema change. |
| `staff_absences` (new) | 1 per (staff_id, absence_date) | PK absence_id; UNIQUE (staff_id, absence_date); FK staff_id | Planted only (section 5), plus about 1% background absences in the horizon. reported_on <= as_of. Only staff with a membership covering absence_date. |

Checks to add: integrity-scheduled-route-order (1..n), integrity-scheduled-schedule (times fit, start
>= prev end + travel, window agrees with start), integrity-scheduled-after-as-of (visit_date > as_of,
status_changed_on <= as_of), integrity-scheduled-cadence (each plan's first scheduled date = next
cadence date after its last history visit; plans ended at or before as_of have none: the plan ending
on as_of included), integrity-rules (values valid; booked slots satisfy hard rules, except where a
section 5 scenario plants a rule mismatch on purpose), synthetic-coordinates (every coordinate inside
the fixture box; its leading comment carries `-- protected-columns:` with the four coordinate columns,
as `kit/fixture/validate.js` `readHeader` requires). Mirror each in operations-rules-style JS so the generator refuses bad output.

Existing truths/checks that could move, and how to keep them: none move with this design. The risks
are (a) drawing from the main or ops stream (moves every later value, so all truths miss); keep the
new stream; (b) changing `visits` (see section 2); (c) `readTargets` demands exactly TRUTH_IDS in
targets.json `truths`; put routing targets under a separate `routing` key read by a separate
routing-truths module, and leave TRUTH_IDS alone.

## 2. Future schedule: separate table, not a new visits status

Recommend `scheduled_visits`. Putting status 'scheduled' rows into `visits` would break:
integrity-no-date-after-as-of (visit_date > as_of), rules.js line 159 (status in completed/cancelled),
the canon line "integrity-no-date-after-as-of guarantees none exist" (MET-005), and every query that
uses `status <> 'completed'` or counts cancellations as "not completed". The existing
`status = 'completed'` queries (labour-cost, win-back last visit, invoice/timesheet checks) would
survive, but the silent ones would not. Cost: a view of "all of a crew's days" is a UNION ALL of
the two tables. It is disjoint by date (history <= as_of < scheduled), so use UNION ALL, never UNION.
Carry a `source` column because the two id spaces overlap.

## 3. Coordinates vs forbidden columns

Yes: forbid all four. The guard (kit/runtime/sql `checkForbidden`) matches the column NAME in any
table, so names must be unique (`geo_lat_e6`, never `lat`). Then no module query, dataset entry or
LLM-built SQL can select them.

Engine read path: a new `travelMatrix(fromIds, toIds)` in kit/runtime/data, built inside the
`createData` closure so it shares the guard, timeouts and redaction. It is one static, reviewed SQL
template in the kit. Its table and column names come from a profile `routing.coordinates` block,
checked against the identifier regex. Before it runs it checks that each declared coordinate column
is INTEGER or BIGINT (so `street_address` declared as a coordinate is refused). It runs `checkSql`
with only the declared coordinate columns removed from the forbidden list (all other forbidden
columns are still enforced). Node ids are kind-prefixed (`property:<id>`, `crew:<id>`). It returns a
rectangle (from × to), capped by pair count, never an N×N over every node. It computes haversine ×
detour / speed inside DuckDB, rounds to 1e-6 before rounding up, and returns integer minutes only.
Every DuckDB error becomes a fixed-text RoutingFault. Coordinates never reach JS module code, logs,
Slack or an LLM.

- **T3 profile change:** add the 4 columns to `sql.forbidden_columns` and a new `routing:` block
  (coordinates, speed_kmh, detour_factor, min_travel_minutes = 5). The profile JSON Schema rejects
  unknown keys, so the schema changes too (profiles/**).
- **T3 kit change** (computed: `kit/runtime/data/**` is an engine T3 floor): `travelMatrix` in
  kit/runtime/data. A test must prove no other caller can drop a forbidden column.

## 4. Engine input contract (kit never reads Brightside tables)

A Brightside adapter (examples/brightside) maps tables to this:
- `day`: ISO date; `asOf`: ISO date. Times are minutes after local midnight (wall clock, no TZ).
- `limits`: { earliestStart 360, defaultStart 480, aimFinish 1080, latestFinish 1380, startRoundTo 5 }.
- `crews[]`: { crewId, zoneId, baseNode, headcountPlanned, headcountPresent, available: bool }.
  The adapter sets `available: false` when the lead is absent or nobody is present (definition
  pending Dana Reyes's confirmation).
- Node ids are kind-prefixed strings: `property:<property_id>`, `crew:<crew_id>`.
- `stops[]`: { stopId, node, currentCrewId, labourMinutes, serviceMinutes (for headcountPresent,
  round to 15, min 30), locked: bool, rules: { preferredCrewId?, allowedIsoDays?, window? } }.
- `candidates[]` (route change): stops from later days with { plannedDate, cadenceDays, prevVisitDate,
  flexible }. `flexible` is true when the stop has no hard day_of_week or time_of_day rule.
  `prevVisitDate` is the latest non-cancelled visit from history or schedule.
- `travel(fromNode, toNode)`: integer minutes, from the travelMatrix above (which can later be
  swapped for a real routing API).
- Output: per crew [{ stopId, routeOrder 1..n, start, travelMinutesFromPrevious }], `unplaced[]` with
  reason, `moves[]` { stopId, fromCrew, toCrew, crossZone, fromDate }, `shifted[]` (existing stops
  whose time moved: "call to confirm the new time"). Ids and minutes only.

Adapter base query (no forbidden names). Rules are pivoted to one row per property first, so the
join cannot fan out:

```sql
WITH r AS (
  SELECT sr.property_id,
         MAX(CASE WHEN sr.rule_type = 'preferred_crew' THEN sr.value END) AS preferred_crew,
         MAX(CASE WHEN sr.rule_type = 'day_of_week'    THEN sr.value END) AS allowed_days,
         MAX(CASE WHEN sr.rule_type = 'time_of_day'    THEN sr.value END) AS time_window
  FROM service_rules sr GROUP BY sr.property_id)
SELECT sv.scheduled_visit_id, sv.property_id, sv.crew_id, sv.visit_date, sv.route_order,
       sv.labour_minutes, sv.scheduled_minutes, r.preferred_crew, r.allowed_days, r.time_window
FROM scheduled_visits sv LEFT JOIN r ON r.property_id = sv.property_id
WHERE sv.status = 'scheduled' AND sv.visit_date = CAST($day AS DATE)
ORDER BY sv.crew_id, sv.route_order
```

## 5. Known-answer truths (planted; tolerance 0; targets in targets.json `routing`)

Planted scenarios, seeded at fixed ids and dates by the routing stream:
- **S1 zig-zag day:** crew 4 on as_of+1 has 7 stops booked in a deliberate back-and-forth city order.
- **S2 cancellation:** a stop on crew 2, as_of+2, status 'cancelled', status_changed_on = as_of.
  Planted around it: one clear best fill (same city, next visit in 3 days, rules allow), one closer
  decoy with time_of_day = morning (the gap is in the afternoon), and one decoy that moves up too
  far for its cadence.
- **S3 sick crew:** the lead and one member of crew 7 are absent on as_of+3, so the crew is out.
  Its 6 orphans fit onto the 2 other crews in its zone except one. That one must go cross-zone,
  because one zone crew-day is planted near the 23:00 limit.

| id | statement | run | expect |
|---|---|---|---|
| scheduled-stops-next-14d | Scheduled stops as_of+1..as_of+14 | SQL below | planted count |
| route-optimize-s1-drive | S1: booked drive minutes (from travelMatrix) exact; optimized ≤ booked; 0 hard breaks | node engine script | booked minutes |
| route-change-s2-top | property_id of the top-ranked fill for S2 | node engine script | the planted best-fill property |
| route-change-s2-count | Valid candidates for S2 (both decoys excluded) | node engine script | planted count |
| route-change-s3-crosszone | S3: in-zone 5 / cross-zone recommendations 1 / unplaced 0 (a recommendation is not placed) | node engine script | 5/1/0 |

```sql
WITH meta AS (SELECT CAST(value AS DATE) AS as_of FROM fixture_meta WHERE key = 'as_of')
SELECT COUNT(sv.scheduled_visit_id) AS stops
FROM scheduled_visits sv, meta
WHERE sv.status = 'scheduled'
  AND sv.visit_date > meta.as_of
  AND sv.visit_date <= CAST(meta.as_of + INTERVAL 14 DAY AS DATE)
```

The truths only check rules a person can see: rule violations, limit breaches, unplaced and
cross-zone counts, and the top-ranked fill. Exact optimizer minutes are tied to the algorithm, so
the S1 truth pins only the booked minutes; the exact optimum lives in the engine's known-optimal
unit test (Story 12.3).

## 6. Gotchas

- **as_of:** "today" is fixture_meta as_of (2026-09-30), never CURRENT_DATE; scenarios are as_of+n.
  "Next 14 days" means (gap_date, gap_date+14], inclusive of the 14th day.
- **Timezone:** dates and TIMEs are the local business calendar. Work in wall-clock minutes and never
  convert to UTC. The 2026-11-01 DST change falls inside a 28-day horizon, and wall clock sidesteps it.
- **Day of week:** use ISO (`isodow`, Mon=1). DuckDB `dayofweek` is Sun=0. Monthly plans drift weekday.
- **route_order:** history keeps cancelled stops in 1..n. Suggestions renumber 1..n without them;
  never compare a suggested order with the booked order position by position.
- **Travel:** the first stop's travel is from the crew base; there is no return leg in the data, and
  the objective follows that by default. Historical travel_minutes are random draws, not geometry:
  never check the engine against history, only against scheduled_visits.
- **Memberships:** end_date is inclusive. Future headcount = memberships covering the date (only
  end_date IS NULL rows qualify after as_of) minus staff_absences. Fewer people means longer
  service: labour_minutes / present, rounded to 15, minimum 30.
- **Gap-fill exclusions:** never offer the property that cancelled, or any property already visited
  on the gap date. prevVisitDate = latest non-cancelled visit across history and schedule.
- **Dates:** ISO strings only; never a local `Date`. Routing tests run under two TZ values across
  2026-11-01.
- **Moving up:** cadence spacing (default: not closer than half the cadence to the previous visit).
  A plan's later visits do not shift.
- **Cross-zone:** allowed but flagged in `moves[]`. Zone comes from crews.zone_id vs clients.zone_id.
- **Audience:** output is for ops schedulers: crew names, client name, city, times. Never
  coordinates, street address or postal code. Drive minutes are fine (history already has them).
- **Squeezed days:** about 30 historical crew-days exceed the day. The future generator must keep
  every crew-day within 06:00-23:00 or squeeze it, and the planted S3 near-limit day must fit exactly.
