---
owner: Ely Potter          # the named client person who owns this file
signed_off: 2026-10-31  # pending, or the ISO date (YYYY-MM-DD) the owner signed off
signed_off_by: "Ely Potter (2026-10-31)"  # who signed off: the owner, recorded by a facilitator
updated: 2026-10-31        # ISO date of the last edit
---

# Guardrails

Written by the Onboarder for Architect. Most of this mirrors `.aplabs/profile.yml`: cite the
profile rather than copy it, and propose profile changes to the Orchestrator instead of editing it.

In this template repo Brightside's profile is `profiles/brightside/profile.yml` (a fork keeps it at
`.aplabs/profile.yml`). **All nine rule cards (GRD-001 to GRD-009) are approved:** Ely Potter signed
off this file on 2026-10-31 (plan brightside-v1, Story 18.1). GRD-009 (Ask's read-only queries) was
signed by the same plan's gate approval (`approve plan brightside-v1`, 2026-10-31) as worded in its
D10, and added by Story 19.7, with GRD-005's exceptions.

Until 2026-10-31 these files named a fictional owner, Dana Reyes, played by Ely; lines that say
"Ely as Dana Reyes" are kept as history. History of this file: it was first signed on 2026-10-25 (Ely
as Dana Reyes). Story 13.3 (route optimization) changed it on 2026-10-26: GRD-002 named the four
coordinate columns and GRD-008 recorded the crew-out rule (DEP-028). Story 15.5 added the routing map
image rule to GRD-002 (DEP-025), and Story 15.11 reworded it for the street map under the picture.
Story 15.7 added the Columbus coordinates line to GRD-007 (with DEP-025), and its follow-up fix on
2026-10-27 kept every point off the area's big water. Story 15.15 (Plan a route, 2026-10-27) added
the Office and a route's total distance to GRD-002 and the Office exception to GRD-007 (DEP-032).
Ely Potter approved all of them on 2026-10-31 and settled GRD-008's edge cases; DEP-025, DEP-028 and
DEP-032 are closed.

## Guardrails

<!-- The client's standing rules for any build. One rule card each (below). -->

- GRD-001: the bot only reads data. No query writes, changes structure or attaches anything.
- GRD-002: forbidden columns (coordinates included) are never named, and `SELECT *` is refused;
  `travelMatrix` alone reads the coordinates and returns drive minutes only. Approved update: a
  coarse map picture (about 150 m) on a street map, only in the Routing window, deleted within 20
  minutes; the street-map provider learns the area viewed and when, never which stops or customers.
  Approved update (DEP-032): an estimated distance too, only a route's total shown; the Office has
  its own marker and is never shown by address.
- GRD-003: MotherDuck is read through the locked reader sequence; one accepted exception (`my_db`).
- GRD-004: anything that writes to an outside system goes through the approval step, never a module.
- GRD-005: the AI fills in a form and nothing else: no data rows, a spend breaker and an off switch.
- GRD-006: pay rates are open for the demo, but Labour cost is for owner and admin only, totals only.
- GRD-007: the data is synthetic, and publishing it is a human step. Approved update: the
  coordinates are random points in the Columbus area, none from a real address and none on water.
  Approved update (DEP-032): the Office is the one point that is not random.
- GRD-008: a crew is out for the day when its lead is absent, or nobody on it is present. A stand-in
  lead counts as the lead; a member present for part of the day counts as present.
- GRD-009: Ask may answer a data question with a read-only query built only from signed query
  rules, for people granted `ASK_DATA` by name, reading only the profile's `ask` tables and columns.
  The AI never sees the result.

## Protected systems

<!-- Systems and data no build may change without a named approver, and why. -->

- **The profile** (`profiles/**`, and `.aplabs/**` in a fork): who can use what. T3 by the profile's
  `tiers`, and `.aplabs/**` always floors at T3. Any change needs the plan gate and a T3 approver.
- **Write paths, connections and secrets:** `kit/runtime/archetypes/approval-write/**`,
  `kit/runtime/connectors/**`, `kit/lib/secrets/**` are T3 in the profile's `tiers`.
- **The SQL guardrail, query runner and AI service:** `kit/runtime/sql/**`, `kit/runtime/data/**`
  and `kit/runtime/llm/**` are T2 in the profile, and the engine floors them at T3 for every fork
  (`ENGINE_T3` in `kit/lib/tier`).
- **The shared data** (`brightside_fixture` in MotherDuck): only `fixture:publish`, run by Ely, may
  change it (`docs/runtime/motherduck-publish.md`). The bot holds a read-only key to a share.
- **Billing and client export** (`billing/**`, `customers/export/**`): T3 in the profile. No code
  exists there yet.

## Write paths

<!-- Every action that writes to a system outside the repo: what it writes, the human gate on it, the kill switch. -->

| Write | Where it goes | Human gate | Kill switch | Status |
|---|---|---|---|---|
| Create a win-back list, add its contacts | Mock email tool (`email` connector, outbox file) | The approval-write archetype: preview, then a person approves (Epic 10) | `BRIGHTSIDE_EMAIL_OFF`, or `APLABS_WRITES_OFF` for every connector | Connector built (Story 8.3); the approval flow is not built yet (Epic 10), so nothing writes today |
| Publish the fixture | MotherDuck `brightside_fixture` | Ely runs it by hand; agents never do | Not run | Human step |

Every connector write is a dry run unless the approval-write archetype passes `dryRun: false`. The
write-path check (`engine:write-path`, in `npm run check`, `npm test` and every `npm run verify`)
fails any other code that does. The mock CRM has no writes.

## Approvers

<!-- Who approves what: name, role, and the scope of their approval. Cite the profile's permissions. -->

From the profile's `users` and `resources`:

- **Ely Potter** (admin): holds `TIER3_APPROVE` (approve T3 changes; `admin_grantable: false`, so
  only the profile can give it), `WIN_BACK` and `ROUTING_ALL_CREWS`. Owns and signs every client
  context file. The admin role confers the gated resources, such as `OUTBOX`.
- **Steven Auslander** (admin): every grant Ely Potter has, on every hub, always (plan
  brightside-v1: any grant to Ely is granted to Steven in the same change). He may sign rules for
  the demo client as Ely can.
- **Marcus Lee** (member): holds `VERIFY_SKIP` (waive a skipped verify check). No T3 approval.
- **The routing map audience** (`routing.audience`, Story 15.5): `ROUTING_ALL_CREWS` (dispatchers)
  and `ROUTING_OWN_CREW` (crew leads), neither conferred by the admin role. Decided by Ely Potter on
  2026-10-31 (DEP-024, closed): the dispatchers are Ely Potter and Steven Auslander, and there are
  no crew leads.
- `TIER3_APPROVE` here is the demo client's resource; merges in this template repo are Ely's
  (AGENTS.md "Merge authority").

## Cost limits

<!-- Spending limits per system or service (API calls, compute, licences) and who is told when one is near. -->

- **AI (Anthropic):** the profile sets no `llm` block, so the defaults apply: USD 2 an hour of
  estimated spend per bot process (`llm.hourly_usd_limit`), 20 AI requests per person an hour,
  1,024 output tokens a reply, 20 seconds a call, no retries (`docs/runtime/ai-setup.md`). The
  hourly breaker resets on restart; the console's monthly spend cap (suggested USD 20, DEP-018,
  owner Ely) is the one that can't.
- **MotherDuck:** 10 seconds to connect, 30 seconds a query (`kit/runtime/data/motherduck.js`).
  No spending limit is recorded: **empty field, owner Ely** (the MotherDuck plan and its cap).
- **Connectors:** 5 calls a second each (see `connectors.md`).
- Who is told when a limit is near: **empty field, owner Ely Potter.** Today the breaker refuses and
  logs a warning; nobody is notified.

## Rule cards

<!--
One card per rule (docs/reference/05-discovery-process.md §3); typical types here are access_rule,
exception_workflow and data_quality_guard.

### RULE-ID: name
- rule: plain-language statement of the rule, and what it is NOT
- owner: the client person who confirms it
- evidence: where it came from (session, document, system) and how a build can test it
- status: draft | challenged | approved | retired (approved only with the owner's sign-off and date)
-->

### GRD-001: Read-only data
- type: access_rule
- rule: every query the bot runs only reads. The SQL guardrail (`kit/runtime/sql`) refuses writes,
  DDL, `ATTACH`, `COPY`, file and URL reads and multiple statements before the query runs, and the
  query runner (`kit/runtime/data`) opens the data read-only. NOT a promise about the outside
  systems: writes there follow GRD-004.
- owner: Ely Potter
- evidence: Story 7.4 and 7.5; the guardrail and runner tests in `test/`. A build tests it by
  sending a write through the runner and expecting a refusal.
- status: approved

### GRD-002: Forbidden columns
- type: access_rule
- rule: no query may name a column in the profile's `sql.forbidden_columns` (client phone, property
  street address, property postal code, and the four coordinate columns `properties.geo_lat_e6`,
  `properties.geo_lon_e6`, `crews.base_geo_lat_e6`, `crews.base_geo_lon_e6`, and since Story 15.15
  the Office's two, `depots.geo_lat_e6` and `depots.geo_lon_e6`), and while any is set,
  `SELECT *` and whole-row references are refused. The coordinate columns have one named exception,
  `travelMatrix` (below). Email is allowed: the win-back push needs it.
  `properties.access_method` holds a method, never a door code. NOT a rule about display: a column
  that is allowed can still be limited by who may use the entry (GRD-006).
- coordinates (Story 13.3, route optimization): the four coordinate columns are forbidden before the
  fixture gains them (Story 14.1), and they stay forbidden to every query and every other read path.
  The one named exception is the kit's drive-time read, `travelMatrix`
  (`kit/runtime/data/travel.js`): it alone may read them, and only the columns the profile's
  `routing.coordinates` declares. It returns whole-minute drive times and an estimated distance
  (straight line × 1.3, in tenths of a km) between two places only, never a latitude or longitude,
  and every other forbidden column still applies to it. Only a route's total distance is shown, in whole km; the distance of one leg
  is never shown or logged. (The distance words are Story 15.15's, approved by Ely Potter on
  2026-10-31, DEP-032.) No coordinate
  value, street address or postal code appears as text anywhere: Slack, logs, reasons, errors or AI
  input. NOT the map image: that is the update below, signed separately.
- map image (Story 15.5, reworded for the street map by Story 15.11; approved by Ely Potter on
  2026-10-31, DEP-025): the Routing entry in Slack shows a map of a crew's day as a picture, and
  nowhere else. This update adds one more read
  beside `travelMatrix`, for the picture only: the kit's map read
  (`mapPoints`, `kit/runtime/data/map.js`) turns the declared coordinate columns into pixel
  positions inside the bot; like `travelMatrix`, it never returns a latitude or longitude, and the
  positions are never logged, stored or sent. Only the picture leaves. What it reveals, in plain
  words:
  - **The street map (Story 15.11, the wording Ely Potter signed on 2026-10-31, DEP-025).** The picture now has a
    street map under it. Anyone who sees it can read each marker's area directly, to about 150 m (a
    block), with no need to line it up. Next to the window's list (client name, city, stop number),
    a screenshot shows roughly where a named client lives. To draw the streets, the bot asks the
    street-map provider (OpenStreetMap, through its delivery network) for the map squares of the
    area shown. The provider learns which area of 5 km or more is being viewed, and when, from the
    bot's server address. It never learns which stops or customers. The bot keeps those squares in
    memory only. The provider's name and credit show under the picture. If the street map can't be
    fetched, the plain map shows.
  - **Where the street map comes from.** The profile's `routing.basemap` names the one provider
    (OpenStreetMap's free tiles, for dev and the demo; a production fork names its own, DEP-031).
    Each request carries only the map square's numbers and the bot's app name and contact, never a
    stop, a customer or a coordinate. `APLABS_BASEMAP_OFF` stops every request; then, or with no
    network, the plain map shows (no streets, no tiles, scale or numbers), which anyone who knows
    where two of the places are can still line up with a real map.
  - **How approximate.** Every place is first rounded to a grid cell about 220 m north-south and
    about 140 to 190 m east-west (at 30° to 50° latitude), so a marker is within about 150 m of the
    real place and never closer; places in one cell share a marker.
  - **Never zoomed in.** Every map covers at least 5 km each way, so it cannot show one street.
  - **Where it shows.** Only inside the Routing window, only to the routing audience (dispatchers
    see every crew, a crew lead only their own: the profile's `routing.audience`). It is never
    posted to a channel or a DM and never sent to the AI. No address, postal code or coordinate
    appears as text, in the window's list, its alt text or the logs.
  - **How long it lives.** Each picture is a private Slack file shared nowhere. It is deleted when
    the window closes, or by a sweep at the latest 20 minutes after upload.
  - **The named risk.** If the bot crashes between uploading a picture and recording it, that one
    unshared file can be left behind where the kit cannot find it to delete it.
  - **What a viewer can do with it (Story 15.1's live check, 2026-10-26).** In Slack, a person who
    sees the map can click it and open it in a browser, copy its private link, or share it
    (AirDrop, Messages, Mail, Notes, Copy). The link opens only for a workspace member with access
    to the file, but Copy can put the picture itself on the clipboard, and anyone can take a
    screenshot. Once copied or screenshotted, the picture is outside the 20-minute deletion.
  - NOT a change to the forbidden columns: they stay forbidden to every query, and no coordinate
    goes to the street-map provider. The Routing module (Route map) runs in production from
    Story 15.6 (after this sign-off).
- the Office and Plan a route (Story 15.15, approved by Ely Potter on 2026-10-31, DEP-032): The
  Office, where every crew starts and ends in Plan a route, is a point in the data's `depots` table.
  Its coordinate columns are forbidden like the others. The map shows it with its own marker. It is
  called 'Office' in the list, never by address.
  - **Where the picture shows.** Plan a route's window shows the same kind of picture as Routing's,
    to the same audience, deleted the same way. Its header shows the route's total distance in whole
    km ("about 64 km"); a leg's distance never shows.
  - **Held for the window's life.** So a reorder reads nothing new, the stops' pixel positions are
    kept in the bot's memory while the window is open (15 minutes, longer while in use), and dropped
    when it closes or expires. They are never logged, stored or sent.
  - NOT a change to who sees it: the same audience as Routing. Plan a route runs in production from
    Story 15.6 (after DEP-025 and DEP-032).
- owner: Ely Potter
- evidence: profile `sql.forbidden_columns` and `routing` (`map_grid_e6` 2000, `map_min_span_km`
  5, `audience`, `basemap`, `depot`); `kit/runtime/sql`; `kit/runtime/data/map.js`; `kit/runtime/basemap`;
  `fixture-tables.md` "Rules"; architecture-routing AD-R9, AD-R10, AD-R12, AD-R13, AD-R15,
  AD-R17, AD-R18 and AD-R23 to AD-R27; Story 15.1's live check in `epics-routing.md`. The mock CRM's field list and the email connector's contact shape leave
  these columns out too.
- status: approved
- approval: approved by Ely Potter on 2026-10-31 (plan brightside-v1, Story 18.1); earlier drafts:
  the rest approved on 2026-10-25 (Ely as Dana Reyes); the coordinate columns added on 2026-10-26
  (DEP-028); the map image update added on 2026-10-26 and reworded for the street map the same day
  (Story 15.11, DEP-025); the distance words and the Office added on 2026-10-27 (Story 15.15,
  DEP-032).

### GRD-003: MotherDuck reader lockdown
- type: access_rule
- rule: when the profile says `data.source: motherduck`, the bot reads with its own read-only key
  (never the publish key) through the locked sequence: extension pre-installed, attach mode single,
  the database attached read-only, external access off, configuration locked. Only that database,
  `md_information_schema` and the in-process `memory` are visible. If MotherDuck is down the person
  sees "data unavailable"; there is no fallback to the local file.
- exception (accepted by Ely, 2026-10-24): the reader account's own `my_db` can still be attached
  by name; MotherDuck can't block it. The barrier is GRD-001: the guardrail refuses `ATTACH`. The
  reader's `my_db` must stay empty. Exception confirmed for the client canon on 2026-10-25 (Ely as
  Dana Reyes), and by Ely Potter on 2026-10-31.
- owner: Ely Potter
- evidence: `docs/runtime/motherduck-publish.md` ("The bot reading MotherDuck", "Known
  exception"); `npm run fixture:probe` (Ely only) shows each lock as PASS and `my_db` as ACCEPTED.
  Brightside's profile in this repo stays `local`.
- status: approved

### GRD-004: Writes only through approval
- type: exception_workflow
- rule: no module writes to an outside system. A module that pushes declares a `write` block in its
  manifest, and the approval-write archetype previews the write, waits for a person's approval and
  then sends it once with an idempotency key. Writes are dry runs unless that archetype says
  otherwise. Either kill switch stops every write at once.
- actions: create a list and add contacts in the email tool; human gate: approval in Slack
  (Epic 10, not built yet).
- failure_modes: a module calling a connector's write directly (caught by `engine:write-path`); a
  retry sending twice (stopped by the idempotency key); a partial push (reported honestly, Story
  10.3).
- owner: Ely Potter
- evidence: `kit/templates/connector.md` (the contract); Epic 10 stories in
  `docs/planning/planning-artifacts/epics.md`. Who may approve a push is an **empty field, owner
  Ely Potter**.
- status: approved

### GRD-005: The AI service
- type: access_rule
- rule: Claude only fills in the blanks of a form a module already declares. It never writes SQL
  and never sees data rows. It sees the client's name, `org.md` and `data.md` (headers, truth
  blocks and comments removed; never `guardrails.md` or `connectors.md`) and at most 500
  characters of what the person typed. Modules can't call it (not on `kit/runtime/sdk`). It runs
  only for a person allowed to use the module, behind an off switch (`APLABS_LLM_OFF`), a
  per-person limit and an hourly spend breaker that fails closed. Requests and replies are never
  logged, but they do reach Anthropic. With the AI off, the form still works.
- exceptions: GRD-009 (Ask's read-only queries): the AI writes or fills in a query; it still never
  sees a data row. Admin notes, including uploaded PDFs, images and CSVs, are sent to the AI as
  context on their hub.
- owner: Ely Potter
- evidence: `kit/runtime/llm/index.js` and `context.js` (Story 9.1); `docs/runtime/ai-setup.md`;
  the Epic 9 plan. A grep test keeps the AI off the SDK. The exceptions: plan brightside-v1 D10
  (architect P3-16), added by Story 19.7.
- status: approved

### GRD-006: Pay rates and Labour cost
- type: access_rule
- rule: `staff.hourly_rate_cents` and `pay_rates.hourly_rate_cents` stay open (not forbidden) for
  the Brightside demo, because the data is synthetic. The "Labour cost" entry (resource
  `LABOUR_COST`, Story 9.7) is granted only to the owner or admin role, never open access, and shows
  totals only: never one person's pay rate or name. A real client decides on day one whether pay
  rates are forbidden (fork guide, Story 11.4).
- owner: Ely Potter
- evidence: Ely's decision on the Epic 9 plan (`approve plan epic-9`, 2026-10-25,
  `docs/planning/planning-artifacts/plan-epic-9.md`, decision 1). `LABOUR_COST` is not in the
  profile yet; Story 9.7 adds it.
- status: approved

### GRD-007: Synthetic data, human publish
- type: data_quality_guard
- rule: every Brightside record is generated: emails end in `.invalid`, phones are 555-0100 to
  555-0199. The fixture checks (`fixture-validate` in the profile's `verify.checks`) must pass
  before a publish, and only Ely publishes; agents never run `fixture:publish` or touch its token.
- coordinates (Story 15.7, approved by Ely Potter on 2026-10-31, with DEP-025): every property and crew
  base is a random synthetic point in the Columbus, Ohio area. On a street map a marker sits near
  real streets and homes, never on the area's big water (reservoirs, the Scioto and the Olentangy,
  from rough hand-drawn outlines, not map data; generator v6), and none is or comes from a real
  address.
- the Office (Story 15.15, approved by Ely Potter on 2026-10-31, DEP-032): One point is not
  random: the Office, a point Ely chose in Westerville, rounded to 0.002° (about 150 m). It is the
  one row of the `depots` table (generator v7); no street address for it is written anywhere.
- failure_modes: a real-looking email or phone (caught by `synthetic-email.sql` and
  `synthetic-phone.sql`); a stale or hand-edited build (publish refuses it); a coordinate outside
  the Columbus box (caught by `synthetic-coordinates.sql`) or on water (caught by
  `synthetic-off-water.sql`), the Office's included.
- owner: Ely Potter
- evidence: `fixture-tables.md` "Rules" and "Validation"; `docs/runtime/motherduck-publish.md`;
  `examples/brightside/fixture/lib/routing.js` (`CENTRE`, `BOX`; generator v6; `OFFICE`, generator
  v7) and `lib/water.js`.
- status: approved
- approval: approved by Ely Potter on 2026-10-31 (plan brightside-v1, Story 18.1); earlier drafts:
  approved on 2026-10-25 (Ely as Dana Reyes); the coordinates line added on 2026-10-26 and its
  off-water words on 2026-10-27 (DEP-025); the Office exception added on 2026-10-27 (DEP-032).

### GRD-008: A crew out for the day
- type: classification
- rule: for route optimization, a crew is out for the day (`available: false`), and its stops need a
  new crew, when its lead is absent, or nobody on the crew is present. A crew with its lead and at
  least one person present works the day with fewer people, and its visits take longer. NOT a rule
  about who may see a route, and NOT a change to any booked visit: routing only suggests.
- edge_cases: A stand-in lead counts as the lead for that day. A member present for part of the
  day counts as present. Brightside's data has neither (no stand-in field; `staff_absences` holds
  whole days only), so the adapter needs no change; a fork whose data records either must map it
  this way.
- owner: Ely Potter
- evidence: data-design §4 and architecture-routing AD-R1 (the adapter, Story 14.3); absences come
  from `staff_absences` (Story 14.2).
- status: approved
- approval: approved by Ely Potter on 2026-10-31 (plan brightside-v1, Story 18.1), with its edge
  cases settled; earlier draft: recorded on 2026-10-26 by Story 13.3 (DEP-028).

### GRD-009: Ask's read-only queries
- type: access_rule
- rule: on a hub that sees data and rules, Ask may answer a data question from signed query
  rules: by running a rule's reviewed SQL with parameters the AI fills, or by an AI-written
  read-only query composed only from signed rules. Only people granted `ASK_DATA` by name get
  this, and **they must be cleared for every metric the allowed tables expose, including
  client-level money (invoices, payments, balances): `client_id` is pseudonymous, not
  anonymous.** The query may read only the tables and columns the profile's `ask` block lists;
  names, emails, phones, addresses, coordinates, staff and pay are never readable. The SQL guard
  (GRD-001, GRD-002) and DuckDB's own parse both check it before it runs; it runs for at most 10
  seconds, one at a time, and returns at most 50 rows. The AI never sees the result. A figure a
  signed truth covers comes from the rule's reviewed SQL. Not run at all unless every signed truth
  passed its last check within 7 days. NOT a change to any tool: tools keep their reviewed queries.
- owner: Ely Potter
- evidence: plan brightside-v1 D10, D11; `kit/runtime/sql` (`allowedTables`), `kit/runtime/data`
  (Ask's connection), `kit/runtime/archetypes/ask`; Stories 19.6 to 19.8.
- status: approved
- approval: approved by Ely Potter on 2026-10-31 (`approve plan brightside-v1`), added by Story 19.7.
