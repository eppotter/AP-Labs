# Brightside v1 and the three-stage demo: plan for Ely

Status: **draft, awaiting `approve plan brightside-v1`.** Tier **T3** (computed per story below with `APLABS_PROFILE=$PWD/profiles/brightside/profile.yml node kit/lib/tier <paths>`, 2026-10-31). Three epics: **18** (v0 demo pack, CSV, Ely replaces Dana, rules signed off), **19** (the `/brightside-v1` hub: shared notes, the database, route skills, Ask that runs queries) and **20** (appointment emails on the live hub). Run mode after the gate: you let it run.

**Not yet run:** the architect design review and `bmad-review` (adversarial and edge-case lenses). This plan is T3, so the Orchestrator runs both before the gate and folds their findings in, as it did for plans brightside-v0 and hub-status-menu. SQLsmith reviews D10 (Ask's queries) in the same pass.

**Gate items for you** (each has a recommended default; `approve plan brightside-v1` accepts all of them; run mode, so this is every question up front):
1. **Ask on v1 writes its own read-only SQL (Option B).** This reverses AD-10 ("no person and no LLM writes SQL") and changes GRD-005 ("the AI never writes SQL"), for one tool on one kind of hub only. The AI never sees a data row (D10). Approving the plan signs the new rule card **GRD-009** with the wording in D10. Recommended: approve.
2. **Build requests from a hub that sees data or context.** Today only a blank hub may post (AD-14 amendment, plan brightside-v0 D11). The summary call already runs with no business context (`withContext: false`), so v1 may post too (D11). Recommended: approve.
3. **v0 and v1 share one set of notes** (D6). Recommended: approve.
4. **Appointment emails on the live hub.** A new write: reminders and change notices to the mock email tool, through the approval step. Approving the plan signs **GRD-010** with the wording in D14. Recommended: approve.
5. **Who may ask data questions on v1:** a new key `ASK_DATA`, granted by name only. Recommended: you only.
6. **Who sees routes on v1:** the existing routing audience, unchanged: you as the one dispatcher, no crew leads (D9). This closes DEP-024 with that as the demo's real audience. Steven gets no route tools unless you say "grant Steven routes". Recommended: you only, DEP-024 closed.
7. **Story 15.6 (production for the route modules)** is unblocked once you sign GRD-002 and GRD-007 in 18.1. Recommended: the Orchestrator runs it as its own PR right after 18.1, and it turns on prod for every route module on both hubs.
8. **The five routing truths** in `data.md` stay `pending` (your decision covered the rule cards, not the truths). Say "sign the routing truths too" and 18.1 signs them, so the strip reads 12 truths, not 7. Recommended: keep them pending.

**In short:**
1. Three slash commands, one bot. `/brightside-v0` is the blank bot you teach (now with CSV files and a demo pack). `/brightside-v1` knows the company (context, data, rules), keeps what you taught v0, runs four named route skills, and answers data questions by running a checked, read-only query. `/brightside` is the full hub, and it gains appointment emails as the finale.
2. Ely Potter replaces the fictional Dana Reyes everywhere she is a person, and signs off every rule card. The strip on v1 then reads "Knows: 1 source · 7 truths · 8 rules" (9 and 10 once GRD-009 and GRD-010 land).
3. Fifteen stories. Twelve are T3 or T2. One step from you before the v1 live check: the `/brightside-v1` slash command.

## The three stages (Ely's decisions, 2026-10-31)

| Stage | Command | What it is | Demo point |
|---|---|---|---|
| v0 | `/brightside-v0` (built) | A blank bot. You import context (typed, PDFs, photos, and now CSVs) and it answers questions from it | "It knows nothing, until you teach it" |
| v1 | `/brightside-v1` (new) | Company context, the database and the rules, plus the route skills and an Ask that runs safe queries | "Now it works on your real data, inside your rules" |
| live | `/brightside` (exists) | The full hub, plus appointment emails | "And it acts, with your approval" |

## Decisions Ely made (2026-10-31, not reopened)

- [x] Run mode.
- [x] **Dana does not exist.** Ely Potter replaces Dana Reyes as the owner and sign-off of the four context files, as the profile's admin user (same Slack identity, same admin role, new name), and in docs, open ledger DEP rows and rule-card owners. Sign-offs are recorded as Ely Potter on 2026-10-31. Past records that say "Ely as Dana Reyes" stay as history, with a note.
- [x] **Ely signs off the rules.** Every draft rule card becomes approved: GRD-002 (coordinates, the map image, the Office), GRD-007 (synthetic coordinates, off water, the Office) and GRD-008 (crew out for the day). GRD-008's open edge cases: a stand-in lead counts as the lead for that day; a member present for part of the day counts as present.
- [x] v0's demo flow: walk the template hub, show it can't answer, import a few PDFs and CSVs, then ask 3 to 5 specific questions it now answers.
- [x] **v1 keeps what v0 was taught**, reads the actual database (the fixture, local DuckDB or MotherDuck, as `/brightside` does), has the route function as named skills, and **Ask answers deeper data questions by running queries (Option B).** This reverses the earlier Option A.
- [x] **The live hub's "wow":** draft emails to customers about their appointment: a reminder, and a change notice when the appointment moved.
- [x] The `/brightside-v1` slash command is added by Ely.

## What the code has today

Read on `main` at `71027d7`.

| What | Where | What it means for this plan |
|---|---|---|
| Hub files and `sees` | `examples/brightside/app/hubs/*.json`, `kit/runtime/schema/hub.schema.json` (T3 floor), `kit/runtime/sees.js`, `kit/runtime/slack/hub-view.js` (T3 floor) | A hub that sees `data` gets the runner; `context` puts `org.md` and `data.md` in the AI's prompt; `rules` reads the truths, the rule files and forbidden columns. v1 is `["context", "data", "rules"]`, like `/brightside`. No change needed for that |
| One hub per module | `kit/runtime/registry/index.js` `loadModules`: `id` must equal the folder name, `hub` is one id | A tool on two hubs is two folders with their own ids. The fork guide (step 8) already says so: "to put Ask on a second hub, copy the folder again under a new name and set its `id` and `hub`" |
| Route modules | `modules/route-planner` (Plan a route, `screen: "route-editor"`) and `modules/routing` (Route map, four views), both `routing-map`, resource `ROUTING_ALL_CREWS`, `environments: ["dev"]`, adapters re-export `app/routing/adapter.js` | A copy on v1 is a manifest plus a one-line adapter. Routing maps, adapters and sessions are already per hub (`hubs.js` `routingMaps`, adapters keyed by module id). The registry forces `resource` to be `routing.audience.all_crews` |
| Routing engine | `kit/runtime/routing`: `optimizeDay`, `placeOrphans` (crew out), `fillGap` (top 5 for a cancelled slot), `evaluateOrder` | Optimize, crew out and gap fill exist. "Add a stop" does not. Crew out and gap fill only show what the data holds (absences and cancelled visits), never a "what if" |
| Route map views | `archetypes/routing-map/views.js`: `compare` (Booked vs optimized), `change` (Route change: a crew out), `zone`, `gap` (Gap fill) | Each skill below starts from one of these |
| Knowledge store | `kit/runtime/knowledge/store.js` (T3 floor): `<var>/context/<client>/<hub>/<entry>.json`, typed 3,000, file 6,000, hub 15,000 characters and 20 entries | Per hub today. v1 must see v0's notes (D6) |
| Uploads | `kit/runtime/slack/files.js` (T3 floor) `READABLE`: pdf, png, jpg, jpeg, gif, webp, txt, md; office files refused (DEP-036, docx) | No CSV. Text files are UTF-8, stored as they are within the 6,000 cap |
| Readiness and status | `knowledge/readiness.js` (truths, two rule files signed, `approvedRules` counts `- status: approved` cards only while `guardrails.md` is signed), `knowledge/summary.js`, `registry/status.js` | Signing `guardrails.md` and approving its cards changes the strip on every hub that sees rules. No code change |
| Ask | `archetypes/ask/index.js`: `route_question` sorts into module, data, context, other; data tools are `QUERY_ARCHETYPES` only (scoped-pull, approval-write); with data and rules both ready and no tool: "There's no tool for that yet." | A route question classed as `data` naming a routing-map tool gets "no tool yet" today. Ask never runs SQL |
| Build requests | `slack/channel.js` (T3 floor) `mayPostBuildRequest`: refused from any hub whose `sees` has `context` or `data`; the summary call is `withContext: false` | Request a tool would be "not on this hub" on v1 |
| SQL guard and runner | `kit/runtime/sql` `checkSql` (tokenizer; forbidden columns matched by bare column name; wildcards refused while any is set), `kit/runtime/data` (read-only, 30 s per query) | The base for D10. No table allow-list today |
| Email tool | `examples/brightside/app/connectors/email` (mock, outbox file), writes `createList`, `addContacts`, `pushList`; a contact is exactly `{ external_ref, email, first_name }` | Lists only, no message body. D14 adds one write |
| Approval writes | `kit/runtime/archetypes/approval-write/**` (T3 floor): preview, approve, send once, kill switches, retry; rows only from a scoped-pull run record; `engine:write-path` keeps connector writes there (DEP-012, closed) | D14's emails go through it. Issue #92 (Story 8.3 follow-ups) is closed |
| Slack manifest | `npm run slack:manifest` writes `examples/brightside/app/slack-manifest.json` from the hub files; `kit/runtime/slack/scopes.js` | A new hub file adds the command. No new scope |

## Design decisions

### D1. Ely replaces Dana: what changes, what stays as history

**Changes (living files):**
- `profiles/brightside/profile.yml`: the user `dana` becomes `id: ely`, `name: Ely Potter`, `role: admin`, the same `identities.slack` (`U0CB6HDBBQX`) and the same grants. The fictional `github: dana-r` handle is dropped (no code reads `identities.github`). Every comment that names Dana says Ely. The routing audience comment drops "dev placeholder" (gate item 6).
- The four context files (`org.md`, `data.md`, `guardrails.md`, `connectors.md`): frontmatter `owner: Ely Potter`, `signed_off: 2026-10-31`, `signed_off_by: "Ely Potter (2026-10-31)"`, `updated: 2026-10-31`. Every rule-card and truth `owner` becomes Ely Potter (the routing truths stay `signed_off: pending`, gate item 8). Each file's header gains one line: "Until 2026-10-31 these files named a fictional owner, Dana Reyes, played by Ely; lines that say 'Ely as Dana Reyes' are kept as history."
- Open DEP rows in `docs/ledger.md` (D2).
- Code comments and tests: `examples/brightside/app/routing/adapter.js`, `crews.sql`, `app/routing/__tests__/adapter.test.js`, `examples/brightside/test/*.test.js` (profile, guardrails-routing, demo-flow, v0-*), `examples/brightside/test/fixtures/demo-profile.yml` (the fixture user becomes `ely`, fake Slack id `U0FIXTUREELY`), `examples/brightside/fixture/__tests__/validate.test.js`, `test/unit/truths.test.js`, `test/unit/runtime-llm.test.js`, `test/unit/connector-contract.test.js` (a sample admin name).
- Living docs: `docs/runtime/demo-script.md`, `docs/runtime/routing-map.md`, `docs/runtime/map-check.md`, `docs/HANDOFF.md`, `docs/planning/team/steven-onboarding.md`, `docs/PLAN-v1.md`'s profile example.
- `kit/templates/context/data.md`: its commented example names no person ("owner: <the owner's name>"), because a fork copies it.

**Stays as history** (one note each where it is read, no rewrite): closed plans and their stories (`plan-epic-9.md`, `plan-epic-10.md`, `plan-brightside-v0.md`, `plan-hub-status-menu.md`), `epics-routing.md`, `architecture-routing.md`, `docs/planning/specs/spec-routing/**`, build files in `docs/ledger/builds/`, closed DEP rows, retros, and `docs/reference/**` (never edited). `architecture-routing.md` and `epics-routing.md` get one dated note at the top: "Dana Reyes was a fictional owner played by Ely; from 2026-10-31 Ely Potter owns and has signed GRD-002, GRD-007 and GRD-008 (plan brightside-v1)."

**Check:** after 18.1, `grep -rn "Dana" --exclude-dir=node_modules .` lists only the history files above and the notes. 18.1's PR lists them.

### D2. The rules are signed off, and what that closes

`guardrails.md`: every card's `- status:` line is exactly `approved` (the parser in `readiness.js` counts nothing else), with the history kept in an `- approval:` line under it ("approved by Ely Potter on 2026-10-31; earlier drafts: …"). The "pending", "draft" and "for Dana's sign-off" words inside GRD-002 and GRD-007 become past tense ("signed 2026-10-31"). The header paragraph is rewritten to say all eight cards are approved.

**GRD-008, settled:**
- rule unchanged; `edge_cases` becomes: "A stand-in lead counts as the lead for that day. A member present for part of the day counts as present. Brightside's data has neither (no stand-in field; `staff_absences` holds whole days only), so the adapter needs no change; a fork whose data records either must map it this way."
- `crews.sql` and `adapter.js` comments: "GRD-008, approved 2026-10-31". No logic change. A test pins that a crew whose only lead is absent is out, and that a member with no absence row is present (exists; renamed).

**Eight rule cards** (GRD-001 to GRD-008), so the strip counts 8 rules once the file is signed.

**DEP rows** (in `docs/ledger.md`, flipped in 18.1's PR, each with what closed it):

| Row | Today | After 18.1 |
|---|---|---|
| DEP-025 | Dana signs GRD-002's map-image rule (street-map wording) | **closed:** "Signed by Ely Potter on 2026-10-31 (plan brightside-v1, Story 18.1): GRD-002's map image and street-map wording approved as written by Story 15.11. Unblocks Story 15.6." |
| DEP-028 | Dana re-signs GRD-002 with the four coordinate columns, and confirms the crew-out rule | **closed:** "Signed by Ely Potter on 2026-10-31 (Story 18.1): GRD-002's coordinate columns approved; GRD-008 approved, with a stand-in lead counting as the lead and a member present for part of the day counting as present." |
| DEP-032 | Dana signs the Office and distance additions to GRD-002 and the GRD-007 Office exception | **closed:** "Signed by Ely Potter on 2026-10-31 (Story 18.1): the Office marker, the route's total km and GRD-007's Office exception (and its Columbus and off-water lines) approved. With DEP-025, unblocks Story 15.6." |
| DEP-029 | Ely approves the tile fetch for the template; Dana for Brightside through DEP-025 | **closed:** "Template half approved at the routing-streetmap gate (Stories 15.7 to 15.11 built after it); Brightside half signed with DEP-025 on 2026-10-31." |
| DEP-024 | Dana's routing audience | **closed** (gate item 6): "Ely Potter confirmed on 2026-10-31: the demo's audience is Ely, the one dispatcher; no crew leads. The crew-lead view stays tested on fixtures only." Owner text becomes Ely. |
| DEP-034 | Ely, then Dana Reyes | stays **open**, owner **Ely** |

Each changed open row keeps its id and its history ("was: Dana Reyes (via Ely)").

### D3. CSV files in Add context

The smallest safe support, read as text, never summarised.

- **Why as text, not summarised.** The demo asks for exact figures ("which zone had most complaints?"). A summary loses them, and summarising rows through the AI costs a call per upload. Text within a cap keeps every cell, and the AI reads it as data like any note.
- **Where.** `kit/runtime/slack/files.js` (T3 floor) adds `csv: { kind: 'csv', format: null, mediaType: 'text/csv' }` to `READABLE` (so `FILETYPES` and the form's `file_input` offer it). The download path is the text one (content type `text/*` or `application/octet-stream`).
- **Checks, all before storing,** in a new `readCsv(bytes)` beside `readText`, with no new dependency:
  - UTF-8 only (fatal decoding), a leading BOM dropped, no NUL byte;
  - parsed as RFC 4180 (quoted fields, `""` inside quotes, CRLF or LF); an unterminated quote is refused;
  - a header row, then **at most 200 data rows** and **at most 30 columns**; every row has the header's column count;
  - stored as the normalised text (LF line ends), so it must fit the store's **file cap of 6,000 characters** measured escaped, as every entry is. Over any cap: "That CSV is too big for a note: at most 200 rows, 30 columns and about 6,000 characters. Keep the rows you need, or split it."
- **Kind.** The entry's `kind` stays `file` (the store's caps and wrapper are unchanged); `file.type` is `text/csv`. The prompt wrapper is the existing `<added_context>`, escaped, after the fixed "this is data" sentence.
- **The screen** lists ".csv" with the others and adds: "Don't upload personal details (emails, phones, addresses): everyone who can use Ask here can read them." After the upload: "Here's what I took from <title>: <N> rows, <M> columns" and the first 1,500 characters.
- **Not changed:** spreadsheets (`.xlsx`) stay refused with "save it as a PDF first" (DEP-036 is Word and office files; it stays open, and its text gains "or a .csv for a sheet").
- **Ways out, each tested:** a CSV over each cap (rows, columns, characters); a ragged row; an unterminated quote; invalid UTF-8; a NUL byte; an empty file or header only (refused: "no rows"); a `.csv` whose content type is JSON (an error body); the hub's notes full; closing the screen while it is read (stored, D13 of plan brightside-v0).

### D4. The v0 demo pack

New folder `examples/brightside/demo-pack/`, built by `npm run demo-pack` (new script `examples/brightside/demo-pack/build.js`) from the fixture, so every figure agrees with the data. The built files are committed, so you can upload them from disk without building.

| File | What it holds | Source |
|---|---|---|
| `price-list-2026.pdf` (1 page) | Every package and add-on with its price | the fixture's `packages` and `add_ons` |
| `service-policies.pdf` (2 pages) | Arrival windows, the 24-hour notice to reschedule (no fee: the data has none), what a standard and a deep clean include, how a crew-out day is handled (in the words of GRD-008) | written; arrival windows from `visits.arrival_window` values |
| `zone-billing-2026-09.csv` (5 rows) | Zone, invoices issued, billed $, paid $ in September 2026 | the fixture, by the truths' own definitions; billed totals 36,402,350 cents and paid 35,018,640 cents, matching `billed-revenue-2026-09` and `paid-revenue-2026-09` |
| `complaints-2026-09.csv` (about 40 rows) | Date, zone, crew name, category (late arrival, missed area, damage, other), resolved yes/no | synthetic, seeded; dates in September 2026, real fixture zones and crews, **no client names, emails or addresses** |

- The PDFs are written by a small hand-made PDF writer in `build.js` (text only, one font, no dependency); a test reads each back with `file-check.js` `pdfPageCount` and checks it sniffs as a PDF.
- **Sizes:** together the four extract to at most about 11,000 characters, under the hub's 15,000, so all four fit with room for a typed note. A test pins it (the CSVs measured exactly; the PDFs' text measured before writing).
- **Determinism:** the same fixture version builds the same bytes (a test builds twice and compares).

**The v0 question script** (in `docs/runtime/demo-script.md`, with expected answers computed by `build.js` and printed when it runs, so the doc and the files can't drift; the test checks each expected answer appears in the files):
1. "How much is a deep clean, and what does the eco add-on cost?" (price list)
2. "How much notice does a customer need to give to reschedule?" (policies: 24 hours, no fee)
3. "Which zone billed the most in September, and how much of it was paid?" (zone billing CSV)
4. "Which crew had the most late-arrival complaints in September?" (complaints CSV)
5. "How many complaints in September are still unresolved?" (complaints CSV)

Before the import, question 3 is the "it can't answer" moment: Ask says it has no data and no rules.

### D5. The v1 hub and its menu

New `examples/brightside/app/hubs/brightside-v1.json`:

```json
{ "id": "brightside-v1", "command": "/brightside-v1", "name": "Brightside v1",
  "description": "Open the Brightside v1 menu", "sees": ["context", "data", "rules"],
  "notes": "brightside-v0",
  "welcome": "Brightside on your real data: it knows the company, follows its rules, and plans routes." }
```

Modules are folder copies with their own ids (the registry's one-hub rule and the fork guide's advice; a manifest naming two hubs is not needed):

| Folder | Label | Archetype | Resource | Group |
|---|---|---|---|---|
| `v1-route-optimize` | Optimize a route | routing-map, `screen: "route-editor"` | `ROUTING_ALL_CREWS` | Routing |
| `v1-route-cancellation` | Customer cancellation | routing-map, `screen: "cancellation"` (D8) | `ROUTING_ALL_CREWS` | Routing |
| `v1-route-crew-out` | Crew out | routing-map, `screen: "crew-out"` (D8) | `ROUTING_ALL_CREWS` | Routing |
| `v1-route-add-stop` | Add a stop | routing-map, `screen: "add-stop"` (D8) | `ROUTING_ALL_CREWS` | Routing |
| `v1-route-map` | Route map | routing-map (four views) | `ROUTING_ALL_CREWS` | Routing |
| `v1-ask` | Ask | ask | `ASK` | — |
| `v1-build-request` | Request a tool | build-request | `BUILD_REQUEST` | — |
| `v1-add-context` | Add context | add-context | `ADD_CONTEXT` | Setup (engine) |
| `v1-data-sources` | Data sources | data-sources | `DATA_SOURCES` | Setup (engine) |

- The route modules' `environments` match the originals (`["dev"]`) until Story 15.6 (gate item 7) adds prod to every route module on both hubs. Their adapters re-export `../../routing/adapter`, as the originals do. The skills use `verb: "Run"`; Route map keeps View.
- `/brightside` and `/brightside-v0` are untouched by Epic 19 (their files, modules and tests).

### D6. v0's notes come across: one shared set of notes

**Chosen: v1 uses v0's notes store** (a hub field `notes: "<hub id>"`), over a one-time copy (stale the moment you teach v0 again, mid-demo) and over v1 reading v0's notes on top of its own (two caps that could together exceed the prompt limit).

- **How.** `hub.schema.json` gains an optional `notes`: the id of another hub whose added-context store this hub uses. `hub-view.js` builds the view's `knowledge` from `knowledge.forHub(hub.notes || hub.id)`, and `llm.forHub({ id, sees, notes })` reads the same store for the prompt. Add context on either hub adds to, lists and removes from the one set. The store, its folder layout, caps and queue are unchanged: the shared set is still one hub folder (`brightside-v0/`), at most 20 entries and 15,000 characters.
- **The prompt still fits.** v1's prompt is the profile's context (about 18,000 characters today) plus the shared notes (at most 15,000) under the 40,000 limit, as for any hub.
- **Why it stays safe.** `sees` still decides what each hub gets from the profile: v0 still never sees `org.md`, `data.md`, data or rules. Notes are admin-written text that both hubs already treated as "readable by everyone who can use Ask here". Sharing changes who can read them, so boot refuses a `notes` link unless:
  - the target hub exists and has no `notes` link of its own (no chains or loops);
  - every `ask` and `add-context` module on the two hubs uses the same resource keys (`ASK`, `ADD_CONTEXT`), so the same people read and write the shared notes on both hubs;
  - each failure names the hub file and the field.
- **What v0 gains from v1.** A note added on v1 shows on v0. That is by design (one set); the Add context screen on both hubs says "Shared with Brightside v0 / v1" and Data sources lists the notes under "Added context (shared with <hub>)". The SQL writer (D10) never reads notes, so an upload can't steer a query.
- **Resetting for the next demo:** remove the notes on either hub (Remove, as today).

### D7. The database

v1 sees `data`, so it gets the same runner as `/brightside` (`kit/runtime/data`, whatever the profile's `data` block says: the local DuckDB fixture today, MotherDuck when set). Nothing new. Data sources on v1 shows the source, the truths and the signed rules; one small addition (19.3): a line "Rule cards approved: 8" from `detail.rules.approvedRules` (a count only, as the readiness contract allows), so "the signed-off rules" are visible there too.

### D8. The route function as named skills

| Skill (menu row) | What exists | What is new |
|---|---|---|
| **Optimize a route** | Plan a route's editor: pick a crew and a day, the day from the Office, Optimize, Reset, move stops by hand, rule breaks flagged, drive and km at the top (`editor.js`) | Nothing. A copy on v1 with the skill's label |
| **Customer cancellation** | `fillGap` and the Gap fill view: top 5 visits that could move up into a slot a cancellation left, but only for visits the data already shows cancelled | A **what-if**: pick a crew and a day, then the visit that cancels (a select of that day's stops: time and client name, no address). The adapter builds the gap input with that stop treated as cancelled (a new `gapFor({ day, crewId, stopId, scope })`, reusing the gap candidate code); the view shows the gap and the top 5 with their reasons, and **Fill with #n** shows the new day in the editor. The data's own cancellations still show as today |
| **Crew out** | `placeOrphans` and the Route change view: moves, cross-zone recommendations and stops to rebook, for crews the data shows out | A **what-if**: pick a day and a crew, **Mark out for the day**; the adapter returns the input with that crew `available: false`, and the same view shows the plan. A crew the data already shows out says so ("out in the data: lead absent") and shows it directly |
| **Add a stop** | `evaluateOrder` and the editor's order | New: in the editor's step 2, **Add a stop**: pick a client (an `external_select` searching client names, at most 20 results, only properties of the crew's zone, never an address), a visit length (30 to 240 minutes, step 15) and a window (any, morning, afternoon). A new pure engine entry, `insertStop(input, stop, { travel, rules, returnToBase })` in `kit/runtime/routing/insert.js`, returns the cheapest position on this crew under the AD-R5 cost tuple, and the two cheapest other crews of the zone with their added drive minutes. The stop joins the order marked ➕, and can be moved or optimized like any stop. Nothing is saved |
| **Route map** | The four views | Nothing |

- **One archetype, new screens.** `module.schema.json`'s `screen` enum gains `cancellation`, `crew-out` and `add-stop` (`add-stop` is the editor with Add a stop open on step 2). Each opens with the same scope (AD-R17, `audience.js` unchanged), the same session, map files and 20-minute deletion as today. The `external_select` needs a `block_suggestion` (options) listener in `hubs.js`, which re-checks access and scope before any read; no new Slack scope.
- **Suggestions only, nothing saved** stays the rule. Every screen says so.
- **Adapter reads** stay inside `travelMatrix` and `mapPoints` for coordinates (GRD-002). The client search reads `clients.first_name`, `last_name` and `properties.city` for the zone, never `street_address`, `postal_code` or a coordinate; a test checks the SQL against the forbidden columns.
- **Demo days** (the planted scenarios, as_of 2026-09-30): Optimize, crew 4 on 2026-10-01 (S1: booked 134 minutes); Customer cancellation, crew 2 on 2026-10-02 (S2: property 762 is the top fill when its afternoon stop cancels); Crew out, crew 7 on 2026-10-03 (S3: 5 in-zone moves, 1 cross-zone, 0 unplaced).

### D9. Who sees routes on v1

The same rule as `/brightside`, by construction: every route module's resource must be `routing.audience.all_crews` (the registry refuses anything else), so `ROUTING_ALL_CREWS` holders see every crew, and `ROUTING_OWN_CREW` holders listed in `crew_leads` see their own crew (none are listed). The admin role confers neither. **Today that is you only.** Steven (admin) sees v1's Ask, Request a tool and the Setup group, and no route rows (gate item 6). Ask never names a tool the person can't open, so for Steven a route question gets the "request a tool" answer.

### D10. Ask on v1 runs safe queries (Option B)

The biggest and riskiest part, so it is two stories (19.6 the guard, 19.7 the flow), both T3, with SQLsmith and the architect reviewing the design before the gate.

**When Ask runs a query** (all must hold, else the Option A answers below):
1. the hub sees `data` and `rules`, readiness says both ready, and the profile has an `ask` block (below);
2. the person holds the new key **`ASK_DATA`** (`admin_grantable: false`: by name only; you hold it, gate item 5), checked at submit and again before the run;
3. no signed truth **failed** at the last `npm run verify` on this machine (a failed truth means the data and the signed figures disagree: "The data didn't match its signed figures at the last check, so I won't query it. Ask <admin>.");
4. the question was sorted as `data` and no tool on the hub fits it (a fitting tool is still offered first, with its button).

**The flow:**
1. **Write.** One structured call, `write_query` (`effects: "none"`), with a dedicated prompt: fixed instructions, the **allowed schema** (tables and columns from the profile's `ask` block, with their types), the truths' **statements** as definitions ("815 plans are active at as_of: start_date <= as_of and …"; never `expect` or `run`), and the data's as-of date. **No** `org.md`, no notes, no guardrails text: only reviewed, signed definitions can steer the SQL. It returns `{ sql, label (≤ 80), unit: count | cents | number | percent | date | text, truth_id? }`.
2. **Check.** `checkSql(sql, { forbiddenColumns, allowedTables })` (D10 guard, below). A refusal is never retried with the AI: the person sees "I couldn't write a safe query for that" with Request a tool.
3. **Run.** A new runner path, `data.askQuery(sql)`, wraps the checked SQL as `SELECT * FROM (<sql>) AS ask_q LIMIT 51` (engine text, added after the check), with a 10-second limit (the runner's interrupt, 30 s today for tools), one Ask query at a time per process (a queue, so Ask can't starve the tools), and the same read-only connection.
4. **Reconcile.** If the AI named a `truth_id` and that truth is valid and signed off, the result must be a single number within the truth's tolerance of its signed figure. Match: the answer says "Matches the signed figure <truth id>." Mismatch: the number is **not shown**: "My query gave a different number from the signed figure <truth id>, so I won't show it." with Request a tool, and the mismatch is logged (truth id and query hash only).
5. **Show.** The engine, not the AI, renders the result: a single value as "*<label>:* $350,186.40" (cents become dollars, counts get commas); a table of at most 50 rows and 10 columns, each cell at most 100 characters, escaped. Over 50 rows: "first 50 of more than 50; narrow the question". **The AI never sees a data row**: it wrote the query and the label before the run. So GRD-005's "never sees data rows" still holds.
6. **Provenance.** Under every answer: "One read-only query on <source label>, data as of <as-of date>, <n> rows, tables: payments, invoices. Written by the AI, checked by the SQL guard." and a **Show the query** button that pushes a view with the SQL (escaped, in a code block) and the same lines. Every answer ends with "Not what you needed?" and Request a tool.

**The guard (19.6):**
- **The profile's `ask` block** (schema, `kit/lib/profile`, T3): `tables`, a map of table to the columns Ask may read; `queries_per_hour` (default 10 a person). Brightside's: `zones`, `packages`, `add_ons`, `crews` (`crew_id`, `zone_id`, `name`), `plans`, `plan_price_changes`, `visits`, `scheduled_visits`, `invoices`, `invoice_lines`, `payments`, `clients` (`client_id`, `zone_id`, `created_on` only), `properties` (`property_id`, `client_id`, `zone_id`, `city` only), `service_rules`, `staff_absences` (`staff_id`, `absence_date`), `crew_memberships`, `fixture_meta`. **Not allowed:** `staff`, `pay_rates`, `timesheets` (people and pay; GRD-006 keeps pay to Labour cost) and `depots`.
- **An allow-list, enforced through the deny-list the guard already has.** Two layers:
  - **Tables:** a table not in `ask.tables` is refused by the new table check (below), whatever its columns.
  - **Columns of allowed tables:** at boot the engine reads the data's columns once (a fixed, reviewed `information_schema` query through the runner) and adds every column of an allowed table that `ask.tables` does not list to Ask's forbidden set, on top of `sql.forbidden_columns`. `checkSql` matches forbidden columns by bare name, so a hidden `email` is refused anywhere in the query.
  - Columns of tables that are not allowed at all are **not** added to the forbidden set: hiding `staff.name` by name would also hide `crews.name`, `zones.name` and `packages.name`. The table check already keeps `staff` out.
  - Boot refuses an `ask` block where an allowed column's bare name equals a hidden column's in another allowed table, naming both: fail closed, never a silent gap (DEP row for resolving qualified names). Tests cover each layer.
- **`checkSql` gains `allowedTables`** (`kit/runtime/sql`, T3 floor): every table reference after `FROM` and `JOIN` must be an allowed table or a CTE defined in the same statement; anything else is refused (`table_not_allowed`), including `information_schema`, `duckdb_*` and qualified names. The parity tests gain cases.
- **No PII by construction:** names, emails, phones, street addresses, postal codes and coordinates are not readable. Client and property ids are; a question that needs names is pointed to a tool that shows them under its own key, or to Request a tool.
- **Caps:** 51 rows fetched, 50 shown, 10 seconds, one at a time, 10 query answers a person an hour (the AI's own per-person limit and spend breaker apply too: one AI call per answer).
- **Logs:** module, query hash (SHA-256 of the SQL), tables, row count, milliseconds, the guard's rule on a refusal. Never the question, the SQL text, the label or a row.

**What Ask says on v1:**

| Question | Example | Answer |
|---|---|---|
| A route question | "Crew 4's stops on Oct 1 zig-zag. Can you fix the order?" | "*Optimize a route* can help with that. Press Run to use it." [Run]. Ask treats a routing-map tool as a data tool (19.3; today only scoped pulls count), so a route question sorted as `data` that names it also gets its button. A person outside the routing audience gets the row below instead |
| A data question, `ASK_DATA` held | "What was paid revenue in September 2026?" | "*Paid revenue, September 2026:* $350,186.40. Matches the signed figure paid-revenue-2026-09." Provenance, Show the query, Request a tool |
| A data question, without `ASK_DATA`, or the guard refused, or no query fits | "How many clients joined in the North zone this year?" | **"The data and rules are ready, but there's no tool for that yet. Press Request a tool and the team will build one."** [Request a tool] (without the Request key: "… Tell <admin> what you need.") |
| A context question | "What does Brightside promise when a crew is out?" | Answered from `org.md`, `data.md` (truth blocks and comments stripped, as today) and the shared notes, through `toMrkdwn`, ending "Not what you needed?" [Request a tool] |

The bold readiness line replaces "There's no tool for that yet." in `ASK_WORDS` (`readyRequestTool(offered, admin)`), on every hub where data and rules are both ready.

**GRD-009 (new card; approving the plan signs it, gate item 1):**

> ### GRD-009: Ask's read-only queries
> - type: access_rule
> - rule: on a hub that sees data and rules, Ask may answer a data question by having the AI write one read-only query. Only people granted `ASK_DATA` by name get this. The query may read only the tables and columns the profile's `ask` block lists; names, emails, phones, addresses, coordinates, staff and pay are never readable. The SQL guard checks it (GRD-001, GRD-002) before it runs; it runs for at most 10 seconds and returns at most 50 rows. The AI never sees the result: the bot shows it, with the query and its sources. A result that names a signed truth must match it, or it is not shown. Not run at all while a signed truth failed its last check. NOT a change to any tool: tools keep their reviewed queries.
> - owner: Ely Potter
> - evidence: plan brightside-v1 D10; `kit/runtime/sql` (`allowedTables`), `kit/runtime/data` (`askQuery`), `kit/runtime/archetypes/ask`; Stories 19.6 and 19.7.
> - status: approved
> - approval: approved by Ely Potter on <the gate date> (`approve plan brightside-v1`), added by Story 19.6.

GRD-005 gains one line: "Exception: GRD-009 (Ask's read-only queries): the AI writes the query; it still never sees a data row." AD-10 in `architecture-runtime.md` gains the same exception (the scribe drafts it in 19.6).

### D11. Request a tool on v1

The summary call already sends no business context (`withContext: false`, Story 16.6, pinned by a test), so it can't repeat context into the channel from any hub. `channel.js`'s `mayPostBuildRequest` stops refusing hubs that see `context` or `data`; instead the build-request archetype asserts at call time that its summary call is `withContext: false`, and a test fails if that option ever changes. The posted text still holds only the person's previewed words, the AI's summary of them, the hub's name and the requester. The AD-14 amendment in `architecture-runtime.md` is updated (gate item 2). Ask's Request a tool prefill still carries only the person's own question.

### D12. Readiness wording and the strip after sign-off

- **No readiness wording changes for the rule files:** "rules set up" already means `data.md` and `guardrails.md` signed off plus a signed truth. Only Ask's "both ready, no tool" line changes (D10).
- **`/brightside`** for you after 18.1: "Knows: 1 source · 7 truths · 8 rules" and "All 8 tools working" in dev (its eight modules, routing included) (the strip reads setup complete; the Setup 3 of 4 note in the hub-status-menu live check no longer applies).
- **`/brightside-v1`** for you after Epic 19: "Knows: N notes · 1 source · 7 truths · 9 rules" (GRD-009 makes 9) and "All 7 tools working". 10 rules once GRD-010 lands (Epic 20).
- **`/brightside-v0`:** unchanged (`sees: []`, no truths or rules), except its notes count includes notes added on v1.

### D13. The Slack app

`npm run slack:manifest` regenerates `slack-manifest.json` with `/brightside-v1` ("Open the Brightside v1 menu"). No new scope: the `external_select` options use the existing interactivity. Adding the command in the live app is your step (below).

### D14. Appointment emails on the live hub

**Two kinds, two templates, no AI.**
- **Reminder** of an upcoming appointment, unchanged.
- **Change notice:** what changed (day, arrival window or crew), what it was before, a fixed reason line by source ("we've improved the day's route", "an earlier slot opened up", "our team for that day is unavailable", "we've adjusted the day's schedule"), an apology ("Sorry for the change."), and how to reply ("Reply to this email, or call us on 555-0100, and we'll find a time that suits you.").
- **Why templates only:** the words are fixed and reviewed, the preview is exactly what is sent, and no customer name or appointment goes to the AI (GRD-005: the AI never sees data rows). AI-polished wording is a DEP row if you want it later.

**What an email may contain** (and nothing else): the customer's first name; the service date; the arrival window (the visit's `arrival_window`, or for a suggested time the 2-hour window it falls in); the crew's name; the package name; the before values for a change; the fixed Brightside sign-off, the synthetic office phone 555-0100 (GRD-007's range) and a reply line. **Never:** a street address, postal code or coordinate (GRD-002), a price, another customer, a staff name, or a route's other stops.

**How a change is detected: from a route skill's result** (chosen over a list of changed visits). Route skills never save (the bookings in the data never change), so a list of changed visits in the data would always be empty; only the route session knows booked versus suggested. A visit counts as changed when its **day, arrival window or crew** differs between booked and suggested. A start that moves within the same window is not a change, so customers are not emailed over minutes. Reminders, which need no before and after, come from a list (a scoped pull of a day's visits).

**The write path (GRD-004, DEP-012):** both go through the approval-write archetype, so preview, approve, send once, the kill switches (`BRIGHTSIDE_EMAIL_OFF`, `APLABS_WRITES_OFF`), idempotency and honest counts are reused, and `engine:write-path` stays satisfied.
- **The email tool** gains one write, `sendEmails({ batchName, emails, idempotencyKey, dryRun })`: each email is exactly `{ external_ref, email, first_name, subject, body, kind: "reminder" | "change" }`, keyed per email (perItemIdempotency), recorded in the outbox. It refuses any address that does not end in `.invalid` (the fixture's rule, GRD-007), so nothing can reach a real inbox even by mistake. Templates live in `examples/brightside/app/connectors/email/templates.js` and are rendered in the dry run, so the preview shows the exact text.
- **Appointment reminders** (`/brightside`, new module `appointment-reminders`, group **Customers**, verb Review): an approval-write module whose reviewed query lists a day's scheduled visits for one crew or zone (`scheduled_visit_id` as `row_id`, first name, email, date, window, crew name, package), then **Push to email tool** → preview with the first email rendered in full → Approve.
- **Change notices** (`/brightside`, new module `change-notices`, not on the menu by itself: it has no form). After a route skill's result, a person who holds its key sees **Notify affected customers (N)**. The click writes a route-source run record (new `approval-write/route-source.js`, T3): the changed visits' ids with their before and after day, window and crew, and the source skill. The module's reviewed query then reads first name and email for exactly those visit ids (an engine-bound list parameter, never from a form or the click), and the usual preview and approval follow. Stops a crew-out plan leaves to rebook are listed as "needs a call to rebook: not emailed". An added stop (Add a stop) is a new booking, not a change: it is not emailed (DEP row).
- **A resource key** `APPOINTMENT_EMAILS`, `admin_grantable: false` (approval-write requires it), granted to you by name.
- **The honest caveat, on the preview:** "These routes are suggestions: nothing is saved in the schedule. Sending tells customers their visit changed, so change the booking too." A real fork must send change notices only after its scheduling system holds the change (DEP row).

**Placement: the live hub only, not v1.** The stages then read as a ladder: v1 reads the data and suggests; the live hub acts on it, with approval. Reversible: one module folder on v1. So the live hub also gets the new route skills (Customer cancellation, Crew out, Add a stop) as copies beside Plan a route, so its demo can go "cancel, fill, notify". "Live is unchanged" is superseded for these additions only; nothing already on `/brightside` changes.

**GRD-010 (new card; approving the plan signs it, gate item 4):**

> ### GRD-010: Appointment emails
> - type: exception_workflow
> - rule: the bot may draft two kinds of customer email, a reminder and a change notice, from fixed templates. Each holds only the customer's first name, the service date, the arrival window, the crew's name, the package, and for a change what it was before; never an address, postal code, coordinate, price, another customer or a staff name. They go to the email tool only through the approval step (GRD-004), after a person granted `APPOINTMENT_EMAILS` by name approves the exact text. A change notice comes only from a route skill's result and only for a visit whose day, window or crew changed. The mock email tool refuses any address not ending in `.invalid`. NOT a change to bookings: routes stay suggestions.
> - owner: Ely Potter
> - evidence: plan brightside-v1 D14; the email connector's `sendEmails` and `templates.js`; `approval-write/route-source.js`; Stories 20.1 to 20.3.
> - status: approved
> - approval: approved by Ely Potter on <the gate date> (`approve plan brightside-v1`), added by Story 20.1.

`guardrails.md`'s Write paths table gains the row: "Send appointment emails | Mock email tool (outbox) | approval-write preview and approval | `BRIGHTSIDE_EMAIL_OFF`, `APLABS_WRITES_OFF` | built by Epic 20".

### Engine changes, kept as small as the asks allow

Profile and hub config alone do the v1 hub, its menu, the route copies, who sees routes, the database, and the strip. These asks need engine code:

| Change | Why config can't do it | Story |
|---|---|---|
| `.csv` in `files.js` | a new file type | 18.2 |
| hub `notes` link (`hub.schema.json`, `hub-view.js`, `llm`) | v1 must see v0's notes | 19.1 |
| `mayPostBuildRequest` allows any hub | Request a tool on v1 | 19.3 |
| Ask treats routing-map as a data tool; the "ready, request a tool" line; Data sources' rule count | route questions; Ely's wording | 19.3 |
| three new routing-map screens; `gapFor`; crew-out what-if | named skills | 19.4 |
| `insertStop`, Add a stop, the options listener | Add a stop | 19.5 |
| `allowedTables`, `askQuery`, the profile `ask` block, `ASK_DATA` | Option B | 19.6 |
| Ask's `write_query` flow, rendering, provenance, reconciliation | Option B | 19.7 |
| `sendEmails`, templates, route-source run record | appointment emails | 20.1 to 20.3 |

## The stories

Stories are PRs. Estimates: **S** about half a day, **M** about a day, **L** up to two days.

### Epic 18: the v0 demo, Ely, and the rules

| Story | Size | Tier | You will see |
|---|---|---|---|
| 18.1 Ely replaces Dana; the rules are signed off | M | **T3** | Data sources and the strip on `/brightside`: "signed off 2026-10-31 by Ely Potter", 8 rules; DEP-024, 025, 028, 029, 032 closed |
| 18.2 CSV files in Add context | M | **T3** | Add context takes a `.csv`; "N rows, M columns" |
| 18.3 The v0 demo pack and script | M | T1 | `examples/brightside/demo-pack/` with two PDFs and two CSVs; the v0 script in `demo-script.md` |

### Epic 19: `/brightside-v1`

| Story | Size | Tier | You will see |
|---|---|---|---|
| 19.1 Hubs can share notes | M | **T3** | Nothing in Slack yet; tests show one store on two hubs |
| 19.2 The v1 hub, its tools and the Slack mirror | M | T2 (computes T1; raised) | `/brightside-v1` with Optimize a route, Route map, Ask, Request a tool and the Setup group |
| 19.3 Ask and Request a tool on a hub with data | M | **T3** | Route questions point to the route skills; "data and rules are ready, request a tool"; Request a tool posts from v1; Data sources shows "Rule cards approved: 8" |
| 19.4 Route skills: Customer cancellation and Crew out | L | T2 | Two new rows on v1 with what-if flows |
| 19.5 Route skill: Add a stop | L | T2 | Add a stop on v1 |
| 19.6 The query guard | L | **T3** | Nothing in Slack; tests show the guard; GRD-009 in `guardrails.md` |
| 19.7 Ask answers with a query | L | **T3** | Ask on v1 answers data questions with the query and its sources |
| 19.8 v1 docs, demo script and live check | S | T0 | The v1 script and live check list |

### Epic 20: appointment emails on the live hub

| Story | Size | Tier | You will see |
|---|---|---|---|
| 20.1 The email tool sends appointment emails | M | **T3** (computes T3: `profiles/**`) | Nothing in Slack; tests show the two templates and the `.invalid` guard; GRD-010 |
| 20.2 Appointment reminders | M | **T3** | Customers → Appointment reminders on `/brightside`: preview, approve, then Outbox shows them |
| 20.3 Change notices from a route skill, and the skills on `/brightside` | L | **T3** | Customer cancellation, Crew out and Add a stop on `/brightside`; Notify affected customers after a result |
| 20.4 Live demo script and live check | S | T0 | The live script ending with the email flow |

**Tiers** (computed 2026-10-31 per path with `APLABS_PROFILE=$PWD/profiles/brightside/profile.yml node kit/lib/tier <path>`; the Orchestrator recomputes each story on its full file list before it starts, and a tier only goes up):

- 18.1: `profiles/brightside/profile.yml` and `profiles/brightside/context/*.md` are T3 (`profiles/**`). The examples, tests and `kit/templates/context/data.md` compute T1 or T0. Onboarding-style: the context files' sign-off.
- 18.2: `kit/runtime/slack/files.js` T3 (engine floor); `archetypes/add-context` T1.
- 18.3: `examples/brightside/demo-pack/**`, `package.json` T1; `docs/runtime/demo-script.md` T0.
- 19.1: `kit/runtime/schema/hub.schema.json`, `kit/runtime/slack/hub-view.js`, `kit/runtime/llm/index.js`, `kit/runtime/knowledge/store.js` T3 (engine floors); `kit/runtime/registry/index.js` T1.
- 19.2: `examples/brightside/app/hubs/brightside-v1.json`, the module folders, `slack-manifest.json` compute T1. Raised to T2: a new hub that sees context, data and rules, and a new slash command.
- 19.3: `kit/runtime/slack/channel.js` T3 (engine floor); `archetypes/ask`, `archetypes/build-request`, `archetypes/data-sources`, `messages.js` T1.
- 19.4: `kit/runtime/archetypes/routing-map/index.js` and `editor.js` T2 (profile), `kit/runtime/routing/**` T2, `module.schema.json` and `examples/brightside/app/routing/adapter.js` T1. `audience.js` (T3) is not edited; if it must be, the story becomes T3.
- 19.5: `kit/runtime/routing/insert.js` and `editor.js` T2; `slack/hubs.js` and the adapter T1.
- 19.6: `kit/runtime/sql/**`, `kit/runtime/data/**`, `profiles/_schema/**`, `kit/lib/profile/**`, `profiles/**` T3.
- 19.7: `kit/runtime/llm/**` T3; `archetypes/ask/**` and `messages.js` T1.
- 19.8, 20.4: docs only, T0.
- 20.1: the email connector computes T1 (it sits in `examples/`), raised to T3: a write path to an outside system; `profiles/**` (the key, GRD-010) T3.
- 20.2: `kit/runtime/archetypes/approval-write/**` T3 if touched; the module computes T1; `profiles/**` (the grant) T3.
- 20.3: `kit/runtime/archetypes/approval-write/route-source.js` T3 (engine floor); `archetypes/routing-map/**` T2.

All T2 and T3 stories get an architect design review. 19.6 and 19.7 also get SQLsmith on every query and prompt they add. 20.1 to 20.3 get Connector.

## Acceptance criteria

Every story, in addition to what is listed:
- `npm run check && npm test` pass. A story that touches a path `AGENTS.md` lists for `npm run test:slow` runs it too.
- Tests read client specifics from fixtures (`test/fixtures/`, `examples/brightside/test/fixtures/`), never from `profiles/brightside/`, except the example's own profile and canon tests that already read it (`examples/brightside/test/profile.test.js`, `guardrails-routing.test.js`, `fixture/__tests__/validate.test.js`).
- A test that fixes the time freezes every clock (`mock.timers`, or `now` passed to every path: the store's TTLs, the knowledge store's `added_at`, the AI breaker, the Ask query budget, the route sessions).
- The Slack, Anthropic and email fakes reject what the real systems reject, for every field the story's code sets. Each story names the fields it added to a fake.
- Each new or changed Slack screen lists every way out: Back, the X, an error, an expired trigger, a click from an old message, and, for slow work, the person closing it while it runs. Each has a test.
- Every ack returns within Slack's 3 seconds: slow work shows "Thinking…" or "Reading…" and updates the view.
- No status glyph outside `kit/runtime/registry/vocabulary.js`; no menu button says "Open".
- Nothing is reworded to quiet a check. If a check flags safe code, the code moves or the check is fixed in its own change.
- Steps only the live app or CI can run are named as untested in the builder's report and the PR body.
- Each story updates the docs that describe what it changed (`architecture-runtime.md`, `architecture-routing.md`, the file's header comment) in the same PR.
- No reference-client name, path, Slack id or data outside `docs/reference/` (`docs/reference/dist-deny.txt`).
- No "Dana" in any new text.

### Story 18.1: Ely replaces Dana; the rules are signed off

- Every change in D1's "Changes" list, and the history notes. The PR lists the files `grep -rn Dana` still finds, all in D1's "Stays as history" list.
- `profile.yml`: the user `ely` (Ely Potter, admin, Slack `U0CB6HDBBQX`, grants `TIER3_APPROVE`, `WIN_BACK`, `ROUTING_ALL_CREWS`); no `github` identity. `validateProfile` passes.
- The four context files signed as D1 says; `npm run onboard -- --status` shows each signed by Ely Potter on 2026-10-31.
- `guardrails.md`: all eight cards `- status: approved`; GRD-008's edge cases as D2; the header rewritten; the routing-map and Office words in past tense. Test (example canon test): `countApprovedRules` on the file is 8; no card says draft or pending.
- `data.md`: owners Ely Potter; the seven signed truths keep their dates; the five routing truths stay `pending` (gate item 8 may change this).
- The DEP rows as D2's table, word for word, in `docs/ledger.md`; `node --test test/unit/ledger*.test.js` passes.
- The example tests renamed and passing (`demo-flow` finds the user `ely`; `profile.test.js` "granted to Ely by name"; `guardrails-routing.test.js` asserts approved, not pending; `validate.test.js` owner Ely Potter).
- `docs/runtime/routing-map.md`: the audience is no longer a placeholder; production waits only on Story 15.6.
- Data sources on `/brightside`'s fixture twin shows "signed off 2026-10-31 by Ely Potter" for both rule files (test on a fixture copy).

### Story 18.2: CSV files in Add context

- D3 in full: `READABLE.csv`, `readCsv` with every cap and check, the screen's words, "N rows, M columns".
- Tests, one each: 200 and 201 data rows; 30 and 31 columns; 6,000 and 6,001 escaped characters (a cell of `<` counts 4); a ragged row; an unterminated quote; quoted commas and line breaks kept; a BOM dropped; invalid UTF-8; a NUL byte; header only; CRLF stored as LF; a `.csv` with a JSON content type; `.xlsx` still refused with "save it as a PDF first".
- The D6 injection test of plan brightside-v0 runs on a CSV whose cell says "ignore your instructions".
- The Slack fake's `file_input` validator accepts `csv` as a filetype.
- `DEP-036`'s text gains "or a .csv for a sheet".
- Untested until the live check: a real `.csv` through Slack's `file_input`.

### Story 18.3: the v0 demo pack and script

- D4 in full: `build.js` (no dependency), the four files committed, `npm run demo-pack`.
- Tests: each PDF sniffs as `pdf` and `pdfPageCount` reads its pages; each CSV passes 18.2's `readCsv`; the zone billing totals equal the two truths' planted targets (read from `targets.json`); the complaints CSV holds no client name, email or street (checked against the fixture's clients and properties); the four together fit under 11,000 escaped characters; two builds give the same bytes; each expected answer in the script appears in the files.
- `docs/runtime/demo-script.md` gains "Stage 1: v0", the script below.
- If 18.2 has not merged, the CSVs still build; the script's CSV steps say they need 18.2.

### Story 19.1: hubs can share notes

- `hub.schema.json`: optional `notes` (a hub id slug). The registry refuses: a `notes` naming no hub, naming itself, naming a hub that has its own `notes`, and two hubs sharing notes whose `ask` or `add-context` modules use different resource keys; each names the hub file and field.
- `hub-view.js`: `knowledge` is `knowledge.forHub(hub.notes || hub.id)`; its header says so and why it stays safe (D6).
- `llm.forHub({ id, sees, notes })` reads the shared store for the prompt; the 40,000 limit and the per-call refusal are unchanged.
- Tests: one process, two fixture hubs sharing notes: a note added on either is listed and in the prompt on both; removed on either, gone from both; a third hub without `notes` never sees them; the blank hub's prompt still holds no profile context (`sees: []`); the caps count the shared set once; two adds at once, one from each hub, run one at a time (the per-store queue).
- `architecture-runtime.md`: AD-3's knowledge store bullet and the hub file's fields.

### Story 19.2: the v1 hub, its tools and the Slack mirror

- `brightside-v1.json` as D5; the nine module folders as D5's table (the three new route screens' folders land with 19.4 and 19.5, so this story adds `v1-route-optimize`, `v1-route-map`, `v1-ask`, `v1-build-request`, `v1-add-context` and `v1-data-sources`).
- `slack-manifest.json` regenerated; `--check` passes; it lists three commands and the same seven scopes.
- Tests on a fixture copy of the three hubs: the v1 menu for an admin with the routing key shows Routing (Optimize a route, Route map), Tools (Ask, Request a tool) and Setup; without the routing key, no Routing group; `/brightside` and `/brightside-v0` menus are unchanged (snapshot of their blocks before and after).
- Ways out of the v1 menu, each tested: the X, each verb button and Back, Help and Back, an expired trigger, a person not in the profile.
- Untested until the live check: the live app's `/brightside-v1` command.

### Story 19.3: Ask and Request a tool on a hub with data

- `channel.js`: `mayPostBuildRequest` no longer refuses on `sees`; the build-request archetype asserts its summary call is `withContext: false` (a test fails if the option changes); the posting tests run from a hub that sees all three. The AD-14 amendment text updated.
- Ask: a `routing-map` tool counts as a data tool (gated by readiness like a scoped pull); `ASK_WORDS.noToolYet` becomes `readyRequestTool(offered, admin)` with D10's words. Tests: a route question sorted `module` and sorted `data` both get the skill's button; a person without the routing key gets the request line; the request line with and without the Request a tool key.
- Data sources: "Rule cards approved: N" from `approvedRules`, only on a hub that sees rules. Test: 8 on a fixture with eight approved cards; 0 while the file is unsigned.
- The hub menu: Request a tool on v1 is `ready` (no "not on this hub").

### Story 19.4: route skills, Customer cancellation and Crew out

- `module.schema.json` `screen` gains `cancellation` and `crew-out` (and `add-stop`, used by 19.5); the registry's routing-map checks are unchanged.
- **Customer cancellation:** crew and day, then the visit that cancels, then the gap and the top 5 with reasons, then **Fill with #n** opens the editor with the filled day. The adapter's `gapFor` reuses the gap candidate code. Test: on the fixture, crew 2 on as_of+2 with its afternoon stop cancelled gives property 762 first (the S2 truth); a what-if on a day with no candidates says so.
- **Crew out:** day and crew, then **Mark out for the day**, then the Route change view's plan. Test: crew 7 on as_of+3 as a what-if gives 5 in-zone moves, 1 cross-zone, 0 unplaced (S3); a crew the data shows out says "out in the data".
- Scope (AD-R17): a crew lead's what-if is their own crew only; the visit select lists only stops they may see. Tests per scope.
- No new coordinate read: every read goes through `travelMatrix`, `mapPoints` or the existing adapter queries; a test checks the new SQL against the forbidden columns.
- New v1 folders `v1-route-cancellation`, `v1-route-crew-out`.
- Ways out of each screen, each tested: Back, the X, Change crew or day, an expired session, no stops that day, the data unavailable, the map not ready (Why?), a click from someone else's view.

### Story 19.5: route skill, Add a stop

- `kit/runtime/routing/insert.js` `insertStop`, pure, exported from `kit/runtime/routing` and `kit/runtime/sdk` as the others are; `engine-boundary.test.js` passes. Tests: the cheapest position under the AD-R5 tuple; a window that no position keeps (placed last, flagged); the two cheapest other crews of the zone; byte-identical output for the same input.
- The editor's **Add a stop** with the client `external_select` (`min_query_length` 2, at most 20 options, the crew's zone only), the length and the window; the stop joins the order marked ➕ and moves like any other. The options listener re-checks access and scope before any read; a search from someone without access returns no options.
- The Slack fake gains `external_select` and the `block_suggestion` payload, and rejects more than 100 options and option text over 75 characters.
- New v1 folder `v1-route-add-stop`.
- Ways out, each tested: Back to the day, the X, no client found, the search failing (no options, logged), the session expired, a stop added then removed.

### Story 19.6: the query guard

- `checkSql(sql, { forbiddenColumns, allowedTables })`: `table_not_allowed` for any table reference that is not allowed or a same-statement CTE. Tests: `information_schema.columns`, `duckdb_tables()`, a qualified `main.staff`, a CTE named like an allowed table, a subquery reading `staff`, a join on `pay_rates`, a quoted `"staff"`; the existing parity tests still pass.
- The profile schema's `ask` block (`tables`, `queries_per_hour`), validated by `kit/lib/profile` (unknown keys rejected; tables and columns lower-case slugs). Brightside's block as D10. `ASK_DATA` (`admin_grantable: false`) granted to `ely`.
- Boot reads the data's columns once (a fixed query) and builds Ask's forbidden set as D10 says; a hidden column whose bare name equals an allowed one's stops boot, naming both. Test on a fixture schema.
- `data.askQuery(sql)`: the engine's `LIMIT 51` wrapper after the check, 10 seconds, one at a time, the read-only connection. Tests: a slow query is interrupted at 10 s (frozen clock); a second waits for the first; the wrapper is applied to checked SQL only.
- `guardrails.md` gains GRD-009 as D10 (approved, owner Ely Potter); GRD-005's exception line. AD-10's exception drafted by the scribe in `architecture-runtime.md`.
- SQLsmith reviews the allowed schema and the fixed columns query.

### Story 19.7: Ask answers with a query

- The flow, provenance and words in D10. `write_query` tool schema: `sql` (at most 4,000 characters), `label` (80), `unit` (the enum), `truth_id` (a slug); the Anthropic fake checks it.
- Tests, one each: each "When Ask runs a query" condition missing gives the Option A line; a guard refusal shows "I couldn't write a safe query"; a truth match shows "Matches the signed figure"; a mismatch hides the number; a failed truth at the last verify refuses before any AI call; 51 rows shows "first 50"; cents render as dollars; the AI's call never includes a row (the fake records every request, and no fixture value appears in any of them); the prompt holds no note text and no `org.md` text; per-person limit; logs hold no question, SQL text or row.
- **Show the query** pushes a view with the escaped SQL and the provenance lines; Back returns.
- Ways out, each tested: Back, the X, closing while it thinks, the AI off or over budget, the data unavailable, the query timing out ("That question took too long to answer; narrow it"), an expired trigger.
- SQLsmith reviews the prompt and runs D10's demo questions against the fixture through the Verifier; their answers go in the PR.

### Story 19.8: v1 docs, demo script and live check

- `docs/runtime/demo-script.md` gains "Stage 2: v1"; `docs/fork-guide.md` explains `notes`, the `ask` block and `ASK_DATA`, and when a fork should leave Option B off (no `ask` block); `kit/templates/module.md` the new screens.
- The live check list for v1 is in the PR body; the result is recorded as "live-checked" or not in the epic report.

### Story 20.1: the email tool sends appointment emails

- `sendEmails` as D14, with the dry-run plan (renders every email, lists refused ones), per-email keys, partial failure and retry like `pushList`. The `.invalid` guard refuses before any outbox write.
- `templates.js`: `reminder(fields)` and `change(fields, before, reason)`; every field escaped for plain text; a template refuses a field outside D14's list. Tests: each template's exact text for a fixture visit; no address, price or staff name can appear (the fields aren't accepted).
- Connector contract suite passes; `engine:write-path` passes.
- `APPOINTMENT_EMAILS` (`admin_grantable: false`) granted to `ely`; GRD-010 and the Write paths row in `guardrails.md`.

### Story 20.2: appointment reminders

- Module `appointment-reminders` (approval-write, group Customers, verb Review), form: day (within the data's scheduled range) and crew or zone; reviewed SQL (SQLsmith) reads no forbidden column. Push → preview with the first email rendered in full and a count → Approve → Outbox shows them.
- Tests: the preview equals what is sent; a second approve sends nothing new; `BRIGHTSIDE_EMAIL_OFF` stops it; a person without the key never sees the row.
- Ways out: the approval-write archetype's existing ones (Cancel, an expired preview, a partial failure and Retry), each run once on this module.

### Story 20.3: change notices from a route skill, and the skills on `/brightside`

- Copies of Customer cancellation, Crew out and Add a stop on `/brightside` (folders `route-cancellation`, `route-crew-out`, `route-add-stop`), in the Routing group, dev-only until 15.6.
- `route-source.js`: the changed-visits record (D14's rule: day, window or crew), bound to the person and the session, 30 minutes, consumed by the preview. **Notify affected customers (N)** shows only on a hub with a `change-notices` module the person can open, and only when N > 0.
- The module's query reads first name and email for the record's visit ids only (an engine-bound list parameter). Tests: a forged click can't name other visits; a visit moved within its window is not emailed; a crew-out stop to rebook is listed, not emailed; an added stop is not emailed; the reason line matches the source skill.
- Tests on the S1, S2 and S3 scenarios: the expected visits and before/after values.
- Ways out: Back to the route, Cancel, the record expired ("start from the route again"), nothing changed (no button), and the approval-write ways out.

### Story 20.4: live demo script and live check

- `docs/runtime/demo-script.md` gains "Stage 3: live", ending with the email flow; the live check list in the PR body.

## Build order and shared files

Run one at a time, in this order, except where a line says "alongside":

1. **18.1.** Everything after it reads the signed files. Then **15.6** (gate item 7), its own PR.
2. **18.2**, then **18.3** (the CSVs need `readCsv`). 18.3's PDFs may start alongside 18.2.
3. **19.1**, then **19.2**.
4. **19.3** after 19.2.
5. **19.4**, then **19.5** (both edit `editor.js`, `routing-map/index.js`, the adapter and `hubs.js`).
6. **19.6** may start alongside 19.4 (no shared file), then **19.7** after 19.3 and 19.6 (both edit `archetypes/ask` and `messages.js`).
7. **19.8** last in Epic 19.
8. **20.1**, then **20.2**, then **20.3** (after 19.5: it copies the skills). **20.4** last.

| File | Stories |
|---|---|
| `profiles/brightside/profile.yml` | 18.1, 19.6, 20.1, 20.2 |
| `profiles/brightside/context/guardrails.md` | 18.1, 19.6, 20.1 |
| `docs/ledger.md` (DEP rows) | 18.1, and any story that opens a DEP row |
| `kit/runtime/slack/files.js` | 18.2 |
| `kit/runtime/archetypes/add-context/index.js` | 18.2, 19.1 (the "shared with" line) |
| `kit/runtime/slack/hub-view.js`, `hub.schema.json`, `kit/runtime/llm/index.js` | 19.1, 19.7 (llm) |
| `kit/runtime/archetypes/ask/index.js`, `kit/runtime/messages.js` | 19.3, 19.7 |
| `kit/runtime/archetypes/routing-map/index.js`, `editor.js`, `examples/brightside/app/routing/adapter.js` | 19.4, 19.5, 20.3 |
| `kit/runtime/slack/hubs.js` | 19.2 (tests only), 19.5, 20.3 |
| `kit/runtime/schema/module.schema.json` | 19.4 |
| `kit/runtime/sql/index.js`, `kit/runtime/data/index.js` | 19.6 |
| `kit/runtime/archetypes/approval-write/**` | 20.2, 20.3 |
| `test/fixtures/fake-slack.js` | 18.2, 19.5 |
| `test/fixtures/fake-anthropic.js` | 19.7 |
| `examples/brightside/app/slack-manifest.json` | 19.2 |
| `docs/runtime/demo-script.md` | 18.3, 19.8, 20.4 |
| `docs/planning/planning-artifacts/architecture-runtime.md` | 19.1, 19.3, 19.6, 19.7, 20.3 |

If a later builder finds `main` has moved, it merges `main` and resolves the conflicts before it reports.

## Steps only you can do

1. **Approve the plan** (`approve plan brightside-v1`), with any gate item changed.
2. **Add `/brightside-v1` in the Slack app, before 19.2's live check,** the same way you added `/brightside-v0`:
   1. Open api.slack.com/apps and pick the Brightside app.
   2. Click **Slash Commands**, then **Create New Command**.
   3. Command: `/brightside-v1`. Short description: `Open the Brightside v1 menu`. Leave the usage hint empty and "Escape channels, users, and links" off. Save.
   4. If Slack shows a banner asking you to reinstall the app, click it and allow.
3. **Nothing else before the build.** No new scope, token, channel or install. The bot runs in dev as today.
4. **The live checks**, at the end of each epic (lists below).

## Demo scripts

Each step is one click or one question. They go into `docs/runtime/demo-script.md` (18.3, 19.8, 20.4).

**Before any demo:** update the bot to the latest `main`, restart it, and remove any notes left from the last demo (Add context → Remove on each).

### Stage 1: v0, the blank bot

1. Type `/brightside-v0`. Point at the strip: "Knows: nothing yet", "Setup 0 of 1".
2. Press **Help**: four template tools, each in one line. Press Back.
3. Press **Ask**, ask "Which zone billed the most in September, and how much of it was paid?". It says it can't answer: no data and no rules.
4. Press **Add** on Add context, upload `price-list-2026.pdf`, title "Price list". It shows what it read.
5. Upload `service-policies.pdf` ("Policies"), `zone-billing-2026-09.csv` ("Billing by zone, September") and `complaints-2026-09.csv` ("Complaints, September"). Each shows its rows and columns.
6. Close, type `/brightside-v0`: "Knows: 4 notes".
7. Ask the five questions in D4, one after another (Ask another). Each answer matches the script's expected answer.

### Stage 2: v1, the real data

1. Type `/brightside-v1`. Point at the strip: "Knows: 4 notes · 1 source · 7 truths · 9 rules", "All 7 tools working".
2. Press **View** on Data sources: the source, the seven truths signed by Ely Potter, both rule files signed, "Rule cards approved: 9", and the four notes "shared with Brightside v0".
3. Ask "How much notice does a customer need to reschedule?": answered from the shared note.
4. Ask "What was paid revenue in September 2026?": $350,186.40, "Matches the signed figure paid-revenue-2026-09". Press **Show the query**.
5. Ask "How many active plans are there in each zone?": a five-row table with provenance.
6. Ask "Crew 4's stops on October 1 zig-zag. Can you fix the order?": it points to Optimize a route. Press **Run**.
7. Pick crew 4 and 2026-10-01, **Show stops** (134 minutes booked), **Optimize**: the drive drops.
8. Back to the menu, **Run** Customer cancellation: crew 2, 2026-10-02, the afternoon visit cancels: property 762's client is top. **Fill with #1**.
9. **Run** Crew out: 2026-10-03, crew 7 is "out in the data": 5 visits move in the zone, 1 is a cross-zone recommendation.
10. **Run** Add a stop: crew 4, 2026-10-01, search a client in its zone, 60 minutes, afternoon. The stop joins with ➕ and the drive and finish update.
11. Ask "Which clients have the highest unpaid balance?": it can't show names, so: "The data and rules are ready, but there's no tool for that yet." Press **Request a tool**, preview, Post: it appears in `#ai-build-requests`.

### Stage 3: live, it acts

1. Type `/brightside`. Lists, Routing, Customers and Tools; "All N tools working".
2. **Run** Unpaid invoices for North (the names Ask wouldn't show, under their own key).
3. **Review** Win-back list (North, 90 days, 25): the scored list. (Optional: Push and approve, then Outbox.)
4. **Run** Customer cancellation: crew 2, 2026-10-02, the afternoon visit cancels, **Fill with #1**.
5. Press **Notify affected customers (1)**. The preview shows the change notice: the new day and window, the old ones, the apology and the reply line. Press **Approve**.
6. **Run** Crew out on 2026-10-03, crew 7, then **Notify affected customers (N)**: a change notice for each of the five moved visits (and for any receiving-crew visit whose window moved); the cross-zone recommendation is listed, not emailed, because it isn't placed. Approve.
7. **Review** Appointment reminders for 2026-10-01, crew 4: the reminders. Approve.
8. **View** Outbox: the reminders and change notices, each to a `.invalid` address. "Nothing left the building."

## The live checks

Run in Slack, from your own account. Each step is one thing to do and what you should see. If something differs, stop and tell the Orchestrator the step number and what you saw.

**After Epic 18:**
1. Type `/brightside`. The first line reads "Knows: 1 source · 7 truths · 8 rules", and the second line has no "Setup".
2. Type `/brightside-v0`, press **Add** on Add context, upload `complaints-2026-09.csv`. You see "N rows, M columns".
3. Upload the other three demo-pack files. Each is added. The strip says "Knows: 4 notes".
4. Ask the five v0 questions. Each answer matches the script.
5. Try to upload a `.xlsx`. You are told to save it as a PDF first.

**After Epic 19** (after you add `/brightside-v1`):
6. Type `/brightside-v1`. The first line reads "Knows: 4 notes · 1 source · 7 truths · 9 rules", the second "All 7 tools working".
7. Press **View** on Data sources. You see the source, seven truths signed by Ely Potter, both rule files signed off by Ely Potter, "Rule cards approved: 9", and the notes marked shared with Brightside v0.
8. Ask "Crew 4's stops on October 1 zig-zag. Can you fix the order?". The answer names Optimize a route with a **Run** button.
9. Press **Run**, pick crew 4 and 2026-10-01, **Show stops**, **Optimize**. The map and the drive time update.
10. Open **Route map**. Its four views work as on `/brightside`.
11. Run Customer cancellation, Crew out and Add a stop as in the Stage 2 script, steps 8 to 10. Each shows what the script says.
12. Ask "What was paid revenue in September 2026?". You see $350,186.40, "Matches the signed figure", and **Show the query** shows the SQL.
13. Ask "Which clients have the highest unpaid balance?". You see "The data and rules are ready, but there's no tool for that yet." with **Request a tool**.
14. Ask "What does Brightside do when a crew is out?". You get an answer from the company context, ending "Not what you needed?".
15. Press **Request a tool** on any answer, Preview, Post. It appears in `#ai-build-requests` with your name and "Brightside v1".
16. Add a typed note on v1, then type `/brightside-v0`. The note is there too. Remove it on v0; it is gone from v1.
17. Type `/brightside-v0` and `/brightside`. Both menus look as they did after Epic 18.
18. Open the Slack app's settings: the commands are `/brightside-v0`, `/brightside-v1` and `/brightside`, matching `slack-manifest.json`, with the same seven scopes.

**After Epic 20:**
19. Type `/brightside`. A Customers group shows Appointment reminders, and Routing shows Customer cancellation, Crew out and Add a stop.
20. Run the Stage 3 script, steps 4 to 8. Each preview shows the exact email, nothing is sent before Approve, and Outbox lists every email to a `.invalid` address.
21. Approve the same preview twice (double click). Outbox shows each email once.

Not checked live, by design: a crew lead's view (none is listed) and a member's view (Marcus is fictional). The tests cover both.

## Ledger items

**Closed or changed by 18.1:** DEP-024, DEP-025, DEP-028, DEP-029, DEP-032 closed; DEP-034's owner becomes Ely; DEP-036's text gains CSV (D2, D3).

**New (proposed;** the Orchestrator assigns ids from DEP-041 when the stories open them):

| Row | Owner | What |
|---|---|---|
| DEP-(next) | Orchestrator | Ask's query answers as a CSV in the person's DM, for results over 50 rows. Today: the first 50 and "narrow the question". |
| DEP-(next+1) | **Ely** | AI-polished wording for appointment emails. Today: fixed templates only, so no customer data reaches the AI (GRD-005). Needs a GRD-010 change. |
| DEP-(next+2) | Each engagement lead | A real fork sends a change notice only after its scheduling system holds the change: route skills never save, and there is no write to a scheduling system yet. The demo's preview says so. |
| DEP-(next+3) | Orchestrator | A booking confirmation email for a stop added with Add a stop (today it is not emailed: it is not a booked visit). |
| DEP-(next+4) | Orchestrator | Allowing a column whose bare name a hidden column shares (for example `crews.name` with `staff.name` hidden) needs the guard to resolve qualified names. Today boot refuses that `ask` block. |
| DEP-(next+5) | **Ely** | Steven's route access on v1 and `/brightside` (gate item 6): granted by name if you want him to demo routes. |

## Risks

- **AI-written SQL (Option B).** Contained, not removed: the table allow-list, the column deny-list built from it, the read-only connection, the 10-second limit, the row cap, the truth checks and no rows to the AI. A wrong-but-safe query can still give a wrong number for a question no truth covers; the answer always shows the query, and SQLsmith's review and the demo questions are the check. The guard's table check is new code in a T3 file: the parity tests and the architect review cover it.
- **Shared notes.** A note added on v1 shows on v0. By design, and said on both screens.
- **What-if route screens** read more from the adapter (a visit picked by the person, a client search). Every read stays inside the scope check and the forbidden columns.
- **Change notices for suggestions.** In the demo the email says the visit moved while the data didn't. The preview says so (DEP row for real forks).
- **The fixture's emails** end in `.invalid`, and the tool refuses anything else, so a mistake can't reach a real inbox.
- **Size.** Fifteen stories over three epics. The epics stand alone: Epic 18 gives a complete v0 demo, Epic 19 a complete v1, Epic 20 the finale.

## Not in this plan

- Saving a route to the bookings, or any write to a scheduling system.
- Ask writing anything, or running a query on `/brightside` or `/brightside-v0`.
- Word or Excel uploads (DEP-036).
- The Home tab (DEP from plan hub-status-menu).
- AI-written emails.

## Approval

Write `approve plan brightside-v1` to start the build. It accepts the eight gate items at the top with their recommended defaults, and signs GRD-009 and GRD-010 as worded in D10 and D14. To change one, say so with the approval. Before the gate, the Orchestrator runs the architect design review, `bmad-review` and SQLsmith's review of D10, and folds their findings in here.
