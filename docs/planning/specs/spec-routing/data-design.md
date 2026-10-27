# Route optimization: data design (SQLsmith)

Status: draft for the Orchestrator. Canon: profiles/brightside/context/data.md (signed 2026-10-25).
Nothing here has been run; every expected value is a generator-planted target, not an observed number.

## 1. Fixture additions (smallest set)

All from a new stream `createRng(deriveSeed(seed, 'routing'))`, run after `buildOperations`, reading
final tables only. Appended columns go last. Every existing column and seed keeps its values byte for
byte. Bump GENERATOR_VERSION to 4 and update seed.json. fixture_meta gains `rows_<new table>` and
`schedule_horizon_end`. No existing truth figure moves.

**Amended 2026-10-26 (routing-streetmap, Story 15.7, architecture AD-R22):** the fixture box moves
from open ocean to a real US metro, Columbus, Ohio, so a street map can sit under the plot. Only
`CENTRE` and `BOX` change (a round-number point such as 40.000000, −83.000000); the per-km scales
(already 40° values), the jitter, city and base offsets are unchanged, so every random draw is
unchanged and the row counts should not move. GENERATOR_VERSION goes to 5; every non-routing
column stays byte-identical to v4. Points stay random, never taken from an address; a marker may
land on water (no land mask). Drive time stays haversine × detour ÷ speed, not road time.

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

Map read path (added 2026-10-26 for the Slack map, Epic 15; SQLsmith to confirm the SQL at Story
15.2): a second read, `mapPoints(nodeIds, frame)`, in the same closure and under the same guard,
cap and refusal tests. `frame` is `{ width, height, padding }` integers within kit bounds. One static
template projects the requested nodes inside DuckDB. First it snaps each micro-degree value to
the `routing.map_grid_e6` grid (default 2000, about 220 m north-south), rounding to the nearest
multiple. Then x comes from longitude scaled by the cosine of the box's middle latitude, y from
latitude flipped so north is up, both fitted to the bounding box of the requested nodes only, with
each side widened around its centre to at least `routing.map_min_span_km` (default 5), plus
padding, centred, then rounded to integers. It returns `node, x, y` (INTEGER pixels) and never a
latitude or longitude. One node, or nodes in one cell, sit at the frame's centre. Capped at
`routing.max_points` (default 500). Duplicate node ids are refused; an unknown id, or a node whose
coordinate is null, is left out of the result (the caller treats a missing node as a fault). It is not on the data object modules receive and not in the
sdk; only the routing-map archetype may require it. Pixel positions are not coordinates, but they
still trace the layout: they stay in process memory, never in text or logs (architecture AD-R12,
AD-R13).

**Amended 2026-10-26 (routing-streetmap, Story 15.8, architecture AD-R20):** the projection
above changes so the plot lines up with street tiles. Snap to the grid first (unchanged), then
project Web Mercator, not longitude scaled by the middle latitude's cosine. Pick the largest whole
zoom z ≤ `max_zoom` at which the requested nodes' box, widened to at least `map_min_span_km`,
fits inside the frame's padding; no stretch to the frame, so a frame may show up to twice the
area, and never less than 5 km. The select list becomes `node, x, y, z, tx0, ty0, cols, rows,
ox, oy`, all INTEGER; the mosaic columns must match on every row, else `query_failed`. The call
returns `{ points, mosaic }`; `mosaic` is null when the box crosses the antimeridian, reaches
beyond ±85.0511°, or needs more than 64 tiles. Tile numbers are rough locations (about 2 km):
process memory only, passed only to the tile fetcher, never logged. SQLsmith confirms the SQL at
Story 15.8.

**As built (Story 15.8, `kit/runtime/data/map.js`):** in one static template, after the snap:
(1) the box's latitude side is widened to `map_min_span_km` ÷ (km per degree, radius 6371.0088),
and its longitude side to the same ÷ cos of the widened box's poleward edge, so the floor holds
across the whole box. (2) Web Mercator with the world as 1 × 1: x = (lon + 180) / 360,
y = (1 − ln(tan φ + sec φ) / π) / 2, φ held within ±85.0511° so the pole never reaches tan.
(3) z = least(`max_zoom`, floor(log2(least((width − 2·padding − 1) ÷ (256 × box width),
(height − 2·padding − 1) ÷ (256 × twice the box's longer half about its middle latitude))))),
one pixel kept so rounding never puts a marker in the padding; z may be below 0 for a box wider
than the world (then no mosaic). (4) The frame's top-left corner in world pixels is
round(centre × 256·2^z − side / 2), centred on the box's middle longitude and middle latitude, so a
lone node is at the frame's centre; x and y are round(world pixel − corner). (5) tx0 = floor(left /
256), ox = 256·tx0 − left (in (−256, 0]), cols = ceil((width − ox) / 256), the same for rows. The
mosaic columns are NULL on every row when the widened box passes ±85.0511° or ±180°, z < 0, or the
tiles fall off the world; JS then checks the rows agree, the mosaic covers the frame exactly from
tiles on the world (else `query_failed`), and drops it over 64 tiles. `max_zoom` is
`routing.basemap.max_zoom` when Story 15.9's block sets it (0 to 19), else 19. No `*` in any step:
the guard refuses a wildcard when columns are forbidden. The archetype takes `points` only.

- **T3 profile change:** add the 4 columns to `sql.forbidden_columns` and a new `routing:` block
  (coordinates, speed_kmh, detour_factor, min_travel_minutes = 5). The profile JSON Schema rejects
  unknown keys, so the schema changes too (profiles/**).
- **T3 kit change** (computed: `kit/runtime/data/**` is an engine T3 floor): `travelMatrix` in
  kit/runtime/data. A test must prove no other caller can drop a forbidden column. `mapPoints`
  (Story 15.2) is the same kind of change and gets the same tests.

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
  because each other zone crew has one morning-only stop placed so nothing can start before noon
  ahead of it, leaving the morning-only orphan no in-zone slot. (Amended 2026-10-26, Story 14.2:
  the zone's real load on as_of+3 is too small for any crew-day to sit near 23:00. Answer
  unchanged: 5 / 1 / 0.)

**Amended 2026-10-26 (routing-streetmap, Story 15.7):** the move to Columbus changes the drive
times (cos(40° + n) ≠ cos(−40° + n)), so 15.7 re-computes S1, S2 and S3 from `travelMatrix` and
re-pins `targets.json` `routing` and the `data.md` truths. The shapes must hold: S1 optimized ≤
booked with 0 hard breaks; S2 the afternoon gap on crew 2 at as_of+2; S3 5 / 1 / 0. If one
breaks, the plant is adjusted, never the engine, and the PR says so. The S1 booked minutes and
S2's top property and count may change; the 14-day stop count should not.

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
- **Audience:** output is for dispatchers and crew leads (a crew lead sees only their own crew):
  crew names, client name, city, times. Never coordinates, street address or postal code as text.
  Drive minutes are fine (history already has them). The map image shows approximate locations and
  is allowed only inside the routing modal (SPEC constraints, changed 2026-10-26).
- **Squeezed days:** about 30 historical crew-days exceed the day. The future generator must keep
  every crew-day within 06:00-23:00 or squeeze it, and S3's planted morning-only stops must fit exactly.
