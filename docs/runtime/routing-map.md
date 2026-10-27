# The routing map: a module, and its live check (Stories 15.4 and 15.5)

The `routing-map` archetype (`kit/runtime/archetypes/routing-map`) puts a plain map of a crew's day in a Slack window, with a short text list under it. A dispatcher sees every crew; a crew lead sees only their own (AD-R17). Suggestions only: nothing is written, and nothing goes to the AI. Design: `docs/planning/planning-artifacts/architecture-routing.md` AD-R12 to AD-R17.

## A module that uses it

A folder under `<app>/modules/<id>/` with two files.

`manifest.json`:

```json
{
  "id": "routing",
  "hub": "ops",
  "label": "Routing",
  "description": "Each crew's day on a map",
  "resource": "ROUTING_ALL_CREWS",
  "archetype": "routing-map",
  "environments": ["dev"],
  "adapter": "adapter.js"
}
```

- `resource` must be the profile's `routing.audience.all_crews` key. Who may open it comes from the whole audience (`all_crews`, or `own_crew` plus a `crew_leads` row), not from this key alone.
- No `handler`, `query`, `parameters`, `scoring` or `row_id`: startup refuses them.
- The profile needs a `routing:` block with an `audience` (Story 15.2).

`adapter.js` exports `createAdapter({ data, routing })`, which returns three functions:

| Function | Returns |
|---|---|
| `asOf()` | The date the data is as of (`YYYY-MM-DD`). Read once when the window opens; the date picker allows 7 days before it to `routing.gap_fill.horizon_days` after it. |
| `input({ day, view, scope })` | `{ input, travel }`: the engine's input for that day (AD-R2) and the travel function (`sdk.routing.travel.fromMatrix` over `sdk.travelMatrix` rows). For `change`, crews that are out have `available: false`. For `gap`, add `cancelled` and `candidates`. `scope` is `{ all: true }` or `{ crewId }`; `change` and `gap` must not be cut to one crew (the engine needs the others). |
| `labels({ day, nodeIds, scope })` | An object keyed by node id: `{ crewName }` for `crew:<id>`, `{ clientName, city }` for a place. Nothing else: any other field is refused and the window shows an error. Filter the query by `scope`. Never an address, postal code or coordinate. |

The test fixture `test/fixtures/routing-map/adapter.js` is a working example; Brightside's (Story 15.5, below) is a real one.

## What the person sees

- **Open:** "Loading…", then the map, the controls (view, day, crew or zone) and the list.
- **Views:** Booked vs optimized (one crew), Route change (one zone; a crew lead: their crew), Zone (one zone's booked routes), Gap fill (one crew's first gap and up to five visits that could move into it).
- **A switch:** "Drawing the map…", then the new map. The old image file is deleted.
- **A crew lead:** only their crew. Stops moved off their crew say "moved to another crew"; gap candidates booked on other crews are counted, not named.
- **Ways out:** Back (to the menu), Close (the X), an error (a plain message, with Back), an expired window after 15 minutes without use ("This map has expired… open Routing again"), access withdrawn (the refusal, in the window).

Image files are private Slack files shared nowhere. They are deleted when the window closes or, at the latest, 20 minutes after upload (the sweep).

## Brightside's Routing module (Story 15.5)

`examples/brightside/app/modules/routing/`: dev only (`environments: ["dev"]`) until Dana Reyes signs GRD-002's map image rule (Story 15.6). Its adapter is `examples/brightside/app/routing/adapter.js`; names come from `labels.sql`. The audience in `profiles/brightside/profile.yml` is a **dev placeholder**: Dana (the user Ely drives in dev) is the one dispatcher, and no crew leads are listed until Dana confirms the real list (DEP-024).

## Live check (Ely, dev Slack)

Real Slack only, so each step is **untested until you run it**. About 10 minutes.

**Before you start** (in the main checkout, after this story merges):

1. `npm run fixture:build`: the local data must be generator v4 (it has the schedule the map reads). `npm run fixture:status` should say `local fixture version 4+…, as of 2026-09-30`.
2. Start the bot in dev: `APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" APLABS_APP_DIR="$PWD/examples/brightside/app" npm start`. The startup line's `engine_jobs` must list `sweep-map-files`. Keep the terminal visible.

| # | You do (as Dana) | Look for |
|---|---|---|
| 1 | `/brightside`, **Open** on **Routing**. Pick day **2026-10-03** (as_of+3). | "Loading…", then a map, the controls (view, day, crew) and a list. |
| 2 | Switch the view to **Route change**, then the zone to **Zone east**. | A map, and in the list one "Recommended for another zone" line and no "To rebook". |
| 3 | Switch to **Zone**, then **Gap fill**, then **Booked vs optimized**. | Each: "Drawing the map…", then a map or a plain sentence (Gap fill on this day: no cancellation). Terminal: `map image shown` per map, no `map not shown`. |
| 4 | Pick a day more than 7 days before 2026-09-30. | "That day is outside what this map can show…", no map. |
| 5 | Read the list and the alt text (hover the image on desktop). | No address, postal code or coordinate anywhere. |
| 6 | Look through your DM with the bot, a channel and Files. | `route-map.png` is nowhere outside the window. |
| 7 | Press **Back**. | The menu. Terminal: `map view closed`, `deleted:` at least 1. |
| 8 | **15.1 carry-over:** open Routing again and close it with the **X** (desktop), then once more with a swipe down (iOS). | `map view closed` with `cleared: true` each time. None? Note it: the sweep deletes within 20 minutes; nothing changes. |
| 9 | Open Routing, leave it over 15 minutes, then switch the view. | "This map has expired… open Routing again". |
| 10 | **15.1 carry-over:** a second person (not in the audience) searches **Files** for `route-map.png` and `Route map`. | They find nothing; they don't see Routing on their menu either. |

**Pending DEP-024:** the crew-lead check (a lead sees only their crew in every view) waits for Dana's audience list. The tests cover it on the fixture today.

**A note, no change:** clicking the image offers Open in Browser, Copy Link and Share (15.1 item 5). This is written into GRD-002 for Dana's sign-off (DEP-025).

Record the outcome in the Story 15.5 PR, one line per step.
