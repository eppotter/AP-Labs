# Handoff: route optimization planning (2026-10-26)

**What this is:** where the route-optimization plan stands, so the work can continue on another computer. Read this first, then `AGENTS.md`.

## 1. Where it stands

- **Branch:** `docs/plan-routing`, pushed, with no PR yet. Planning docs only; no code is written.
- **Stage:** the plan gate (stage 3). It is T3, so nothing gets built until Ely writes `approve plan routing`.
- **Done:** intake → spec (scribe) → data design (sqlsmith) → architecture and epics → T3 architect review (1 P1 and 12 P2s, all folded into the docs).

| File | What |
|---|---|
| `docs/planning/specs/spec-routing/SPEC.md` | The spec: CAP-1 to CAP-7 and the not-doing list |
| `docs/planning/specs/spec-routing/data-design.md` | Fixture additions, the `travelMatrix` read path, the engine input contract, the truths S1–S3 |
| `docs/planning/planning-artifacts/architecture-routing.md` | Decisions AD-R1 to AD-R11 and the computed tiers |
| `docs/planning/planning-artifacts/epics-routing.md` | Epics 12–14 (13 PRs), acceptance criteria, files per story, DEP notes |

## 2. What we're building

Two route functions, built as a generic template block in `kit/runtime/routing/` and then applied to Brightside:

1. **Optimize route:** given the stops for a day and the crews, return each crew's stop order and start times.
2. **Route change:** when a customer cancels or a crew is out:
   - place the orphaned stops onto the crews already in the field, as a call list;
   - fill gaps with the top 5 customers from the next 14 days who could be moved up, each with a reason.

Both only suggest. Techs make the calls.

## 3. Ely's decisions (2026-10-26)

- Build the generic engine in the template first, then apply it to Brightside.
- Locations: Brightside gets synthetic coordinates, and drive time is straight-line distance × a factor. Addresses and coordinates are forbidden columns and never reach Slack or an LLM. A maps API comes later as a connector.
- Suggest only: no write-back in v1.
- Keep the rules simple but extensible: preferred crew (soft), day of week, time of day, plus the crew-day limits.
- Ranking order: hard rules → same crew → drive time → finishing by 18:00. A move to another zone can be *recommended* and is flagged.
- Gap fill: the next 14 days, top 5 per gap.
- Users: a dispatcher first, crews later. The Slack UX is deferred.

Decided in review, and open to change at the gate:
- Rules can be hard or soft per customer, defaulting to hard.
- A customer is "flexible" when they have no hard day or time rule.
- A cross-zone recommendation does not count as placed.
- Every shifted stop gets a "call to confirm" row.
- Story 14.5 is a command-line tool, not a Slack module.

## 4. Next steps, in order

1. **Ely:** read the four files, then write `approve plan routing` or ask for changes.
2. **Agent, after approval:**
   - Open a docs PR for the plan (body opens with `**What this does:**`, plus a ledger row) and land it.
   - Add Epics 12–14 to `sprint-status.yaml`.
   - Start Story 12.1 with the builder, following the build loop in `AGENTS.md`.
   - Build Epic 12's stories strictly in order, because they share engine files.
   - Build 13.3 before 14.1.
3. **Ely, at Story 13.3:** get Dana's sign-off on the profile change, `guardrails.md` GRD-002 and the crew-out rule ("lead absent, or nobody present").
4. **Ely, after Story 14.1:** republish to MotherDuck (`npm run fixture:publish`).

## 5. Notes for the agent on the new machine

- Copy the decisions in section 3 into Claude Code memory as a `routing-block` memory. The old machine's memory does not move.
- A P3 review note says "fill defaults after the profile is hashed". Nothing in `kit/` hashes the profile today (checked 2026-10-26), so this needs no work unless a profile hash is added.
- Compute tiers with `APLABS_PROFILE=$PWD/profiles/brightside/profile.yml node kit/lib/tier <paths>`. The path must be absolute.
