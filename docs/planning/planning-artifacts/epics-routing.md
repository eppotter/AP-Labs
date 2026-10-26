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

**Status: approved by Ely 2026-10-26 (`approve plan routing`).**

## Overview

The routing spec (`SPEC.md`, standing in for a PRD) and SQLsmith's `data-design.md`, broken into epics (phases) and stories (one PR each). Sequencing (Ely): the generic engine goes into the template first, on synthetic test fixtures; Brightside gets it only once the engine is built. Epics continue at 12. Stories cite `architecture-routing.md` (AD-R1 to AD-R17) and the runtime ADs they inherit. Epic 15 (the Slack map modal) was added 2026-10-26 on Ely's decisions; Story 14.5's CLI stays as the no-Slack test path.

Estimates: **S** about half a day, under ~300 lines; **M** about a day; **L** up to two days. 19 stories: 4 S, 12 M, 3 L.

Computed tiers (`APLABS_PROFILE=$PWD/profiles/brightside/profile.yml node kit/lib/tier <paths>`, 2026-10-26):

| Epic | Tier | Stories at T2 or T3 |
|---|---|---|
| 12 | T2 declared (computes T1) | all: 13.3 adds `kit/runtime/routing/**` as T2, so Epic 12 runs at a declared T2 |
| 13 | T3 | 13.1, 13.2, 13.3 |
| 14 | T3 | 14.4 (`profiles/brightside/context/data.md`); 14.1 computes T1, treated as T2 |
| 15 | T3 | all six: 15.1 `kit/runtime/store/**`, `kit/runtime/jobs/**`; 15.2 `kit/runtime/data/**` engine floor, `profiles/_schema/**`, `kit/lib/profile/**`; 15.3 `Dockerfile` (T3 whatever it computes) and `.github/workflows/**`; 15.4 `kit/lib/tier/**` and the access filter; 15.5 and 15.6 `profiles/**` and the guardrail sign-off gate |

### Architect T3 review, round 1 (2026-10-26)

Applied: typed coordinate columns and fixed-text errors (P1); `travelMatrix` inside `createData`, a capped rectangle, kind-prefixed node ids; unplaced over hard breaks; aim-finish in its own cost position; the gap definition and candidate exclusions; shifted-stop rows and all-crews-out; crew "out" in the adapter; determinism across TZ and DST; the protected-columns header; GRD-002 re-sign. Resolutions (a)–(e): S2 is the afternoon gap on crew 2 at as_of+2; `flexible` set by the adapter; S1 pins booked minutes; S3 reports 5 / 1 / 0; Epic 12 at a declared T2.

### Architect T3 review, round 2 (2026-10-26, Epic 15)

Decisions by the Orchestrator; folded as follows.
- **F1 (P1) map precision:** `mapPoints` is not in the sdk and only `kit/runtime/archetypes/routing-map/**` may require `kit/runtime/data/map.js` (boundary test); coordinates are snapped to a `routing.map_grid_e6` grid (default 2000) before projection; every frame spans at least `routing.map_min_span_km` (default 5); the real precision is stated in numbers in AD-R12, the SPEC map rule and the GRD-002 text (15.5). AD-R12, R13, data-design §3, 15.2.
- **F2 (P1) the upload check:** the Slack fake accepts a channel-less upload; the channel_id-required assertion moves to `deliverCsv`'s own test (`scoped-pull-run.test.js`); `runtime-channel-posts.test.js` gains an ALLOWED row for `image.js` with a guard regex; the fake gains `files.delete`. AD-R15, 15.1.
- **F3 (P1) tiers:** all Epic 15 stories are T3, each with its raising path (table above, each story). The `routing.audience` schema moves to 15.2 so one story owns Epic 15's profile changes. New DEP for the store record kind.
- **F5 file lifecycle:** no `files:read` scope; the crash window between upload and record is a named risk; ids persist in `kit/runtime/store`, the session stays in memory; files expire at 15 minutes, the sweep runs every 5, so a file lingers at most 20 (stated in GRD-002); Back-exit fallback, delete-failure and restart tests added. AD-R15, 15.1, 15.4.
- **F4 click order:** a per-session request sequence, checked before upload and before `views.update`; a superseded click abandons; a file whose update is dropped or fails is deleted at once. AD-R16, 15.4 (out-of-order and upload-then-update-fails tests).
- **F6 image path:** the hub accepts `image` only from the routing-map archetype and the dev map-check module; others refused and logged. AD-R15, 15.1.
- **F7 crew-lead filter:** filtering is before `mapPoints` and the labels read, not before every read; scope from the audience, never the select value; session bound to user and view, `crypto.randomUUID` ids; moved-on stops in full; unknown `crew_id` refused; visible candidates renumbered 1..n. AD-R16, R17, 15.4.
- **F8 adapter contract:** `input({ day, view, scope })` and `labels({ day, nodeIds })` defined; the fixture adapter and Brightside's implement them. AD-R16, 15.4, 15.5.
- **F9 Slack file:** live-check items (5)–(7); fixed filename `route-map.png` and title `Route map`; the DM fallback keeps the lifecycle, needs its own ALLOWED row, and shows in notification previews and the Files list, which Dana is asked about. AD-R15, 15.1, DEP.
- **F10 strict fake:** unknown or deleted `slack_file`, over 100 options, option text over 75 characters, malformed `initial_date`, `ratelimited` on upload and delete; selects in an `actions` block. AD-R16, 15.4 (with a `ratelimited` error-exit test).
- **F11 rasterizer:** a CI container smoke step (`.github/workflows/ci.yml`) renders inside the built image; needs the `workflow` token scope; untested until CI runs. Also a lazy require whose failure is a fixed-text fault shown by the error exit, an offline lockfile test for `@resvg/resvg-js-linux-x64-gnu`, and a 1 MB PNG cap. AD-R14, 15.3.
- **F12 prod gate:** 15.5 ships `environments: ["dev"]`; Story 15.6 is the one-line PR that adds prod after GRD-002 is signed.
- **F13 engine floor:** 15.4 adds `kit/runtime/archetypes/routing-map/audience.js` and `kit/runtime/slack/image.js` to `ENGINE_T3` in `kit/lib/tier`.
- **F14 sweep:** a registered engine job, `kit/runtime/jobs/sweep-map-files.js`, in 15.1. It runs whenever a map module is enabled, regardless of `jobs.enabled` and `APLABS_JOBS_OFF`; if it cannot run, the module shows "not available" and opens no modal (fail closed, tested in 15.1 and 15.4).
- **F15 testable ACs:** per-view assertions of drawn features and exact text rows; spies for the points object and `x`/`y` keys instead of a text scan, the scan kept for micro-degree values and address fixtures; the alt text from one fixed template, asserted exactly. AD-R15, 15.1, 15.4.
- **F16 mapPoints inputs:** duplicate ids refused; unknown ids and null coordinates omitted; a missing node is an engine fault at the error exit. AD-R13, data-design §3, 15.2, 15.4.
- **F17 date range:** the date picker is bounded to [as_of − 7 days, as_of + `gap_fill.horizon_days`]; the server refuses other dates with a plain message. AD-R16, 15.4.
- **F18 blocking:** Epic 15 blocks on Dana's audience list only at 15.5.

### Deferred (DEP notes; not ledger rows)

- **DEP: MotherDuck republish** of the v4 fixture (new tables and columns). Owner: Ely (a credentialed human step, runtime AD-18).
- **DEP (blocker for 15.5, no longer a deferral): Slack audience and resource keys** for the routing module: which people are dispatchers (all crews), which are crew leads and of which crew, and the two resource keys (AD-R17). Owner: Dana Reyes. 15.1 to 15.4 build on fixture profiles and do not wait for it; 15.5 cannot merge without it. The Orchestrator asks for it with the other up-front questions.
- **DEP (blocker for 15.6): Dana Reyes signs the map image rule** as an update to GRD-002 (AD-R12, T3 guardrail change), with its precision and linger numbers, and the DM fallback too if 15.1 needs it (the image would then show in push notification previews and the person's Files list). Owner: Dana Reyes, via Ely. 15.5 merges with the rule marked pending; 15.6 (prod) waits for the signature.
- **DEP (blocker for 15.4): the 15.1 live check.** Ely opens the dev-only map check in dev Slack and reports what he sees. Owner: Ely.
- **DEP: dependency review of `@resvg/resvg-js`** (licence, platform packages, Docker image) in 15.3. Owner: architect review, Ely approves.
- **DEP: a new record kind in `kit/runtime/store`** for uploaded map file ids and their expiry (15.1). Approver: Ely.
- **Named risk (accepted, F5):** if the process dies between a map upload and recording its file id, that file is never swept. It is shared nowhere, but it stays in Slack's file storage until someone removes it by hand. Without `files:read` the kit cannot find it. The window is one Slack call long.
- **Fork-guide note:** a fork on an older kit rejects a `routing:` block (`additionalProperties: false`); update the kit first.

**Shared files (never build these in parallel):** `kit/runtime/routing/index.js` and `contract.js` (12.1–12.5, strictly in order); `kit/runtime/sdk/index.js` (12.1, 13.2); `test/unit/engine-boundary.test.js` (12.1, 13.2, 15.2, 15.3, 15.4); `kit/lib/profile` + schema (13.1 before 13.2 and 13.3; 13.1 before 15.2); `kit/runtime/data/index.js` (13.2 before 15.2); `kit/runtime/slack/{hubs,image}.js` and `test/fixtures/fake-slack.js` (15.1 before 15.4); `profiles/brightside/profile.yml` and `context/guardrails.md` (13.3 before 15.5); `examples/brightside/app/modules/routing/manifest.json` (15.5 before 15.6); `examples/brightside/fixture/{generate.js,lib/tables.js,lib/routing.js,schema.sql,seed.json,targets.json}` (14.1 before 14.2). 13.3 must merge before 14.1 so the coordinate columns are forbidden before they exist. Epic 13 may run alongside Epic 12 after 12.1 (no shared files except `engine-boundary.test.js`: the later builder merges main first). Epic 15 order: 15.1 and 15.2 may run in parallel (the later merges main first for `engine-boundary.test.js`); 15.3 after Epic 12; 15.4 after 15.1's live check, 15.2 and 15.3; 15.5 after 15.4 and Epic 14; 15.6 after Dana signs GRD-002.

## Requirements Inventory

### Functional Requirements

- FR1: Optimize a day: per crew, stop order and start times, no hard rule broken, preferred crew kept where possible, drive time no worse than the booked order. (CAP-1)
- FR2: Place a broken day's orphaned stops on crews in the field with a slot, or list them unplaceable with a reason. (CAP-2)
- FR3: Offer a gap up to five ranked candidates from the next 14 days, each with a reason. (CAP-3)
- FR4: Rules in a registry: hard/soft, weight; a new rule needs no solver edit. (CAP-4)
- FR5: Drive time through one estimator interface, haversine now. (CAP-5)
- FR6: Every row explains itself; cross-zone moves only as flagged recommendations. (CAP-6)
- FR7: Brightside's fixture gains coordinates, a future schedule, rules and absences, deterministically, with routing truths. (CAP-7)
- FR8: A Slack modal shows a plain map of the route and switches between four views (booked vs optimized, before vs after a change, a zone's crews, gap fill). (CAP-8)
- FR9: Dispatchers see every crew; a crew lead sees only their own, from a profile mapping. (CAP-9)

### NonFunctional Requirements

- NFR1: Deterministic: same input, same output; no LLM; integer arithmetic (AD-R5, AD-R6); same map model, same SVG (AD-R14).
- NFR2: Suggest only; no writes (AD-R11).
- NFR3: Latitude and longitude never leave `travelMatrix` and `mapPoints`; no location ever as text; the map image only in the routing modal, uploaded privately (AD-R9, R12, R13, R15); addresses stay forbidden.
- NFR6: Slack's 3-second ack is always met: acknowledge, then draw and update (AD-R16).
- NFR4: Offline tests from `test/fixtures/` (engine) or `examples/brightside/**` (example).
- NFR5: Data reads go through the query runner (runtime AD-9).

### Additional Requirements

- Profile `routing:` block and schema change (AD-R10); `RoutingFault` in `kit/runtime/errors.js` (runtime AD-17).
- Future schedule in a separate `scheduled_visits` table so `integrity-no-date-after-as-of` keeps its scope (data-design §2).
- New dependency `@resvg/resvg-js` for SVG to PNG, after review (AD-R14).
- Profile `routing.max_points` and `routing.audience` (AD-R13, R17).

### UX Design Requirements

- The CLI in 14.5 prints plain text for a dispatcher (the no-Slack test path).
- The routing modal (Epic 15): opens from the hub menu; a view select, a date picker and a crew or zone select; one map image with a short text list under it (crew, client name, city, start time, drive minutes, reason); every way out (Back, Close, an error, an expired trigger, an expired session, access withdrawn) is listed in the AC with a test (AGENTS.md).

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
| FR8 | 15.1, 15.2, 15.3, 15.4, 15.5, 15.6 |
| FR9 | 15.2, 15.4, 15.5 |

## Epic List

### Epic 12: A routing engine any field-service fork can call
Pure engine on synthetic fixtures. T1. Stories 12.1–12.5.

### Epic 13: Coordinates read safely
The governed data path: profile block, forbidden columns, `travelMatrix`. T3. Stories 13.1–13.3.

### Epic 14: Brightside's dispatcher gets a suggested plan
Fixture, adapter, truths, a read-only CLI. T3 (14.4). Stories 14.1–14.5.

### Epic 15: Dispatchers and crew leads see the route on a map in Slack
A private map image in a routing modal, four views, filtered by audience. T3 (computed 2026-10-26). Stories 15.1–15.6. Ely's suggested shape had four stories; `mapPoints` is split from the spike into its own story (15.2) because it is a T3 engine read like 13.2, while the spike is a live check, and the two share no files; 15.6 is the one-line prod switch that waits for Dana's GRD-002 signature (F12).

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

## Epic 15: Dispatchers and crew leads see the route on a map in Slack

Added 2026-10-26 (Ely). Only 15.5 waits for Dana Reyes's audience list (F18); 15.6 waits for her GRD-002 signature. Tiers per story computed 2026-10-26 with `node kit/lib/tier` on the files listed; all are T3 (F3).

### Story 15.1: Spike: a private image in a modal (live check)
**Implements:** FR8 · **Estimate:** M · **Tier:** T3 (`kit/runtime/store/**` new record kind, `kit/runtime/jobs/**` the sweep job) · **Architecture:** AD-R12, R15, R16
**Files:** `kit/runtime/slack/{image,hubs}.js`, `kit/runtime/store/index.js`, `kit/runtime/jobs/{index,sweep-map-files}.js`, `test/fixtures/fake-slack.js`, `test/unit/runtime-slack-image.test.js`, `test/unit/runtime-hubs.test.js`, `test/unit/runtime-store.test.js`, `test/unit/runtime-jobs.test.js`, `test/unit/runtime-sweep-map-files.test.js`, `test/unit/runtime-channel-posts.test.js`, `test/unit/scoped-pull-run.test.js`, `test/fixtures/routing-map/test-pattern.png`, `examples/brightside/app/modules/map-check/{manifest.json,handler.js,test-pattern.png}`

**Given** a PNG **When** `image.js` uploads it **Then** it calls `files.uploadV2` with no channel, filename `route-map.png` and title `Route map`, returns the file id, and builds an image block with `slack_file: { id }`; it never sets `image_url`
**And** the alt text comes from one fixed template, `Route map: <view label>, <crew label>, <n> stops`, and the test asserts the exact string (F15)
**And** `runtime-channel-posts.test.js` gains an ALLOWED row for `kit/runtime/slack/image.js` whose guard regex proves the upload passes no `channel_id`, `channel` or `channels`
**And** each file id is recorded in `kit/runtime/store` (a new record kind, DEP above) with a 15-minute expiry before the image is shown; a view switch deletes the previous file and `view_closed` deletes all of a session's files
**And** the sweep `kit/runtime/jobs/sweep-map-files.js` is a registered engine job: it runs at start-up and every 5 minutes and deletes every expired record's file, so no file outlives its upload by more than 20 minutes (tests freeze every clock the job and the store read)
**And** the sweep runs whenever a module that uploads map images is enabled, regardless of the profile's `jobs.enabled` and `APLABS_JOBS_OFF` (test with each switched off); if it cannot run (no store, no Slack client), the module shows "not available" and opens no modal (fail closed, test)
**And** a failed `files.delete` keeps the record, logs Slack's error code only, and the next sweep retries it (test); after a restart, a new process with the same store deletes the files a previous process recorded (test)
**And** a reply may carry `image: { png, alt }` only from the `routing-map` archetype or the dev-only `map-check` module; the hub uploads it and renders the block in the module view (`pushedView`), and the PNG bytes are never logged. An `image` in any other module's reply is refused, nothing is uploaded, and the refusal is logged (test, F6)
**And** the Slack fake accepts an upload with no channel (an unshared file, as Slack does) and gains `files.delete` (rejects an unknown id); the channel_id-required assertion moves from the fake into `deliverCsv`'s own test in `scoped-pull-run.test.js`. Otherwise the fake rejects what Slack rejects for every field set: `files.uploadV2` without content or filename, an image block with both `image_url` and `slack_file` or without alt text, alt text over 2000 characters, an expired trigger
**And** the dev-only `map-check` module (`environments: ["dev"]`) shows a fixed synthetic test pattern (no client data). Exits, one test each: Back returns to the hub menu and deletes the file on `view_closed`, and if no `view_closed` arrives the sweep deletes it within 20 minutes of upload (both paths tested); Close closes and deletes the file; an upload failure shows a plain message in the view with Back; an expired trigger takes the hub's existing path
**Live check (Ely, dev Slack; untested until run, named so in the PR):** (1) the image shows in the modal; (2) the file appears in no channel; (3) `view_closed` arrives on Back and on Close; (4) after `files.delete` the file is gone; (5) clicking the image and trying to open, share or download it, and what each allows; (6) a user outside the audience searches Files for `route-map.png` and finds nothing; (7) `views.update` immediately after the upload shows the image, and if not, whether one retry does (F9). The outcome is written under this story. If (1) fails, AD-R15's fallback applies (same delete lifecycle, its own ALLOWED row), 15.4's AC change to match, Ely is told, and Dana Reyes is asked whether the image may sit in the person's DM, where it shows in push notification previews and their Files list (DEP above). If (3) fails on Back, the sweep is Back's delete path (20 minutes at most) and no AC changes.

### Story 15.2: `mapPoints`, snapped pixel positions for the map, and the profile keys
**Implements:** FR8, FR9, NFR3 · **Estimate:** M · **Tier:** T3 (`kit/runtime/data/**` engine floor, `profiles/_schema/**`, `kit/lib/profile/**`) · **Architecture:** AD-R10, R13, R17, runtime AD-9
**Files:** `kit/runtime/data/{map,index}.js`, `profiles/_schema/profile.schema.json`, `kit/lib/profile/index.js`, `test/unit/runtime-data-map.test.js`, `test/unit/runtime-data-travel.test.js`, `test/unit/profile.test.js`, `test/unit/engine-boundary.test.js`, `test/fixtures/profiles/routing.yml`, `test/fixtures/profiles/routing-audience.yml`

**Given** a temp DuckDB with known coordinates **When** `mapPoints(nodeIds, frame)` runs **Then** it returns only `node, x, y` as integers inside the frame, matching hand-computed positions: coordinates snapped to the `routing.map_grid_e6` grid first, then fit to the requested nodes' box widened to at least `routing.map_min_span_km` on each side around its centre, padded, centred, north up
**And** two places in one grid cell get the same pixel; a box smaller than the minimum span is widened (so one node, or a cluster, sits at the centre of a 5 km frame)
**Given** a frame out of bounds, a node id without a kind prefix, a duplicate node id, or more than `routing.max_points` ids **Then** it refuses before running
**Given** an unknown node id, or a node whose coordinate is null **Then** that node is left out of the result and the rest return (F16)
**Given** a profile declaring `properties.street_address` as a coordinate column **Then** it refuses (not INTEGER/BIGINT); any DuckDB error is a fixed-text `RoutingFault`
**And** it shares the data layer's guard, timeout and redaction but is not a key of the data object modules and adapters receive: the exact-keys test is unchanged from 13.2; `run()` still refuses every coordinate column; no other forbidden column is dropped
**And** the sdk does not export `mapPoints` (test); the boundary test fails if any file outside `kit/runtime/archetypes/routing-map/**` (and `kit/runtime/data/**` itself) requires `kit/runtime/data/map.js`; `kit/runtime/routing` still never requires `data`
**And** the profile accepts `routing.max_points` (default 500), `routing.map_grid_e6` (default 2000, a smaller value refused) and `routing.map_min_span_km` (default 5, a smaller value refused), and `routing.audience` (AD-R17: an undeclared key, a `user` not in `users`, the same user twice or a crew lead without the `own_crew` grant fails, naming the key); an unknown key fails

### Story 15.3: The map renderer: four views, SVG to PNG
**Implements:** FR8, NFR1 · **Estimate:** L · **Tier:** T3 (`Dockerfile`, treated as T3 whatever it computes; `.github/workflows/**`) · **Architecture:** AD-R14
**Files:** `kit/runtime/routing-map/{svg,png,glyphs,index}.js`, `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md`, `Dockerfile`, `.github/workflows/ci.yml`, `scripts/smoke-routing-map.js`, `test/unit/runtime-routing-map-svg.test.js`, `test/unit/runtime-routing-map-png.test.js`, `test/fixtures/routing-map/{compare,change,zone,gap}.json`, `test/unit/engine-boundary.test.js`

**Given** each fixture model **When** `renderSvg(view, model)` runs twice **Then** the SVG is byte-identical, and it has no `<text>` element, no font, no external reference and no `href`
**Given** `compare.json` **Then** two panels (booked, optimized), numbered stops, one line color per crew, the base marked; `change.json`: moved stops ringed, the cross-zone recommendation dashed, unplaced stops hollow; `zone.json`: one color per crew and each zone as its padded hull; `gap.json`: the gap's two neighbours marked and up to five candidates as diamonds numbered by rank
**Given** a model with a node missing from the points, more than 99 stops on a crew, or an unknown view **Then** it throws `RoutingFault`
**When** `png.js` rasterizes an SVG twice **Then** the bytes match and the PNG has the frame's width and height; system fonts are off
**Given** a PNG over 1 MB **Then** `png.js` refuses it with a fixed-text `RoutingFault` (F11)
**And** `png.js` is the only file that requires `@resvg/resvg-js`, and it requires it lazily on first use; a load failure becomes a fixed-text `RoutingFault` (a test stubs the require), which 15.4's error exit shows
**And** an offline test asserts `package-lock.json` contains `@resvg/resvg-js-linux-x64-gnu`, the package the Docker image (`linux/amd64`, glibc, `npm ci --ignore-scripts`) installs
**And** `routing-map` requires nothing outside `errors` and itself (boundary test); no client name in the directory
**And** the dependency passes review before merge (DEP above)
**And** CI gains a container smoke step: it builds the Docker image and runs `scripts/smoke-routing-map.js` inside it, which rasterizes a fixture SVG and checks the PNG's width and height. Only CI can run it: named as untested in the builder's report and the PR, and the first CI run is its test. `npm run test:slow` runs before commit (a `ci.yml` change). The push needs the `workflow` token scope; if it is refused, the story stops and posts `--kind blocked` (AGENTS.md)

### Story 15.4: The routing-map archetype: modal, view switching, audience
**Implements:** FR8, FR9, NFR3, NFR6 · **Estimate:** L · **Tier:** T3 (`kit/lib/tier/**`, and the access filter: `audience.js` and `image.js` join `ENGINE_T3`) · **Architecture:** AD-R12, R15, R16, R17, runtime AD-1
**Files:** `kit/runtime/archetypes/routing-map/{index,audience,views,session}.js`, `kit/runtime/schema/module.schema.json`, `kit/runtime/registry/index.js`, `kit/runtime/slack/{hubs,image}.js`, `kit/runtime/messages.js`, `kit/lib/tier/index.js`, `test/unit/tier.test.js`, `test/fixtures/fake-slack.js`, `test/fixtures/routing-map/adapter.js`, `test/fixtures/profiles/routing-audience.yml`, `test/unit/runtime-routing-map-archetype.test.js`, `test/unit/runtime-routing-map-audience.test.js`, `test/unit/runtime-registry.test.js`, `test/unit/engine-boundary.test.js`

**Given** `kit/lib/tier` **Then** `ENGINE_T3` includes `kit/runtime/archetypes/routing-map/audience.js` and `kit/runtime/slack/image.js`, and `tier.test.js` proves each computes T3 under any profile

**Given** a module with `archetype: "routing-map"` and an `adapter` **When** the registry loads it **Then** it validates; a missing adapter or an unknown field fails naming the field
**And** `test/fixtures/routing-map/adapter.js` implements `input({ day, view, scope })` and `labels({ day, nodeIds })` as AD-R16 defines them; `labels` returns only crew name, client name and city (a test fails on any other field) (F8)
**Given** the sweep cannot run (no store, no Slack client) **Then** the routing module shows "not available" and opens no modal (test)
**Given** a dispatcher clicks Open **Then** the ack goes first, the view is pushed with "Loading…" inside the trigger's life, and the map follows by `views.update`: one image block, an `actions` block with a view select, a date picker and a crew or zone select, and a text list (crew, client name, city, start, drive minutes, reason)
**And** the date picker is bounded to [as_of − 7 days, as_of + `gap_fill.horizon_days`]; a date outside it, sent by a crafted action, is refused with a plain message and nothing is read (test, F17)
**When** they pick another view **Then** the click is acked at once, the view shows "Drawing the map…", then the new map; the previous file is deleted
**Given** two clicks whose work finishes out of order **Then** the newer request's map is the one shown, the older one checks the per-session sequence before upload and before `views.update`, abandons, and uploads nothing (test, F4)
**Given** an upload that succeeds and a `views.update` that then fails or is dropped on `hash_conflict` **Then** that file is deleted at once (test, F4)
**And** per view, the test asserts the 15.3 fixture's drawn features and the exact text-list rows: `compare`, both panels and booked and optimized drive minutes; `change`, moved stops, the cross-zone recommendation and unplaced stops, each with its row; `zone`, one color per crew and every crew's rows; `gap`, the gap and up to five ranked candidates with their reasons (F15)
**Given** a crew lead (`own_crew` grant and a `crew_leads` row) **Then** every view holds only their crew: the adapter gets their `scope`, the labels SQL is filtered by it, `mapPoints` is called with only their crew's node ids (a spy checks), the text list names no other crew's customer, stops moved off show as "moved to another crew", stops moved onto their crew from elsewhere show in full, and gap candidates on other crews are counted only, with the visible ones renumbered 1..n (F7)
**And** a lead's action carrying another crew's id or a zone still yields only their crew: scope comes from the audience, never from the select value (test)
**And** the session is bound to the user id and the view id; a click from another user or another view is refused (test); session ids come from `crypto.randomUUID`
**Given** a person with `own_crew` and no `crew_leads` row, or a `crew_leads` row whose `crew_id` matches no crew **Then** they get the configuration refusal, never an empty map, it is logged, and nothing is drawn
**And** access is re-checked on every click; nothing goes to the LLM
**And** spies on the logger, every Slack call and every error assert that none holds the points object or an `x`/`y` key; a scan of the same records finds none of the fixture's micro-degree coordinate values and none of its address or postal-code fixtures (F15)
**Exits, one test each:** Back returns to the hub menu and deletes the session's files on `view_closed`, or through the sweep within 20 minutes when none arrives (both paths tested, per 15.1's live check); Close does the same; an error shows a plain message in the view with Back, tested for data unavailable, an engine fault, a node missing from `mapPoints`, a render failure, the rasterizer failing to load, an upload failure and Slack's `ratelimited` on `files.uploadV2` and on `files.delete`; an expired trigger on Open takes the hub's existing path; an expired session (15 minutes) says "this map has expired, go back and open Routing again"; access withdrawn mid-session shows the refusal in the view
**And** the Slack fake rejects what Slack rejects for every field set (AD-R16's list, including an unknown or deleted `slack_file` id, more than 100 `static_select` options, option text over 75 characters and a malformed `initial_date`, and answering `ratelimited`) (F10), so a test passing here would pass against Slack

### Story 15.5: Brightside's routing module, its audience and the guardrail sign-off
**Implements:** FR8, FR9 · **Estimate:** M · **Tier:** T3 (`profiles/**`, guardrails); adds `kit/runtime/routing-map/**` and `kit/runtime/archetypes/routing-map/**` to Brightside's T2 row · **Architecture:** AD-R12, R17
**Files:** `examples/brightside/app/modules/routing/manifest.json`, `examples/brightside/app/routing/{adapter.js,labels.sql}`, `examples/brightside/app/routing/__tests__/module.test.js`, `examples/brightside/app/modules/map-check/**` (removed), `profiles/brightside/profile.yml`, `profiles/brightside/context/guardrails.md`

**Given** the Brightside profile **Then** it declares the two routing resource keys, the dispatchers' and crew leads' grants and `routing.audience.crew_leads` exactly as Dana Reyes confirmed (DEP above; this story waits for it); `npm run check && npm test` pass
**And** the module manifest has `environments: ["dev"]` only (F12); prod is Story 15.6
**And** GRD-002 states the map image rule (AD-R12) in plain words with its numbers: the image reveals approximate locations, each place rounded to a grid cell about 220 m north-south and about 140 to 190 m east-west (at 30° to 50° latitude), so a marker is within about 150 m of the real place and never closer; every map covers at least 5 km; files are deleted on close or by a sweep, at most 20 minutes after upload; and a process crash between upload and record can leave one unshared file behind (the named risk). It is marked for Dana Reyes's sign-off (`npm run onboard -- --status` shows it pending)
**Given** the built fixture and S3's day (as_of+3) **When** the module test drives the archetype with the Brightside adapter **Then** the change view places 5 in zone, recommends 1 cross-zone and leaves 0 unplaced, matching truth `route-change-s3-crosszone`
**And** the Brightside adapter implements `input({ day, view, scope })` and `labels({ day, nodeIds })` (AD-R16); the labels SQL is filtered by `scope`, returns only crew name, client name and city, passes the guardrail and names no forbidden column
**And** the dev-only `map-check` module is removed
**And** this story adds no screen code (the screens are 15.4's); the live check walks them
**Live check (Ely, dev Slack; untested until run):** a dispatcher opens Routing for as_of+3 and switches through all four views; a crew lead sees only their crew; every exit is tried once; no location appears as text; the image appears nowhere outside the modal. The result is recorded in the PR.

### Story 15.6: Routing goes to prod after the guardrail is signed
**Implements:** FR8 · **Estimate:** S · **Tier:** T3 (gated by the GRD-002 sign-off, AD-R12; the Orchestrator confirms with the tier tool) · **Architecture:** AD-R12
**Files:** `examples/brightside/app/modules/routing/manifest.json`

**Given** `npm run onboard -- --status` shows GRD-002 signed by Dana Reyes with the map image rule **When** this PR opens **Then** its one change adds `"prod"` to the routing module's `environments`, and the PR body quotes the sign-off date
**Given** GRD-002 still pending **Then** this story does not start
