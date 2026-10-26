---
owner: Dana Reyes          # the named client person who owns this file
signed_off: pending  # pending, or the ISO date (YYYY-MM-DD) the owner signed off
signed_off_by: ""  # who signed off: the owner, recorded by a facilitator
updated: 2026-10-26        # ISO date of the last edit
---

# Guardrails

Written by the Onboarder for Architect. Most of this mirrors `.aplabs/profile.yml`: cite the
profile rather than copy it, and propose profile changes to the Orchestrator instead of editing it.

In this template repo Brightside's profile is `profiles/brightside/profile.yml` (a fork keeps it at
`.aplabs/profile.yml`). Dana Reyes signed off this file on 2026-10-25 (Ely as Dana Reyes). Story 13.3
(route optimization) changed it on 2026-10-26, so the file awaits her sign-off again (DEP-028): GRD-002
now names the four coordinate columns and GRD-008 records the crew-out rule, both **draft**. Every
other card stays **approved** as signed on 2026-10-25.

## Guardrails

<!-- The client's standing rules for any build. One rule card each (below). -->

- GRD-001: the bot only reads data. No query writes, changes structure or attaches anything.
- GRD-002: forbidden columns (coordinates included) are never named, and `SELECT *` is refused.
- GRD-003: MotherDuck is read through the locked reader sequence; one accepted exception (`my_db`).
- GRD-004: anything that writes to an outside system goes through the approval step, never a module.
- GRD-005: the AI fills in a form and nothing else: no data rows, a spend breaker and an off switch.
- GRD-006: pay rates are open for the demo, but Labour cost is for owner and admin only, totals only.
- GRD-007: the data is synthetic, and publishing it is a human step.
- GRD-008: a crew is out for the day when its lead is absent, or nobody on it is present (draft).

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

- **Dana Reyes** (admin): holds `TIER3_APPROVE` (approve T3 changes; `admin_grantable: false`, so
  only the profile can give it). Owns and signs every client context file. The admin role confers
  the gated resources, such as `OUTBOX`.
- **Marcus Lee** (member): holds `VERIFY_SKIP` (waive a skipped verify check). No T3 approval.
- On the AP Labs side, Ely drives Dana in the demo workspace and signs as her; merges in this
  template repo are Ely's (AGENTS.md "Merge authority").

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
- Who is told when a limit is near: **empty field, owner Dana Reyes.** Today the breaker refuses and
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
- owner: Dana Reyes
- evidence: Story 7.4 and 7.5; the guardrail and runner tests in `test/`. A build tests it by
  sending a write through the runner and expecting a refusal.
- status: approved

### GRD-002: Forbidden columns
- type: access_rule
- rule: no query may name a column in the profile's `sql.forbidden_columns` (client phone, property
  street address, property postal code, and the four coordinate columns `properties.geo_lat_e6`,
  `properties.geo_lon_e6`, `crews.base_geo_lat_e6`, `crews.base_geo_lon_e6`), and while any is set,
  `SELECT *` and whole-row references are refused. Email is allowed: the win-back push needs it.
  `properties.access_method` holds a method, never a door code. NOT a rule about display: a column
  that is allowed can still be limited by who may use the entry (GRD-006).
- coordinates (Story 13.3, route optimization): the four coordinate columns are forbidden before the
  fixture gains them (Story 14.1). Only the kit's drive-time read (`travelMatrix`,
  `kit/runtime/data`) may read them, and only the columns the profile's `routing.coordinates`
  declares; it returns whole minutes between two places, never a latitude or longitude, and every
  other forbidden column still applies to it. No coordinate value, street address or postal code
  appears as text anywhere: Slack, logs, reasons, errors or AI input. NOT the map image: showing a
  coarse map in the routing modal is a separate update to this card that Dana signs at Story 15.5
  (DEP-025); until then no Brightside module shows a map.
- owner: Dana Reyes
- evidence: profile `sql.forbidden_columns` and `routing`; `kit/runtime/sql`; `fixture-tables.md`
  "Rules"; architecture-routing AD-R9 and AD-R10. The mock CRM's field list and the email
  connector's contact shape leave these columns out too.
- status: draft (the coordinate columns were added on 2026-10-26 and await Dana Reyes's sign-off,
  DEP-028; the rest was approved on 2026-10-25)

### GRD-003: MotherDuck reader lockdown
- type: access_rule
- rule: when the profile says `data.source: motherduck`, the bot reads with its own read-only key
  (never the publish key) through the locked sequence: extension pre-installed, attach mode single,
  the database attached read-only, external access off, configuration locked. Only that database,
  `md_information_schema` and the in-process `memory` are visible. If MotherDuck is down the person
  sees "data unavailable"; there is no fallback to the local file.
- exception (accepted by Ely, 2026-10-24): the reader account's own `my_db` can still be attached
  by name; MotherDuck can't block it. The barrier is GRD-001: the guardrail refuses `ATTACH`. The
  reader's `my_db` must stay empty. Exception confirmed for the client canon by Dana Reyes (Ely as
  Dana Reyes, 2026-10-25).
- owner: Dana Reyes
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
- owner: Dana Reyes
- evidence: `kit/templates/connector.md` (the contract); Epic 10 stories in
  `docs/planning/planning-artifacts/epics.md`. Who may approve a push is an **empty field, owner
  Dana Reyes**.
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
- owner: Dana Reyes
- evidence: `kit/runtime/llm/index.js` and `context.js` (Story 9.1); `docs/runtime/ai-setup.md`;
  the Epic 9 plan. A grep test keeps the AI off the SDK.
- status: approved

### GRD-006: Pay rates and Labour cost
- type: access_rule
- rule: `staff.hourly_rate_cents` and `pay_rates.hourly_rate_cents` stay open (not forbidden) for
  the Brightside demo, because the data is synthetic. The "Labour cost" entry (resource
  `LABOUR_COST`, Story 9.7) is granted only to the owner or admin role, never open access, and shows
  totals only: never one person's pay rate or name. A real client decides on day one whether pay
  rates are forbidden (fork guide, Story 11.4).
- owner: Dana Reyes
- evidence: Ely's decision on the Epic 9 plan (`approve plan epic-9`, 2026-10-25,
  `docs/planning/planning-artifacts/plan-epic-9.md`, decision 1). `LABOUR_COST` is not in the
  profile yet; Story 9.7 adds it.
- status: approved

### GRD-007: Synthetic data, human publish
- type: data_quality_guard
- rule: every Brightside record is generated: emails end in `.invalid`, phones are 555-0100 to
  555-0199. The fixture checks (`fixture-validate` in the profile's `verify.checks`) must pass
  before a publish, and only Ely publishes; agents never run `fixture:publish` or touch its token.
- failure_modes: a real-looking email or phone (caught by `synthetic-email.sql` and
  `synthetic-phone.sql`); a stale or hand-edited build (publish refuses it).
- owner: Dana Reyes
- evidence: `fixture-tables.md` "Rules" and "Validation"; `docs/runtime/motherduck-publish.md`.
- status: approved

### GRD-008: A crew out for the day
- type: classification
- rule: for route optimization, a crew is out for the day (`available: false`), and its stops need a
  new crew, when its lead is absent, or nobody on the crew is present. A crew with its lead and at
  least one person present works the day with fewer people, and its visits take longer. NOT a rule
  about who may see a route, and NOT a change to any booked visit: routing only suggests.
- edge_cases: who counts as the lead on a day the usual lead is swapped; a member present for part
  of the day. Both wait for Dana Reyes.
- owner: Dana Reyes
- evidence: data-design §4 and architecture-routing AD-R1 (the adapter, Story 14.3); absences come
  from `staff_absences` (Story 14.2).
- status: draft (pending Dana Reyes's confirmation, DEP-028)
