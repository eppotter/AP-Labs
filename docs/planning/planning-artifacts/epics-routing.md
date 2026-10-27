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

**Status: approved by Ely 2026-10-26 (`approve plan routing`).** Amendment routing-streetmap (Stories 15.7 to 15.11): built (#231, #233, #235, #237, #239; fix #241). Amendment routing-editor (Stories 15.12 to 15.15): awaiting `approve plan routing-editor`.

## Overview

The routing spec (`SPEC.md`, standing in for a PRD) and SQLsmith's `data-design.md`, broken into epics (phases) and stories (one PR each). Sequencing (Ely): the generic engine goes into the template first, on synthetic test fixtures; Brightside gets it only once the engine is built. Epics continue at 12. Stories cite `architecture-routing.md` (AD-R1 to AD-R28) and the runtime ADs they inherit. Epic 15 (the Slack map modal) was added 2026-10-26 on Ely's decisions; Story 14.5's CLI stays as the no-Slack test path. Stories 15.7 to 15.11 (a street map under the plot) were added later the same day (amendment routing-streetmap, below). Stories 15.12 to 15.15 (Plan a route) were added 2026-10-27 (amendment routing-editor, below).

Estimates: **S** about half a day, under ~300 lines; **M** about a day; **L** up to two days. 28 stories: 5 S, 19 M, 4 L.

Computed tiers (`APLABS_PROFILE=$PWD/profiles/brightside/profile.yml node kit/lib/tier <paths>`, 2026-10-26):

| Epic | Tier | Stories at T2 or T3 |
|---|---|---|
| 12 | T2 declared (computes T1) | all: 13.3 adds `kit/runtime/routing/**` as T2, so Epic 12 runs at a declared T2 |
| 13 | T3 | 13.1, 13.2, 13.3 |
| 14 | T3 | 14.4 (`profiles/brightside/context/data.md`); 14.1 computes T1, treated as T2 |
| 15 | T3 | all but 15.12 (T2, `kit/runtime/routing/**`): 15.1 `kit/runtime/store/**`, `kit/runtime/jobs/**`; 15.2 `kit/runtime/data/**` engine floor, `profiles/_schema/**`, `kit/lib/profile/**`; 15.3 `Dockerfile` (T3 whatever it computes) and `.github/workflows/**`; 15.4 `kit/lib/tier/**` and the access filter; 15.5 and 15.6 `profiles/**` and the guardrail sign-off gate; 15.7 `profiles/**` (`data.md`, `guardrails.md`); 15.8 `kit/runtime/data/**` engine floor; 15.9 `profiles/_schema/**`, `kit/lib/profile/**`, `kit/lib/tier/**`; 15.10 computes T2, declared T3 (the `unsafe_svg` defence and what leaves the process); 15.11 `profiles/**` and guardrails; 15.13 `kit/runtime/data/**` engine floor, `profiles/_schema/**`, `kit/lib/profile/**`; 15.14 `kit/runtime/archetypes/routing-map/**`, `kit/runtime/slack/image.js`; 15.15 `profiles/**` (`profile.yml`, `guardrails.md`, `data.md`) |

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

### Amendment: routing-streetmap (2026-10-26)

Ely, after seeing the plain plot in dev Slack ("we need a map here"): a street map under the plot from free OpenStreetMap tiles ($0, no account), the demo company moved onto a real US metro (Columbus, Ohio), and new stories built now, after `approve plan routing-streetmap`. Architect review: approve with conditions, all folded into AD-R18 to AD-R22 and the stories below. Gate items, risks and the cut list are under the amendment note at the top of `architecture-routing.md`. Build order: 15.7 alongside (15.8 alongside 15.9), then 15.10, then 15.11; 15.6 waits for the reworded GRD-002 to be signed (DEP-025).

### Amendment: routing-editor (2026-10-27)

Ely asked for "Plan a route": a new menu option where a dispatcher or crew lead picks a crew and a date, then reorders that day's stops with ↑/↓ or Optimize, with the map redrawn for the current order and the total drive time and distance at the top. Every crew starts and ends at the Office (a point in Westerville, Ohio, rounded to 0.002°, shown only as "Office"). A manual order that breaks rules is allowed and flagged, with a count at the top. The four-view Routing screen stays. Suggest only; same audience as Routing. Architect review: approve with conditions, folded into AD-R23 to AD-R28 and the stories below; gate items, risks and the cut list are under the routing-editor note at the top of `architecture-routing.md`. Build order: 15.12 alongside 15.13, then 15.14, then 15.15. 15.6 now turns on prod for both routing modules, after DEP-025 and DEP-032.

### Deferred (DEP notes; not ledger rows)

- **DEP: MotherDuck republish** of the v5 fixture after 15.7 (new tables and columns, coordinates in Columbus), one publish; v4 is not published on its own (DEP-027, changed by routing-streetmap). Owner: Ely (a credentialed human step, runtime AD-18).
- **DEP (blocker for 15.5, no longer a deferral): Slack audience and resource keys** for the routing module: which people are dispatchers (all crews), which are crew leads and of which crew, and the two resource keys (AD-R17). Owner: Dana Reyes. 15.1 to 15.4 build on fixture profiles and do not wait for it; 15.5 cannot merge without it. The Orchestrator asks for it with the other up-front questions.
- **DEP (blocker for 15.6): Dana Reyes signs the map image rule** as an update to GRD-002 (AD-R12, T3 guardrail change), with its precision and linger numbers, and the DM fallback too if 15.1 needs it (the image would then show in push notification previews and the person's Files list). Owner: Dana Reyes, via Ely. 15.5 merges with the rule marked pending; 15.6 (prod) waits for the signature. **Changed (routing-streetmap):** Dana signs the reworded rule from 15.11 (the street layer and what the tile server learns), not 15.5's wording (DEP-025).
- **DEP-029: a new outbound connection,** `kit/runtime/basemap` to the tile provider (AD-R18, R19). Approver: Ely for the template, at the gate; Dana for Brightside, through DEP-025. Blocks 15.9.
- **DEP-030: the contact address in the tile User-Agent:** a monitored role address, not a personal one (it ships in the distribution repo). Owner: Ely. Blocks 15.11.
- **DEP-031 (deferred): a production tile provider per client fork.** OpenStreetMap's free service can be withdrawn and is not for production; keyed providers need the secrets path. Owner: each engagement lead. A fork-guide note says so.
- **Deferred notes (routing-streetmap, no rows):** a disk tile cache; the attribution drawn into the image (needs glyphs); a land mask for the synthetic points.
- **DEP-032: Dana Reyes signs the routing-editor additions** to GRD-002 (the Office marker, distance from `travelMatrix`, a route's total km shown) and the GRD-007 Office exception, written by 15.15 and marked pending. Owner: Dana Reyes, via Ely. Blocks prod for Plan a route (15.6).
- **DEP-033: MotherDuck republish of fixture v7** (the `depots` table) after 15.15. A MotherDuck-mode run that declares the depot node before the republish fails every routing read. Owner: Ely (the Orchestrator may run it at Ely's request). Blocks MotherDuck mode only.
- **DEP-034 (deferred): does the Office replace crew bases for all routing?** That re-pins S1 to S3. Owner: Ely, then Dana Reyes. Until then a fixed note in Plan a route says Routing's other views start from each crew's base.
- **DEP-035: the Office point's provenance.** Ely confirms the point derived from a real address may ship in the fixture to every fork, or picks a synthetic point. Owner: Ely. Blocks 15.15.
- **DEP (blocker for 15.4): the 15.1 live check.** Ely opens the dev-only map check in dev Slack and reports what he sees. Owner: Ely.
- **DEP: dependency review of `@resvg/resvg-js`** (licence, platform packages, Docker image) in 15.3. Owner: architect review, Ely approves.
- **DEP: a new record kind in `kit/runtime/store`** for uploaded map file ids and their expiry (15.1). Approver: Ely.
- **Named risk (accepted, F5):** if the process dies between a map upload and recording its file id, that file is never swept. It is shared nowhere, but it stays in Slack's file storage until someone removes it by hand. Without `files:read` the kit cannot find it. The window is one Slack call long.
- **Fork-guide note:** a fork on an older kit rejects a `routing:` block (`additionalProperties: false`); update the kit first.

**Shared files (never build these in parallel):** `kit/runtime/routing/index.js` and `contract.js` (12.1–12.5, strictly in order); `kit/runtime/sdk/index.js` (12.1, 13.2); `test/unit/engine-boundary.test.js` (12.1, 13.2, 15.2, 15.3, 15.4); `kit/lib/profile` + schema (13.1 before 13.2 and 13.3; 13.1 before 15.2); `kit/runtime/data/index.js` (13.2 before 15.2); `kit/runtime/slack/{hubs,image}.js` and `test/fixtures/fake-slack.js` (15.1 before 15.4); `profiles/brightside/profile.yml` and `context/guardrails.md` (13.3 before 15.5); `examples/brightside/app/modules/routing/manifest.json` (15.5 before 15.6); `examples/brightside/fixture/{generate.js,lib/tables.js,lib/routing.js,schema.sql,seed.json,targets.json}` (14.1 before 14.2). 13.3 must merge before 14.1 so the coordinate columns are forbidden before they exist. Epic 13 may run alongside Epic 12 after 12.1 (no shared files except `engine-boundary.test.js`: the later builder merges main first). Epic 15 order: 15.1 and 15.2 may run in parallel (the later merges main first for `engine-boundary.test.js`); 15.3 after Epic 12; 15.4 after 15.1's live check, 15.2 and 15.3; 15.5 after 15.4 and Epic 14; 15.6 after Dana signs GRD-002. **Routing-streetmap:** 15.7, 15.8 and 15.9 may run in parallel; 15.7 and 15.8 both edit `docs/planning/specs/spec-routing/data-design.md` (different sections; the later merges main first); 15.10 after 15.8 and 15.9 (it shares `kit/runtime/archetypes/routing-map/index.js` and `test/unit/runtime-routing-map-archetype.test.js` with 15.8); 15.11 after 15.7 and 15.10 (it shares `profiles/brightside/context/guardrails.md` with 15.7); 15.6 after 15.11 and Dana's signature. **Routing-editor:** 15.12 and 15.13 may run in parallel (no shared files); 15.14 after both (it needs `evaluateOrder`, `km_tenths` and the `route` view, and shares `kit/runtime/slack/{hubs,image}.js` and `test/fixtures/fake-slack.js` with earlier Epic 15 stories); 15.15 after 15.14 and DEP-035 (it shares `profiles/brightside/profile.yml`, `context/{guardrails,data}.md` and the fixture generator files with 15.7 and its fix); 15.6 after 15.15, DEP-025 and DEP-032.

## Requirements Inventory

### Functional Requirements

- FR1: Optimize a day: per crew, stop order and start times, no hard rule broken, preferred crew kept where possible, drive time no worse than the booked order. (CAP-1)
- FR2: Place a broken day's orphaned stops on crews in the field with a slot, or list them unplaceable with a reason. (CAP-2)
- FR3: Offer a gap up to five ranked candidates from the next 14 days, each with a reason. (CAP-3)
- FR4: Rules in a registry: hard/soft, weight; a new rule needs no solver edit. (CAP-4)
- FR5: Drive time through one estimator interface, haversine now. (CAP-5)
- FR6: Every row explains itself; cross-zone moves only as flagged recommendations. (CAP-6)
- FR7: Brightside's fixture gains coordinates, a future schedule, rules and absences, deterministically, with routing truths. (CAP-7)
- FR8: A Slack modal shows a plain map of the route and switches between four views (booked vs optimized, before vs after a change, a zone's crews, gap fill). Amended (routing-streetmap): with the profile's `routing.basemap` on, a street map sits under the plot, with the provider's credit under the image; without it, or when tiles fail, the plain map. Amended (routing-editor): a second screen, "Plan a route", lets a person reorder one crew's day from the Office with ↑/↓ or Optimize and see the map, total drive time and distance, and any rule breaks for that order. (CAP-8)
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
- Plan a route (15.14, added 2026-10-27): opens from the hub menu; step 1 a crew select, a date picker and Show stops; step 2 a totals line, the map, Optimize, Reset to booked, Change crew or day, and the stop rows with ↑/↓ and warning lines, between "Office · leave" and "Office · back". Every way out (Change crew or day, Back, Close, an error, an expired trigger, an expired session, access withdrawn, a map that fails to update) has a test.

### FR Coverage Map

| FR | Stories |
|---|---|
| FR1 | 12.3, 14.4, 15.12 |
| FR2 | 12.4, 14.4 |
| FR3 | 12.5, 14.4 |
| FR4 | 12.2 |
| FR5 | 12.1, 13.2, 15.13 |
| FR6 | 12.3, 12.4, 12.5, 14.5 |
| FR7 | 13.3, 14.1, 14.2, 14.3, 14.4, 15.7, 15.15 |
| FR8 | 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.11, 15.13, 15.14, 15.15 |
| FR9 | 15.2, 15.4, 15.5, 15.14 |

## Epic List

### Epic 12: A routing engine any field-service fork can call
Pure engine on synthetic fixtures. T1. Stories 12.1–12.5.

### Epic 13: Coordinates read safely
The governed data path: profile block, forbidden columns, `travelMatrix`. T3. Stories 13.1–13.3.

### Epic 14: Brightside's dispatcher gets a suggested plan
Fixture, adapter, truths, a read-only CLI. T3 (14.4). Stories 14.1–14.5.

### Epic 15: Dispatchers and crew leads see the route on a map in Slack
A private map image in a routing modal, four views, filtered by audience. T3 (computed 2026-10-26). Stories 15.1–15.15. 15.7–15.11 (routing-streetmap) put a street map under the plot and move the demo to Columbus, Ohio. 15.12–15.15 (routing-editor) add "Plan a route", a screen to reorder one crew's day from the Office. Ely's suggested shape had four stories; `mapPoints` is split from the spike into its own story (15.2) because it is a T3 engine read like 13.2, while the spike is a live check, and the two share no files; 15.6 is the one-line prod switch that waits for Dana's GRD-002 signature (F12).

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

Added 2026-10-26 (Ely). Only 15.5 waits for Dana Reyes's audience list (F18); 15.6 waits for her GRD-002 signature, now of the wording 15.11 writes. Tiers per story computed 2026-10-26 with `node kit/lib/tier` on the files listed; all are T3 (F3). Routing-editor (2026-10-27): 15.12 computes T2; 15.13 to 15.15 compute T3.

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
**Live-check steps:** `docs/runtime/map-check.md`. **Outcome:** pending (Ely has not run it yet).
**Live check outcome (2026-10-26, Ely, dev Slack, iOS and desktop):**
1. Image shows in the modal: **pass** (after the retry below).
2. File appears in no channel or DM: **pass**.
3. `view_closed` on Back: **pass** (`map view closed`, `deleted: 1`, twice). On Close (X / swipe down): **not checked**; if it doesn't arrive, the sweep deletes within 20 minutes and no AC changes.
4. After `files.delete` the file is gone: **pass** (the copied link says "file not found").
5. Clicking the image (iOS): Slack offers Open in Browser, Copy Link and Share… (AirDrop, Messages, Mail, Notes, Copy). The shared item is the private `files.slack.com` link (opens only for a workspace member with access), but Copy may put the image on the clipboard, and anyone can screenshot. **Dana must know this before signing GRD-002 (DEP-025).**
6. A user outside the audience searches Files: **not checked** (needs a second person).
7. `views.update` straight after the upload: **fails** with `invalid slack file`; one retry about 1 s later succeeds (`map image shown`, attempt 2, every time). Retry with backoff added (PR fixing this).

Result: AD-R15's primary path holds (no DM fallback). Story 15.4 may proceed; items 3 (Close) and 6 stay open and are re-checked in 15.4's live check.

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
**Audience, as built (2026-10-26, Ely's call):** a dev placeholder pending DEP-024. Dana Reyes's audience list has not arrived, so the profile declares the two resource keys (neither conferred by the admin role) and the audience, with Dana (the user Ely drives in dev) the one dispatcher and `crew_leads` empty. Safe because the module is dev-only (F12). The crew-lead live check waits for the list; the profile is updated when it arrives. Steps: `docs/runtime/routing-map.md`. The fixture-driven module test is `examples/brightside/test/routing-module.test.js` (app `__tests__` may require only `#sdk`); `app/routing/__tests__/module.test.js` covers the adapter contract on hand-made rows.

### Story 15.6: Routing goes to prod after the guardrail is signed
**Implements:** FR8 · **Estimate:** S · **Tier:** T3 (gated by the GRD-002 sign-off, AD-R12; the Orchestrator confirms with the tier tool) · **Architecture:** AD-R12
**Files:** `examples/brightside/app/modules/routing/manifest.json`

**Given** `npm run onboard -- --status` shows GRD-002 signed by Dana Reyes with the map image rule **When** this PR opens **Then** its one change adds `"prod"` to the routing module's `environments`, and the PR body quotes the sign-off date
**Given** GRD-002 still pending **Then** this story does not start
**Changed (routing-streetmap):** the signature 15.6 waits for is of GRD-002 as 15.11 rewords it (the street layer and what the tile server learns), so 15.6 starts only after 15.11 merges and Dana signs that wording (DEP-025). Its one-line change is the same.
**Changed (routing-editor):** 15.6 adds `"prod"` to both routing modules' `environments` (Routing and Plan a route), so its files add `examples/brightside/app/modules/route-planner/manifest.json`. It starts only after 15.15 merges and Dana has signed both DEP-025 and DEP-032; the PR body quotes both sign-off dates.

### Story 15.7: The demo moves to Columbus (fixture v5)
**Implements:** FR7, FR8 · **Estimate:** M (may grow to L if S2's or S3's planted shape breaks) · **Tier:** T3 (computed: `profiles/**` via `context/data.md` and `context/guardrails.md`) · **Architecture:** AD-R22
**Files:** `examples/brightside/fixture/{generate.js,targets.json}`, `examples/brightside/fixture/lib/routing.js` (and `lib/scenarios.js` only if a plant breaks), `examples/brightside/fixture/checks/synthetic-coordinates.sql`, `examples/brightside/fixture/seeds/*`, `examples/brightside/fixture/__tests__/{routing,scenarios}.test.js`, `examples/brightside/test/{dataset,routing-module}.test.js`, `profiles/brightside/context/data.md`, `profiles/brightside/context/guardrails.md` (the GRD-007 line), `docs/planning/specs/spec-routing/data-design.md` §1, §5

**Given** the seed **When** generated twice **Then** the files are identical, GENERATOR_VERSION is 5, and among the coordinate constants only `CENTRE` and `BOX` changed
**And** every non-routing column is byte-identical to v4 (a test diffs them); the row counts of `scheduled_visits`, `service_rules` and `staff_absences` equal v4's, or the PR says why
**And** every coordinate is inside the new `BOX`: `synthetic-coordinates.sql` checks it, and its header says "random points in a real metro, never taken from an address"
**And** S1–S3 are recomputed from `travelMatrix`, and `targets.json` `routing` and the `data.md` truths are re-pinned: S1 optimized ≤ booked with 0 hard breaks; S2 still the afternoon gap on crew 2 at as_of+2; S3 still 5 / 1 / 0. If a shape breaks, `lib/scenarios.js` (the plant, never the engine) is adjusted and the PR says so
**And** `npm run verify` reconciles all five routing truths offline, and no output line holds a coordinate
**And** `data.md` says drive time is haversine × detour ÷ speed, not road time
**And** GRD-007 says the coordinates are random synthetic points in the Columbus area: markers sit near real streets and homes, and none is or comes from a real address; marked pending (with DEP-025)
**Untested until Ely runs it:** the MotherDuck republish of v5 (DEP-027).

### Story 15.8: `mapPoints` in Web Mercator, with the tile mosaic
**Implements:** FR8 · **Estimate:** M · **Tier:** T3 (computed: `kit/runtime/data/**` engine floor) · **Architecture:** AD-R20, AD-R13 amended
**Files:** `kit/runtime/data/map.js`, `kit/runtime/archetypes/routing-map/index.js` (the new return shape only), `test/unit/runtime-data-map.test.js`, `test/unit/runtime-routing-map-archetype.test.js`, `docs/planning/specs/spec-routing/data-design.md` §3

**Given** a temp DuckDB with known coordinates **When** `mapPoints` runs **Then** it returns `{ points: [{ node, x, y }], mosaic: { z, tx0, ty0, cols, rows, ox, oy } }`, all integers
**And** positions match hand-computed Web Mercator (snapped first); a reference point maps to its slippy-map tile index (a hand-computed constant in the test)
**And** z is the largest whole zoom ≤ `max_zoom` (19) at which the widened box fits; the test derives the shown span from z and the frame and asserts at least 5 km each way
**And** the mosaic covers the frame: ox ≤ 0, oy ≤ 0, ox + 256 × cols ≥ width, oy + 256 × rows ≥ height
**Given** a box needing more than 64 tiles, crossing the antimeridian, or beyond ±85.0511° **Then** `mosaic` is null and the points still return
**And** two nodes in one grid cell share a pixel; a single node is centred
**Given** mosaic columns that differ between rows **Then** `query_failed`
**And** every 15.2 refusal holds; the exact-keys, sdk and boundary tests are unchanged; `run()` still refuses the coordinate columns
**And** the archetype passes the points to the renderer and the mosaic to nothing else yet (spies: no mosaic in logs, Slack calls or errors)

### Story 15.9: The tile source: profile block and fetcher
**Implements:** FR8 · **Estimate:** M · **Tier:** T3 (computed: `profiles/_schema/**`, `kit/lib/profile/**`, `kit/lib/tier/**`) · **Architecture:** AD-R18, AD-R19
**Files:** `profiles/_schema/profile.schema.json`, `kit/lib/profile/index.js`, `kit/lib/tier/index.js`, `kit/runtime/basemap/{index,cache}.js`, `test/unit/{profile,tier,runtime-basemap,engine-boundary}.test.js`, `test/fixtures/fake-tiles.js`, `test/fixtures/profiles/routing-basemap.yml`, `test/fixtures/routing-map/tiles/*.png` (synthetic patterns, not OpenStreetMap imagery)

**Given** a fixture profile with `routing.basemap` **Then** validation accepts the AD-R18 keys with their ranges and defaults; an absent block means no basemap
**And** it refuses, naming the key: a template that is not https, has userinfo, an IP or localhost host, a query or a fragment; a template without exactly one each of `{z}`, `{x}`, `{y}`, or with other braces; an attribution that is empty, over 120 characters, or holds any of ``<>&*_~`|``; a `user_agent` with no email or https contact, or a library default; an unknown key
**Given** a mosaic **When** `fetchMosaic` runs **Then** only cols × rows tiles are requested, minus cache hits (a request-count test), at most 2 at once, with `redirect: 'error'` and the profile's User-Agent
**And** a 403, 429, 5xx, timeout, non-PNG, wrong size, oversize or abort gives `null` with its reason; one failed tile drops the layer; after a 403, 429 or 5xx nothing is requested for 10 minutes; `APLABS_BASEMAP_OFF` means no request
**And** the cache honours max-age and Expires, falls back to `cache_days`, sends If-None-Match (a 304 refreshes the entry), stores nothing on no-store, evicts least recently used, and shares one fetch per tile; every clock is frozen with `mock.timers`
**And** the fake tile server rejects what OpenStreetMap rejects: 403 for a missing or generic User-Agent; 404 for z outside 0–19 or x/y outside [0, 2^z); 400 for any query string; a non-GET refused. It sends Cache-Control and ETag, answers 304 on a matching ETag, and can answer 429, 503, slowly, oversize or non-PNG
**And** logger and error spies find no URL, host path, z/x/y or body; `npm test` never reaches the network (global `fetch` stubbed to throw; every path injects `fetch`)
**And** `ENGINE_T3` includes `kit/runtime/basemap/**` and `tier.test.js` proves T3 under any profile
**And** the boundary test: basemap requires only `errors` and itself; only `kit/runtime/archetypes/routing-map/**` and `scripts/smoke-routing-map.js` require it; `kit/runtime/routing-map/**` never does

### Story 15.10: Streets under the plot: compositing, attribution, fallback
**Implements:** FR8 · **Estimate:** M · **Tier:** T3 declared (computes T2; it changes the `unsafe_svg` defence and what leaves the process) · **Architecture:** AD-R21, AD-R18
**Files:** `kit/runtime/routing-map/{png,svg,index}.js`, `kit/runtime/archetypes/routing-map/{index,views}.js`, `kit/runtime/messages.js`, `scripts/smoke-routing-map.js`, `test/unit/runtime-routing-map-{png,svg,archetype}.test.js`. `.github/workflows/ci.yml` unchanged (no `workflow` scope needed).

**Given** no basemap **Then** the PNG is byte-identical to today's for each fixture (a regression test, one machine)
**Given** a basemap `{ tiles: [{ col, row, png }], ox, oy }` **Then** `composeBasemap` draws the tiles under both panels of the two-panel views, with the wash instead of white; the same model and tile bytes give a byte-identical PNG twice, at the frame's dimensions
**And** `<image`, `href` and `url(` in the plot SVG are still refused (`unsafe_svg`), with or without a basemap; a tile that is not a 256×256 PNG is refused (`basemap_invalid`); the composed SVG has exactly tiles × panels `<image` elements, each `data:image/png;base64,`
**And** `MAX_PNG_BYTES` is set from measuring the four views with realistic synthetic tiles (the maximum × 2, at most 4 MB); a PNG over it is re-drawn plain
**Given** a basemap block and a non-null mosaic **When** a view draws **Then** the streets show, with a context block straight under the image holding the profile's attribution, escaped, linked to `attribution_url`; the alt-text template is unchanged and holds no attribution
**Given** the fetch returns null (any reason) **Then** the plain map shows with "Street map unavailable, showing the plain map."; never the error exit
**Exits:** all of 15.4's exits still pass. New, one test each: a newer click while tiles load (the fetch is aborted, nothing uploaded); Back or Close while tiles load (aborted, no file); the session expires during the fetch (the expired message); access withdrawn during the fetch (the refusal, nothing uploaded); rasterizing with tiles fails (one plain-map retry, then the error exit)
**And** spies find no z/x/y, mosaic or URL in logs, Slack calls or errors
**And** the smoke script, inside the image with `--network none`, renders one view with fixture tiles and checks its size against the cap, and runs `fetchMosaic` against the OpenStreetMap template and asserts null within the time budget. Only CI can run it: named as untested in the builder's report and the PR, and the first CI run is its test

### Story 15.11: Brightside turns the street map on; GRD-002 reworded
**Implements:** FR8 · **Estimate:** S · **Tier:** T3 (computed: `profiles/**`, guardrails) · **Architecture:** AD-R12 amended, AD-R18
**Files:** `profiles/brightside/profile.yml`, `profiles/brightside/context/guardrails.md`, `docs/runtime/{routing-map,container}.md`, `docs/planning/specs/spec-routing/{SPEC,HANDOFF}.md` (only what the routing-streetmap docs PR left), `docs/fork-guide.md` (one line for DEP-031: a fork sets its own production tile provider in `routing.basemap`)

**Given** the Brightside profile **Then** `routing.basemap` holds `url_template` `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, `attribution` `© OpenStreetMap contributors`, `attribution_url` `https://www.openstreetmap.org/copyright`, `user_agent` `aplabs-routing-map/<version> (+<DEP-030 contact>)` naming no client, `max_zoom` 19, `cache_days` 7; the module stays `environments: ["dev"]`
**And** GRD-002's map-image part carries this wording, marked pending (`npm run onboard -- --status` shows it pending):
> The picture now has a street map under it. Anyone who sees it can read each marker's area directly, to about 150 m (a block), with no need to line it up. Next to the window's list (client name, city, stop number), a screenshot shows roughly where a named client lives. To draw the streets, the bot asks the street-map provider (OpenStreetMap, through its delivery network) for the map squares of the area shown. The provider learns which area of 5 km or more is being viewed, and when, from the bot's server address. It never learns which stops or customers. The bot keeps those squares in memory only. The provider's name and credit show under the picture. If the street map can't be fetched, the plain map shows.

**And** `docs/runtime/container.md` names outbound 443 to the tile host
**Live check (Ely, dev Slack; untested until run; kept short):** all four views show streets, with markers on streets (note any on water); the attribution caption shows on desktop and iOS; kill switch on gives the plain map and the note; a bad host gives the plain map and the note within about 8 s; the modal shows the larger PNG (note its size and time to draw); OpenStreetMap answers 200; re-opening the same view sends no new tile requests (a debug log printing only a count); and 15.1's open items (Close sends `view_closed`; a second person's Files search finds nothing)
**And** 15.6 keeps its rule, now with the reworded GRD-002 signed (DEP-025)

### Story 15.12: `evaluateOrder` and the depot node kind
**Implements:** FR1, NFR1 · **Estimate:** M · **Tier:** T2 (computed) · **Architecture:** AD-R24, AD-R23, AD-R2 amended
**Files:** `kit/runtime/routing/{contract,evaluate,optimize,index}.js`, `test/unit/runtime-routing-{evaluate,contract}.test.js`, `test/fixtures/routing/route-depot.json`

**Given** a depot-based one-crew input and an order **When** evaluated twice (under two `TZ` values) **Then** the JSON is byte-identical, and the times, drive minutes, `leaveAt`, `backAt` and breaks match hand-computed values
**Given** an order that breaks a time window, runs past aim-finish, or runs past 23:00 **Then** each stop lists its breaks with label and reason, `lateBack` is set, and no stop is dropped; times past 24:00 stay integers
**Given** an order that misses, repeats or adds a stop, or names another crew's stop **Then** `RoutingFault` names the field
**Given** `depot:x` as a `baseNode` and in `fromMatrix` rows **Then** it is accepted; `place:x` is still refused
**And** `optimizeDay` with `returnToBase` from a depot equals brute force on a ≤ 7-stop fixture; the boundary test is unchanged

### Story 15.13: Distance in `travelMatrix`, `routing.depot`, the `route` view
**Implements:** FR5, FR8 · **Estimate:** M · **Tier:** T3 (computed) · **Architecture:** AD-R25, AD-R23, AD-R28, AD-R9 amended
**Files:** `kit/runtime/data/{travel,index}.js`, `profiles/_schema/profile.schema.json`, `kit/lib/profile/index.js`, `kit/runtime/routing-map/{svg,index}.js`, `test/unit/{runtime-data-travel,profile,runtime-routing-map-svg,runtime-routing-map-png}.test.js`, `test/fixtures/profiles/routing-depot.yml`, `test/fixtures/routing-map/route.json`, `docs/planning/specs/spec-routing/data-design.md` §3

**Given** a temp DuckDB **When** `travelMatrix` runs **Then** its rows are exactly `from_node, to_node, minutes, km_tenths`, matching hand-computed values; `run()` still refuses every coordinate column; the data object's exact keys and the sdk are unchanged
**Given** `routing.depot` with an undeclared node kind, a label over 24 characters or holding markup, or any extra key (`lat`) **Then** validation fails naming the key
**Given** `route.json` **Then** the SVG holds the Office marker, numbered stops and a closed loop, no `<text>`, byte-identical twice; `unsafe_svg` holds; the PNG is under `MAX_PNG_BYTES`
**And** `npm run verify` still reconciles all routing truths; no log or error holds `km_tenths`

### Story 15.14: The route-editor screen
**Implements:** FR8, FR9 · **Estimate:** L · **Tier:** T3 (computed) · **Architecture:** AD-R26, AD-R27, AD-R16 amended, AD-R12 amended, AD-R17
**Files:** `kit/runtime/archetypes/routing-map/{index,editor,session}.js`, `kit/runtime/slack/{hubs,image}.js` (the reuse-image show path), `kit/runtime/schema/module.schema.json`, `kit/runtime/registry/index.js`, `kit/runtime/messages.js`, `test/fixtures/fake-slack.js`, `test/fixtures/routing-map/adapter.js` (`route()`), `test/unit/runtime-routing-map-editor.test.js`, `test/unit/runtime-registry.test.js`

**Given** a `route-editor` module with no `route()`, or a profile with no `routing.depot` **Then** it shows "not available" and opens no modal
**Given** a dispatcher picks a crew and a day and taps Show stops **Then** step 2 shows the header totals (drive time, about N km, last stop done, back at Office, rule-break count), the image, the Office first and last rows and one row per stop; no ↑ on the first stop, no ↓ on the last; rows with breaks carry warning lines
**When** ↓ is tapped **Then** the list updates first (same file id, "Map updating…"), then one map; three taps within 1 s give one upload, for the final order (spy counts); clocks frozen with `mock.timers`
**Given** a stale version, an unknown stop, ↑ on the first stop, or an editor action sent to a views session (and the reverse) **Then** the order is unchanged and the refusal is logged by reason only
**When** Optimize is tapped **Then** the order equals `optimizeDay` from the Office; unplaced stops are appended and flagged; "Already the best order found" shows when nothing changed
**When** Reset to booked is tapped **Then** the booked order shows, with times re-estimated from the Office
**Given** a crew lead **Then** a crafted `crewId` still gives their own crew; `mapPoints` gets only the Office and their stops (spy); `adapter.labels` never gets the depot
**Given** the crew is out that day **Then** a banner shows and the list is read-only (no ↑, ↓ or Optimize)
**Given** 0 stops, or more than 40 **Then** a plain message shows with Change crew or day
**And** the Slack fake also rejects: a duplicate `block_id`, a duplicate `action_id` within a block, a button value over 2000 characters, an `accessibility_label` over 75 characters, a reused `slack_file` that was deleted
**And** spies on logs, Slack calls and errors find no positions, `x`/`y` keys, mosaic, per-leg `km_tenths` or fixture coordinate values
**Exits, one test each:** Change crew or day goes to step 1 and deletes the files; Back or Close: `view_closed` deletes the files (or the sweep, within 20 minutes); an expired trigger takes the hub's path; an expired session says "This plan has expired, go back and open Plan a route again."; access withdrawn shows the refusal in the view; a click from another user or view is refused; data unavailable or an engine fault on Show stops gives the error exit with Back; a node missing from `mapPoints` gives the error exit; a render, upload, `ratelimited` or not-accepted failure leaves the list with "Map not updated; the list is current."; a reused file that expired or was deleted gives the list without the image
**Untested until the live check:** Slack accepting a reused `slack_file` in `views.update`; button rows on iOS.

### Story 15.15: Brightside's Office and the "Plan a route" module (dev only)
**Implements:** FR7, FR8 · **Estimate:** M · **Tier:** T3 (computed) · **Architecture:** AD-R23, AD-R26
**Files:** `examples/brightside/fixture/{generate.js,schema.sql,lib/tables.js,lib/routing.js,seeds/*,checks/synthetic-coordinates.sql,checks/synthetic-off-water.sql,__tests__/routing.test.js}`, `examples/brightside/app/routing/adapter.js`, `examples/brightside/app/modules/route-planner/{manifest.json,adapter.js}`, `examples/brightside/test/route-planner.test.js`, `profiles/brightside/profile.yml`, `profiles/brightside/context/{guardrails.md,data.md}`, `docs/runtime/routing-map.md`, `docs/fork-guide.md`

**Given** the seed **When** generated **Then** GENERATOR_VERSION is 7, it adds `depots` (one row) and nothing else changes: every other table is byte-identical to v6; S1 to S3 unchanged
**And** the Office is inside `BOX` and passes the off-water check; if not, Ely is told and the point is not moved silently (it is near the Hoover outline)
**And** the profile adds the two forbidden columns, the depot node source and `routing.depot` in the same PR as the table
**And** `adapter.route()` passes the guard, names no coordinate column, and fetches only [Office, stops] × [stops, Office] within `max_pairs`
**And** the manifest has `environments: ["dev"]` and label "Plan a route"; the existing Routing module is unchanged
**And** the new GRD-002 and GRD-007 wording below is marked pending, and `npm run onboard -- --status` shows it (DEP-032; GRD-007's final words depend on DEP-035):
> GRD-002, coordinates: "...returns whole-minute drive times and an estimated distance (straight line × 1.3, in tenths of a km) between two places only. Only a route's total distance is shown, in whole km; the distance of one leg is never shown or logged."
> GRD-002, new line: "The Office, where every crew starts and ends in Plan a route, is a point in the data's `depots` table. Its coordinate columns are forbidden like the others. The map shows it with its own marker. It is called 'Office' in the list, never by address."
> GRD-007, exception: "One point is not random: the Office, a point Ely chose in Westerville, rounded to 0.002° (about 150 m)."

**Untested until Ely runs it:** the MotherDuck republish of v7 (DEP-033).
**Live check (Ely, dev Slack; untested until run; kept short):** (1) open Plan a route, pick a crew and as_of+3, Show stops: the Office marker and the loop, the totals; (2) tap ↓ three times fast on one stop: the list follows each tap without jumping, and the map lands on the final order (note the seconds); (3) Optimize, then Reset to booked; (4) move a morning stop late: a warning shows and the count rises; (5) Change crew or day, then Back; open again and Close with the X: the log shows deleted for both (also 15.1's open Close item); (6) once on iOS: buttons tappable, layout stable.
