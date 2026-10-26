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

## Constraints

- Deterministic solver: no LLM anywhere in routing, and no dependency on Epic 9 (plain-English parameters). Inputs are typed.
- Objective order is fixed: never break a hard rule; then keep the same crew where possible (preferred-crew penalty); then minimize drive time; then finish by the aim-finish time (18:00 soft; 23:00 is the hard limit). Each has its own position in the cost tuple, and a lower priority never trades against a higher one. A stop that cannot be placed without breaking a hard rule is returned unplaced with a reason.
- Suggest only. Nothing is written back to any scheduling system; techs call customers and update by hand.
- Coordinates are internal inputs only: never shown in Slack, never sent to an LLM, never in a reason. Address columns (`properties.street_address`, `postal_code`) stay forbidden and are not used.
- Crew-day hard limits come from configuration, not code. The fixture generator's values are the demo defaults: earliest start 06:00, latest finish 23:00, 15-minute slots.
- Gap-fill candidates come only from scheduled visits in the next 14 days after the gap's date. Ranking uses closeness to the gap, flexibility, how soon the next visit is due, and window fit; reuse `kit/runtime/scoring` (declared weights, a reason per row) where it fits.
- Generic in the kit: no Brightside names, zones or ids in engine code; Brightside wiring ships later as example modules.
- Tests are offline and deterministic, read client specifics from fixtures, and never call a maps service or a model.
- Data reads go through the existing query runner and its guardrails.

## Non-goals

- A real maps or routing API (a later connector).
- Write-back to a scheduling system, or approve-and-push (approval-write archetype, later).
- Any LLM in solving, ranking or parameter filling.
- Slack UX, access key and hub wiring (deferred to the Brightside phase).
- Live traffic or time-of-day travel speeds.
- Multi-day optimization beyond the 14-day candidate pull.
- Crew skills or equipment matching.

## Success signal

- On the Brightside fixture, given a planted broken day (a cancelled afternoon visit on crew 2 at as_of+2, and crew 7 out sick at as_of+3), the engine returns the gap's top-five candidates and the orphaned stops' placements exactly as the known-answer truths state, every row with a plain reason and no coordinates in the output, and `npm run verify` reconciles them offline.

## Assumptions

- Dispatcher is the first user; crews later. Neither changes the engine.
- "Flexibility" for gap-fill is a `flexible` flag the adapter sets on each candidate: true when the stop has no hard day-of-week or time-of-day rule. No new rule type; the engine never infers it.
- A crew's base is its day's start and end point for drive-time estimates.
- One day at a time is enough for v1; the 14-day pull only feeds candidates, it does not re-plan those days.

## Open Questions

Resolved 2026-10-26 (architect T3 review): latest finish (23:00 hard, 18:00 soft, own cost position); day and window strictness (per rule instance, default hard); quality bar (booked-order bar plus a known-optimal unit test); unabsorbable stops (unplaced, call to rebook); the 14-day schedule (separate `scheduled_visits` table, data-design §2). The original questions stay below for the record.


- **Latest finish:** the fixture aims to finish by 18:00 but allows 23:00. Is 18:00 a soft rule (penalized) and 23:00 the hard limit, or should 18:00 be hard for routing? Recommend 23:00 hard, 18:00 soft.
- **Day-of-week and window strictness:** are a customer's day and window always hard, or can a customer mark them preferred (soft)? Recommend each rule declares hard or soft per customer, defaulting to hard.
- **Solver quality bar:** is "no worse than the booked order" enough, or is a stated optimality gap needed? Recommend the booked-order bar for v1, with a known-optimal truth on a small instance.
- **Extra stops a crew cannot absorb:** when no crew in the zone fits, is rescheduling to a later day in scope, or only "unplaceable, call to rebook"? Recommend the latter for v1.
- **Data design dependency:** CAP-7 and the truths wait on sqlsmith's `data-design.md`; the 14-day future schedule means some visits sit after as_of, which the current fixture check `integrity-no-date-after-as-of` forbids. That check's scope needs a decision there.
