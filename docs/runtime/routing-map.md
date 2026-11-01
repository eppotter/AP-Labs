# The routing map: a module, and its live check (Stories 15.4 and 15.5)

The `routing-map` archetype (`kit/runtime/archetypes/routing-map`) puts a plain map of a crew's day in a Slack window, with a short text list under it. A dispatcher sees every crew; a crew lead sees only their own (AD-R17). Suggestions only: nothing is written, and nothing goes to the AI. Design: `docs/planning/planning-artifacts/architecture-routing.md` AD-R12 to AD-R17.

## A module that uses it

A folder under `<app>/modules/<id>/` with two files.

`manifest.json`:

```json
{
  "id": "routing",
  "hub": "ops",
  "label": "Route map",
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
- **Ways out:** Back (to the menu), Close (the X), an error (a plain message, with Back), an expired window after 15 minutes without use ("This map has expired… open Route map again"), access withdrawn (the refusal, in the window).

Image files are private Slack files shared nowhere. They are deleted when the window closes or, at the latest, 20 minutes after upload (the sweep).

## Brightside's Routing module (Story 15.5)

Its menu label is **Route map** (renamed 2026-10-31, so the tool is not named like its **Routing** group header); the module id stays `routing`.

`examples/brightside/app/modules/routing/`: dev and production (`environments: ["dev", "prod"]`); Story 15.6 added production after Ely Potter signed GRD-002's map image rule on 2026-10-31 (DEP-025). Its adapter is `examples/brightside/app/routing/adapter.js`; names come from `labels.sql`. The audience in `profiles/brightside/profile.yml`, decided by Ely Potter on 2026-10-31 (DEP-024, closed): **Ely Potter and Steven Auslander** are the dispatchers (both hold `ROUTING_ALL_CREWS`), and there are no crew leads.

## Live check (Ely, dev Slack)

Real Slack only, so each step is **untested until you run it**. About 10 minutes.

**Before you start** (in the main checkout, after this story merges):

1. `npm run fixture:build`: the local data must be generator v4 (it has the schedule the map reads). `npm run fixture:status` should say `local fixture version 4+…, as of 2026-09-30`.
2. Start the bot in dev: `APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" APLABS_APP_DIR="$PWD/examples/brightside/app" npm start`. The startup line's `engine_jobs` must list `sweep-map-files`. Keep the terminal visible.

| # | You do (as Ely or Steven) | Look for |
|---|---|---|
| 1 | `/brightside`, **View** on **Route map** (under the **Routing** header). Pick day **2026-10-03** (as_of+3). | "Loading…", then a map, the controls (view, day, crew) and a list. |
| 2 | Switch the view to **Route change**, then the zone to **Zone east**. | A map, and in the list one "Recommended for another zone" line and no "To rebook". |
| 3 | Switch to **Zone**, then **Gap fill**, then **Booked vs optimized**. | Each: "Drawing the map…", then a map or a plain sentence (Gap fill on this day: no cancellation). Terminal: `map image shown` per map, no `map not shown`. |
| 4 | Pick a day more than 7 days before 2026-09-30. | "That day is outside what this map can show…", no map. |
| 5 | Read the list and the alt text (hover the image on desktop). | No address, postal code or coordinate anywhere. |
| 6 | Look through your DM with the bot, a channel and Files. | `route-map.png` is nowhere outside the window. |
| 7 | Press **Back**. | The menu. Terminal: `map view closed`, `deleted:` at least 1. |
| 8 | **15.1 carry-over:** open Route map again and close it with the **X** (desktop), then once more with a swipe down (iOS). | `map view closed` with `cleared: true` each time. None? Note it: the sweep deletes within 20 minutes; nothing changes. |
| 9 | Open Route map, leave it over 15 minutes, then switch the view. | "This map has expired… open Route map again". |
| 10 | **15.1 carry-over:** a second person (not in the audience) searches **Files** for `route-map.png` and `Route map`. | They find nothing; they don't see Route map on their menu either. |

**Not checked live:** the crew-lead check (a lead sees only their crew in every view): the demo has no crew leads (DEP-024, closed). The tests cover it on the fixture.

**A note, no change:** clicking the image offers Open in Browser, Copy Link and Share (15.1 item 5). This is written into GRD-002, signed by Ely Potter on 2026-10-31 (DEP-025).

Record the outcome in the Story 15.5 PR, one line per step.

## Street map live check (Story 15.11, Ely, dev Slack)

Brightside's profile turns the street map on (`routing.basemap`: OpenStreetMap's free tiles, dev and demo only). **Untested until you run it.** Start the bot as above; the fixture must be generator v6 (Columbus, no point on water). Note each result in the Story 15.11 PR, one line each.

1. **Four views** (Booked vs optimized, Route change, Zone, Gap fill): each shows streets, markers on streets. Note any marker on water.
2. **Credit:** "© OpenStreetMap contributors" shows under the picture on desktop and iOS.
3. **Kill switch:** restart with `APLABS_BASEMAP_OFF=1`: the plain map and the short note.
4. **Bad host:** point `url_template` at a host that doesn't answer (a local copy of the profile): the plain map and the note within about 8 s.
5. **Modal image:** the larger PNG shows. Note its size and how long it takes to draw.
6. **Provider:** OpenStreetMap answers 200 (no `forbidden`, `rate_limited` or `server_error` in the terminal).
7. **Cache:** re-open the same view: the debug log's tile-request count is 0 (a count only, never a tile number).
8. **15.1 carry-overs:** Close (the X) sends `view_closed` (`map view closed`); a second person's Files search finds nothing (steps 8 and 10 above).

Story 15.6 turned on production after Ely Potter signed GRD-002's reworded map image rule on 2026-10-31 (DEP-025).

## Plan a route live check (Story 15.15, Ely, dev Slack)

**Plan a route** (`examples/brightside/app/modules/route-planner/`, dev and production since Story 15.6) reorders one crew's day from the Office (`routing.depot`, the one `depots` row). **Untested until you run it.** First `npm run fixture:build`: the local data must be generator v7 (it has the Office). Start the bot as above. Note each result in the Story 15.15 PR, one line each, with seconds where asked.

1. **Open:** `/brightside`, **Open** on **Plan a route**, pick a crew and as_of+3 (**2026-10-03**), **Show stops**: the Office marker and the loop, the totals line at the top.
2. **Fast moves:** pick **⋯ Move stop 1 down** three times fast: the list follows each move without jumping, and the map lands on the final order. Note the seconds.
3. **Optimize,** then **Reset to booked**: the order changes, then returns to the booked one.
4. **Rule break:** move a morning stop late: a warning shows under it and the count at the top rises.
5. **Ways out:** **Change crew or day**, then **Back**; open again and close with the **X**: the terminal shows the files deleted both times (also 15.1's open Close item).
6. **iOS,** once: the buttons and the ⋯ menus (an action sheet) can be tapped and the layout stays put.

The MotherDuck copy has no Office until Ely republishes v7 (DEP-033): until then, run this on the local fixture. Story 15.6 turned on production after DEP-025 and DEP-032 were signed (2026-10-31).

## Customer cancellation and Crew out (Story 19.4)

Two what-if screens of the same archetype (`kit/runtime/archetypes/routing-map/whatif.js`, plan brightside-v1 D8). Same audience, sessions, map files and 20-minute deletion as the views. Suggestions only: nothing is written.

A module names its screen in `manifest.json`:

| `screen` | The tool | The adapter also needs |
|---|---|---|
| `cancellation` | **Customer cancellation:** pick a crew and day, **Show visits**, then the visit that cancels (a select of "hh:mm · client name", "(cancelled)" when the data already shows it). The Gap fill view for the gap it leaves, the top five with reasons, and **Fill with #1** to **#5**: Plan a route's list and map for the day with that visit moved up into the gap ("↩️ Moved up from <day>"). | `visits()`, `gapFor()`, and what Plan a route needs (`route()` taking `fill`, and `routing.depot` in the profile) |
| `crew-out` | **Crew out:** pick a day and crew, **Mark out for the day**: the Route change view for the crew's zone with that crew out. A crew the data already shows out says so above the same view. | `crewOut()` |
| `add-stop` | **Add a stop** (Story 19.5): see the next section. | `addStop()`, `clients()`, and what Plan a route needs |

| Function | Returns |
|---|---|
| `visits({ day, crewId, scope })` | `{ known, visits }`: whether the crew is in the day's data, and its visits, each `{ stopId, node, start, cancelled }`. Names come from `labels()`. |
| `gapFor({ day, crewId, stopId, scope })` | `{ input, travel }` for `fillGap`, with `stopId` taken as cancelled (one the data already shows cancelled stays as it is). |
| `crewOut({ day, crewId, scope })` | `{ input, travel, wasOut }`: the day with that crew `available: false`; `wasOut` says the data already had it out. |
| `route({ ..., fill: { cancel, add } })` | Plan a route's day with visit `cancel` left out and candidate `add` in its place. |

Each is scoped like `route()`: a crew lead's crew comes from `scope`, whatever `crewId` says. A screen whose adapter lacks one shows "not available" and the menu row shows **Why?** ("needs map setup"). Brightside's adapter has all four and runs no new SQL.

**Ways out, each tested:** Back and the X (the map files go; a draw still running shows nothing), **Change crew or day** (from every step, the Fill result too), **Pick another visit**, an error (a plain message, Back), an expired window, an expired trigger, no visits, a crew not working, access withdrawn, a click from another person's window, and the map not ready (Why?).

**Where they run:** dev only until their live check passes, then a one-line PR each turns on production (plan brightside-v1 gate item 5). On `/brightside-v1` (Story 19.2) they are the folders `v1-route-cancellation` and `v1-route-crew-out`, beside `v1-route-optimize` (Optimize a route, the route editor), `v1-route-add-stop` (Add a stop, Story 19.5) and `v1-route-map` (Route map), all five dev only, with the same key and adapter as `/brightside`'s; the `/brightside` copies come with Story 20.3.

### Live check (Ely or Steven, dev Slack)

**Untested until you run it.** Run on the local fixture (`npm run fixture:build`).

1. **Customer cancellation:** crew 2, **2026-10-02**, **Show visits**. The afternoon visit shows "(cancelled)". Pick it: property 762's client is **#1**. Press **Fill with #1**: the day shows that client "↩️ Moved up from…" in the gap. **Optimize** works.
2. **Pick another visit**, then a morning visit: a different gap and its candidates.
3. **Crew out:** **2026-10-03**, crew 7, **Mark out for the day**: "is out on … in the data"; 5 visits move in the zone, 1 is recommended for another zone, none to rebook.
4. **Crew out** on a crew that is working that day: "What if … is out…?" and its stops placed.
5. **Ways out:** **Change crew or day** from each result, **Back**, the **X**; the terminal shows the files deleted.

## Add a stop (Story 19.5)

Plan a route's editor with one more button (`kit/runtime/archetypes/routing-map/addstop.js`, plan brightside-v1 D8). Same audience, sessions, map files and 20-minute deletion. Suggestions only: nothing is saved or booked.

1. Pick a crew and day, **Show stops**: Plan a route's list and map, with **Add a stop** between **Reset to booked** and **Change crew or day**.
2. **Add a stop** opens a form where the buttons were (the list and the map stay; the ⋯ menus hide): a client search, a length (30 minutes to 4 hours, steps of 15; 1 hour first) and a start window (Any time, Morning, Afternoon).
3. The client search is a Slack `external_select`. After two letters, Slack asks the app for options (`block_suggestion`): at most 20 clients of the crew's zone (`clients.zone_id`) whose name holds the text, one per property, as "name · city". A property with a visit booked that day is never offered. Never an address, postal code or position. The options carry tokens, not ids.
4. **Add**: the engine's `insertStop` puts the stop at the cheapest place in the order shown (the AD-R5 tuple: hard breaks, soft penalty, drive, past the aim finish; the first of equal places). It joins the list marked "➕ Added stop: a suggestion only, nothing is booked", and the map redraws. When no place keeps every hard rule, it goes last with "⚠ No place on this crew keeps every hard rule, so it is placed last". A dispatcher also sees the two cheapest other crews of the zone that could take it; a crew lead sees none.
5. **Remove added stop** takes it out again. **Optimize** and the ⋯ moves work with it in the day; **Reset to booked** keeps it where `insertStop` put it.

| Function | Returns |
|---|---|
| `clients({ day, crewId, query, scope })` | `{ clients: [{ node, clientName, city }] }`: the search's clients, at most 20 (Brightside: `clients.sql`). |
| `addStop({ day, crewId, depot, scope, node, minutes, window })` | `{ input, travel, distance, stop }`: the crew's zone from the Office (a crew lead: only their crew), and the new stop with its window as a hard time-of-day rule. It checks the client again (in the zone, no visit that day) and refuses one that fails (`unknown_client`). |

Both are scoped like `route()`. A module whose adapter lacks one shows "not available" and the menu row shows **Why?**.

**Who may search:** the hub's options listener answers no options unless the search comes from this person's own open Add a stop form, the module is still theirs to open here (grant and environment), and the routing audience still gives them a scope, all checked before any read. A search that fails, or takes longer than 2.5 seconds (Slack waits 3), answers no options too.

**Ways out, each tested:** **Back to the day** (closes the form), Back and the X (the files go; an Add still working shows nothing), no client found (Slack shows no results), the search failing or too slow (no results), a client that can't be added (the form says why), the day's bookings changed under the form (the form says so), the data unavailable on Add (the form says so), a stop added then removed, an expired window and an expired trigger, access withdrawn (a click shows the refusal; a search gets no options), a search or click from someone else's window, and the map not ready (Why?).

**Where it runs:** dev only, as `v1-route-add-stop` on `/brightside-v1` (the `/brightside` copy comes with Story 20.3).

### Live check (Ely or Steven, dev Slack)

**Untested until you run it.** Run on the local fixture (`npm run fixture:build`).

1. `/brightside-v1`, **Run** on **Add a stop**: crew 4, **2026-10-01**, **Show stops**: seven stops and the map.
2. **Add a stop**: the form shows where the buttons were. Type two letters of a client's name: up to 20 names of crew 4's zone, each "name · city". **This is the first test of Slack's options load over Socket Mode.** If no list appears, note what Slack shows.
3. Pick one, 1 h, **Afternoon**, **Add**: the stop joins with ➕ after 12:00, the map redraws, and a line names the other crews of the zone that could take it (or says none has room).
4. **Remove added stop**: the day as before.
5. **Ways out:** **Add a stop** then **Back to the day**; **Back**; the **X**; the terminal shows the files deleted.

