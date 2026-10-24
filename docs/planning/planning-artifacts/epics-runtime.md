---
status: approved
stepsCompleted: [1, 2, 3]
inputDocuments:
  - docs/planning/specs/spec-runtime/SPEC.md
  - docs/planning/planning-artifacts/architecture-runtime.md
  - docs/planning/specs/spec-runtime/fixture-tables.md
  - docs/planning/specs/spec-runtime/demo-flow.md
  - docs/planning/specs/spec-runtime/connector-review.md
  - docs/reference/runtime-harvest-map.md
  - docs/PLAN-v1.md
---

# AP-Labs - Epic Breakdown: the runtime

## Overview

This document breaks the runtime spec (`SPEC.md`, standing in for a PRD) into implementable epics and stories. Each epic is one build phase that leaves something a person can use. Each story is one PR. Status is **draft** until Ely types `approve plan runtime-phase`.

Epics are numbered 6–11 so they continue the Orchestrator phase's Epics 1–5 in `sprint-status.yaml`. Where code lives, the manifest format, the store, data access, LLM isolation, secrets and profile keys are settled in `architecture-runtime.md` (AD-1 to AD-18); stories cite the ADs they build against.

Estimates: **S** about half a day of builder time and under ~300 changed lines; **M** about a day; **L** up to two days, the most a single PR should carry. 29 stories: 8 S, 20 M, 1 L.

Computed tiers (`node kit/lib/tier` against a temp copy of `profiles/brightside/profile.yml` carrying the tier rows Story 6.1 adds; see the architecture's "Computed tiers"):

| Epic | Tier | Stories at T2 or T3 |
|---|---|---|
| 6 | T3 | 6.1 (T3: `kit/lib/secrets/**`) |
| 7 | T2 | 7.1 (CI workflow), 7.4, 7.5 |
| 8 | T3 | 8.1 (T3: `kit/runtime/connectors/**`) |
| 9 | T2 | 9.1 |
| 10 | T3 | 10.2, 10.3 (T3: approval-write) |
| 11 | T2 | 11.2 |

All other stories compute T1. The whole phase is still behind one plan gate (`approve plan runtime-phase`); each story's tier sets its review ceremony inside it (architect review on T2/T3 stories).

### Round 3 changes

No renumbering; still 29 stories. Round 3 tightens: the approval entry carries its own copy of the rows to push (10.2, 10.3, 9.6); the guardrail blocks DuckDB table functions, `COLUMNS(` and whole-row structs (7.4); thread history no longer goes to the LLM (9.2); the profile gains tier rows for the runtime's risky paths (6.1); plus health grace, stop-then-start deploys, library log routing, import grep tests, double-click "already done", truth blocks stripped from LLM context.

### Round 2 renumbering

| Round 1 | Round 2 |
|---|---|
| 7.1 generator (L) | 7.1 reference tables + 7.2 time series (split) |
| 7.2 DuckDB build | 7.3 |
| 8.1 SQL guardrails | 7.4 (must exist before the runner) |
| 7.5 Dataset entry | 7.5 the query runner + Dataset entry |
| 7.3 validation and truths | 7.6 |
| 7.4 MotherDuck publish | 7.7 |
| 8.2, 8.3, 8.4 | 8.1, 8.2 (lookup only), 8.3 |
| 9.3 (L) | 9.3 typed form, no LLM + 9.4 LLM extraction (split) |
| 9.4, 9.5 | 9.5, 9.6 |

## Requirements Inventory

### Functional Requirements

- FR1: A fork's Slack app boots in dev from env and the profile, refuses to start naming any missing setting (never its value), and answers a person privately. (CAP-1)
- FR2: Each hub is a slash command whose menu is built from registry data; a hidden entry is rejected at dispatch as well as left off the menu; the app manifest's commands are generated from the hub files. (CAP-2)
- FR3: A module is one manifest plus files in its folder; a module made from the template appears in its hub with no engine edit, and a malformed manifest fails the check. (CAP-3)
- FR4: Menu visibility and every dispatch are decided by `kit/lib/permissions` against the profile through the person's Slack identity, with distinct messages for denied, unknown person and misconfigured key. (CAP-4)
- FR5: One LLM service, with declared context files, one structured call, a kill switch, a per-person rate limit and an hourly spend breaker; no test calls a model. (CAP-5)
- FR6: Every external-system adapter has one shape and passes one shared contract test. (CAP-6)
- FR7: Brightside has a mock CRM (read) and a mock email tool (write) over the fixture; pushes are idempotent and visible in a local outbox; the fixture is never written. (CAP-7)
- FR8: SQL runs only through one read-only runner, and only if it is one read-only statement that avoids forbidden columns and DuckDB's file, network and env functions; unterminated input fails closed. (CAP-8)
- FR9: One scoped-pull engine fills a module's declared parameters (typed form or plain English), confirms them, runs the bound query and delivers results privately; modules configure it, never copy it. (CAP-9)
- FR10: An approval-gated write previews, pushes only after the same person approves, and reports the outcome, safe against expiry, wrong person, double click, partial failure and the kill switch. (CAP-10)
- FR11: Slack basics: acknowledge-first handling, markdown to Slack with chunking, a provenance button with the exact SQL, first-run onboarding and help per hub, one TTL store. Thread context to the LLM is deferred (round 3). (CAP-11)
- FR12: Scheduled jobs are declared as data and their runs logged; the template ships no jobs. (CAP-12)
- FR13: The Brightside Tier-1 dataset is generated deterministically into versioned seed files, built offline into a local DuckDB, validated, carries known truths, and is publishable to MotherDuck by Ely. (CAP-13)
- FR14: In a fresh Brightside fork, a person in Slack goes plain-English request → scoped pull → scoring → approval → push to the mock email tool; scoring is deterministic with a reason per row. (CAP-14)
- FR15: Two forks differ only in their profile and their own modules. (CAP-15)

### NonFunctional Requirements

- NFR1: Runtime is Node 24 (LTS) and bash (ADR 0004; was Node 20).
- NFR2: Slack is the only surface; menus and typed forms, not an open chat box.
- NFR3: Private delivery by default; files only to the person's DM; any channel delivery is a declared, tested exception.
- NFR4: Each new profile key lands with the story that reads it, schema-validated, unknown keys rejected; the profile never holds secrets (AD-16).
- NFR5: Secrets come from env or the macOS Keychain at runtime through `kit/lib/secrets`; never in the repo, profile, logs or agent-visible output (AD-12).
- NFR6: Tests and CI are offline and deterministic: no Slack, no model, no MotherDuck.
- NFR7: Synthetic data only (`.invalid` emails, 555-01xx phones).
- NFR8: SQL runs only through the runner and guardrails; external writes only through a connector via the approval-gated archetype.
- NFR9: Scoring is deterministic and explainable; no LLM in the score; query rows never reach the LLM.
- NFR10: One parameterised engine per archetype.
- NFR11: Every LLM call passes the kill switch, rate limit and breaker, and a stopped call tells the person plainly and offers the typed form.
- NFR12: Engine code is identical across forks; Brightside runtime examples live only in `examples/brightside/` (AD-1).
- NFR13: Dependencies pinned exactly with a reason each.
- NFR14: No Hometown specifics outside `docs/reference/`.
- NFR15: One process per deployment (AD-8).

### Additional Requirements

- Reuse `kit/lib/profile`, `kit/lib/permissions`, `kit/lib/tier`, `kit/lib/onboard` (`contextDirFor`) and `kit/lib/truths`; Slack identities use the profile's existing `users[].identities.slack`.
- The runtime loads its profile via `APLABS_PROFILE` (absolute path) in template dev and the container. Never add `.aplabs/profile.yml` to the template repo (AD-2).
- Slack runs in Socket Mode for dev, as a separate runtime bot app in the existing `aplabs-demo` workspace (AD-5).
- Every story follows the Orchestrator build loop: tier computed with `node kit/lib/tier`, a ledger row, `npm run review`, `npm run land`.
- Tests: engine tests under `test/**` read client specifics from `test/fixtures/`, never `profiles/brightside/` or `examples/brightside/`. Carve-out: example tests under `examples/brightside/**` may use Brightside's profile and data, and are deleted with the example in a fork.
- Prior art per capability: `docs/reference/runtime-harvest-map.md`. Fixture tables and definitions: `fixture-tables.md`. Demo steps: `demo-flow.md`. Connector contract review: `connector-review.md`.
- Orchestrator Story 4.3 (prove onboarding on Brightside, DEP-004) becomes buildable after Epic 7 and stays tracked in `epics.md`; it reuses the truth blocks Story 7.6 writes.
- Human steps (Ely), none of which any story's CI depends on:
  - Before live checks of Epic 6: in the existing `aplabs-demo` workspace, create a separate runtime bot app (for example "Brightside Bot (dev)") from the repo manifest. Don't add bot scopes to the existing "AP Labs Orchestrator" incoming-webhook app, so `npm run notify` and the runtime keep separate credentials. Store the bot token (`xoxb-`) and the app-level token (`xapp-`, `connections:write`); Socket Mode needs no signing secret. Add your `aplabs-demo` member id to a Brightside user's `identities.slack` (an id, not a secret).
  - Before live checks of Epic 9: a venture Anthropic API key with a spend cap set in the console.
  - Before live checks of Story 10.3: create `#brightside-ops` in `aplabs-demo` and invite the bot.
  - After Epic 7: MotherDuck account and collaborator, then run the publish command (Story 7.7).
- DEP row for the Orchestrator to add to `docs/ledger.md`: "runtime reads MotherDuck: needs an approved read-only service token and injection path; approver Ely". V1's bot reads the local fixture only.

### UX Design Requirements

- UX-DR1: Every reply is private (DM or ephemeral) unless an entry declares otherwise; files go to the person's DM.
- UX-DR2: Every refusal or failure gives a plain-language reason and what to do next; none is silent (AD-17).
- UX-DR3: Long output is split into sections under Slack's 3,000-character limit, and large results are delivered as a CSV file in the person's DM.
- UX-DR4: Every hub has a help entry, and a person's first visit to a hub shows a short welcome.
- UX-DR5: Every data result has a "How was this made?" button.

### FR Coverage Map

- FR1: Epic 6 (6.1), Epic 11 (11.2) - boot, private reply, container and health
- FR2: Epic 6 (6.2) - hub menus from the registry, generated app manifest
- FR3: Epic 6 (6.2, 6.5) - module contract and template
- FR4: Epic 6 (6.3) - access from the profile
- FR5: Epic 9 (9.1, 9.4) - LLM service, extraction
- FR6: Epic 8 (8.1) - connector contract
- FR7: Epic 8 (8.2, 8.3) - mock CRM and email tool
- FR8: Epic 7 (7.4, 7.5) - SQL guardrails and the query runner
- FR9: Epic 9 (9.3, 9.4, 9.5) - scoped-pull engine
- FR10: Epic 10 (10.2, 10.3) - approval-gated write
- FR11: Epic 6 (6.1, 6.2, 6.4), Epic 9 (9.2, 9.6) - Slack basics and the store
- FR12: Epic 11 (11.1) - scheduled jobs
- FR13: Epic 7 (7.1, 7.2, 7.3, 7.6, 7.7) - Brightside fixture
- FR14: Epic 10 (10.1, 10.4) - scoring and the demo flow
- FR15: Epic 11 (11.3, 11.4) - fork acceptance

## Epic List

### Epic 6: Hello from Slack
A person types a hub command in a fork's Slack app and sees a menu of the modules their profile allows; a builder adds a module by filling in a template.
**FRs covered:** FR1, FR2, FR3, FR4, FR11 (store, acknowledge-first, onboarding and help)

### Epic 7: Brightside's data, queried safely
Builders and the bot work against a realistic, synthetic company that builds offline in seconds, validates itself and carries known truths; every query goes through one guarded, read-only runner.
**FRs covered:** FR8, FR13

### Epic 8: Safe connections
Any system connects one standard way, and Brightside's mock CRM and email tool are ready to be read and written.
**FRs covered:** FR6, FR7

### Epic 9: Ask for data in plain English
A person asks for a list in a typed form or plain English, confirms what the bot understood, and gets a private, explained result, within an LLM budget.
**FRs covered:** FR5, FR9, FR11 (formatting, provenance)

### Epic 10: Score, approve, push
The demo flow: a scored list goes to the mock email tool only after the person approves it, exactly once. Done-definition 3.
**FRs covered:** FR10, FR14

### Epic 11: Ready to fork
A new engagement forks the template, adds its profile and modules, and runs; scheduled jobs and a container are ready; two forks prove the engine is shared.
**FRs covered:** FR1 (container), FR12, FR15

## Epic 6: Hello from Slack

A person types a hub command in a fork's Slack app and sees a menu of the modules their profile allows; a builder adds a module by filling in a template.

### Story 6.1: The bot answers in Slack

**Implements:** FR1, FR11
**Estimate:** M
**Tier:** T3 (`kit/lib/secrets/**`)
**Architecture:** AD-2, AD-5, AD-6, AD-12

As a person at the client,
I want the bot to answer me when I message it,
So that I know the platform is live.

**Acceptance Criteria:**

**Given** `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in env (or the macOS Keychain) and a valid profile at `APLABS_PROFILE`
**When** the app starts in dev
**Then** it connects in Socket Mode, logs one startup line naming the client, the profile path and "single instance", and replies privately to a direct message with a short greeting

**Given** a missing token or setting
**When** the app starts
**Then** it exits non-zero listing each missing variable by name, and no value of any secret appears in any output

**Given** an invalid profile
**When** the app starts
**Then** it refuses to start and lists the profile's validation errors

**Given** a handler that throws after it acknowledged
**When** the error is caught by the shared handler wrapper
**Then** the person gets a plain message, and the ack was sent before any work
**And** the env-then-Keychain read and `redact()` move from `kit/lib/notify` into a new shared `kit/lib/secrets` (notify's tests still pass unchanged); the Keychain is skipped when `APLABS_NO_KEYCHAIN=1`
**And** `kit/runtime/log` redacts every secret loaded, with a test that logs a loaded secret and finds only the redaction
**And** Bolt and the Slack SDK get a custom logger that routes their output through `kit/runtime/log` at INFO and above; a test sets the library to debug (which prints the Socket Mode connection URL) and asserts that URL never reaches the output
**And** `profiles/brightside/profile.yml` gains the runtime tier rows (T3: `kit/runtime/archetypes/approval-write/**`, `kit/runtime/connectors/**`, `kit/lib/secrets/**`; T2: `kit/runtime/sql/**`, `kit/runtime/data/**`, `kit/runtime/llm/**`) as this story's first commit, and `node kit/lib/tier` on each path returns its row's tier
**And** the repo holds a setup note for the human step: create "Brightside Bot (dev)" in `aplabs-demo` from the manifest, separate from the "AP Labs Orchestrator" webhook app; store the `xoxb-` and `xapp-` tokens; no signing secret
**And** Slack Bolt is pinned with its reason, and tests use a fake Slack client with no network

### Story 6.2: A hub menu built from the registry, with a hello-world module

**Implements:** FR2, FR3, FR11
**Estimate:** L
**Architecture:** AD-3, AD-4, AD-5, AD-6, AD-7

As a person at the client,
I want one command that shows me what the platform can do,
So that I don't have to remember module names.

**Acceptance Criteria:**

**Given** hub files and module manifests in the app dir (`APLABS_APP_DIR`; template dev: `examples/brightside/app`)
**When** a person types a hub's slash command
**Then** a private Block Kit menu lists that hub's entries (label and one-line description), built by directory scan with no hub-specific code

**Given** a person clicks an entry
**When** the action arrives
**Then** it is acknowledged within 3 seconds, the module's handler runs, and it replies privately; the hello-world module replies with the person's name and the client's name

**Given** a retried event delivery (`retry_attempt` / `x-slack-retry-num`)
**When** it arrives with an `event_id` already seen
**Then** it is not processed twice
**And** `kit/runtime/store` exists with synchronous `get`, `set` and `consume`, TTL and an injected clock, and is the only short-lived state
**And** hub and module manifests are validated with ajv against `kit/runtime/schema/` and fail naming the file and field
**And** `npm run slack:manifest` generates the app manifest's slash commands from the hub files, and a test fails when the committed manifest differs
**And** an entry hidden for the current environment is left off the menu and rejected if its action arrives anyway
**And** until access wiring lands (6.3), only modules on an `open_access` resource can be registered
**And** tests build menus from fixture entries and cover dispatch, hidden entries, an unknown action id, a retried event and store expiry

### Story 6.3: People see only what the profile grants

**Implements:** FR4
**Estimate:** M
**Architecture:** AD-16, AD-17

As a client admin,
I want menus and actions governed by the profile,
So that nobody runs a module they were not given.

**Acceptance Criteria:**

**Given** a person whose Slack id matches a profile user's `identities.slack`
**When** they open a hub
**Then** they see exactly the entries whose resource key `kit/lib/permissions` allows them, with deny beating allow

**Given** a click on an entry they are not allowed
**When** the action arrives (for example a replayed payload)
**Then** it is re-checked at dispatch and refused with "you don't have access to <label>; ask <admin>"

**Given** a Slack id that matches no profile user
**When** they use any hub
**Then** they are told they are not set up yet and who to ask, and only open-access entries show
**And** two users with the same `identities.slack` fail profile validation
**And** an entry naming a resource key the profile does not declare fails the startup check, and at runtime is reported as a configuration fault, never as a denial
**And** tests cover allow, deny, deny-beats-allow, unknown person, open access, the duplicate Slack id and the misconfigured key with fixture profiles

### Story 6.4: First-run welcome and help on every hub

**Implements:** FR11
**Estimate:** S
**Architecture:** AD-7

As a new person at the client,
I want a short welcome and a help entry,
So that I can start without training.

**Acceptance Criteria:**

**Given** a person opening a hub for the first time since the app started
**When** the menu appears
**Then** a one-paragraph welcome for that hub appears above it, once per person per hub (store namespace `welcome`)

**Given** any hub
**When** its menu is built
**Then** it ends with a Help entry that lists the hub's modules the person can use and how to give feedback
**And** a person joining the workspace gets a private welcome naming the hubs they can use
**And** tests cover first visit, repeat visit, help contents filtered by access, and the join welcome

### Story 6.5: A builder adds a module from the template

**Implements:** FR3
**Estimate:** S
**Architecture:** AD-1, AD-3, AD-4

As a builder in a client fork,
I want to add a module by copying a template,
So that a new tool takes minutes, not a day of wiring.

**Acceptance Criteria:**

**Given** the module template in `kit/templates/module/` (a manifest, a handler and a test)
**When** a builder copies it into the app dir, fills in hub, label, resource key and archetype, and restarts
**Then** the module appears in its hub with no engine file changed

**Given** a manifest with a missing field, an unknown archetype, an unknown hub or a duplicate id
**When** `npm test` or app startup runs
**Then** it fails naming the module and the field
**And** a short guide explains each manifest field
**And** `kit/runtime/paths.js` exports the identical-engine set (`kit/**`, `profiles/_schema/**`; AD-1), and a test copies the template into a temp fork's app dir and asserts it registers while every engine path is untouched
**And** grep tests fail if any file under the app dir (template dev: `examples/brightside/app/`) imports a `kit/` path other than `kit/runtime/sdk`, or if any engine file references `examples/`
**And** the guide states that handler code is trusted, reviewed code, not sandboxed: it can reach `process.env`, and the protection is that the LLM has no tools and all output is redacted
**And** a "clean bones" CI job copies the repo, deletes `examples/brightside/` and `profiles/brightside/`, then runs `npm run check`, `npm test` and a boot smoke test against a minimal stub profile; it fails if the template no longer stands alone without the example client (Ely, 2026-10-24)

## Epic 7: Brightside's data, queried safely

Builders and the bot work against a realistic, synthetic company that builds offline in seconds, validates itself and carries known truths; every query goes through one guarded, read-only runner.

### Story 7.1: A deterministic generator writes the reference tables

**Implements:** FR13
**Estimate:** M
**Tier:** T2 (CI workflow)
**Architecture:** AD-18

As an AP Labs builder,
I want Brightside's data generated the same way every time and committed,
So that every test, demo and collaborator sees identical, reviewable data.

**Acceptance Criteria:**

**Given** the generator in `examples/brightside/fixture/` and a seed recorded in the repo
**When** I run the fixture generate command
**Then** it writes `zones`, `packages`, `add_ons`, `crews`, `crew_memberships`, `clients` and `properties` (`fixture-tables.md`) as seed files plus a schema file, using a seeded PRNG in the toolchain Ely chose (recommended: Node)

**Given** the committed seed files
**When** the generate command runs again with the same seed
**Then** the output is byte-identical, and a CI step that regenerates and diffs fails on any difference
**And** every email ends in `.invalid`, every phone is 555-0100 to 555-0199, names are generated, money is integer cents, and every property is in its client's zone
**And** tests cover determinism and the synthetic rules on a small seed

### Story 7.2: The generator adds plans, visits, invoices and payments

**Implements:** FR13
**Estimate:** M
**Architecture:** AD-18

As an AP Labs builder,
I want 24 months of realistic activity with planted figures,
So that the demo and the known truths have something real to find.

**Acceptance Criteria:**

**Given** the reference tables from 7.1 and a targets file of planted figures
**When** the generator runs
**Then** it writes `plans`, `plan_price_changes`, `visits`, `invoices`, `invoice_lines`, `payments` and `fixture_meta` (generator version, seed, `as_of` = 2026-09-30, row counts), following every definition in `fixture-tables.md`
**And** the data hits each planted target in the targets file (the known truths in `fixture-tables.md`), checked by the generator's own tests
**And** committed seed files total under 10 MB, checked by a test
**And** regeneration stays byte-identical

### Story 7.3: The fixture builds into a local DuckDB, offline

**Implements:** FR13
**Estimate:** M
**Architecture:** AD-9, AD-18

As an AP Labs builder,
I want one command that builds the database from the seed files,
So that I can query Brightside with no network and no credentials.

**Acceptance Criteria:**

**Given** the committed schema and seed files
**When** I run the fixture build command
**Then** `kit/fixture/build.js` creates `var/fixture/brightside.duckdb` (gitignored) in under 60 seconds, with every table loaded and row counts matching `fixture_meta`
**And** tests get an isolated temporary database from the same files, never a shared path
**And** `@duckdb/node-api` is pinned exactly with its reason; the build runs in CI with no network
**And** the builder is the only code that opens DuckDB for writing, and the app never loads it

### Story 7.4: SQL guardrails block writes, escapes and forbidden columns

**Implements:** FR8
**Estimate:** M
**Tier:** T2
**Architecture:** AD-9, AD-16

As a client admin,
I want every query checked before it runs,
So that the bot can never change data, reach files or the network, or expose a protected column.

**Acceptance Criteria:**

**Given** `sql.forbidden_columns` in the profile (new optional key, `"table.column"` strings; Brightside: `clients.phone`, `properties.street_address`, `properties.postal_code`)
**When** a query is checked
**Then** it is blocked if it is not a single read-only statement, names a forbidden column, selects a wildcard while any forbidden column is configured (including inside a CTE, after `TOP n`, as a quoted `"t".*`, or with `EXCLUDE`/`REPLACE`), uses `COLUMNS(`, or uses a table name or alias as a value in the select list while any forbidden column is configured (`SELECT c FROM clients c` returns the whole row as a struct)

**Given** a query using `ATTACH`, `SET`, `PRAGMA`, `INSTALL`, `LOAD` or `COPY`, any table-function call not on the allowlist (V1 allowlist: empty), or a quoted path or URL used as a table (such as `'https://…'` or `'s3://…'`)
**When** it is checked
**Then** it is blocked naming the rule; this covers the file, network and env readers (`read_csv`, `read_csv_auto`, `read_parquet`, `read_json`, `read_text`, `read_blob`, `glob`, `getenv`) and, named explicitly, `query(`, `query_table(` and `json_execute_serialized_sql`
**And** a comment marker inside a string literal does not hide anything, and an unterminated string or comment fails closed
**And** the story notes the threat model (AD-9): V1 SQL is reviewed static templates, so the guardrail is defence in depth, not the only line
**And** tests cover every case above, one test per bypass (`query(`, `query_table(`, `json_execute_serialized_sql`, `COLUMNS(`, whole-row struct by table name and by alias, `* EXCLUDE`), plus DDL, DML and stacked statements

### Story 7.5: One read-only query runner, and the Dataset entry

**Implements:** FR8, FR13
**Estimate:** M
**Tier:** T2
**Architecture:** AD-9, AD-10

As a client admin,
I want every query to go through one runner that cannot write or escape,
So that no module can bypass the guardrails.

**Acceptance Criteria:**

**Given** the built fixture at `APLABS_DATA_PATH`
**When** the runtime opens it
**Then** `kit/runtime/data` opens DuckDB with `access_mode=READ_ONLY`, `enable_external_access=false`, `autoinstall_known_extensions=false`, `autoload_known_extensions=false`, then `lock_configuration=true`, and a test shows a later `SET` fails

**Given** any call to `run(sql, params)`
**When** it executes
**Then** the guardrail (7.4) runs first on every call (a test spies on it), parameters are bound as prepared-statement parameters, and a parameter not declared by the caller is rejected
**And** a test fails if any file outside `kit/runtime/data` and `kit/fixture/build.js` imports `@duckdb/node-api`

**Given** an allowed person picks the Brightside "Dataset" entry
**When** it runs
**Then** they see privately the source (local fixture), fixture version, `as_of` date and table row counts

**Given** the data file is missing or can't be opened
**When** the app starts or the entry runs
**Then** the person is told plainly the data is unavailable, and the app keeps running
**And** V1 reads the local fixture only; reading MotherDuck is a DEP row (approver Ely)

### Story 7.6: The fixture validates itself and carries known truths

**Implements:** FR13
**Estimate:** M
**Architecture:** AD-18

As SQLsmith (and anyone writing a query),
I want the data's integrity and a few known figures checked automatically,
So that a wrong number is caught by a test, not by a client.

**Acceptance Criteria:**

**Given** a built fixture
**When** `npm run fixture:validate` runs (also registered as a verify check)
**Then** it runs every integrity and synthetic-only check in `fixture-tables.md` as a SQL file through the query runner, each expecting zero rows, and prints pass or each failure

**Given** Brightside's `profiles/brightside/context/data.md` (created from `kit/templates/context/data.md`)
**When** `npm run verify` runs with `APLABS_PROFILE` pointing at Brightside
**Then** each known truth in `fixture-tables.md` is a `truth` block whose `run` executes its SQL through the runner, and each matches its planted value with tolerance 0
**And** the truths carry owner "Dana Reyes" and `signed_off: pending`; Orchestrator Story 4.3 completes the onboarding proof and the sign-off
**And** a deliberately broken seed in a test fixture fails each integrity rule once

### Story 7.7: Ely publishes the fixture to MotherDuck

**Implements:** FR13
**Estimate:** M
**Architecture:** AD-12, AD-18

As Ely,
I want one command that publishes the validated fixture to MotherDuck,
So that a teammate and I query the same copy online.

**Acceptance Criteria:**

**Given** a MotherDuck token read through `kit/lib/secrets`
**When** Ely runs the fixture publish command
**Then** it refuses unless local validation passes, then replaces the shared database with the local build and records the fixture version
**And** the token is never printed, logged or written; a missing token exits 1 with how to configure it

**Given** the published copy
**When** Ely runs the fixture status command with the remote flag
**Then** it compares remote and local fixture versions and row counts and says whether they match
**And** publish and remote status are human-run (Ely); agents never run them; tests use an injected fake connection

## Epic 8: Safe connections

Any system connects one standard way, and Brightside's mock CRM and email tool are ready to be read and written.

### Story 8.1: One connector contract and a template

**Implements:** FR6
**Estimate:** M
**Tier:** T3 (`kit/runtime/connectors/**`)
**Architecture:** AD-15; `connector-review.md`

As a builder in a client fork,
I want one shape for every external system,
So that each new integration is safe by default and reviewable the same way.

**Acceptance Criteria:**

**Given** the connector template in `kit/templates/connector/`
**When** a builder fills it in for a system
**Then** it declares its auth env var names (never values), read and write operations, dry-run, idempotency keys, a kill-switch env var and a rate limit, as in `connector-review.md`

**Given** any connector
**When** the shared contract test suite runs against it
**Then** it checks that writes honour dry-run, the connector kill switch and `APLABS_WRITES_OFF`, a repeated idempotency key changes nothing, rate limits are respected, reads fail closed on auth errors, and errors never include credentials
**And** the suite passes against the template adapter
**And** `kit/templates/context/connectors.md` gains the contract fields per system (kill-switch env name, idempotency, batch size) instead of a new template

### Story 8.2: Brightside's mock CRM (read path)

**Implements:** FR7
**Estimate:** S
**Architecture:** AD-9, AD-15

As an AP Labs builder,
I want a CRM stand-in over the fixture,
So that modules can look up clients the standard way without a real vendor.

**Acceptance Criteria:**

**Given** the built fixture
**When** a module looks up a client by id or email
**Then** the mock CRM returns `client_id`, name, email and zone through the query runner, and never phone or address
**And** it has no write operations (the round-1 "update a client" was dropped: no consumer); it is the contract's read-path example
**And** it passes the 8.1 contract suite, and a test-only option simulates an auth failure (fails closed) and a rate limit

### Story 8.3: Brightside's mock email tool and the Outbox

**Implements:** FR7
**Estimate:** M
**Architecture:** AD-14, AD-15

As a person at the client,
I want to see what was sent to the email tool,
So that I can confirm a push landed.

**Acceptance Criteria:**

**Given** the mock email tool
**When** a connector call creates a list or adds contacts
**Then** `var/outbox/email.jsonl` (gitignored) records each list and contact with its idempotency key, and a repeated key adds nothing

**Given** `BRIGHTSIDE_EMAIL_OFF` or `APLABS_WRITES_OFF` is set
**When** a write is attempted
**Then** it is refused before any I/O

**Given** an allowed person
**When** they pick the Outbox entry
**Then** they see privately the latest lists, their contact counts and a sample, newest first
**And** the mock passes the 8.1 contract suite, and tests cover create, add, repeat, kill switch, a simulated row failure and the Outbox view

## Epic 9: Ask for data in plain English

A person asks for a list in a typed form or plain English, confirms what the bot understood, and gets a private, explained result, within an LLM budget.

### Story 9.1: An LLM service with a spend breaker and kill switch

**Implements:** FR5
**Estimate:** M
**Tier:** T2
**Architecture:** AD-11, AD-12, AD-16

As a client admin,
I want one LLM client that knows our company and cannot run up a bill or touch data,
So that every module gets good answers within budget.

**Acceptance Criteria:**

**Given** an API key read through `kit/lib/secrets` and the profile's `llm` keys (new, optional: `model`, `extraction_model`, `hourly_usd_limit` > 0 default 2, `max_tokens` default 1024)
**When** a module calls the LLM service
**Then** the system prompt holds the client name and the declared context files (`org.md`, `data.md`) from `contextDirFor(profilePath)`, with YAML frontmatter and every fenced `truth` block stripped (a test asserts no truth SQL or expected value reaches the prompt); `guardrails.md` and `connectors.md` are never sent; each call carries `max_tokens` and a timeout

**Given** the kill switch `APLABS_LLM_OFF`, a person over the per-person rate limit, or estimated spend in the last hour above the limit
**When** a call is attempted
**Then** it is refused before any request (kill switch checked first), and the caller gets a typed error the module turns into a plain message and the typed-form fallback
**And** the breaker reserves each call's worst-case cost (`max_tokens` × output price plus input tokens × input price) at check time and settles to the actual cost on reply, so concurrent calls can't overshoot the limit; a test fires two calls that would each fit alone and expects the second refused
**And** the breaker is per process and resets on restart; the setup note says the console spend cap backs it
**And** cost uses a per-model price table in code; a test fails if a configured model has no price
**And** a registered tool must declare `effects: "none"`, so no LLM-callable tool can run SQL or a connector write; a test registers one that doesn't and expects a refusal
**And** the Anthropic SDK is pinned exactly with its reason
**And** tests use a stubbed client and cover prompt assembly, the context list, token cap, timeout, rate limit, breaker trip and kill switch; no test calls a model

### Story 9.2: Slack formatting and chunking

**Implements:** FR11
**Estimate:** S
**Architecture:** AD-6

As a person at the client,
I want answers that read well in Slack, however long,
So that I never get a cut-off or garbled reply.

**Acceptance Criteria:**

**Given** markdown output
**When** it is sent to Slack
**Then** headings, bold, links, lists and code convert to Slack formatting, and text is split on line boundaries into sections under 2,900 characters

**And** thread history is not converted into LLM messages in V1 (a thread can hold result rows, and rows never reach the LLM, NFR9); "thread context to the LLM" is deferred with the tool loop (architecture, Deferred)
**And** tests cover each conversion, a long body, a body with no line break under the limit, and a code block split across sections

### Story 9.3: Declared parameters and a typed form, no LLM

**Implements:** FR9
**Estimate:** M
**Architecture:** AD-4, AD-7, AD-10

As a person at the client,
I want to fill in a short form and check it before anything runs,
So that I get the right list even when the LLM is off.

**Acceptance Criteria:**

**Given** a scoped-pull module whose manifest declares its parameters (name, type, allowed values or min/max, default, required)
**When** the manifest is loaded
**Then** the declarations are validated, and a declaration with an unknown type or an impossible range fails naming the module and parameter

**Given** a person opens the module
**When** they fill in the typed modal form
**Then** values are validated against the declarations, and the engine shows them privately with Confirm and Change

**Given** an open session (store namespace `session`, keyed by a session id carried in the buttons and bound to the person, AD-7)
**When** 30 minutes pass without activity
**Then** it closes, and a later click is told the session expired, not silently ignored

**Given** a Confirm click
**When** it arrives
**Then** it consumes the session's pending state synchronously before the query runs, so a double click or replay runs the query once and the second click is told it is already running or done (store `done`); a click by a different person is refused
**And** the first consumer is the Brightside example module "Win-back list" in `examples/brightside/app/modules/win-back/`
**And** tests cover a full form, an invalid value, Change, Confirm, double Confirm, a different person's click, two open sessions for one person, and expiry

### Story 9.4: Plain English fills the declared parameters

**Implements:** FR5, FR9
**Estimate:** M
**Architecture:** AD-10, AD-11

As a person at the client,
I want to describe the list I need in my own words,
So that I don't have to learn the form.

**Acceptance Criteria:**

**Given** a scoped-pull module and a plain-English request
**When** the engine extracts parameters
**Then** it makes one structured LLM call (no tool loop) that returns values for the declared parameters only; each is validated against its declaration before it is shown with Confirm and Change

**Given** a missing required parameter or a value outside the declared range
**When** extraction finishes
**Then** the engine asks one plain question for it instead of guessing; a second miss opens the typed form

**Given** the LLM is off, rate-limited or over budget
**When** a request arrives
**Then** the person is told plainly and offered the typed form (9.3)
**And** the Win-back example (`demo-flow.md` step 2) extracts zone = North, lapsed within 90 days, limit 25 from a stubbed reply
**And** tests with a stubbed LLM cover a full request, an undeclared parameter in the reply (dropped), a missing value, an out-of-range value and each fallback

### Story 9.5: The bound query runs and the results arrive privately

**Implements:** FR9
**Estimate:** M
**Architecture:** AD-9, AD-10, AD-14

As a person at the client,
I want my confirmed request turned into results I can use,
So that I get the list in Slack and as a file.

**Acceptance Criteria:**

**Given** confirmed parameters
**When** the engine runs
**Then** it binds them into the module's static SQL template as prepared-statement parameters, runs it through the query runner, and replies privately with the row count and the first rows
**And** the CSV of all rows goes only to the person's DM (`conversations.open`, then upload to that DM); the ephemeral reply links to it; a test asserts the upload target is the DM
**And** query rows are never passed to the LLM service (a test spies on it)

**Given** every module's SQL template
**When** the app boots
**Then** each passes the guardrail, and one that fails stops boot naming the module; a test checks templates contain no `${`

**Given** a guardrail block, a query error or zero rows
**When** the engine finishes
**Then** the person gets a plain message saying which, and nothing partial is delivered as complete
**And** a second Brightside example module ("Unpaid invoices", using `outstanding-at-as-of`'s definition) uses the same engine with only a manifest and SQL file
**And** tests on a temp fixture assert the exact rows for a scripted request on both modules

### Story 9.6: "How was this made?"

**Implements:** FR11
**Estimate:** S
**Architecture:** AD-7

As a person at the client,
I want to see how a result was produced,
So that I can trust it or challenge it.

**Acceptance Criteria:**

**Given** any scoped-pull result
**When** it is delivered
**Then** it carries a "How was this made?" button, and the run record is kept in store namespace `provenance` (24 h) keyed by run id, with exactly the AD-15 shape: `{ runId, person, module, parameters, sql, source, fixtureVersion, ranAt, rowIds, rows }`, where `rows` holds only the module's declared push fields and score, and only for a module with a write (Story 10.1 fills `score`)

**Given** a click by the person who ran the pull
**When** the action arrives
**Then** they see privately the confirmed parameters, the exact SQL that ran, the data source and fixture version, and the run time
**And** after the record expires, the button says the details are no longer available rather than failing
**And** the record serves this button and the preview (10.2) only; a push never reads it
**And** tests cover the shown SQL matching the SQL executed, the record shape, a different person clicking, and expiry

## Epic 10: Score, approve, push

The demo flow: a scored list goes to the mock email tool only after the person approves it, exactly once. Done-definition 3.

### Story 10.1: Deterministic scoring with a reason per row

**Implements:** FR14
**Estimate:** M
**Architecture:** AD-4

As a person at the client,
I want the list ranked with a reason I can read,
So that I work the best prospects first and can explain why.

**Acceptance Criteria:**

**Given** a module manifest that declares scoring inputs and weights
**When** pull results are scored
**Then** each row gets a score and a one-line reason naming its top contributing inputs, and rows are ordered by score with a stable tie-break (`client_id`)

**Given** the same data and weights
**When** scoring runs twice
**Then** scores and order are identical
**And** no LLM is involved; the Win-back module declares the inputs in `demo-flow.md` using the definitions in `fixture-tables.md`; tests assert exact scores on fixture rows

### Story 10.2: Preview and approve before anything is pushed

**Implements:** FR10
**Estimate:** M
**Tier:** T3 (approval-write)
**Architecture:** AD-7, AD-15, AD-16

As a client admin,
I want every push previewed and approved by the person who asked,
So that nothing reaches an external tool by accident.

**Acceptance Criteria:**

**Given** a scored result and a module with an approval-gated write
**When** the person clicks Push
**Then** they see privately the destination list (its name includes the run date), the row count and a sample, with Approve and Cancel

**Given** the preview
**When** it is created
**Then** an opaque CSPRNG token (at least 128 bits) is stored (namespace `approval`, 30 minutes) with the approval entry `{ person, runId, destination, listName, rows, idempotencyKey }`, where `rows` is a **copy** of the approved rows' declared push fields (Win-back: `client_id`, `email`, `first_name`, `score`) taken from the run record; the button carries only the token

**Given** the run record has already expired when Push is clicked
**When** the preview would be built
**Then** the person is told the results expired and to run the pull again; no token is created

**Given** an Approve click
**When** the token is expired, unknown, or belongs to someone else
**Then** the same "this preview is no longer valid" reply is given in each case, and nothing is pushed or consumed
**And** boot refuses an `approval-write` module whose resource is not declared `admin_grantable: false` in the profile
**And** Cancel ends the session with a confirmation
**And** tests cover each case, including that a push still succeeds after the run record has expired (the entry carries its own rows)

### Story 10.3: Push once, report honestly, escalate quietly

**Implements:** FR10
**Estimate:** M
**Tier:** T3 (approval-write)
**Architecture:** AD-7, AD-14, AD-15, AD-16

As a person at the client,
I want an approved push to happen once and tell me exactly what happened,
So that I never double-send or think a failed push worked.

**Acceptance Criteria:**

**Given** a valid Approve
**When** the push runs
**Then** the person binding is checked, then the connector and global kill switches (refusing without consuming), then the token is consumed synchronously just before the first write; the push reads only the approval entry's own rows (never the run record, never the button), and each is written through the connector with the idempotency key from `connector-review.md` (list name includes the run date, so the same list re-sent on a later day is a new list)

**Given** two Approve clicks in the same tick, a double click or a replayed payload
**When** the second arrives
**Then** exactly one push happens; `consume` left a `done` marker (AD-7, 10 minutes), so the second click is told "already done" with the counts (or "already running" while the first push is in flight)

**Given** some rows fail, or a kill switch is on
**When** the push finishes or is refused
**Then** the person sees pushed, skipped and failed counts with reasons
**And** a failure posts one escalation to the profile's `slack.ops_channel` (new optional key), the one declared channel-delivery exception: it carries module, reason and counts only, never row data (a test asserts no row value appears), and repeats of the same reason within a window are suppressed (namespace `escalation`)
**And** with no `ops_channel` set, the escalation is logged only
**And** the setup note: create `#brightside-ops` in `aplabs-demo` and invite the bot
**And** tests cover success, same-tick double Approve, a second click during and after the push, replay, partial failure, both kill switches, the run record expired before Approve, and suppression with the mock email tool

### Story 10.4: The demo flow, end to end

**Implements:** FR14
**Estimate:** M
**Architecture:** all

As Ely,
I want the whole demo to run in CI and live,
So that I can show a client the template working on Brightside.

**Acceptance Criteria:**

**Given** a fresh copy of the template configured with the Brightside profile (`APLABS_PROFILE`) and example app dir
**When** the acceptance test drives fake Slack through every step in `demo-flow.md`
**Then** the mock email tool's outbox holds exactly the approved, scored list once, every message went privately to the requesting person, and the CSV went to their DM
**And** with the LLM kill switch on, step 2 says so plainly and the typed form completes the same flow

**Given** a demo script in the repo
**When** Ely follows it in the live Slack app
**Then** Ely sees the same steps (human check, recorded in the PR)
**And** the test runs offline in CI

## Epic 11: Ready to fork

A new engagement forks the template, adds its profile and modules, and runs; scheduled jobs and a container are ready; two forks prove the engine is shared.

### Story 11.1: Scheduled jobs declared as data

**Implements:** FR12
**Estimate:** S
**Architecture:** AD-16

As a builder in a client fork,
I want to add a scheduled job as one registry entry,
So that recurring reports need no new plumbing.

**Acceptance Criteria:**

**Given** entries in `<app>/jobs.json` (name, schedule, run, enabled) and the profile's `jobs.enabled` (new optional key, default false)
**When** the app starts with jobs enabled
**Then** each enabled entry is scheduled, and each run logs start, finish or failure with its duration

**Given** a job that throws
**When** it runs
**Then** the failure is logged and the app keeps running
**And** the template ships no jobs; any dependency is pinned with its reason
**And** tests with a fake clock cover enabled, disabled, failing and the global off switch

### Story 11.2: The app runs in a container

**Implements:** FR1
**Estimate:** S
**Tier:** T2 (`Dockerfile`, CI workflow)
**Architecture:** AD-8, AD-12, AD-13

As an AP Labs consultant,
I want a generic container definition,
So that a fork can deploy on whatever host the client uses.

**Acceptance Criteria:**

**Given** the container definition
**When** it is built and started with the required env
**Then** the app boots as in 6.1, env only (`APLABS_NO_KEYCHAIN=1`), with `APLABS_PROFILE` and `APLABS_APP_DIR` set, and `GET /healthz` on `APLABS_HEALTH_PORT` returns 200 during a 90-second boot grace period and while Socket Mode is connected, and 503 only after the connection has been down for more than 60 seconds (tests with an injected clock cover boot grace, a short reconnect staying 200, and a long outage)
**And** dependencies are installed inside the image with `npm ci` for the target platform (DuckDB is native), never copied from the host
**And** the docs say: exactly one replica (in-memory state); deploys are stop-then-start, never rolling (name the host's "recreate"-style setting); no secret is baked into the image; the host choice is the fork's
**And** CI builds the image or, where Docker is unavailable, a check validates the definition and reports skipped, never passed

### Story 11.3: Two forks differ only by profile and modules

**Implements:** FR15
**Estimate:** M
**Architecture:** AD-1, AD-2

As an AP Labs consultant,
I want proof that the engine is shared,
So that a fix in the template reaches every engagement.

**Acceptance Criteria:**

**Given** two fixture clients, each with its own profile and app dir
**When** the acceptance test builds two forks in temp directories
**Then** every path in the identical-engine set (`kit/**`, `profiles/_schema/**`, from `kit/runtime/paths.js`) is byte-identical between them, and the only differences are each fork's profile, context, app dir and any dependencies a fork appended to `package.json`

**Given** each fork booted with a fake Slack client
**When** the same person id opens each fork's hub
**Then** each shows its own client name, menus and access from its own profile
**And** in each temp fork, `node kit/lib/tier` and `npm run verify` resolve from that fork's profile, and the write gate blocks an unplanned write
**And** the test runs offline in CI

### Story 11.4: The engagement fork guide

**Implements:** FR15
**Estimate:** S
**Architecture:** AD-1, AD-5, AD-8

As an AP Labs consultant starting an engagement,
I want a day-one checklist,
So that a new fork is running before the deep dive ends.

**Acceptance Criteria:**

**Given** the guide
**When** a consultant follows it in a fresh fork
**Then** it covers: write the client profile at `.aplabs/profile.yml` (with tier rows for the runtime paths as in Brightside's, plus the fork's own `app/connectors/**` and write modules at T3), delete `examples/brightside/` and `profiles/brightside/`, create the runtime Slack app from the generated manifest (separate from any notify webhook app), store tokens and the LLM key with a spend cap, build or connect the data source, add the first module from the template, run the onboarding build, and deploy one replica, stop-then-start
**And** it says a fork may append dependencies to `package.json` but never edits `kit/**` or `profiles/_schema/**` (fixes go to the template)
**And** each human-only step (anything with a credential) is marked as such
**And** a structural test fails when the guide names a command or file that does not exist

### Story 11.5: Template releases flow cleanly into client forks

**Implements:** FR15
**Estimate:** M
**Architecture:** AD-1

As AP Labs,
I want every improvement to the template to reach each client's fork with one command and no hand-merging,
So that we iterate on the bones without rebuilding them for every client.

**Acceptance Criteria:**

**Given** the template repo
**When** a release is cut
**Then** it is a git tag `vX.Y.Z` with a `CHANGELOG.md` entry (what changed, anything a fork must do), created by `npm run template:release -- <version>`, which refuses unless `main` is green and the clean-bones job passes
**And** `v0.1.0` marks the Orchestrator phase and is tagged retroactively on the commit where that phase finished

**Given** a client fork with the template recorded as its `upstream` remote
**When** `npm run template:update -- vX.Y.Z` runs
**Then** it fetches that tag, merges it on a new branch, runs `npm run check && npm test`, and opens a PR in the fork naming the version and linking the changelog
**And** it refuses, naming the files, if the fork has edited anything under `kit/**` or `profiles/_schema/**` since its last template version

**Given** a fork
**When** CI runs
**Then** an "engine untouched" check fails if `kit/**` or `profiles/_schema/**` differs from the template version recorded in `.aplabs/template-version`

**Given** a release that changes the profile format
**When** a fork updates
**Then** a migration script for that `schema_version` step upgrades the fork's profile automatically, and the update PR shows the profile diff for human review

**Given** the fork guide (Story 11.4)
**When** a consultant reads it
**Then** it explains forks, `upstream`, "clients add, never edit the engine", and how to take an update, in plain language
