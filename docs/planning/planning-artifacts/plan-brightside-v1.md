# Brightside v1 and the three-stage demo: plan for Ely

Status: **draft, awaiting `approve plan brightside-v1`.** Tier **T3** (computed per story below with `APLABS_PROFILE=$PWD/profiles/brightside/profile.yml node kit/lib/tier <paths>`, 2026-10-31). Three epics: **18** (v0 demo pack, CSV, Ely replaces Dana, rules signed off), **19** (the `/brightside-v1` hub: shared notes, the database, route skills, signed query rules, Ask that runs queries) and **20** (appointment emails on the live hub). Run mode after the gate: you let it run.

**Reviews: done, 2026-10-31.** The architect design review (12 findings plus P3s) and the SQLsmith review of the data design (15 findings) are folded in below; every one is applied (section "Review findings folded in"). Your decisions of 2026-10-31 on Option B and Steven's access are applied too. `bmad-review` was not run as a separate pass: the architect's review covered the adversarial and edge-case lenses, as for plan hub-status-menu.

**Decided by you (2026-10-31), recorded, not gate items:**
- **Option B is approved:** Ask on v1 writes and runs read-only queries. "Running queries is a need." Approving the plan signs **GRD-009** as worded in D10.
- **Steven Auslander gets everything you have, on every hub, always.** Plan-wide rule: **any grant to Ely is granted to Steven in the same change.** That covers `ASK_DATA`, the route tools on v1 and live, the email tools, admin and setup, and (as you said "everything") `TIER3_APPROVE` and `WIN_BACK` in the demo profile. `TIER3_APPROVE` there is the demo client's resource; it does not change who merges in this repo (AGENTS.md "Merge authority": Ely).
- **Who gets context answers on v1:** whoever holds `ASK` (the admin role confers it): you and Steven. Marcus (member) does not.
- **Who sees routes on v1 and live:** you and Steven, both dispatchers (`ROUTING_ALL_CREWS`); no crew leads. DEP-024 closes with that.
- **SQLsmith documents query rules and business logic** as a living, signed canon (D11, Story 19.6), before Ask's flow is built.

**Gate items for you** (each has a recommended default; `approve plan brightside-v1` accepts all of them; run mode, so this is every open question up front):
1. **v0 and v1 share one set of notes** (D6). Recommended: approve.
2. **Build requests from a hub that sees data or context.** The summary call already sends no business context (`withContext: false`), so v1 may post (D12). Recommended: approve.
3. **Appointment emails on the live hub:** reminders and change notices to the mock email tool, through the approval step (D14, D14a). Approving signs **GRD-010** as worded in D14. Recommended: approve.
4. **When Story 15.6 runs.** It is unblocked once you sign GRD-002 and GRD-007 in 18.1. Recommended: its own PR right after 18.1.
5. **What production turns on** (architect P2-11c). Recommended: 15.6 adds prod to the two existing route modules on `/brightside` (Plan a route, Route map) only. Every new route screen (Customer cancellation, Crew out, Add a stop) and every v1 copy stays dev-only until its own live check passes, then a one-line PR each turns it on. Copies never inherit production.
6. **The five routing truths** in `data.md` stay `pending`. Say "sign the routing truths too" and 18.1 signs them (12 truths). Recommended: keep them pending. Ask never uses a pending truth.
7. **Template-wide additions every fork receives** (architect P2-11b). Each is off unless a fork configures it, except one:
   - the hub file's `notes` field (off unless set);
   - the profile's `ask` block (no block: Ask never writes a query);
   - `checkSql`'s `allowedTables` option and the DuckDB-parser check (used only by Ask's query path);
   - the query-writing prompt mode (`write_query`, only with an `ask` block and signed query rules);
   - the `query-rule` blocks in `data.md`, their verify check and `npm run query-rules` (no rules: nothing runs);
   - the route row source into approval-write (only for a module that declares it);
   - the new routing-map screens (only when a manifest names them), CSV uploads (wherever Add context is);
   - **on by default:** `mayPostBuildRequest` no longer refuses a hub that sees data or context, so a fork hub with a Request a tool module and data can post. The release notes say so.
   Recommended: approve all.
8. **Seed query rules signed by this approval** (D11). The seed rules only restate MET rules you already signed, and each must pass its verify check against a signed truth. Recommended: the gate approval signs them (recorded as Ely Potter, the gate date); any other rule waits for you or Steven.

**In short:**
1. Three slash commands, one bot. `/brightside-v0` is the blank bot you teach (now with CSV files and a demo pack). `/brightside-v1` knows the company, keeps what you taught v0, runs four named route skills, and answers data questions from signed query rules with a checked, read-only query. `/brightside` is the full hub, and it gains appointment emails as the finale.
2. Ely Potter replaces the fictional Dana Reyes everywhere she is a person, and signs off every rule card. Steven gets the same access as you everywhere.
3. Sixteen stories. Thirteen are T3. One step from you before the v1 live check: the `/brightside-v1` slash command. Before each demo: `npm run verify` (Ask needs a recent pass).

## The three stages (Ely's decisions, 2026-10-31)

| Stage | Command | What it is | Demo point |
|---|---|---|---|
| v0 | `/brightside-v0` (built) | A blank bot. You import context (typed, PDFs, photos, and now CSVs) and it answers questions from it | "It knows nothing, until you teach it" |
| v1 | `/brightside-v1` (new) | Company context, the database and the rules, plus the route skills and an Ask that runs safe queries | "Now it works on your real data, inside your rules" |
| live | `/brightside` (exists) | The full hub, plus appointment emails | "And it acts, with your approval" |

## Decisions Ely made (2026-10-31, not reopened)

- [x] Run mode.
- [x] **Dana does not exist.** Ely Potter replaces Dana Reyes as the owner and sign-off of the four context files, as the profile's admin user (same Slack identity, same admin role, new name), and in docs, open ledger DEP rows and rule-card owners. Sign-offs are recorded as Ely Potter on 2026-10-31. Past records that say "Ely as Dana Reyes" stay as history, with a note.
- [x] **Ely signs off the rules.** Every draft rule card becomes approved: GRD-002, GRD-007 and GRD-008. GRD-008's edge cases: a stand-in lead counts as the lead for that day; a member present for part of the day counts as present.
- [x] v0's demo flow: walk the template hub, show it can't answer, import a few PDFs and CSVs, then ask 3 to 5 specific questions it now answers.
- [x] v1 keeps what v0 was taught, reads the actual database, has the route function as named skills, and **Ask answers deeper data questions by running queries (Option B, approved).**
- [x] **Steven has everything Ely has, on every hub, always.** Any grant to Ely is granted to Steven in the same change.
- [x] **SQLsmith documents query rules and business logic**, signed, before Ask's queries are built.
- [x] **The live hub's "wow":** draft emails to customers about their appointment: a reminder, and a change notice when it moved.
- [x] The `/brightside-v1` slash command is added by Ely.

## What the code has today

Read on `main` at `71027d7`.

| What | Where | What it means for this plan |
|---|---|---|
| Hub files and `sees` | `examples/brightside/app/hubs/*.json`, `kit/runtime/schema/hub.schema.json` (T3 floor), `kit/runtime/sees.js`, `kit/runtime/slack/hub-view.js` (T3 floor) | v1 is `["context", "data", "rules"]`, like `/brightside`. No change needed for that |
| One hub per module | `kit/runtime/registry/index.js` `loadModules`: `id` equals the folder name, `hub` is one id | A tool on two hubs is two folders. The fork guide (step 8) already says so |
| Route modules | `modules/route-planner` (Plan a route, `screen: "route-editor"`) and `modules/routing` (Route map), `routing-map`, resource `ROUTING_ALL_CREWS`, `environments: ["dev"]`, adapters re-export `app/routing/adapter.js` | A copy on v1 is a manifest plus a one-line adapter. Routing maps, adapters and sessions are already per hub |
| Routing engine | `kit/runtime/routing`: `optimizeDay`, `placeOrphans` (crew out), `fillGap` (top 5 for a cancelled slot), `evaluateOrder` | Optimize, crew out and gap fill exist, but only for what the data holds. "Add a stop" does not exist |
| Knowledge store | `kit/runtime/knowledge/store.js` (T3 floor): per hub, typed 3,000, file 6,000, hub 15,000 characters and 20 entries | Per hub today |
| Uploads | `kit/runtime/slack/files.js` (T3 floor) `READABLE`: pdf, images, txt, md; office files refused (DEP-036) | No CSV |
| Readiness and status | `knowledge/readiness.js` (`approvedRules` counts `- status: approved` cards only while `guardrails.md` is signed), `summary.js`, `registry/status.js` | Signing changes the strip on every hub that sees rules. No code change |
| Ask | `archetypes/ask/index.js`: sorts into module, data, context, other; data tools are scoped-pull and approval-write only; with data and rules ready and no tool: "There's no tool for that yet." | Never runs SQL today |
| Build requests | `slack/channel.js` (T3 floor) `mayPostBuildRequest` refuses hubs that see `context` or `data`; the summary call is `withContext: false` | Request a tool would be "not on this hub" on v1 |
| SQL guard and runner | `kit/runtime/sql` `checkSql` (tokenizer; forbidden columns by bare name; `analyseRelations` at `index.js:286-385` tracks CTE names without scope), `kit/runtime/data` (read-only, 30 s, `execute()` re-checks SQL) | The base for D10. No table allow-list; a nested `WITH` can shadow a table (architect P1-2) |
| Data canon | `profiles/brightside/context/data.md`: Terminology, Grain notes, Join patterns, MET-001 to MET-007, truth blocks | The home for signed query rules (D11) |
| Email tool | `examples/brightside/app/connectors/email` (mock outbox): `createList`, `addContacts`, `pushList`; a contact is exactly `{ external_ref, email, first_name }` | No message body. D14a adds one write |
| Approval writes | `kit/runtime/archetypes/approval-write/**` (T3 floor): rows only from a scoped-pull run record; `engine:write-path` keeps connector writes there | D14a adds a route row source. Issue #92 is closed |

## Design decisions

### D1. Ely replaces Dana: what changes, what stays as history

**Changes (living files):**
- `profiles/brightside/profile.yml`: the user `dana` becomes `id: ely`, `name: Ely Potter`, `role: admin`, the same `identities.slack` (`U0CB6HDBBQX`) and the same grants. The fictional `github: dana-r` is dropped (no code reads it). **Steven** (`steven`, admin) gains the same grants: `TIER3_APPROVE`, `WIN_BACK`, `ROUTING_ALL_CREWS` (the plan-wide rule). The comment on Steven says so.
- The four context files: frontmatter `owner: Ely Potter`, `signed_off: 2026-10-31`, `signed_off_by: "Ely Potter (2026-10-31)"`, `updated: 2026-10-31`; every rule-card and truth `owner` becomes Ely Potter (the routing truths stay pending, gate item 6). Each file's header gains: "Until 2026-10-31 these files named a fictional owner, Dana Reyes, played by Ely; lines that say 'Ely as Dana Reyes' are kept as history."
- Open DEP rows in `docs/ledger.md` (D2).
- Code comments and tests: `examples/brightside/app/routing/adapter.js`, `crews.sql`, `app/routing/__tests__/adapter.test.js`, `examples/brightside/test/*.test.js`, `examples/brightside/test/fixtures/demo-profile.yml` (the fixture user becomes `ely`, Slack id `U0FIXTUREELY`; a fixture Steven with the same grants), `examples/brightside/fixture/__tests__/validate.test.js`, `test/unit/truths.test.js`, `test/unit/runtime-llm.test.js`, `test/unit/connector-contract.test.js`.
- Living docs: `docs/runtime/demo-script.md`, `docs/runtime/routing-map.md`, `docs/runtime/map-check.md`, `docs/HANDOFF.md`, `docs/planning/team/steven-onboarding.md`, `docs/PLAN-v1.md`'s profile example.
- `kit/templates/context/data.md`: its example names no person ("owner: <the owner's name>"), because a fork copies it.

**Stays as history** (a note where read, no rewrite): closed plans (`plan-epic-9.md`, `plan-epic-10.md`, `plan-brightside-v0.md`, `plan-hub-status-menu.md`), `epics-routing.md`, `architecture-routing.md`, `docs/planning/specs/spec-routing/**`, `docs/ledger/builds/`, closed DEP rows, retros, and `docs/reference/**` (never edited). `architecture-routing.md` and `epics-routing.md` get one dated note at the top.

**Check:** after 18.1, `grep -rn "Dana" --exclude-dir=node_modules .` lists only the history files and the notes; 18.1's PR lists them.

### D2. The rules are signed off, and what that closes

`guardrails.md`: every card's `- status:` line is exactly `approved` (the parser counts nothing else), with history in an `- approval:` line ("approved by Ely Potter on 2026-10-31; earlier drafts: …"). The "pending", "draft" and "for Dana's sign-off" words in GRD-002 and GRD-007 become past tense. The header says all eight cards are approved.

**GRD-008, settled:** `edge_cases` becomes "A stand-in lead counts as the lead for that day. A member present for part of the day counts as present. Brightside's data has neither (no stand-in field; `staff_absences` holds whole days only), so the adapter needs no change; a fork whose data records either must map it this way." `crews.sql` and `adapter.js` comments: "GRD-008, approved 2026-10-31". No logic change.

**Eight rule cards** (GRD-001 to GRD-008), so the strip counts 8 rules.

**DEP rows** (in `docs/ledger.md`, flipped in 18.1's PR):

| Row | Today | After 18.1 |
|---|---|---|
| DEP-025 | Dana signs GRD-002's map-image rule (street-map wording) | **closed:** "Signed by Ely Potter on 2026-10-31 (plan brightside-v1, Story 18.1): GRD-002's map image and street-map wording approved as written by Story 15.11. Unblocks Story 15.6." |
| DEP-028 | Dana re-signs GRD-002 with the coordinate columns, and confirms the crew-out rule | **closed:** "Signed by Ely Potter on 2026-10-31 (Story 18.1): GRD-002's coordinate columns approved; GRD-008 approved, with a stand-in lead counting as the lead and a member present for part of the day counting as present." |
| DEP-032 | Dana signs the Office and distance additions to GRD-002 and GRD-007's Office exception | **closed:** "Signed by Ely Potter on 2026-10-31 (Story 18.1): the Office marker, the route's total km and GRD-007's Office exception (with its Columbus and off-water lines) approved. With DEP-025, unblocks Story 15.6." |
| DEP-029 | Ely approves the tile fetch for the template; Dana for Brightside through DEP-025 | **closed:** "Template half approved at the routing-streetmap gate (Stories 15.7 to 15.11 built after it); Brightside half signed with DEP-025 on 2026-10-31." |
| DEP-024 | Dana's routing audience | **closed:** "Ely Potter decided on 2026-10-31: the demo's dispatchers are Ely Potter and Steven Auslander (both hold `ROUTING_ALL_CREWS`); no crew leads. The crew-lead view stays tested on fixtures only." |
| DEP-034 | Ely, then Dana Reyes | stays **open**, owner **Ely** |

Each changed row keeps its id and its history ("was: Dana Reyes (via Ely)").

### D3. CSV files in Add context

Read as text, never summarised.
- **Why.** The demo asks for exact figures; a summary loses them, and summarising rows costs an AI call per upload.
- **Where.** `kit/runtime/slack/files.js` (T3 floor) adds `csv: { kind: 'csv', format: null, mediaType: 'text/csv' }` to `READABLE`, downloaded through the text path (`text/*` or `application/octet-stream`).
- **Checks before storing,** in a new `readCsv(bytes)` beside `readText`, with no dependency: UTF-8 only, a leading BOM dropped, no NUL byte; RFC 4180 parsing (quoted fields, `""`, CRLF or LF), an unterminated quote refused; a header row, then **at most 200 data rows** and **30 columns**, every row with the header's column count; stored as normalised text (LF), so it must fit the store's **file cap of 6,000 escaped characters**. Over any cap: "That CSV is too big for a note: at most 200 rows, 30 columns and about 6,000 characters. Keep the rows you need, or split it."
- **Kind.** The entry stays `kind: file`, `file.type: text/csv`, inside the usual escaped `<added_context>` wrapper.
- **The screen** lists ".csv" and adds: "Don't upload personal details (emails, phones, addresses): everyone who can use Ask here can read them, and they are sent to the AI." After the upload: "Here's what I took from <title>: <N> rows, <M> columns" and the first 1,500 characters.
- **Not changed:** `.xlsx` stays refused with "save it as a PDF first"; DEP-036's text gains "or a .csv for a sheet".

### D4. The v0 demo pack

New folder `examples/brightside/demo-pack/`, built by `npm run demo-pack` (`build.js`) from the fixture, so every figure agrees with the data. The built files are committed.

| File | What it holds | Source |
|---|---|---|
| `price-list-2026.pdf` (1 page) | Every package and add-on with its price | `packages`, `add_ons` |
| `service-policies.pdf` (2 pages) | Arrival windows (morning, afternoon), 24-hour notice to reschedule (no fee: the data has none), what each package includes, how a crew-out day is handled (GRD-008's words) | written; windows from `visits.arrival_window` |
| `zone-billing-2026-09.csv` (5 rows) | Zone, invoices issued, billed $, **cash received in September** $ | the fixture by the MET definitions; zone is the client's zone (`clients.zone_id`, via `invoices.client_id` for billed and `payments → invoices → clients` for cash). Totals 36,402,350 and 35,018,640 cents, matching `billed-revenue-2026-09` and `paid-revenue-2026-09` |
| `complaints-2026-09.csv` (about 40 rows) | Date, zone, crew name, category, resolved yes/no | synthetic, seeded; September 2026, real zones and crews, **no client names, emails or addresses** |

- The PDFs come from a small hand-made PDF writer (text only, no dependency).
- **Sizes:** the four extract to at most about 11,000 characters, under the hub's 15,000.
- **Determinism:** the same fixture builds the same bytes.
- **No ties** (SQLsmith P3-14): `build.js` checks that questions 3 and 4 below each have a single top answer, and fails the build otherwise (the complaints seed is chosen so it holds).

**The v0 question script** (expected answers printed by `build.js`, so the doc and the files can't drift):
1. "How much is a deep clean, and what does the eco add-on cost?" (price list)
2. "How much notice does a customer need to give to reschedule?" (policies: 24 hours, no fee)
3. "Which zone billed the most in September, and how much cash did we receive from that zone in September?" (zone billing CSV)
4. "Which crew had the most late-arrival complaints in September?" (complaints CSV)
5. "How many complaints in September are still unresolved?" (complaints CSV)

Before the import, question 3 is the "it can't answer" moment.

### D5. The v1 hub and its menu

New `examples/brightside/app/hubs/brightside-v1.json`:

```json
{ "id": "brightside-v1", "command": "/brightside-v1", "name": "Brightside v1",
  "description": "Open the Brightside v1 menu", "sees": ["context", "data", "rules"],
  "notes": "brightside-v0",
  "welcome": "Brightside on your real data: it knows the company, follows its rules, and plans routes." }
```

Folder copies with their own ids:

| Folder | Label | Archetype | Resource | Group |
|---|---|---|---|---|
| `v1-route-optimize` | Optimize a route | routing-map, `screen: "route-editor"` | `ROUTING_ALL_CREWS` | Routing |
| `v1-route-cancellation` | Customer cancellation | routing-map, `screen: "cancellation"` | `ROUTING_ALL_CREWS` | Routing |
| `v1-route-crew-out` | Crew out | routing-map, `screen: "crew-out"` | `ROUTING_ALL_CREWS` | Routing |
| `v1-route-add-stop` | Add a stop | routing-map, `screen: "add-stop"` | `ROUTING_ALL_CREWS` | Routing |
| `v1-route-map` | Route map | routing-map (four views) | `ROUTING_ALL_CREWS` | Routing |
| `v1-ask` | Ask | ask | `ASK` | — |
| `v1-build-request` | Request a tool | build-request | `BUILD_REQUEST` | — |
| `v1-add-context` | Add context | add-context | `ADD_CONTEXT` | Setup (engine) |
| `v1-data-sources` | Data sources | data-sources | `DATA_SOURCES` | Setup (engine) |

- Every v1 route module ships `environments: ["dev"]` (gate item 5). Adapters re-export `../../routing/adapter`. Skills use `verb: "Run"`; Route map keeps View.
- `/brightside` and `/brightside-v0` are untouched by Epic 19.
- **Why T3** (architect P2-10): this hub puts `org.md` and `data.md` in front of `ASK` holders on a new command.

### D6. v0's notes come across: one shared set of notes

**Chosen: v1 uses v0's notes store** (hub field `notes: "<hub id>"`), over a copy (stale mid-demo) and over reading both stores (two caps could exceed the prompt limit).
- **How.** `hub.schema.json` gains optional `notes`. `hub-view.js` builds `knowledge` from `knowledge.forHub(hub.notes || hub.id)`; `llm.forHub({ id, sees, notes })` reads the same store. The store's layout, caps and queue are unchanged: one folder (`brightside-v0/`), 20 entries, 15,000 characters.
- **The prompt still fits:** profile context (about 18,000) plus shared notes (at most 15,000) under 40,000.
- **Why it stays safe.** `sees` still decides what each hub gets from the profile: v0 never sees `org.md`, `data.md`, data or rules. Boot refuses a `notes` link unless the target hub exists and has no `notes` of its own (no chains or loops), and every `ask`, `add-context` **and `data-sources`** module on both hubs uses the same resource keys (architect P3-15), so the same people read, write and list the shared notes. Each failure names the hub file and the field.
- **Both ways:** a note added on v1 shows on v0. Both Add context screens say "Shared with Brightside v0 / v1"; Data sources lists "Added context (shared with <hub>)". Ask's query writer never reads notes (D10).
- **Reset for the next demo:** remove the notes on either hub.

### D7. The database

v1 sees `data`, so it gets `/brightside`'s runner (the local DuckDB fixture today, MotherDuck when the profile says). Data sources on v1 adds two lines (19.3, 19.6): "Rule cards approved: N" (`detail.rules.approvedRules`) and "Query rules signed: N" (D11).

### D8. The route function as named skills

| Skill | What exists | What is new |
|---|---|---|
| **Optimize a route** | Plan a route's editor (`editor.js`): crew, day, Office start, Optimize, Reset, hand moves, rule breaks, drive and km | Nothing: a copy on v1 |
| **Customer cancellation** | `fillGap` and the Gap fill view, only for visits the data shows cancelled | A **what-if**: crew and day, then the visit that cancels (a select of that day's stops: time and client name, never an address). The adapter's new `gapFor({ day, crewId, stopId, scope })` treats that stop as cancelled, reusing the gap candidate code; the view shows the top 5 with reasons; **Fill with #n** shows the new day in the editor |
| **Crew out** | `placeOrphans` and the Route change view, only for crews the data shows out | A **what-if**: day and crew, **Mark out for the day**; the adapter returns the input with that crew `available: false`. A crew already out in the data says so and shows it directly |
| **Add a stop** | `evaluateOrder` | New: in the editor, **Add a stop**: a client (`external_select` on client names, at most 20 results, **clients of the crew's zone, `clients.zone_id`**, never an address), a length (30 to 240 minutes, step 15) and a window (any, morning, afternoon). New pure `insertStop(input, stop, { travel, rules, returnToBase })` in `kit/runtime/routing/insert.js`: the cheapest position on this crew under the AD-R5 tuple, and the two cheapest other crews of the zone. The stop joins the order marked ➕. Nothing is saved |
| **Route map** | The four views | Nothing |

- `module.schema.json`'s `screen` enum gains `cancellation`, `crew-out` and `add-stop`. The same scope (AD-R17, `audience.js` unchanged), session, map files and 20-minute deletion as today.
- The `external_select` needs a `block_suggestion` listener in `hubs.js`; it re-checks access and scope before any read. No new Slack scope.
- **Names:** the cancellation select and the client search show client names, read outside `audience.js`, so 19.4 and 19.5 are T3 (architect P2-10). Reads use `clients.first_name`, `last_name`, `clients.zone_id` and `properties.city`; never `street_address`, `postal_code` or a coordinate.
- **Demo days** (as_of 2026-09-30): Optimize, crew 4 on 2026-10-01 (S1, 134 minutes booked); Customer cancellation, crew 2 on 2026-10-02 (S2, property 762 top); Crew out, crew 7 on 2026-10-03 (S3: 5 in-zone, 1 cross-zone, 0 unplaced).

### D9. Who sees routes

The registry forces every route module's resource to `routing.audience.all_crews`, so v1 and live show routes to the same people: `ROUTING_ALL_CREWS` holders, **you and Steven**; crew leads would see their own crew (none listed). Ask never names a tool the person can't open.

### D10. Ask on v1 runs safe queries (Option B, approved)

Stories 19.7 (the guard) and 19.8 (the flow), both T3, after 19.6 (the signed query rules, D11).

**When Ask runs a query** (all must hold; else the refusal line below):
1. the hub sees `data` and `rules`, readiness says both ready, and the profile has an `ask` block;
2. the person holds **`ASK_DATA`** (`admin_grantable: false`; you and Steven), checked at submit and before the run;
3. **the truth gate, fail closed** (architect P2-6, SQLsmith P2-9): every signed truth's last `npm run verify` result on this machine is `pass` and at most 7 days old. A failed, skipped, timed-out, old or missing result (never run) refuses, with the readiness line and "Run `npm run verify`, then ask again.";
4. at least one **signed query rule** (D11) covers the question.

**Two paths, both from signed rules only:**
- **The rule path (preferred):** the question fits one signed rule. The AI only fills that rule's declared parameters (each type-checked: a date within the data, a zone from `zones`); the engine runs the rule's **reviewed SQL**. This is the scoped-pull pattern, so no AI-written SQL runs.
- **The composed path:** the question combines signed rules (a breakdown, a filter). The AI writes SQL using only the signed rules' definitions, SQL and traps; the guard checks it; the answer is labelled "composed from QR-001 and QR-006; not itself a signed rule".

**Truth figures** (SQLsmith P1-4): when the question is one a signed truth answers (a rule whose check names a signed truth, with the same parameters), the answer shows the figure from **the rule's own reviewed SQL**, and beside it the AI's query and its result. They are compared in raw units (cents): a query that divides by 100, or returns anything but exactly 1 row and 1 numeric column, counts as a mismatch. On a mismatch the reviewed figure stands and the answer says "The AI's own query disagreed; the figure shown is from the signed rule." A claimed `truth_id` that is unknown, unsigned or pending, or a result that is not a single number, hides the AI's result (architect P2-6).

**What the AI is given** (SQLsmith P1-3): fixed instructions; the allowed schema (tables, columns, types); the **signed** query rules' definitions, SQL, parameters, traps and question patterns; the signed Terminology and MET rule and formula lines; and the data's as-of date as "today". **No numbers:** no truth figure, no `expect`, no evidence line with a figure, no check value. **Never** `org.md`, notes or guardrails text. It returns `{ covered, rule_ids, path, params?, sql?, label (≤ 80), unit, truth_id? }`.

**The traps the prompt spells out** (SQLsmith P3-15; they live in the signed traps entry, QR-000, D11):
- `visits` holds history up to as_of; `scheduled_visits` holds dates after as_of;
- count completed visits only (`visits.status = 'completed'`) unless the question says otherwise;
- count clients with `COUNT(DISTINCT client_id)`;
- never join `payments` to `invoice_lines` (the sum multiplies);
- for "outstanding", sum payments per invoice first;
- "today" is `fixture_meta`'s `as_of`, never the clock.

**The guard (19.7)** — every check fails closed:
- **The profile's `ask` block** (schema, `kit/lib/profile`): `tables` (table → allowed columns) and `queries_per_hour` (default 10 a person). Brightside's (SQLsmith signs the final list in 19.7):

| Table | Allowed columns |
|---|---|
| `zones` | `zone_id`, `name` |
| `packages` | `package_id`, `name`, `base_price_cents` |
| `add_ons` | `add_on_id`, `name`, `price_cents` |
| `crews` | `crew_id`, `zone_id`, `name` |
| `clients` | `client_id`, `zone_id`, `created_on` |
| `properties` | `property_id`, `client_id`, `city`, `home_type`, `square_feet`, `bedrooms`, `bathrooms`, `has_pets` |
| `plans` | `plan_id`, `property_id`, `package_id`, `frequency`, `start_date`, `end_date`, `status`, `start_price_cents`, `price_cents` |
| `plan_price_changes` | `change_id`, `plan_id`, `effective_date`, `old_price_cents`, `new_price_cents` |
| `visits` | `visit_id`, `property_id`, `plan_id`, `crew_id`, `package_id`, `visit_date`, `status`, `arrival_window`, `scheduled_start`, `scheduled_minutes` |
| `scheduled_visits` | every column except `labour_minutes` (GRD-006, SQLsmith P3-13) |
| `invoices` | `invoice_id`, `client_id`, `visit_id`, `issued_on`, `due_on`, `total_cents` |
| `invoice_lines` | `line_id`, `invoice_id`, `package_id`, `add_on_id`, `quantity`, `amount_cents` |
| `payments` | `payment_id`, `invoice_id`, `paid_on`, `amount_cents`, `method` |
| `service_rules` | `rule_id`, `property_id`, `rule_type`, `value`, `strength` |
| `fixture_meta` | `key`, `value` |

  **Not allowed:** `staff`, `pay_rates`, `timesheets`, `crew_memberships`, `staff_absences` (staff names and ids; SQLsmith P1-1, architect P1-1) and `depots`. A test asserts no allowed column is a person-name or contact column (`first_name`, `last_name`, `email`, `phone`, `street_address`, `postal_code`, any `staff` column, any coordinate).
- **Boot refuses** an allowed table or column the data doesn't have (SQLsmith P1-2), naming it; and an allowed column whose bare name equals a hidden column's in another allowed table.
- **Columns:** every column of an allowed table that `ask.tables` doesn't list is added to Ask's forbidden set (bare-name match), on top of `sql.forbidden_columns`.
- **`checkSql` gains `allowedTables`:** every table reference must be an allowed table or a top-level CTE; refused otherwise (`table_not_allowed`), including `information_schema`, `duckdb_*` and qualified names.
- **CTEs** (architect P1-2a): a CTE may be defined only at the top level of the statement, and its name may not equal any table in the data. This closes the nested `WITH staff AS` bypass in `analyseRelations`.
- **DuckDB's own parser, second** (architect P1-2b): after `checkSql`, the engine asks DuckDB for the plan of the checked SQL (`EXPLAIN (FORMAT JSON)`, or `json_serialize_sql` if the pinned version's plan lacks column names; the builder picks the one that lists every scanned table and column, and says which) and refuses unless every scanned table and column is allowed. Any error or unknown shape refuses. This also catches a column added after boot (a republish).
- **Refused functions** (SQLsmith P2-8): `current_date`, `now`, `today`, `current_timestamp`, `current_time`, `localtime`, `localtimestamp`, `get_current_timestamp`, `epoch_ms` of the clock. "Today" comes from `fixture_meta`.
- **At least one allowed table** must be read (SQLsmith P1-3); a constant query (`SELECT 815`) is refused.
- **The run** (architect P2-4): the checked SQL, with a trailing `;` stripped, is **prepared and streamed**, never wrapped in text; at most 51 rows are read, then the stream is closed. Ask's path has **its own read-only DuckDB connection** with `memory_limit` (512 MB) and `threads` (2) set before the configuration is locked, a 10-second interrupt, and **one query at a time: a second concurrent Ask query is refused** ("Another question is being answered. Try again in a moment.", architect P3-14), never queued.
- **Errors** (architect P2-5): DuckDB's error text never reaches the person or the logs (it can hold hidden column names or values). Ask shows fixed words ("I couldn't run that query safely.") and logs the error class only.
- **Ranking** (SQLsmith P2-12): rows are labelled "not ranked" unless the outermost query has `ORDER BY` (read from DuckDB's parse); with `ORDER BY` and more than 50 rows: "the first 50 by its order".
- **Caps:** 51 rows read, 50 shown, 10 columns, 100 characters a cell, 10 seconds, one at a time, 10 query answers a person an hour.
- **AI calls** (architect P3-13): two per answer, `route_question` and `write_query`; both count against the per-person limit and the spend breaker, which still hold.
- **Logs:** module, path, rule ids, query hash, tables, row count, milliseconds, a refusal's rule or error class. Never the question, the SQL text, the label or a row.

**Show.** The engine renders the result: a single value as "*<label>:* $350,186.40" (cents to dollars, commas on counts), or a table, escaped. The AI never sees a row. **Provenance** under every answer: "From signed rule QR-003 (reviewed query)" or "Composed from QR-001 and QR-006 (AI-written, checked)", the source and as-of date, row count, tables, and **Show the query** (the SQL, escaped). Every answer ends with "Not what you needed?" and Request a tool.

**One refusal text** (SQLsmith P2-6, architect P2-8), for every data question Ask won't answer by query on a hub where data and rules are ready (no signed rule covers it, the guard refused, a hidden column was needed, or the person lacks `ASK_DATA`):

> **"The data and rules are ready, but no signed query rule covers that yet, so I won't guess. I've noted the question for the team. Press Request a tool if you need it sooner."**

The question is logged to the review queue (D11). Without the Request a tool key, the last sentence becomes "Tell <admin> if you need it sooner." The truth gate's refusal (above) is the one other text.

**What Ask says on v1:**

| Question | Example | Answer |
|---|---|---|
| A route question | "Crew 4's stops on Oct 1 zig-zag. Can you fix the order?" | "*Optimize a route* can help with that. Press Run to use it." [Run] (routing-map counts as a data tool, 19.3) |
| A covered data question | "What was paid revenue in September 2026?" | "*Paid revenue, September 2026:* $350,186.40", from QR-003, with Show the query |
| A question needing a hidden column | "List the clients with the highest unpaid balance and their emails." | The refusal text, logged |
| A context question | "What does Brightside do when a crew is out?" | Answered from `org.md`, `data.md` (stripped) and the shared notes, ending "Not what you needed?" [Request a tool] |

**GRD-009 (new card; the gate approval signs it):**

> ### GRD-009: Ask's read-only queries
> - type: access_rule
> - rule: on a hub that sees data and rules, Ask may answer a data question from signed query rules: by running a rule's reviewed SQL with parameters the AI fills, or by an AI-written read-only query composed only from signed rules. Only people granted `ASK_DATA` by name get this, and **they must be cleared for every metric the allowed tables expose, including client-level money (invoices, payments, balances): `client_id` is pseudonymous, not anonymous.** The query may read only the tables and columns the profile's `ask` block lists; names, emails, phones, addresses, coordinates, staff and pay are never readable. The SQL guard (GRD-001, GRD-002) and DuckDB's own parse both check it before it runs; it runs for at most 10 seconds, one at a time, and returns at most 50 rows. The AI never sees the result. A figure a signed truth covers comes from the rule's reviewed SQL. Not run at all unless every signed truth passed its last check within 7 days. NOT a change to any tool: tools keep their reviewed queries.
> - owner: Ely Potter
> - evidence: plan brightside-v1 D10, D11; `kit/runtime/sql` (`allowedTables`), `kit/runtime/data` (Ask's connection), `kit/runtime/archetypes/ask`; Stories 19.6 to 19.8.
> - status: approved
> - approval: approved by Ely Potter on <the gate date> (`approve plan brightside-v1`), added by Story 19.7.

GRD-005 gains (architect P3-16): "Exceptions: GRD-009 (Ask's read-only queries): the AI writes or fills in a query; it still never sees a data row. Admin notes, including uploaded PDFs, images and CSVs, are sent to the AI as context on their hub." AD-10 in `architecture-runtime.md` gains the GRD-009 exception (the scribe drafts it in 19.7).

### D11. Query rules: SQLsmith's signed canon

**Where: a new `## Query rules` section in `data.md`** (in a fork, `.aplabs/context/data.md`), chosen over a separate file. Reason: `data.md` is already SQLsmith's signed canon (Terminology, MET rules, truths), every agent loads it, and `npm run onboard -- --status` and `npm run verify` already read it. Each rule is a fenced block with the info string `query-rule`, holding YAML, the same pattern as truth blocks. `kit/runtime/llm/context.js` strips `query-rule` blocks from the context prompt, as it strips truth blocks; they reach only Ask's query writer.

```query-rule
id: QR-003
kind: metric                      # metric | traps
metric: MET-003                   # the signed MET rule or Terminology term it implements
question_patterns:
  - "paid revenue in <month>"
  - "cash received in <month>"
definition: "Cash received in the month: payments by paid_on. Never billed revenue."
sql: |
  SELECT SUM(p.amount_cents) AS paid_cents
  FROM payments p
  WHERE p.paid_on >= CAST($month_start AS DATE) AND p.paid_on < CAST($month_end AS DATE)
params:
  month_start: { type: date }
  month_end: { type: date }
grain: "one row, one number"
unit: cents
traps:
  - "never join payments to invoice_lines"
reads:
  payments: [amount_cents, paid_on]
check:
  truth: paid-revenue-2026-09
  params: { month_start: "2026-09-01", month_end: "2026-10-01" }
owner: Ely Potter
status: approved                  # draft | approved | retired
signed_off: 2026-10-31            # pending, or the date
signed_off_by: "Ely Potter"       # Ely Potter or Steven Auslander here; a named client person in a fork
```

- **Required fields:** `id` (`QR-NNN`), `kind`, `owner`, `status`, `signed_off`, `signed_off_by`; for `metric`: `metric`, `question_patterns`, `definition`, `sql`, `params` (types `date`, `integer`, `zone`, `enum`), `grain`, `unit`, `reads` and `check`. `check` names a signed truth (`truth` plus `params`), or a stated figure (`expect` plus `params`, which SQLsmith states and the Verifier's output proves in the PR). Unknown keys are refused.
- **Signed means:** `status: approved`, `signed_off` a valid date, `signed_off_by` named, and the rule's last verify result `pass`. Ask uses only signed rules; a draft, pending, failing or retired rule is invisible to it.
- **Allowed tables and columns:** the profile's `ask.tables` stays the enforced allow-list (profiles are the access source). Every rule's `reads`, and every table and column its SQL scans (DuckDB's parse, as D10), must be inside it; the loader and verify refuse a rule that reads outside it, naming the rule and the column.
- **The verify check** `query-rule:<id>` (in `npm run verify` and the end-of-turn hook): runs the rule's SQL with `check.params` through the query runner and Ask's guard, and passes when the single number equals the linked truth's `expect` within its tolerance (or `check.expect`). A rule linked to a pending truth can't pass (the routing truths stay out).
- **The traps entry,** `QR-000`, `kind: traps`, holds the six traps listed in D10, signed like any rule.
- **Seed rules (19.6),** each restating a signed MET rule, linked to a signed truth: QR-000 traps; QR-001 plans active at as_of (MET-001, truth `active-plans-at-as-of`; not `status = 'active'`); QR-002 clients total (truth `clients-total`); QR-003 paid revenue for a month (MET-003); QR-004 billed revenue for a month (MET-004); QR-005 outstanding at as_of (MET-005); QR-006 active plans by zone (MET-001 grouped by `clients.zone_id` through `properties`; check: its five rows sum to the QR-001 figure, the Verifier runs it in 19.6 and the output goes in the PR). Signed by the gate approval (gate item 8).
- **The review queue.** When Ask declines a data question (D10's refusal text), it appends `{ id, at, hub, reason: no_rule | guard | hidden_column | no_key }` and the question (at most 500 characters) to `<APLABS_VAR_DIR>/ask-queue/<client id>/<id>.json` (mode 0600, random ids, at most 200 entries; the oldest dropped and logged). Never a row, the SQL, the person's Slack id or a figure. New `kit/runtime/knowledge/ask-queue.js` (inside the `knowledge/**` T3 floor).
- **The workflow (an Orchestrator stage: "query-rule build").**
  1. `npm run query-rules -- --queue` lists the waiting questions (run by Ely, Steven or the Orchestrator on the bot's machine).
  2. The Orchestrator routes one to **SQLsmith**, which drafts a `query-rule` block (status `draft`, `signed_off: pending`) on a branch with `npm run query-rules -- --new QR-NNN --from <queue id>` (it scaffolds the block with the question as a pattern).
  3. The **Verifier** runs `npm run verify` and pastes the `query-rule:QR-NNN` result in the PR.
  4. **Ely or Steven signs it** in the PR (sets `status`, `signed_off`, `signed_off_by`); the PR is T3 (`profiles/**`, or `.aplabs/**` in a fork) and merges after review. `npm run query-rules -- --done <queue id>` clears the question.
  5. `npm run query-rules -- --status` lists every rule, its sign-off and its last check.
- **Day one in a fork** (fork guide, 19.9): the onboarder creates the `## Query rules` section with QR-000 and one rule per signed MET rule that has a truth; Ask's query mode stays off until at least one rule is signed. **The signer must be a named client person** (architect P3-17); Ely and Steven sign only for the demo client.

### D12. Request a tool on v1

The summary call already sends no business context (`withContext: false`). `channel.js`'s `mayPostBuildRequest` stops refusing hubs that see `context` or `data`; the build-request archetype asserts at call time that its summary call is `withContext: false`, and a test fails if that changes. The posted text still holds only the person's previewed words, the AI's summary of them, the hub's name and the requester. The AD-14 amendment is updated (gate item 2).

### D13. Readiness wording, the strip, the Slack app

- No readiness wording changes for the rule files. Only Ask's lines change (D10).
- **`/brightside`** for you or Steven after 18.1: "Knows: 1 source · 7 truths · 8 rules", "All 8 tools working" in dev.
- **`/brightside-v1`** after Epic 19: "Knows: N notes · 1 source · 7 truths · 9 rules", "All 7 tools working". 10 rules once GRD-010 lands.
- **`/brightside-v0`:** unchanged, except its notes include those added on v1.
- `npm run slack:manifest` adds `/brightside-v1` ("Open the Brightside v1 menu"). No new scope.

### D14. Appointment emails on the live hub

**Two kinds, fixed templates, no AI.**
- **Reminder** of an upcoming appointment.
- **Change notice:** what changed (day, arrival window or crew), what it was before, a fixed reason line by source ("we've improved the day's route", "an earlier slot opened up", "our team for that day is unavailable", "we've adjusted the day's schedule"), "Sorry for the change.", and "Reply to this email, or call us on 555-0100, and we'll find a time that suits you."
- **Why templates only:** the preview is exactly what is sent, and no customer name or appointment goes to the AI (GRD-005).

**What an email may contain** (nothing else): first name; service date; arrival window, **morning or afternoon** (the fixture's vocabulary; a suggested start before 12:00 is morning); crew name; package name; the before values; the fixed sign-off, the synthetic office phone 555-0100 (GRD-007's range) and the reply line. **Never** a street address, postal code or coordinate (GRD-002), a price, another customer, a staff name or a route's other stops.

**How a change is detected: from a route skill's result.** Route skills never save, so a list of changed visits in the data would always be empty; only the route session knows booked and suggested. Ids are **`scheduled_visits.scheduled_visit_id` throughout** (SQLsmith P1-5). The **before** values come from `scheduled_visits` (`visit_date`, `arrival_window`, `crew_id`) where `status = 'scheduled'`; the **after** values from the suggestion. A visit is changed when its date, its window (morning/afternoon) or its `crew_id` differs. A move within the same window is not a change. Reminders, which need no before and after, come from a list (a scoped pull of a day's scheduled visits).

**Limits** (architect P2-9): at most **50 emails a push** and **200 a day per hub** (counted in the outbox; over either, the preview says so and nothing is sent). Each address is parsed strictly: exactly one address, lower-cased, no display name, no comma, no whitespace, no trailing dot, and it must end in `.invalid`; anything else is refused before the outbox.

**Reminders held for absences** (SQLsmith P2-11): any visit on a crew-day that has a `staff_absences` row for a member of that crew is held, not emailed: "Held: a member of <crew> is absent that day. Check Crew out first."

**Placement: the live hub only, not v1.** The stages read as a ladder: v1 reads and suggests; live acts, with approval. Reversible (one module folder). So the live hub also gets the new route skills (Customer cancellation, Crew out, Add a stop) as copies, dev-only like the rest (gate item 5).

**The caveat on every change-notice preview:** "These routes are suggestions: nothing is saved in the schedule. Sending tells customers their visit changed, so change the booking too." A real fork sends change notices only after its scheduling system holds the change (DEP row).

**GRD-010 (new card; the gate approval signs it, gate item 3):**

> ### GRD-010: Appointment emails
> - type: exception_workflow
> - rule: the bot may draft two kinds of customer email, a reminder and a change notice, from fixed templates. Each holds only the customer's first name, the service date, the arrival window (morning or afternoon), the crew's name, the package, and for a change what it was before; never an address, postal code, coordinate, price, another customer or a staff name. They go to the email tool only through the approval step (GRD-004), after a person granted `APPOINTMENT_EMAILS` by name approves the exact text: at most 50 a push and 200 a day per hub. A change notice comes only from a route skill's result and only for a scheduled visit whose date, window or crew changed. A reminder is held for a crew-day with an absence. The mock email tool accepts only a single `.invalid` address. NOT a change to bookings: routes stay suggestions.
> - owner: Ely Potter
> - evidence: plan brightside-v1 D14, D14a; the email connector's `sendEmails` and `templates.js`; `approval-write/route-source.js`; Stories 20.1 to 20.3.
> - status: approved
> - approval: approved by Ely Potter on <the gate date> (`approve plan brightside-v1`), added by Story 20.1.

`guardrails.md`'s Write paths table gains: "Send appointment emails | Mock email tool (outbox) | approval-write preview and approval | `BRIGHTSIDE_EMAIL_OFF`, `APLABS_WRITES_OFF` | built by Epic 20".

### D14a. How the emails fit the write path (for the Connector's review)

The approval-write archetype as built pushes rows of a scoped-pull run through a connector write that takes the contract's `{ name, contacts }` (architect P1-3). The emails fit it this way:
- **`sendEmails({ name, contacts, idempotencyKey, dryRun })`**, a new write on the mock email tool, in the contract's shape. Each contact is `{ external_ref, email, first_name, kind, visit_date, window, crew_name, package_name, before_date?, before_window?, before_crew_name?, reason? }` (`external_ref` is the `scheduled_visit_id`). **The connector renders each email in its dry run** (`templates.js`), so the preview shows the exact text and apply sends what was previewed. Any other field is refused.
- **Idempotency** (perItemIdempotency): each email's key is the push's key plus the kind, the `scheduled_visit_id` and a hash of the new date, window and crew. A repeat sends nothing; a second, different change to the same visit is a new email.
- **Visit ids bound as one string:** the change-notices module's reviewed query reads first name and email with `WHERE sv.scheduled_visit_id IN (SELECT CAST(x AS INTEGER) FROM string_split($visit_ids, ',') AS t(x))`. The engine binds `$visit_ids` from the route record only, so the runner needs no change.
- **The route row source** (`approval-write/route-source.js`, new, T3 floor) is a **named, gated addition to the write path:** only a module whose manifest declares `write.source: "route"` gets it; it holds the changed visits (ids, before and after, the source skill) bound to the person and the route session for 30 minutes, and the preview consumes it. AD-15 in `architecture-runtime.md` is amended; `engine:write-path` stays green.
- **Files for 20.1 to 20.3:** `examples/brightside/app/connectors/email/connector.js`, `templates.js`, `outbox.js`; `kit/runtime/archetypes/approval-write/index.js`, `entry.js`, `preview.js`, `route-source.js`; `kit/runtime/connectors/suite.js` (the contract suite gains the new write); `kit/templates/connector.md`; the two module folders; `profiles/brightside/profile.yml`; `guardrails.md`.

### Engine changes, kept as small as the asks allow

Profile and hub config alone do the v1 hub, its menu, the route copies, who sees routes, the database and the strip. These need code:

| Change | Why config can't do it | Story |
|---|---|---|
| `.csv` in `files.js` | a new file type | 18.2 |
| hub `notes` link | v1 must see v0's notes | 19.1 |
| `mayPostBuildRequest`; Ask treats routing-map as a data tool; Data sources' counts | Request a tool and route questions on v1 | 19.3 |
| three routing-map screens, `gapFor`, the crew-out what-if | named skills | 19.4 |
| `insertStop`, Add a stop, the options listener | Add a stop | 19.5 |
| `query-rule` blocks, their loader, verify check, CLI and review queue | signed query rules | 19.6 |
| `allowedTables`, top-level CTEs, the DuckDB-parse check, Ask's connection, the `ask` block, `ASK_DATA` | Option B's guard | 19.7 |
| Ask's two paths, rendering, provenance, truth figures | Option B | 19.8 |
| `sendEmails`, templates, the route row source | appointment emails | 20.1 to 20.3 |

## The stories

Stories are PRs. **S** about half a day, **M** about a day, **L** up to two days.

### Epic 18: the v0 demo, Ely, and the rules

| Story | Size | Tier | You will see |
|---|---|---|---|
| 18.1 Ely replaces Dana; Steven matches Ely; the rules are signed off | M | **T3** | Data sources and the strip on `/brightside`: "signed off 2026-10-31 by Ely Potter", 8 rules; DEP-024, 025, 028, 029, 032 closed |
| 18.2 CSV files in Add context | M | **T3** | Add context takes a `.csv` |
| 18.3 The v0 demo pack and script | M | T1 | Two PDFs and two CSVs; the v0 script |

### Epic 19: `/brightside-v1`

| Story | Size | Tier | You will see |
|---|---|---|---|
| 19.1 Hubs can share notes | M | **T3** | Tests: one store on two hubs |
| 19.2 The v1 hub, its tools and the Slack mirror | M | **T3** (computes T1; raised, architect P2-10) | `/brightside-v1` with Optimize a route, Route map, Ask, Request a tool, Setup |
| 19.3 Ask and Request a tool on a hub with data | M | **T3** | Route questions point to the skills; Request a tool posts from v1; Data sources' counts |
| 19.4 Customer cancellation and Crew out | L | **T3** (raised: names in the visit select) | Two what-if skills on v1 |
| 19.5 Add a stop | L | **T3** (raised: client-name search) | Add a stop on v1 |
| 19.6 Query rules: SQLsmith's signed canon | M | **T3** | `## Query rules` in `data.md` with seven signed rules; `npm run query-rules`; the review queue |
| 19.7 The query guard | L | **T3** | Tests: the guard, the parser check; GRD-009 |
| 19.8 Ask answers with a query | L | **T3** | Ask on v1 answers covered data questions with provenance |
| 19.9 v1 docs, demo script and live check | S | T0 | The v1 script and live check |

### Epic 20: appointment emails on the live hub

| Story | Size | Tier | You will see |
|---|---|---|---|
| 20.1 The email tool sends appointment emails | M | **T3** | Tests: templates, the address parse, caps; GRD-010 |
| 20.2 Appointment reminders | M | **T3** | Customers → Appointment reminders on `/brightside` |
| 20.3 Change notices from a route skill; the skills on `/brightside` | L | **T3** | Notify affected customers after a route result |
| 20.4 Live demo script and live check | S | T0 | The live script ending with the emails |

**Tiers** (computed 2026-10-31 per path with `APLABS_PROFILE=$PWD/profiles/brightside/profile.yml node kit/lib/tier <path>`; recomputed on each story's full file list before it starts; a tier only goes up):

- 18.1: `profiles/brightside/**` T3; examples, tests, `kit/templates/context/data.md` T1 or T0.
- 18.2: `kit/runtime/slack/files.js` T3 (engine floor); `archetypes/add-context` T1.
- 18.3: `examples/brightside/demo-pack/**`, `package.json` T1; docs T0.
- 19.1: `hub.schema.json`, `slack/hub-view.js`, `llm/index.js`, `knowledge/store.js` T3 (engine floors).
- 19.2: computes T1 (`examples/**`); raised to T3: it shows `org.md` and `data.md` to `ASK` holders on a new command.
- 19.3: `slack/channel.js` T3 (engine floor).
- 19.4: `archetypes/routing-map/**` and `routing/**` T2; raised to T3: the visit select shows client names outside `audience.js`.
- 19.5: `routing/insert.js`, `editor.js` T2; `hubs.js` T1; raised to T3: the options listener reads client names outside `audience.js`.
- 19.6: `profiles/brightside/context/data.md` T3; `kit/runtime/llm/context.js` and `kit/runtime/knowledge/ask-queue.js` T3 (engine floors); `kit/lib/query-rules/**`, `scripts/query-rules.js`, `kit/lib/verify/**` T1.
- 19.7: `kit/runtime/sql/**`, `kit/runtime/data/**`, `profiles/_schema/**`, `kit/lib/profile/**`, `profiles/**` T3.
- 19.8: `kit/runtime/llm/**` T3; `archetypes/ask/**`, `messages.js` T1.
- 19.9, 20.4: T0.
- 20.1: `kit/runtime/connectors/suite.js` T3 (engine floor), `profiles/**` T3; the connector computes T1.
- 20.2, 20.3: `kit/runtime/archetypes/approval-write/**` T3 (engine floor), `profiles/**` T3.

Every story gets an architect design review. 19.6 to 19.8, 20.2 and 20.3 get SQLsmith on every query and prompt. 20.1 to 20.3 get Connector on D14a.

## Acceptance criteria

Every story, in addition to what is listed:
- `npm run check && npm test` pass; `npm run test:slow` too where `AGENTS.md` lists the path.
- Tests read client specifics from fixtures, except the example's own canon tests that already read `profiles/brightside/`.
- A test that fixes the time freezes every clock (the store's TTLs, `added_at`, the AI breaker, Ask's hourly limit and the truth gate's 7 days, the email day cap, route sessions).
- The Slack, Anthropic and email fakes reject what the real systems reject, for every field the story sets; each story names the fields it added.
- Each new or changed Slack screen lists every way out (Back, the X, an error, an expired trigger, a click from an old message, closing while slow work runs), each tested.
- Every ack returns within 3 seconds.
- **Any grant to Ely in the profile is granted to Steven in the same change;** a test in `examples/brightside/test/profile.test.js` asserts their grants are equal.
- No status glyph outside `vocabulary.js`; no menu button says "Open".
- Nothing is reworded to quiet a check.
- Steps only the live app or CI can run are named as untested.
- Each story updates the docs that describe what it changed.
- No reference-client name, path, Slack id or data outside `docs/reference/`. No "Dana" in new text.

### Story 18.1: Ely replaces Dana; Steven matches Ely; the rules are signed off

- D1's changes and history notes; the PR lists what `grep -rn Dana` still finds.
- `profile.yml`: user `ely` (Ely Potter, admin, `U0CB6HDBBQX`, grants `TIER3_APPROVE`, `WIN_BACK`, `ROUTING_ALL_CREWS`); `steven` with the same grants. `validateProfile` passes. The equal-grants test.
- The four context files signed as D1 says; `npm run onboard -- --status` shows each signed by Ely Potter on 2026-10-31.
- `guardrails.md`: eight cards `approved`; GRD-008 as D2; `countApprovedRules` is 8 (test).
- `data.md`: owners Ely Potter; seven signed truths unchanged; routing truths pending.
- DEP rows as D2's table; `node --test test/unit/ledger*.test.js` passes.
- The example tests renamed and passing; `docs/runtime/routing-map.md`: the audience is Ely and Steven.

### Story 18.2: CSV files in Add context

- D3 in full. Tests, one each: 200/201 rows; 30/31 columns; 6,000/6,001 escaped characters (a `<` counts 4); a ragged row; an unterminated quote; quoted commas and line breaks kept; a BOM dropped; invalid UTF-8; a NUL; header only; CRLF stored as LF; a JSON content type; `.xlsx` refused.
- The injection test runs on a CSV cell saying "ignore your instructions".
- The Slack fake's `file_input` accepts `csv`.
- Ways out: each refusal above, the hub's notes full, closing while it is read.
- Untested until the live check: a real `.csv` through `file_input`.

### Story 18.3: the v0 demo pack and script

- D4 in full. Tests: each PDF sniffs as `pdf` with its page count; each CSV passes `readCsv`; zone billing totals equal the two truths' planted targets; the "cash received" column is labelled so; no client name, email or street in the complaints CSV; the four fit under 11,000 escaped characters; two builds are identical; questions 3 and 4 have no tie; each expected answer appears in the files.
- `docs/runtime/demo-script.md` gains "Stage 1: v0".

### Story 19.1: hubs can share notes

- `hub.schema.json` `notes`; boot refusals as D6 (no hub, itself, a chain, different `ASK`, `ADD_CONTEXT` or `DATA_SOURCES` keys), each naming the file and field.
- `hub-view.js` and `llm.forHub` use the shared store; the 40,000 limit unchanged.
- Tests: a note added on either hub is listed and prompted on both, removed from both; a third hub never sees it; the blank hub still gets no profile context; caps count the shared set once; two adds at once from the two hubs run one at a time.

### Story 19.2: the v1 hub, its tools and the Slack mirror

- `brightside-v1.json` and the folders `v1-route-optimize`, `v1-route-map`, `v1-ask`, `v1-build-request`, `v1-add-context`, `v1-data-sources`, all route modules dev-only.
- `slack-manifest.json` regenerated; `--check` passes; three commands, seven scopes.
- Tests on fixture copies: the v1 menu for a person with the routing key (Routing, Tools, Setup) and without it (no Routing); `/brightside` and `/brightside-v0` menus unchanged (block snapshots).
- Ways out of the v1 menu, each tested.
- Untested until the live check: the live `/brightside-v1` command.

### Story 19.3: Ask and Request a tool on a hub with data

- `mayPostBuildRequest` as D12, with the `withContext: false` assertion test and posting tests from a hub that sees all three; the AD-14 amendment.
- Ask: routing-map counts as a data tool (gated by readiness). Tests: a route question sorted `module` and `data` both get the skill's button; a person without the routing key gets the refusal text.
- Data sources: "Rule cards approved: N" (8 on the fixture; 0 while unsigned).
- **Ways out, each tested** (architect P2-12): from Ask's **Run** button into a route skill, then Back (returns to the menu, as any pushed tool view); the Ask answer view expired before the click (the existing "open it from the menu" fallback); Request a tool from v1's Ask: preview, Post, Edit, Cancel, Slack refusing (`not_in_channel`) and Try again, a double Post.

### Story 19.4: Customer cancellation and Crew out

- `screen` gains `cancellation`, `crew-out`, `add-stop`.
- Customer cancellation as D8. Test: crew 2 on as_of+2, afternoon stop cancelled → property 762 first (S2); a day with no candidates says so.
- Crew out as D8. Test: crew 7 on as_of+3 → 5 in-zone, 1 cross-zone, 0 unplaced (S3); a crew out in the data says so.
- Scope tests per AD-R17; the visit select lists only visible stops.
- The new SQL is checked against the forbidden columns.
- Folders `v1-route-cancellation`, `v1-route-crew-out`, dev-only.
- Ways out, each tested: Back, the X, Change crew or day, an expired session, no stops, the data unavailable, the map not ready (Why?), a click from someone else's view.

### Story 19.5: Add a stop

- `insertStop`, pure, exported through `kit/runtime/routing` and `kit/runtime/sdk`; `engine-boundary.test.js` passes. Tests: cheapest position; an impossible window (placed last, flagged); the two cheapest other crews; identical output for the same input.
- Add a stop in the editor; the client search uses `clients.zone_id`; the options listener re-checks access and scope before any read (a search without access returns no options).
- The Slack fake gains `external_select` and `block_suggestion`, rejecting over 100 options and option text over 75 characters.
- Folder `v1-route-add-stop`, dev-only.
- Ways out: Back to the day, the X, no client found, the search failing, the session expired, a stop added then removed.

### Story 19.6: query rules, SQLsmith's signed canon

- The `query-rule` block format, fields and refusals as D11; a loader in `kit/lib/query-rules`; `context.js` strips the blocks from the context prompt (test).
- The verify check `query-rule:<id>`; a rule reading outside `ask.tables` or linked to a pending truth fails it (tests). If 19.7's `ask` block hasn't merged, the check uses a fixture allow-list and the story says so.
- `npm run query-rules -- --queue | --new QR-NNN --from <id> | --done <id> | --status`.
- `kit/runtime/knowledge/ask-queue.js`: writes as D11, caps and modes; a test plants an entry with a row-like value in the question and checks nothing else is stored.
- The seven seed rules (QR-000 to QR-006) in `data.md`, drafted by **SQLsmith**, run by the **Verifier** (its output, including QR-006's five rows summing to the QR-001 figure, in the PR), signed per gate item 8.
- Data sources: "Query rules signed: N".
- The Orchestrator stage "query-rule build" written into `docs/orchestrator/DESIGN.md` and `AGENTS.md`'s stage list.

### Story 19.7: the query guard

- `checkSql(sql, { forbiddenColumns, allowedTables })` with `table_not_allowed`, top-level-only CTEs and no CTE named like a data table. Tests: `information_schema.columns`, `duckdb_tables()`, `main.staff`, `"staff"`, a subquery on `staff`, a join on `pay_rates`, **a nested `WITH staff AS (...)` inside a subquery over an outer `FROM staff`**, a CTE named `clients`; existing parity tests pass.
- The DuckDB-parse check as D10. Tests: every refusal above also refused by it alone (the tokenizer check bypassed in the test); **a column added after boot** (a fixture republished with a new column) is refused; an unknown plan shape refuses.
- Refused clock functions; a query that reads no allowed table is refused.
- The profile's `ask` block as D10's table; boot refuses a missing table or column (`properties.zone_id` as the test case) and a bare-name clash. The person-and-contact column test. **SQLsmith signs the final column list in the PR.**
- `ASK_DATA` (`admin_grantable: false`) granted to `ely` and `steven`.
- Ask's connection: prepared, streamed, at most 51 rows, trailing `;` stripped, `memory_limit` and `threads` set, 10-second interrupt, a second concurrent query refused. Tests for each (frozen clock for the interrupt).
- Error words fixed; logs hold the error class only (a test feeds an error whose text holds a hidden column name and checks neither the reply nor the log holds it).
- GRD-009 and GRD-005's exception in `guardrails.md`; AD-10's exception in `architecture-runtime.md`.

### Story 19.8: Ask answers with a query

- The two paths, truth figures, provenance, refusal text and the review queue as D10 and D11. `write_query` tool schema checked by the Anthropic fake.
- Tests, one each: each "when Ask runs a query" condition missing (including verify never run, a skipped truth and a pass 8 days old); the rule path runs the reviewed SQL with typed parameters (a bad parameter refuses); the composed path labelled; a truth question shows the reviewed figure with the AI's query beside it; a cents-versus-dollars result counts as a mismatch; a two-row result for a truth claim counts as a mismatch; an unknown or pending `truth_id` hides the AI result; "not ranked" and "first 50 by its order"; the AI's requests hold no row, no truth figure, no `expect`, no note text and no `org.md` text; two AI calls per answer, both counted; logs hold no question, SQL or row.
- The demo questions run on the fixture through the Verifier, their answers in the PR: paid revenue September 2026, 35,018,640 cents ($350,186.40, QR-003); billed revenue, 36,402,350 cents (QR-004); active plans today, 815 (QR-001; not `status = 'active'`, 814); outstanding at as_of, 19,875,325 cents (QR-005); active plans by zone, 5 rows summing to 815 (QR-006).
- **Show the query** view with Back.
- Ways out, each tested: Back, the X, closing while it thinks, the AI off or over budget, the data unavailable, a timeout ("That question took too long to answer; narrow it."), a concurrent query, an expired trigger.

### Story 19.9: v1 docs, demo script and live check

- `docs/runtime/demo-script.md` "Stage 2: v1"; the fork guide: `notes`, the `ask` block, `ASK_DATA` and its clearance (GRD-009), query rules from day one, a named client signer; `kit/templates/module.md`: the new screens.
- The v1 live check list in the PR body; the result recorded in the epic report.

### Story 20.1: the email tool sends appointment emails

- `sendEmails` as D14a, with its dry-run render, per-email keys, partial failure and retry; the contract suite covers it.
- `templates.js` (reminder, change); only D14's fields accepted. Tests: exact text for a fixture visit; the strict address parse (two addresses, a display name, a comma, whitespace, a trailing dot, upper case, a `.com`, each refused); 50 and 51 a push; 200 and 201 a day (frozen clock).
- `APPOINTMENT_EMAILS` (`admin_grantable: false`) granted to `ely` and `steven`; GRD-010 and the Write paths row.

### Story 20.2: appointment reminders

- Module `appointment-reminders` (approval-write, group Customers, verb Review); form: a day after as_of and a crew or zone; SQLsmith-reviewed SQL over `scheduled_visits` (`scheduled_visit_id` as `row_id`, `status = 'scheduled'`); visits on a crew-day with a `staff_absences` row are held and listed (test).
- Tests: the preview equals what is sent; a second approve sends nothing new; `BRIGHTSIDE_EMAIL_OFF` stops it; no key, no row.
- Ways out: Cancel, an expired preview, a partial failure and Retry, each once.

### Story 20.3: change notices from a route skill; the skills on `/brightside`

- Copies `route-cancellation`, `route-crew-out`, `route-add-stop` on `/brightside`, dev-only.
- `route-source.js` as D14a; **Notify affected customers (N)** only with a `change-notices` module the person can open and N > 0.
- The module's query binds `$visit_ids` as one string. Tests: a forged click can't name other visits; before values from `scheduled_visits` with `status = 'scheduled'`; a move within the window is not a change; a crew change is; a crew-out stop to rebook is listed, not emailed; an added stop is not emailed; the reason line matches the skill; the S1, S2 and S3 scenarios give the expected visits.
- AD-15's amendment for the route row source.
- Ways out: Back to the route, Cancel, the record expired, nothing changed (no button), the approval-write ways out.

### Story 20.4: live demo script and live check

- `docs/runtime/demo-script.md` "Stage 3: live"; the live check list in the PR body.

## Build order and shared files

One at a time, in this order, except where it says "alongside":

1. **18.1**, then **15.6** (gate item 4).
2. **18.2**, then **18.3** (18.3's PDFs may start alongside 18.2).
3. **19.1**, then **19.2**, then **19.3**.
4. **19.4**, then **19.5** (shared `editor.js`, `routing-map/index.js`, the adapter, `hubs.js`).
5. **19.6** may run alongside 19.4 (no shared file). **19.7** after 19.6 (shares `data.md` and the profile). **19.8** after 19.3 and 19.7.
6. **19.9** last in Epic 19.
7. **20.1**, **20.2**, then **20.3** (after 19.5). **20.4** last.

| File | Stories |
|---|---|
| `profiles/brightside/profile.yml` | 18.1, 19.7, 20.1, 20.2 |
| `profiles/brightside/context/guardrails.md` | 18.1, 19.7, 20.1 |
| `profiles/brightside/context/data.md` | 18.1, 19.6 |
| `docs/ledger.md` (DEP rows) | 18.1, and any story that opens one |
| `kit/runtime/slack/files.js` | 18.2 |
| `kit/runtime/archetypes/add-context/index.js` | 18.2, 19.1 |
| `kit/runtime/slack/hub-view.js`, `hub.schema.json` | 19.1 |
| `kit/runtime/llm/index.js`, `context.js` | 19.1, 19.6 (context), 19.8 |
| `kit/runtime/archetypes/ask/index.js`, `messages.js` | 19.3, 19.8 |
| `kit/runtime/archetypes/data-sources/index.js` | 19.3, 19.6 |
| `kit/runtime/archetypes/routing-map/**`, the adapter | 19.4, 19.5, 20.3 |
| `kit/runtime/slack/hubs.js` | 19.5, 20.3 |
| `kit/runtime/sql/index.js`, `kit/runtime/data/index.js` | 19.7 |
| `kit/runtime/archetypes/approval-write/**` | 20.2, 20.3 |
| `examples/brightside/app/connectors/email/**`, `kit/runtime/connectors/suite.js` | 20.1 |
| `test/fixtures/fake-slack.js` | 18.2, 19.5 |
| `test/fixtures/fake-anthropic.js` | 19.8 |
| `docs/runtime/demo-script.md` | 18.3, 19.9, 20.4 |
| `architecture-runtime.md` | 19.1, 19.3, 19.7, 19.8, 20.3 |

If `main` has moved, the builder merges it and resolves conflicts before reporting.

## Steps only you can do

1. **Approve the plan** (`approve plan brightside-v1`), with any gate item changed.
2. **Add `/brightside-v1` in the Slack app, before 19.2's live check,** as for `/brightside-v0`:
   1. Open api.slack.com/apps and pick the Brightside app.
   2. Click **Slash Commands**, then **Create New Command**.
   3. Command `/brightside-v1`, short description `Open the Brightside v1 menu`, no usage hint, escaping off. Save.
   4. If Slack asks you to reinstall the app, click it and allow.
3. **Before each v1 demo:** run `npm run verify` on the machine the bot runs on (Ask needs every signed truth passed within 7 days). Ely or Steven.
4. **Sign query rules** that come out of the review queue, in their PRs (after this plan; the seed rules are signed by the gate, item 8).
5. **The live checks** at the end of each epic.

## Demo scripts

They go into `docs/runtime/demo-script.md` (18.3, 19.9, 20.4). Ely or Steven can run every step.

**Before any demo:** update the bot to the latest `main`, run `npm run verify`, restart the bot, and remove any notes left from the last demo.

### Stage 1: v0, the blank bot

1. Type `/brightside-v0`. Point at the strip: "Knows: nothing yet", "Setup 0 of 1".
2. Press **Help**: four template tools. Back.
3. **Ask**: "Which zone billed the most in September, and how much cash did we receive from that zone in September?". It can't: no data and no rules.
4. **Add** on Add context: upload `price-list-2026.pdf` ("Price list"). It shows what it read.
5. Upload `service-policies.pdf` ("Policies"), `zone-billing-2026-09.csv` ("Billing by zone, September") and `complaints-2026-09.csv` ("Complaints, September").
6. Close, type `/brightside-v0`: "Knows: 4 notes".
7. Ask D4's five questions (Ask another). Each matches the script.

### Stage 2: v1, the real data

1. Type `/brightside-v1`: "Knows: 4 notes · 1 source · 7 truths · 9 rules", "All 7 tools working".
2. **View** Data sources: the source; seven truths signed by Ely Potter; both rule files signed; "Rule cards approved: 9"; "Query rules signed: 7"; the four notes shared with v0.
3. Ask "How much notice does a customer need to reschedule?": from the shared note.
4. Ask "What was paid revenue in September 2026?": $350,186.40, from QR-003. **Show the query.**
5. Ask "How many plans are active today, by zone?": five rows summing to 815, composed from QR-001 and QR-006 (or QR-006 alone).
6. Ask "What do clients owe us right now?": $198,753.25 (QR-005).
7. Ask "Crew 4's stops on October 1 zig-zag. Can you fix the order?": it points to Optimize a route. **Run**.
8. Crew 4, 2026-10-01, **Show stops** (134 minutes), **Optimize**: the drive drops.
9. **Run** Customer cancellation: crew 2, 2026-10-02, the afternoon visit cancels; property 762's client is top. **Fill with #1**.
10. **Run** Crew out: 2026-10-03, crew 7, out in the data: 5 move in the zone, 1 cross-zone.
11. **Run** Add a stop: crew 4, 2026-10-01, a client in its zone, 60 minutes, afternoon. The stop joins with ➕.
12. Ask "List the clients with the highest unpaid balance and their emails.": the refusal text ("…no signed query rule covers that yet, so I won't guess…"). Press **Request a tool**, preview, Post: it appears in `#ai-build-requests`.

### Stage 3: live, it acts

1. Type `/brightside`: Lists, Routing, Customers, Tools; "All N tools working".
2. **Run** Unpaid invoices for North: the names Ask wouldn't show, under their own key.
3. **Run** Customer cancellation: crew 2, 2026-10-02, the afternoon visit cancels, **Fill with #1**.
4. **Notify affected customers (N)**: the change notice shows the new day and window, the old ones, the apology and the reply line. **Approve**.
5. **Run** Crew out: 2026-10-03, crew 7, **Notify affected customers (N)**: a notice for each moved visit; the cross-zone recommendation listed, not emailed. Approve.
6. **Review** Appointment reminders for 2026-10-01, crew 4. Any visit on an absence day is held. Approve.
7. **View** Outbox: every reminder and change notice, each to a `.invalid` address. "Nothing left the building."

## The live checks

From your own account (Steven may repeat any step from his). Each step is one action and what you should see. If it differs, stop and tell the Orchestrator the step number and what you saw.

**After Epic 18:**
1. Type `/brightside`. The first line reads "Knows: 1 source · 7 truths · 8 rules"; the second has no "Setup".
2. Type `/brightside-v0`, **Add** on Add context, upload `complaints-2026-09.csv`. You see "N rows, M columns".
3. Upload the other three demo-pack files. "Knows: 4 notes".
4. Ask the five v0 questions. Each matches the script.
5. Try to upload a `.xlsx`. You are told to save it as a PDF first.

**After Epic 19** (after you add `/brightside-v1` and run `npm run verify`):
6. Type `/brightside-v1`. "Knows: 4 notes · 1 source · 7 truths · 9 rules", "All 7 tools working".
7. **View** Data sources. The source, seven truths and both rule files signed by Ely Potter, "Rule cards approved: 9", "Query rules signed: 7", the notes shared with v0.
8. Ask "Crew 4's stops on October 1 zig-zag. Can you fix the order?". The answer names Optimize a route with **Run**.
9. Press **Run**, crew 4, 2026-10-01, **Show stops**, **Optimize**. The map and drive time update.
10. Open **Route map**. Its four views work as on `/brightside`.
11. Run Customer cancellation, Crew out and Add a stop as Stage 2 steps 9 to 11. Each shows what the script says.
12. Ask "What was paid revenue in September 2026?". $350,186.40, "From signed rule QR-003"; **Show the query** shows the SQL.
13. Ask "List the clients with the highest unpaid balance and their emails.". You see the refusal text with **Request a tool**.
14. Run `npm run query-rules -- --queue`. Step 13's question is listed, with no figures.
15. Ask "What does Brightside do when a crew is out?". An answer from the company context, ending "Not what you needed?".
16. **Request a tool** from any answer, Preview, Post. It appears in `#ai-build-requests` with your name and "Brightside v1".
17. Add a typed note on v1, then type `/brightside-v0`. The note is there. Remove it on v0; it is gone from v1.
18. Type `/brightside-v0` and `/brightside`. Both look as after Epic 18.
19. Open the Slack app's settings: `/brightside-v0`, `/brightside-v1`, `/brightside` and seven scopes, matching `slack-manifest.json`.

**After Epic 20:**
20. Type `/brightside`. Customers shows Appointment reminders; Routing shows Customer cancellation, Crew out and Add a stop.
21. Run Stage 3 steps 3 to 7. Each preview shows the exact email, nothing is sent before Approve, and Outbox lists every email to a `.invalid` address.
22. Double-click Approve on one preview. Outbox shows each email once.

Not checked live: a crew lead's view and a member's view (no real ones). The tests cover both.

## Ledger items

**Closed or changed by 18.1:** DEP-024, 025, 028, 029, 032 closed; DEP-034's owner becomes Ely; DEP-036 gains CSV.

**New (proposed;** ids from DEP-041 when the stories open them):

| Row | Owner | What |
|---|---|---|
| DEP-(next) | Orchestrator | Ask's query answers as a CSV in the person's DM, for results over 50 rows. |
| DEP-(next+1) | **Ely** | AI-polished wording for appointment emails (needs a GRD-010 change). |
| DEP-(next+2) | Each engagement lead | A real fork sends a change notice only after its scheduling system holds the change. |
| DEP-(next+3) | Each engagement lead | Per-day email caps for a real fork, set with the client (the demo's are 50 a push, 200 a day per hub). |
| DEP-(next+4) | Orchestrator | A booking confirmation email for a stop added with Add a stop. |
| DEP-(next+5) | Orchestrator | Allowing a column whose bare name a hidden column shares needs qualified-name resolution in the guard; today boot refuses that `ask` block. |
| DEP-(next+6) | Orchestrator | Opened only if 19.7 can't build the DuckDB-parse check on the pinned DuckDB version: then Ask's query path stays off (fail closed) until it is built. |

## Review findings folded in

**SQLsmith review, 2026-10-31.**
- P1-1 `crew_memberships`, `staff_absences` out of the `ask` block (D10).
- P1-2 `properties.zone_id` doesn't exist; client zone is `clients.zone_id`; boot refuses missing tables and columns (D8, D10, 19.7).
- P1-3 no truth figures to the AI; signed Terminology and MET lines only; refuse SQL with no allowed table; signed truths only (D10).
- P1-4 truth questions show the reviewed SQL's figure, AI query beside it; raw units; 1 row and 1 numeric column (D10, 19.8).
- P1-5 `scheduled_visit_id`, before values from `scheduled_visits` `status = 'scheduled'`, morning/afternoon, `crew_id` (D14, 20.3).
- P2-6 one refusal text; the hidden-column demo question (D10, scripts, live check 13).
- P2-7 "cash received in September"; zone is `clients.zone_id` (D4).
- P2-8 clock functions refused (D10).
- P2-9 verify never run refuses (D10).
- P2-10 GRD-009 clearance for every metric, `client_id` pseudonymous (D10).
- P2-11 reminders held for absence crew-days (D14, 20.2).
- P2-12 ranking labels (D10).
- P3-13 `labour_minutes` hidden (D10).
- P3-14 no ties in the v0 questions (D4, 18.3).
- P3-15 the traps in the prompt (D10, QR-000).

**Architect design review, 2026-10-31.**
- P1-1 `crew_memberships` out; a person-and-contact column test; SQLsmith signs the list (D10, 19.7).
- P1-2 top-level CTEs only, no shadowing, and DuckDB's parse as a second check; nested-CTE and new-column tests (D10, 19.7).
- P1-3 D14a for the Connector: `{ name, contacts }`, dry-run render, kind-and-change keys, one-string ids, the gated route row source, the file list.
- P2-4 prepared and streamed, no wrapper, `;` stripped, Ask's own memory and threads (D10).
- P2-5 fixed error words, error class only in logs (D10).
- P2-6 the truth gate fails closed; unknown, unsigned or non-numeric truth claims hidden (D10).
- P2-7 as SQLsmith P1-2. P2-8 as SQLsmith P2-6.
- P2-9 50 a push, 200 a day, strict `.invalid` parse (D14).
- P2-10 19.2, 19.4, 19.5 raised to T3.
- P2-11 context answers on v1 stated; template-wide additions and the production stance as gate items 5 and 7.
- P2-12 19.3's ways out.
- P3-13 two AI calls per answer noted. P3-14 a concurrent query refused. P3-15 the same-keys check covers Data sources. P3-16 GRD-005 names notes and CSVs. P3-17 a named client signer in forks.

## Risks

- **AI-written SQL.** Narrowed: the rule path runs reviewed SQL; the composed path is checked twice (tokenizer and DuckDB's parse), reads only allowed columns, and the AI never sees results. A composed query can still be wrong for a question no truth covers; it is labelled "composed", shows its SQL, and the queue turns repeats into signed rules.
- **Shared notes** show on both hubs, by design and said on both screens.
- **What-if route screens** read client names; scope is checked first and no address or coordinate is read.
- **Change notices for suggestions** say a visit moved while the data didn't; the preview says so.
- **Emails** go to `.invalid` addresses only, capped per push and per day.
- **Size:** sixteen stories. Each epic stands alone: 18 gives a complete v0 demo, 19 a complete v1, 20 the finale.

## Not in this plan

- Saving a route to the bookings, or any write to a scheduling system.
- Ask writing anything, or running a query on `/brightside` or `/brightside-v0`.
- Word or Excel uploads (DEP-036). The Home tab. AI-written emails.

## Approval

Write `approve plan brightside-v1` to start the build. It accepts the eight gate items with their recommended defaults, signs GRD-009 and GRD-010 as worded in D10 and D14, and signs the seed query rules (gate item 8). To change one, say so with the approval.
