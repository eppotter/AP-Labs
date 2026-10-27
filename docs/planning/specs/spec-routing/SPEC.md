---
id: SPEC-routing
companions:
  - data-design.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete contract for what to build, test, and validate. `data-design.md` is written by sqlsmith in parallel and owns the table design; this SPEC only names the data it needs.

# Route optimization (field-service scheduling)

## Why

Field-service clients plan crews' days by hand, and when a day breaks (a cancellation, a crew out sick) the dispatcher rebuilds it by phone and memory. A template building block that orders each crew's stops and repairs a broken day turns that into a suggested plan the dispatcher checks and phones through. The engine is generic and lives in the kit, so any field-service engagement gets it on day one. Brightside Home Cleaning (fictional, 15 crews across five zones) proves it once the engine is built, in a later, separate phase.

## Capabilities

- **CAP-1**
  - **intent:** Optimize route. Given a set of customers, or the stops booked on a date, and the crews available, return for each crew its stop order and a start time per stop, never breaking a hard rule, keeping each customer's usual crew where possible, and keeping drive time low.
  - **success:** On fixture inputs the result breaks no hard rule, and its total estimated drive time is no worse than the booked order's for the same assignment; the same input always gives the same output.
- **CAP-2**
  - **intent:** Route change, extra stops. When a day breaks (customer cancels, crew out sick, other), the stops that still need doing today are split across the crews in the field, each with a suggested slot the tech can offer the customer by phone.
  - **success:** For a planted "crew out sick" day, every orphaned stop is either placed in-zone with a slot that breaks no hard rule on the receiving crew's day, returned as a flagged cross-zone recommendation, or listed as unplaceable with a plain reason. A cross-zone recommendation does not count as placed. Every existing stop whose time shifts gets a "call to confirm the new time" row. If every crew is out, every stop is unplaced.
- **CAP-3**
  - **intent:** Route change, gap fill. A gap in a crew's day is offered a ranked list of up to five candidate customers from the next 14 days of schedule who could be moved up, each with a plain reason; the tech calls to confirm.
  - **success:** A known-answer truth ("the cancelled afternoon visit on crew 2 at as_of+2 yields this top candidate and this candidate count") reconciles under `npm run verify`. A gap runs from the previous stop's end to the next stop's start; a candidate fits only if travel in, service and travel out fit inside it without shifting later stops.
- **CAP-4**
  - **intent:** Rules live in a registry. Each rule declares hard or soft, what it checks and its weight; a new rule is added by registering it, with no solver edit. v1 rules: crew-day earliest start and latest finish (hard), day of week (hard), time-of-day window morning/afternoon (hard), preferred crew (soft).
  - **success:** Unit tests per rule; a test registers a fixture-only rule and the solver honours it with no engine change; a malformed rule fails the check.
- **CAP-5**
  - **intent:** Drive time is estimated from straight-line (haversine) distance between coordinates times a configurable speed and detour factor, behind one estimator interface so a maps connector can replace it later.
  - **success:** Estimator tests on known coordinate pairs give the expected minutes; the solver gets its times only through the interface.
- **CAP-6**
  - **intent:** Every suggestion explains itself in plain words: why this order, why this crew, why this candidate. Moving a crew outside its zone is only ever a flagged recommendation, never applied silently.
  - **success:** Every output row carries a reason; a test where the only feasible fix is a cross-zone move returns it flagged as a recommendation.
- **CAP-7**
  - **intent:** The Brightside demo data gains what routing needs (`data-design.md`): synthetic coordinates per property and per crew base, a future schedule, customer rules and crew absences, generated deterministically with the rest of the fixture.
  - **success:** Fixture integrity and synthetic-only checks pass; the same seed gives identical files; the routing truths are `truth` blocks in Brightside's `context/data.md` and match.
- **CAP-8** (added 2026-10-26, Ely)
  - **intent:** Map view in Slack. From the hub menu, a dispatcher or crew lead opens Routing, picks a day and a view, and a modal shows a plain map of the route with a short text list under it. A select menu in the modal switches between four views, redrawn in place: (a) booked vs optimized for a crew's day, with drive minutes for each; (b) before vs after a route change (cancellation or crew out), moved stops highlighted, cross-zone recommendations drawn differently; (c) all crews in a zone for a day, one color per crew; (d) gap fill: the gap on a crew's day and where the top five candidates sit relative to it. The map is a plain plot on a blank background (numbered stops, one line color per crew, zone outlines, crew base marker), drawn on our server as a PNG. **Amended 2026-10-26 (routing-streetmap):** when the profile turns it on (`routing.basemap`), a street map sits under the plot, with the provider's credit under the image; the bot asks the provider only for the map squares of the area shown. Without it, or when the squares can't be fetched, the plain plot shows. **Amended 2026-10-27 (routing-editor): Plan a route.** A new menu option, next to Routing and for the same people. Step 1: pick a crew and a date. Step 2: that day's stops as a list, each with ↑/↓ to move it; the map at the top, redrawn for the current order; Optimize and Reset to booked; and at the top the total estimated drive time and distance, when the last stop is done, when the crew is back, and how many rules the order breaks. Every crew starts and ends at the Office, shown only as "Office". A hand-made order that breaks a rule is allowed; each break shows as a warning on its stop. Nothing is saved or sent: it is a planning aid only.
  - **success:** The same input always gives the same drawing; every view renders on fixture inputs; the image holds no text; no coordinate, address or postal code appears in any text; every way out of the modal has a test; a live check in dev Slack shows the image in the modal. Plan a route: the same order always gives the same times, totals and warnings; no stop is ever dropped; a stale or crafted click changes nothing; a live check shows the list following quick taps and the map landing on the final order.
- **CAP-9** (added 2026-10-26, Ely)
  - **intent:** Audience. Dispatchers see every crew. A crew lead sees only their own crew: every view is filtered to that crew before any position is read. Who is a crew lead, and of which crew, lives in the client profile, not in code. Dana Reyes signs off the audience.
  - **success:** Tests show a crew lead's map and text hold only their crew's stops, a crew lead with no crew mapping is refused, and access is re-checked on every view switch.

## Constraints

- Deterministic solver: no LLM anywhere in routing, and no dependency on Epic 9 (plain-English parameters). Inputs are typed.
- Objective order is fixed: never break a hard rule; then keep the same crew where possible (preferred-crew penalty); then minimize drive time; then finish by the aim-finish time (18:00 soft; 23:00 is the hard limit). Each has its own position in the cost tuple, and a lower priority never trades against a higher one. A stop that cannot be placed without breaking a hard rule is returned unplaced with a reason.
- Suggest only. Nothing is written back to any scheduling system; techs call customers and update by hand.
- No location as text, ever: no coordinate value, street address or postal code appears as text anywhere (Slack text, logs, reasons, LLM input). Address columns (`properties.street_address`, `postal_code`) stay forbidden and are not used.
- **Map image rule (changed 2026-10-26, Ely; a T3 guardrail change, Dana Reyes signs it at Story 15.5):** a rendered map image is allowed. It is shown only inside the routing modal, only to the routing audience (CAP-9), never posted to a channel and never sent to an LLM. Plainly: the image reveals approximate locations. It has no street tiles, scale or axis values, but anyone who knows where two of the places are can line it up with a real map. How approximate, in numbers: every place is rounded to a grid cell about 220 m north-south and 140 to 190 m east-west, so a marker is within about 150 m of the real place and never closer; every map covers at least 5 km each way; each image file is deleted from Slack within 20 minutes of upload. The module runs in dev only until Dana signs (Story 15.6 turns on prod). This replaces the earlier rule that coordinates never reach Slack in any form. **Amended 2026-10-26 (routing-streetmap):** with the street map on, the picture has a street map under it, so anyone who sees it can read each marker's area directly, to about 150 m, with no need to line it up, and the tile provider learns which area of 5 km or more is being viewed, and when, but never which stops or customers. Dana signs this reworded rule (Story 15.11) before prod (Story 15.6).
- **Street map (amended 2026-10-26, routing-streetmap; architecture AD-R18):** off unless the profile's `routing.basemap` block turns it on; the kit has no default provider. When on, the bot fetches only the map squares of the area shown, from the one provider the profile names, keeps them in memory only, and shows the provider's credit under the image. A kill switch turns it off. If the squares can't be fetched, the plain plot shows with a short note, never an error. Brightside uses OpenStreetMap's free tiles for dev and the demo; a client fork needs its own production provider. The plot itself is still drawn offline on our server.
- Drive time is straight-line (haversine) distance × detour ÷ speed, not road time, with or without the street map.
- **Plan a route (amended 2026-10-27, routing-editor; architecture AD-R23 to AD-R28):** suggest only, like the rest of routing. The Office is a point in the data (the `depots` table), its coordinate columns forbidden like the others, never in the profile, and never named by address. Distance is the straight line × detour; only a route's total is shown, in whole km, never a leg's. Plan a route starts from the Office at 08:00 and returns there; Routing's four views still start from each crew's base, and the screen says so. Dev only until Dana signs the GRD-002 and GRD-007 additions (DEP-032).
- Crew-day hard limits come from configuration, not code. The fixture generator's values are the demo defaults: earliest start 06:00, latest finish 23:00, 15-minute slots.
- Gap-fill candidates come only from scheduled visits in the next 14 days after the gap's date. Ranking uses closeness to the gap, flexibility, how soon the next visit is due, and window fit; reuse `kit/runtime/scoring` (declared weights, a reason per row) where it fits.
- Generic in the kit: no Brightside names, zones or ids in engine code; Brightside wiring ships later as example modules.
- Tests are offline and deterministic, read client specifics from fixtures, and never call a maps service or a model.
- Data reads go through the existing query runner and its guardrails.

## Non-goals

- A real maps or routing API for road times (a later connector).
- Write-back to a scheduling system, or approve-and-push (approval-write archetype, later).
- Any LLM in solving, ranking or parameter filling.
- Slack UX beyond the routing map modal (Epic 15): no channel posts, no new slash command (Routing opens from the hub menu), no buttons that act on a plan. (Plan a route's buttons change only the order on screen; nothing is saved or sent.)
- Saving a planned order, or the Office replacing crew bases in Routing's other views (deferred, DEP-034).
- Real road times or routes along streets: the street map is a picture only (amended 2026-10-26, routing-streetmap). Also out: tile providers that need an API key, a disk cache of map squares, and pre-fetching squares not on screen.
- Live traffic or time-of-day travel speeds.
- Multi-day optimization beyond the 14-day candidate pull.
- Crew skills or equipment matching.

## Success signal

- On the Brightside fixture, given a planted broken day (a cancelled afternoon visit on crew 2 at as_of+2, and crew 7 out sick at as_of+3), the engine returns the gap's top-five candidates and the orphaned stops' placements exactly as the known-answer truths state, every row with a plain reason and no coordinates in the output, and `npm run verify` reconciles them offline.
- In dev Slack, a dispatcher opens Routing for S3's day and switches through all four views, and a crew lead sees only their own crew; no location appears as text and the image never leaves the modal.

## Assumptions

- Dispatchers and crew leads are the Slack users (Ely, 2026-10-26); other crew members later. None of this changes the engine.
- "Flexibility" for gap-fill is a `flexible` flag the adapter sets on each candidate: true when the stop has no hard day-of-week or time-of-day rule. No new rule type; the engine never infers it.
- A crew's base is its day's start and end point for drive-time estimates. In Plan a route the Office is (amended 2026-10-27).
- One day at a time is enough for v1; the 14-day pull only feeds candidates, it does not re-plan those days.

## Open Questions

Open (Epic 15, added 2026-10-26):
- **Private image in a modal:** whether Slack shows a privately uploaded file (no channel) in a modal image block is unverified. Story 15.1 live-checks it. Fallback: send the image to the requester's own DM with the bot and link it from the modal; that fallback needs Dana Reyes's yes, because the image then sits in a DM rather than only in the modal.
- **Crew lead and gap-fill candidates:** candidates can be customers booked on other crews. Default until Dana decides: a crew lead sees only candidates booked on their own crew; the rest are counted, not named or drawn.
- **Audience list:** which Brightside people are dispatchers and which are crew leads of which crew (Dana Reyes; blocks Story 15.5 only).

Open (Plan a route, added 2026-10-27):
- **The Office point:** may the point Ely chose (rounded to about 150 m) ship in the fixture to every fork, or should a synthetic nearby point replace it? (Ely, DEP-035; blocks Story 15.15.)
- **Office or crew bases:** should the Office replace crew bases for all routing? (Ely, then Dana Reyes; deferred, DEP-034.)

Resolved 2026-10-26 (architect T3 review): latest finish (23:00 hard, 18:00 soft, own cost position); day and window strictness (per rule instance, default hard); quality bar (booked-order bar plus a known-optimal unit test); unabsorbable stops (unplaced, call to rebook); the 14-day schedule (separate `scheduled_visits` table, data-design §2). The original questions stay below for the record.


- **Latest finish:** the fixture aims to finish by 18:00 but allows 23:00. Is 18:00 a soft rule (penalized) and 23:00 the hard limit, or should 18:00 be hard for routing? Recommend 23:00 hard, 18:00 soft.
- **Day-of-week and window strictness:** are a customer's day and window always hard, or can a customer mark them preferred (soft)? Recommend each rule declares hard or soft per customer, defaulting to hard.
- **Solver quality bar:** is "no worse than the booked order" enough, or is a stated optimality gap needed? Recommend the booked-order bar for v1, with a known-optimal truth on a small instance.
- **Extra stops a crew cannot absorb:** when no crew in the zone fits, is rescheduling to a later day in scope, or only "unplaceable, call to rebook"? Recommend the latter for v1.
- **Data design dependency:** CAP-7 and the truths wait on sqlsmith's `data-design.md`; the 14-day future schedule means some visits sit after as_of, which the current fixture check `integrity-no-date-after-as-of` forbids. That check's scope needs a decision there.
