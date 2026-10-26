# Handoff: route optimization planning (2026-10-26)

**What this is:** where the route-optimization plan stands, so the work can continue on another computer. Read this first, then `AGENTS.md`.

## 1. Where it stands

- **Branch:** `docs/plan-routing`, pushed, with no PR yet. Planning docs only; no code is written.
- **Stage:** approved. Ely wrote `approve plan routing` on 2026-10-26; the build (stage 4) runs Epics 12 to 14, then 15.2 and 15.3, and stops at the 15.1 live check (DEP-026).
- **Done:** intake → spec (scribe) → data design (sqlsmith) → architecture and epics → T3 architect review, round 1 (1 P1 and 12 P2s, all folded) → Epic 15 added → architect review, round 2 (F1–F18, all folded; see `epics-routing.md`).

| File | What |
|---|---|
| `docs/planning/specs/spec-routing/SPEC.md` | The spec: CAP-1 to CAP-9 and the not-doing list |
| `docs/planning/specs/spec-routing/data-design.md` | Fixture additions, the `travelMatrix` and `mapPoints` read paths, the engine input contract, the truths S1–S3 |
| `docs/planning/planning-artifacts/architecture-routing.md` | Decisions AD-R1 to AD-R17 and the computed tiers |
| `docs/planning/planning-artifacts/epics-routing.md` | Epics 12–15 (19 PRs), acceptance criteria, files per story, DEP notes, both review notes |

## 2. What we're building

Two route functions, built as a generic template block in `kit/runtime/routing/` and then applied to Brightside:

1. **Optimize route:** given the stops for a day and the crews, return each crew's stop order and start times.
2. **Route change:** when a customer cancels or a crew is out:
   - place the orphaned stops onto the crews already in the field, as a call list;
   - fill gaps with the top 5 customers from the next 14 days who could be moved up, each with a reason.

Both only suggest. Techs make the calls.

## 3. Ely's decisions (2026-10-26)

- Build the generic engine in the template first, then apply it to Brightside.
- Locations: Brightside gets synthetic coordinates, and drive time is straight-line distance × a factor. Addresses and coordinates are forbidden columns. A maps API comes later as a connector.
- Suggest only: no write-back in v1.
- Keep the rules simple but extensible: preferred crew (soft), day of week, time of day, plus the crew-day limits.
- Ranking order: hard rules → same crew → drive time → finishing by 18:00. A move to another zone can be *recommended* and is flagged.
- Gap fill: the next 14 days, top 5 per gap.

Added later the same day (Epic 15, the Slack map):
- A Slack modal shows a map of the route, opened from the hub menu. A select menu switches between four views: booked vs optimized, before vs after a route change, all crews in a zone, and gap fill.
- The map is a plain plot drawn on our server as a PNG: numbered stops, a line color per crew, zone outlines, the crew base. No street tiles and nothing sent to a map provider; a street basemap waits for the maps connector.
- Users: dispatchers see every crew; a crew lead sees only their own crew. Who is a crew lead of which crew lives in the profile. Dana signs off the audience; that blocks Story 15.5 only.
- **Rule change (T3 guardrail):** no coordinate, street address or postal code ever appears as text anywhere (Slack, logs, reasons, the AI). A map image is allowed, only inside the routing modal, only for the routing audience, never in a channel, never sent to the AI. It reveals approximate locations: each place is rounded to about 200 m (within about 150 m of the real spot), every map covers at least 5 km, and each image is deleted from Slack within 20 minutes. Dana signs this as a GRD-002 update, written at Story 15.5.
- The module ships to dev first (15.5); a one-line PR (15.6) turns on prod once Dana has signed.

From the architect's round 2 review (Orchestrator's calls):
- All Epic 15 stories are T3.
- No new Slack scope (`files:read`): a crash in the moment between uploading an image and recording it can leave one unshared file behind. Accepted as a named risk.
- CI gains a container smoke test for the image library (needs the `workflow` token scope).
- The file sweep runs even when the profile's jobs are switched off; if it can't run, the routing module is not offered.
- A dispatcher can pick a day from a week back to the end of the 14-day horizon, nothing else.
- Story 14.5's command-line tool stays as the way to test without Slack.

Decided in review, and open to change at the gate:
- Rules can be hard or soft per customer, defaulting to hard.
- A customer is "flexible" when they have no hard day or time rule.
- A cross-zone recommendation does not count as placed.
- Every shifted stop gets a "call to confirm" row.
- Story 14.5 is a command-line tool; the Slack module is Epic 15.
- A crew lead sees gap-fill candidates only when they are booked on their own crew; others are counted (until Dana decides).
- `mapPoints` is its own story (15.2), split from the spike (15.1).

## 4. Next steps, in order

1. **Agent:** recompute Epic 15's tiers from the updated file lists (15.6 is new). All round-2 findings are folded.
2. **Ely:** done 2026-10-26 (`approve plan routing`).
3. **Agent, after approval:**
   - Open a docs PR for the plan (body opens with `**What this does:**`, plus a ledger row) and land it.
   - Add Epics 12–15 to `sprint-status.yaml`.
   - Start Story 12.1 with the builder, following the build loop in `AGENTS.md`.
   - Build Epic 12's stories strictly in order, because they share engine files.
   - Build 13.3 before 14.1.
   - With the other up-front questions, ask Ely for Dana's audience answer (who are dispatchers, who leads which crew). Only 15.5 waits for it.
4. **Ely, at Story 13.3:** get Dana's sign-off on the profile change, `guardrails.md` GRD-002 and the crew-out rule ("lead absent, or nobody present").
5. **Ely, after Story 14.1:** republish to MotherDuck (`npm run fixture:publish`).
6. **Ely, at Story 15.1:** approve the new store record kind for map file ids. Then open the dev-only map check in dev Slack and report whether the image shows in the modal, whether Back and Close are seen, and whether the file is gone after delete. Also try to open, share and download the image, have someone outside the audience search Files for `route-map.png`, and note whether the image shows straight after upload. If the image does not show, the fallback (send it to your own DM with the bot) needs Dana's yes, knowing it would then show in notification previews and the Files list.
7. **Ely, at Story 15.3:** approve the new `@resvg/resvg-js` dependency after its review. The story changes `.github/workflows/ci.yml`; if the push is refused for the `workflow` scope, the agent stops and posts `--kind blocked`.
8. **Ely, at Story 15.5:** give Dana's audience list before it merges, then walk the live check in dev Slack. Ask Dana to sign the GRD-002 map image rule (with its numbers).
9. **Ely, at Story 15.6:** once Dana has signed GRD-002, approve the one-line PR that turns on prod.

## 5. Notes for the agent on the new machine

- Copy the decisions in section 3 into Claude Code memory as a `routing-block` memory. The old machine's memory does not move.
- A P3 review note says "fill defaults after the profile is hashed". Nothing in `kit/` hashes the profile today (checked 2026-10-26), so this needs no work unless a profile hash is added.
- Compute tiers with `APLABS_PROFILE=$PWD/profiles/brightside/profile.yml node kit/lib/tier <paths>`. The path must be absolute.
