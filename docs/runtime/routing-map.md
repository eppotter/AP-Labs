# The routing map: a module, and its live check (Story 15.4)

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

The test fixture `test/fixtures/routing-map/adapter.js` is a working example. Brightside's adapter gains these three functions in Story 15.5.

## What the person sees

- **Open:** "Loading…", then the map, the controls (view, day, crew or zone) and the list.
- **Views:** Booked vs optimized (one crew), Route change (one zone; a crew lead: their crew), Zone (one zone's booked routes), Gap fill (one crew's first gap and up to five visits that could move into it).
- **A switch:** "Drawing the map…", then the new map. The old image file is deleted.
- **A crew lead:** only their crew. Stops moved off their crew say "moved to another crew"; gap candidates booked on other crews are counted, not named.
- **Ways out:** Back (to the menu), Close (the X), an error (a plain message, with Back), an expired window after 15 minutes without use ("This map has expired… open Routing again"), access withdrawn (the refusal, in the window).

Image files are private Slack files shared nowhere. They are deleted when the window closes or, at the latest, 20 minutes after upload (the sweep).

## Live check (Ely, dev Slack)

These need real Slack, so each is **untested until you run it**. Run them once Story 15.5 has put a Brightside routing module on the dev menu. Before then, nothing on the menu uses this archetype. Start the bot as in `map-check.md` ("Before you start"); `engine_jobs` must list `sweep-map-files`.

| # | You do | Look for |
|---|---|---|
| 1 | As a dispatcher, open **Routing**. | "Loading…", then the map, three controls (view, day, crew) and the list. |
| 2 | Switch through all four views, and change the crew and zone. | "Drawing the map…" each time, then the new map. In the terminal, one `map image shown` per switch, and no `map not shown`. |
| 3 | Switch twice quickly. | The second choice is the one that stays. |
| 4 | Pick a day more than 7 days back, or past the horizon. | "That day is outside what this map can show…", and no map. |
| 5 | As a crew lead, open Routing and switch through all four views. | Only their crew everywhere: one crew in the select, no other crew's customers. |
| 6 | Press **Back**. | The menu. In the terminal, `map view closed` with `deleted:` at least 1. |
| 7 | **15.1 item 3 (Close), carried over:** open Routing, then close with the **X** on desktop and with a swipe down on iOS. | `map view closed` with `cleared: true` each time. If none appears, write that down: the sweep then deletes the files within 20 minutes, and nothing changes. |
| 8 | **15.1 item 6, carried over:** ask a second person outside the audience to search **Files** for `route-map.png` and `Route map`. | They find nothing. |
| 9 | Leave a map open for over 15 minutes, then switch the view. | "This map has expired… open Routing again". |
| 10 | Read every line of the list and the alt text (hover the image on desktop). | No address, postal code or coordinate anywhere. |

**A note, no change:** clicking the image in Slack offers Open in Browser, Copy Link and Share (15.1 item 5). The link opens only for a workspace member with access, but Copy may put the image on the clipboard, and anyone can screenshot. Dana Reyes must know this before she signs GRD-002 (DEP-025). No code change.

Record the outcome under Story 15.4 in `docs/planning/planning-artifacts/epics-routing.md`, one line per item.
