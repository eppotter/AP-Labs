---
status: draft
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - docs/planning/specs/spec-routing/SPEC.md
  - docs/planning/specs/spec-routing/data-design.md
  - docs/planning/planning-artifacts/architecture-routing.md
  - docs/planning/planning-artifacts/architecture-runtime.md
---

# AP-Labs - Epic Breakdown: route optimization

**Status: drafted, awaiting `approve plan routing`.** Nothing is built until Ely types it.

## Overview

The routing spec (`SPEC.md`, standing in for a PRD) and SQLsmith's `data-design.md`, broken into epics (phases) and stories (one PR each). Sequencing (Ely): the generic engine goes into the template first, on synthetic test fixtures; Brightside gets it only once the engine is built. Epics continue at 12. Stories cite `architecture-routing.md` (AD-R1 to AD-R11) and the runtime ADs they inherit.

Estimates: **S** about half a day, under ~300 lines; **M** about a day; **L** up to two days. 13 stories: 3 S, 9 M, 1 L.

Computed tiers (`APLABS_PROFILE=$PWD/profiles/brightside/profile.yml node kit/lib/tier <paths>`, 2026-10-26):

| Epic | Tier | Stories at T2 or T3 |
|---|---|---|
| 12 | T2 declared (computes T1) | all: 13.3 adds `kit/runtime/routing/**` as T2, so Epic 12 runs at a declared T2 |
| 13 | T3 | 13.1, 13.2, 13.3 |
| 14 | T3 | 14.4 (`profiles/brightside/context/data.md`); 14.1 computes T1, treated as T2 |

### Architect T3 review, round 1 (2026-10-26)

Applied: typed coordinate columns and fixed-text errors (P1); `travelMatrix` inside `createData`, a capped rectangle, kind-prefixed node ids; unplaced over hard breaks; aim-finish in its own cost position; the gap definition and candidate exclusions; shifted-stop rows and all-crews-out; crew "out" in the adapter; determinism across TZ and DST; the protected-columns header; GRD-002 re-sign. Resolutions (a)–(e): S2 is the afternoon gap on crew 2 at as_of+2; `flexible` set by the adapter; S1 pins booked minutes; S3 reports 5 / 1 / 0; Epic 12 at a declared T2.

### Deferred (DEP notes; not ledger rows)

- **DEP: MotherDuck republish** of the v4 fixture (new tables and columns). Owner: Ely (a credentialed human step, runtime AD-18).
- **DEP: Slack audience and resource key** for a routing module. Owner: Dana Reyes.
- **Fork-guide note:** a fork on an older kit rejects a `routing:` block (`additionalProperties: false`); update the kit first.

**Shared files (never build these in parallel):** `kit/runtime/routing/index.js` and `contract.js` (12.1–12.5, strictly in order); `kit/runtime/sdk/index.js` and `test/unit/engine-boundary.test.js` (12.1, 13.2); `kit/lib/profile` + schema (13.1 before 13.2 and 13.3); `examples/brightside/fixture/{generate.js,lib/tables.js,lib/routing.js,schema.sql,seed.json,targets.json}` (14.1 before 14.2). 13.3 must merge before 14.1 so the coordinate columns are forbidden before they exist. Epic 13 may run alongside Epic 12 after 12.1 (no shared files except `engine-boundary.test.js`: the later builder merges main first).

## Requirements Inventory

### Functional Requirements

- FR1: Optimize a day: per crew, stop order and start times, no hard rule broken, preferred crew kept where possible, drive time no worse than the booked order. (CAP-1)
- FR2: Place a broken day's orphaned stops on crews in the field with a slot, or list them unplaceable with a reason. (CAP-2)
- FR3: Offer a gap up to five ranked candidates from the next 14 days, each with a reason. (CAP-3)
- FR4: Rules in a registry: hard/soft, weight; a new rule needs no solver edit. (CAP-4)
- FR5: Drive time through one estimator interface, haversine now. (CAP-5)
- FR6: Every row explains itself; cross-zone moves only as flagged recommendations. (CAP-6)
- FR7: Brightside's fixture gains coordinates, a future schedule, rules and absences, deterministically, with routing truths. (CAP-7)

### NonFunctional Requirements

- NFR1: Deterministic: same input, same output; no LLM; integer arithmetic (AD-R5, AD-R6).
- NFR2: Suggest only; no writes (AD-R11).
- NFR3: Coordinates never leave `travelMatrix`; addresses stay forbidden (AD-R9).
- NFR4: Offline tests from `test/fixtures/` (engine) or `examples/brightside/**` (example).
- NFR5: Data reads go through the query runner (runtime AD-9).

### Additional Requirements

- Profile `routing:` block and schema change (AD-R10); `RoutingFault` in `kit/runtime/errors.js` (runtime AD-17).
- Future schedule in a separate `scheduled_visits` table so `integrity-no-date-after-as-of` keeps its scope (data-design §2).

### UX Design Requirements

None: Slack UX is deferred. The CLI in 14.5 prints plain text for a dispatcher.

### FR Coverage Map

| FR | Stories |
|---|---|
| FR1 | 12.3, 14.4 |
| FR2 | 12.4, 14.4 |
| FR3 | 12.5, 14.4 |
| FR4 | 12.2 |
| FR5 | 12.1, 13.2 |
| FR6 | 12.3, 12.4, 12.5, 14.5 |
| FR7 | 13.3, 14.1, 14.2, 14.3, 14.4 |

## Epic List

### Epic 12: A routing engine any field-service fork can call
Pure engine on synthetic fixtures. T1. Stories 12.1–12.5.

### Epic 13: Coordinates read safely
The governed data path: profile block, forbidden columns, `travelMatrix`. T3. Stories 13.1–13.3.

### Epic 14: Brightside's dispatcher gets a suggested plan
Fixture, adapter, truths, a read-only CLI. T3 (14.4). Stories 14.1–14.5.

## Epic 12: A routing engine any field-service fork can call

### Story 12.1: The input contract and the travel port
**Implements:** FR5, NFR1 · **Estimate:** M · **Tier:** T1 · **Architecture:** AD-R1, R2, R3
**Files:** `kit/runtime/routing/{contract,travel,index}.js`, `kit/runtime/errors.js`, `kit/runtime/messages.js`, `test/unit/engine-boundary.test.js`, `test/unit/runtime-routing-travel.test.js`, `test/fixtures/routing/day-small.json`

**Given** a synthetic day in `test/fixtures/routing/day-small.json` **When** `validateInput` runs **Then** it returns the input unchanged, and each malformed field (missing stopId, float minutes, unknown crew, a node id without a `property:`/`crew:` prefix, a non-ISO date) throws `RoutingFault` naming the field (one test each)
**And** the routing tests run under two `TZ` values across 2026-11-01 with identical output
**Given** a matrix of rows `{from_node, to_node, minutes}` **When** `travel.fromMatrix` builds `travel` **Then** known pairs return their minutes and a missing pair throws `RoutingFault`, never 0
**And** `engine-boundary.test.js` fails if any `kit/runtime/routing` file requires a path outside `scoring`, `errors` and itself, or names `examples/`

### Story 12.2: The rule registry and the v1 rules
**Implements:** FR4 · **Estimate:** M · **Tier:** T1 · **Architecture:** AD-R4
**Files:** `kit/runtime/routing/{rules,index}.js`, `test/unit/runtime-routing-rules.test.js`, `test/fixtures/routing/rules-*.json`

**Given** each v1 rule (`crew-day-limits`, `day-of-week`, `time-of-day`, `preferred-crew`, `aim-finish`) **When** checked on a passing and a failing slot **Then** `ok` matches and the failing reason is plain words (unit test per rule)
**Given** a stop rule instance with `strength: 'soft'` on `day-of-week` **Then** it is soft; with none it is hard; `crew-day-limits` refuses a soft override
**Given** a malformed rule (no `check`, bad strength, weight 0 on a soft rule, duplicate id) **When** registered **Then** `register` throws `RoutingFault`

### Story 12.3: Optimize a day
**Implements:** FR1, FR6, NFR1 · **Estimate:** L · **Tier:** T1 · **Architecture:** AD-R5, R6, R11
**Files:** `kit/runtime/routing/{optimize,index}.js`, `test/unit/runtime-routing-optimize.test.js`, `test/fixtures/routing/{known-optimal,zigzag,locked,contradictory-rules}.json`

**Given** `known-optimal.json` (one crew, ≤ 7 stops) **When** optimized **Then** drive minutes equal a brute-force optimum computed in the test
**Given** `zigzag.json` **Then** no hard rule breaks, drive minutes ≤ booked, every row has a `reason`, and running twice gives identical JSON
**Given** a booked order already optimal and breaking no hard rule **Then** the booked order comes back with "booked order is already best"; a booked order that breaks a hard rule is never returned
**Given** `contradictory-rules.json` (a stop whose hard rules cannot all hold) **Then** it is in `unplaced[]` with a reason and no returned row breaks a hard rule
**And** aim-finish minutes are compared after drive time, never summed with the preferred-crew penalty
**Given** a test registers a fixture-only rule (no engine edit) **Then** the solver honours it
**And** locked stops keep crew and start; no stop moves across zones; the budget is an evaluation count (a test with budget 0 returns the construction result)

### Story 12.4: A broken day: place the orphans
**Implements:** FR2, FR6 · **Estimate:** M · **Tier:** T1 · **Architecture:** AD-R7
**Files:** `kit/runtime/routing/{change,index}.js`, `test/unit/runtime-routing-change.test.js`, `test/fixtures/routing/{sick-crew,cross-zone,all-crews-out}.json`

**Given** `sick-crew.json` (one crew unavailable) **When** `placeOrphans` runs **Then** every orphan is placed with no hard rule broken on the receiving crew, or is in `unplaced[]` with a reason; existing stops keep their order, and each one whose time shifts has a `shifted[]` row "call to confirm the new time"
**Given** `all-crews-out.json` **Then** every stop is in `unplaced[]` with a reason
**Given** `cross-zone.json`, where the only fit is another zone **Then** it appears in `moves[]` with `crossZone: true, recommendation: true` and in no crew's plan; it is not counted as placed

### Story 12.5: Fill a gap with ranked candidates
**Implements:** FR3, FR6 · **Estimate:** M · **Tier:** T1 · **Architecture:** AD-R8
**Files:** `kit/runtime/routing/{gapfill,index}.js`, `test/unit/runtime-routing-gapfill.test.js`, `test/fixtures/routing/{gap,gap-tight,gap-adjacent,gap-two}.json`

**Given** `gap.json` with a planted best fill, a closer decoy whose window misses the gap, and a decoy that breaks cadence **When** `fillGap` runs **Then** the best fill ranks first, both decoys are excluded, at most 5 rows return, each with score and reason, ties by stopId
**And** the cancelled property and any property already visited on the gap date are never offered
**Given** `gap-tight.json` (no candidate's travel in + service + travel out fits) **Then** the list is empty with a reason; no candidate ever shifts a later stop
**Given** `gap-adjacent.json` (two adjacent cancellations) **Then** they form one gap
**Given** `gap-two.json` (two separate gaps on one crew sharing a candidate) **Then** its rows carry `alsoOfferedFor[]`, and passing `exclude[]` removes it
**And** ranking goes through `scoring.rank()` (a test spies on it); overridden weights that fail `checkScoring` throw

## Epic 13: Coordinates read safely

### Story 13.1: The profile's `routing:` block
**Implements:** FR5, FR7 · **Estimate:** S · **Tier:** T3 · **Architecture:** AD-R10, runtime AD-16
**Files:** `profiles/_schema/profile.schema.json`, `kit/lib/profile/index.js`, `test/unit/profile.test.js`, `test/fixtures/profiles/routing*.yml`

**Given** a fixture profile with a valid `routing` block **Then** it loads with defaults filled (5, 10 000 pairs, 14, 5) after the profile is hashed; an unknown key, a bad identifier, or a coordinate column missing from `sql.forbidden_columns` fails validation naming the key
**And** a profile with no `routing` block loads unchanged (existing profile tests pass)

### Story 13.2: `travelMatrix`, the one coordinate read path
**Implements:** FR5, NFR3, NFR5 · **Estimate:** M · **Tier:** T3 · **Architecture:** AD-R9, runtime AD-9
**Files:** `kit/runtime/data/{travel,index}.js`, `kit/runtime/sdk/index.js`, `test/unit/runtime-data-travel.test.js`, `test/unit/engine-boundary.test.js`, `test/fixtures/profiles/routing.yml`

**Given** a temp DuckDB with known coordinate pairs **When** `travelMatrix(fromIds, toIds)` runs **Then** it returns the from × to rectangle and minutes match hand-computed haversine × detour ÷ speed (rounded to 1e-6, then ceil, floor 5) for each pair
**Given** a profile declaring `properties.street_address` as a coordinate column **Then** `travelMatrix` refuses before running (column not INTEGER/BIGINT)
**Given** any DuckDB error **Then** it surfaces as a fixed-text `RoutingFault` (no SQL, path or value in the message)
**And** it is built inside `createData` (same guard, timeout, redaction); a test asserts the frozen data object's exact keys (no override flag, no raw connection)
**And** the result has only `from_node, to_node, minutes`; `run()` still refuses each coordinate column; no other forbidden column is dropped; more than `max_pairs` pairs is refused
**And** the sdk exports `travelMatrix` and the routing entry points; the boundary test still passes

### Story 13.3: Brightside forbids the coordinates and declares routing
**Implements:** FR7, NFR3 · **Estimate:** S · **Tier:** T3 · **Architecture:** AD-R9, R10
**Files:** `profiles/brightside/profile.yml`, `profiles/brightside/context/guardrails.md`

**Given** the Brightside profile **Then** `sql.forbidden_columns` adds `properties.geo_lat_e6`, `properties.geo_lon_e6`, `crews.base_geo_lat_e6`, `crews.base_geo_lon_e6`, and `routing` holds the generator's limits (360, 480, 1080, 1380, 15) and node sources; `tiers.T2` adds `kit/runtime/routing/**`; `npm run check && npm test` pass
**And** GRD-002 in `guardrails.md` names the four coordinate columns and is marked for Dana Reyes's sign-off again (`npm run onboard -- --status` shows it pending)

## Epic 14: Brightside's dispatcher gets a suggested plan

### Story 14.1: The fixture gains coordinates and a future schedule
**Implements:** FR7 · **Estimate:** M · **Tier:** T2 (computes T1; treated as T2) · **Architecture:** runtime AD-18, data-design §1–2
**Files:** `examples/brightside/fixture/{generate.js,schema.sql,seed.json,targets.json}`, `lib/{tables,routing,routing-rules}.js`, `seeds/{properties,crews,scheduled_visits,fixture_meta}.*`, `checks/integrity-scheduled-*.sql`, `checks/synthetic-coordinates.sql`, `__tests__/routing.test.js`

**Given** the seed **When** generated twice **Then** files are identical; GENERATOR_VERSION is 4; every existing truth and seed column is unchanged byte for byte (test diffs v3 columns)
**And** the four scheduled checks and `synthetic-coordinates` return zero rows under `kit/fixture/validate.js`; the generator refuses bad output (routing-rules mirror)
**And** `checks/synthetic-coordinates.sql` declares the four coordinate columns in its leading `-- protected-columns:` comment (`kit/fixture/validate.js` `readHeader`)

### Story 14.2: Rules, absences and the planted scenarios S1–S3
**Implements:** FR7 · **Estimate:** M · **Tier:** T1 · **Architecture:** data-design §1, §5
**Files:** same fixture files as 14.1, plus `seeds/{service_rules,staff_absences}.csv.gz`, `checks/integrity-rules.sql`

**Given** the generated fixture **Then** `service_rules` and `staff_absences` match data-design §1; S1, S2 and S3 sit at their fixed ids and dates; `integrity-rules` passes; targets live under `targets.json` `routing`, and `TRUTH_IDS` is unchanged

### Story 14.3: The Brightside adapter
**Implements:** FR1–FR3, NFR5 · **Estimate:** M · **Tier:** T1 · **Architecture:** AD-R2, data-design §4
**Files:** `examples/brightside/app/routing/{adapter.js,day.sql,candidates.sql,crews.sql}`, `__tests__/adapter.test.js`

**Given** the built fixture and a date **When** the adapter builds the input **Then** it passes `validateInput`, its SQL passes the guardrail with the four coordinate columns forbidden, rules are pivoted one row per property (no fan-out), headcount subtracts absences, a crew is `available: false` when its lead is absent or nobody is present (definition pending Dana Reyes), node ids are kind-prefixed, candidates exclude the cancelled property and properties visited on the gap date, `prevVisitDate` is the latest non-cancelled visit across history and schedule, `flexible` is true when the stop has no hard day or time rule, and travel comes only from `travelMatrix`

### Story 14.4: Routing truths that reconcile under `npm run verify`
**Implements:** FR1–FR3, FR7 · **Estimate:** M · **Tier:** T3 · **Architecture:** runtime AD-18, data-design §5
**Files:** `examples/brightside/fixture/truths/{scheduled-stops-next-14d.sql,routing.js}`, `profiles/brightside/context/data.md`

**Given** the five truths of data-design §5 as `truth` blocks (tolerance 0, owner Dana Reyes) **When** `npm run verify` runs offline **Then** all five reconcile, and no output line contains a coordinate value
**And** S1 states the booked drive minutes (from `travelMatrix`) exactly, optimized ≤ booked, 0 hard breaks; S2 is the afternoon gap on crew 2 at as_of+2; S3 reports in-zone 5 / cross-zone recommendations 1 / unplaced 0

### Story 14.5: A read-only CLI for the dispatcher
**Implements:** FR6, NFR2 · **Estimate:** S · **Tier:** T1 · **Architecture:** AD-R11
**Files:** `examples/brightside/app/routing/{cli.js,format.js}`, `__tests__/cli.test.js`

**Given** `node examples/brightside/app/routing/cli.js optimize|change|gap --day <date> [...]` **Then** it prints crew names, client names, city, times and reasons, never coordinates, addresses or postal codes, writes nothing, and exits non-zero with a plain message on bad input
