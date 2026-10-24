---
status: draft
stepsCompleted: [1, 2, 3]
inputDocuments:
  - docs/planning/specs/spec-runtime/SPEC.md
  - docs/planning/specs/spec-runtime/harvest-map.md
  - docs/planning/specs/spec-runtime/fixture-tables.md
  - docs/planning/specs/spec-runtime/demo-flow.md
  - docs/PLAN-v1.md
---

# AP-Labs - Epic Breakdown: the runtime

## Overview

This document breaks the runtime spec (`SPEC.md`, standing in for a PRD) into implementable epics and stories. Each epic is one build phase that leaves something a person can use. Each story is one PR. Status is **draft** until Ely types `approve plan runtime-phase`.

Epics are numbered 6–11 so they continue the Orchestrator phase's Epics 1–5 in `sprint-status.yaml` without colliding. The architecture (`bmad-architecture`, run by the architect at the plan stage) settles where engine code lives, the manifest format and the profile keys; these stories state behaviour, not file layout.

Estimates: **S** about half a day of builder time and under ~300 changed lines; **M** about a day; **L** up to two days, the most a single PR should carry.

## Requirements Inventory

### Functional Requirements

- FR1: A fork's Slack app boots in dev from env and the profile, refuses to start naming any missing setting (never its value), and answers a person privately. (CAP-1)
- FR2: Each hub is a slash command whose menu is built from registry data; a hidden entry is rejected at dispatch as well as left off the menu. (CAP-2)
- FR3: A module is one manifest plus one handler; a module made from the template appears in its hub with no engine edit, and a malformed manifest fails the check. (CAP-3)
- FR4: Menu visibility and every dispatch are decided by `kit/lib/permissions` against the profile through the person's Slack identity, with distinct messages for denied, unknown person and misconfigured key. (CAP-4)
- FR5: One LLM service assembles prompts from the profile and `.aplabs/context/`, dispatches tools, and stops at an hourly spend limit or a kill switch; no test calls a model. (CAP-5)
- FR6: Every external-system adapter has one shape and passes one shared contract test. (CAP-6)
- FR7: Brightside has a mock CRM and a mock email tool over the fixture; pushes are idempotent and visible in a local outbox; the fixture is never written. (CAP-7)
- FR8: Generated SQL runs only if it is one read-only statement that avoids the profile's forbidden columns; unterminated input fails closed. (CAP-8)
- FR9: One scoped-pull engine turns a plain-English request into a module's declared parameters, confirms them, runs a guarded query and delivers results privately; modules configure it, never copy it. (CAP-9)
- FR10: An approval-gated write previews, pushes only after the same person approves, and reports the outcome, safe against expiry, wrong person, double click, partial failure and the kill switch. (CAP-10)
- FR11: Slack basics: thread context, markdown to Slack with chunking, a provenance button with the exact SQL, first-run onboarding and help per hub, a TTL cache. (CAP-11)
- FR12: Scheduled jobs are declared as data and their runs logged; the template ships no jobs. (CAP-12)
- FR13: The Brightside Tier-1 dataset is generated deterministically into versioned seed files, built offline into a local DuckDB, validated, and publishable to MotherDuck by Ely. (CAP-13)
- FR14: In a fresh Brightside fork, a person in Slack goes plain-English request → scoped pull → scoring → approval → push to the mock email tool; scoring is deterministic with a reason per row. (CAP-14)
- FR15: Two forks differ only in their profile and their own modules. (CAP-15)

### NonFunctional Requirements

- NFR1: Runtime is Node 20 and bash.
- NFR2: Slack is the only surface; menus and typed forms, not an open chat box.
- NFR3: Private delivery by default; any channel delivery is a declared, tested exception.
- NFR4: Each new profile key lands with the story that reads it, schema-validated, unknown keys rejected; the profile never holds secrets.
- NFR5: Secrets come from env or the macOS Keychain at runtime; never in the repo, profile, logs or agent-visible output.
- NFR6: Tests and CI are offline and deterministic: no Slack, no model, no MotherDuck.
- NFR7: Synthetic data only (`.invalid` emails, 555-01xx phones).
- NFR8: Generated SQL is read-only and guarded; external writes only through a connector via the approval-gated archetype.
- NFR9: Scoring is deterministic and explainable; no LLM in the score.
- NFR10: One parameterised engine per archetype.
- NFR11: Every LLM call passes the breaker and kill switch, and a stopped call tells the person plainly.
- NFR12: Engine code is identical across forks; Brightside modules ship as examples.
- NFR13: Dependencies pinned exactly with a reason each.
- NFR14: No Hometown specifics outside `docs/reference/`.

### Additional Requirements

- Reuse `kit/lib/profile`, `kit/lib/permissions` and `kit/lib/tier`; Slack identities use the profile's existing `users[].identities.slack`.
- Slack runs in Socket Mode for dev.
- Every story follows the Orchestrator build loop: tier computed with `node kit/lib/tier`, a ledger row, `npm run review`, `npm run land`.
- Prior art per capability: `harvest-map.md`. Fixture tables: `fixture-tables.md`. Demo steps: `demo-flow.md`.
- Orchestrator Story 4.3 (prove onboarding on Brightside, DEP-004) becomes buildable after Epic 7 and stays tracked in `epics.md`.
- Human steps (Ely): create and install the Slack app and store its tokens (before live checks of Epic 6); store an LLM key with a console spend cap (before live checks of Epic 9); run the MotherDuck publish (Story 7.4). No story's CI depends on them.

### UX Design Requirements

- UX-DR1: Every reply is private (DM or ephemeral) unless an entry declares otherwise.
- UX-DR2: Every refusal or failure gives a plain-language reason and what to do next; none is silent.
- UX-DR3: Long output is split into sections under Slack's 3,000-character limit, and large results are delivered as a CSV file.
- UX-DR4: Every hub has a help entry, and a person's first visit to a hub shows a short welcome.
- UX-DR5: Every data result has a "How was this made?" button.

### FR Coverage Map

- FR1: Epic 6 (6.1), Epic 11 (11.2) - boot, private reply, container
- FR2: Epic 6 (6.2) - hub menus from the registry
- FR3: Epic 6 (6.2, 6.5) - module contract and template
- FR4: Epic 6 (6.3) - access from the profile
- FR5: Epic 9 (9.1) - LLM service and spend breaker
- FR6: Epic 8 (8.2) - connector contract
- FR7: Epic 8 (8.3, 8.4) - mock CRM and email tool
- FR8: Epic 8 (8.1) - SQL guardrails
- FR9: Epic 9 (9.3, 9.4) - scoped-pull engine
- FR10: Epic 10 (10.2, 10.3) - approval-gated write
- FR11: Epic 6 (6.4), Epic 9 (9.2, 9.5) - Slack basics
- FR12: Epic 11 (11.1) - scheduled jobs
- FR13: Epic 7 (7.1–7.5) - Brightside fixture
- FR14: Epic 10 (10.1, 10.4) - scoring and the demo flow
- FR15: Epic 11 (11.3, 11.4) - fork acceptance

## Epic List

### Epic 6: Hello from Slack
A person types a hub command in a fork's Slack app and sees a menu of the modules their profile allows; a builder adds a module by filling in a template.
**FRs covered:** FR1, FR2, FR3, FR4, FR11 (onboarding and help)

### Epic 7: Brightside's data
Builders and the bot work against a realistic, synthetic company that builds offline in seconds, validates itself, and is shared online for collaborators.
**FRs covered:** FR13

### Epic 8: Safe connections
Any system connects one standard way, the bot cannot write through SQL or reveal forbidden columns, and Brightside's mock CRM and email tool are ready to receive.
**FRs covered:** FR6, FR7, FR8

### Epic 9: Ask for data in plain English
A person asks for a list in plain English, confirms what the bot understood, and gets a private, explained result, within an LLM budget.
**FRs covered:** FR5, FR9, FR11 (formatting, thread context, provenance)

### Epic 10: Score, approve, push
The demo flow: a scored list goes to the mock email tool only after the person approves it, exactly once. Done-definition 3.
**FRs covered:** FR10, FR14

### Epic 11: Ready to fork
A new engagement forks the template, adds its profile and modules, and runs; scheduled jobs and a container are ready; two forks prove the engine is shared.
**FRs covered:** FR1 (container), FR12, FR15

## Epic 6: Hello from Slack

A person types a hub command in a fork's Slack app and sees a menu of the modules their profile allows; a builder adds a module by filling in a template.

### Story 6.1: The bot answers in Slack

**Implements:** FR1
**Estimate:** M

As a person at the client,
I want the bot to answer me when I message it,
So that I know the platform is live.

**Acceptance Criteria:**

**Given** the Slack tokens in env (or the macOS Keychain) and a valid profile
**When** the app starts in dev
**Then** it connects in Socket Mode, logs one startup line naming the client and the loaded profile, and replies privately to a direct message with a short greeting

**Given** a missing token or setting
**When** the app starts
**Then** it exits non-zero listing each missing variable by name, and no value of any secret appears in any output

**Given** an invalid profile
**When** the app starts
**Then** it refuses to start and lists the profile's validation errors
**And** the repo holds a Slack app manifest and a setup note for the human step (create the app, install it, store the tokens)
**And** Slack Bolt is pinned with its reason, and tests use a fake Slack client with no network

### Story 6.2: A hub menu built from the registry, with a hello-world module

**Implements:** FR2, FR3
**Estimate:** M

As a person at the client,
I want one command that shows me what the platform can do,
So that I don't have to remember module names.

**Acceptance Criteria:**

**Given** hub definitions and module manifests in the fork
**When** a person types a hub's slash command
**Then** a private Block Kit menu lists that hub's entries (label and one-line description), built from the registry with no hub-specific code

**Given** a person clicks an entry
**When** the action arrives
**Then** the module's handler runs and replies privately; the hello-world module replies with the person's name and the client's name
**And** an entry hidden for the current environment is left off the menu and rejected if its action arrives anyway
**And** until access wiring lands (6.3), only modules on an open-access resource can be registered
**And** tests build menus from fixture entries and cover dispatch, hidden entries and an unknown action id

### Story 6.3: People see only what the profile grants

**Implements:** FR4
**Estimate:** M

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
**And** an entry naming a resource key the profile does not declare fails the startup check, and at runtime is reported as a configuration fault, never as a denial
**And** tests cover allow, deny, deny-beats-allow, unknown person, open access and the misconfigured key with fixture profiles

### Story 6.4: First-run welcome and help on every hub

**Implements:** FR11
**Estimate:** S

As a new person at the client,
I want a short welcome and a help entry,
So that I can start without training.

**Acceptance Criteria:**

**Given** a person opening a hub for the first time since the app started
**When** the menu appears
**Then** a one-paragraph welcome for that hub appears above it, once per person per hub (in-memory)

**Given** any hub
**When** its menu is built
**Then** it ends with a Help entry that lists the hub's modules the person can use and how to give feedback
**And** a person joining the workspace gets a private welcome naming the hubs they can use
**And** tests cover first visit, repeat visit, help contents filtered by access, and the join welcome

### Story 6.5: A builder adds a module from the template

**Implements:** FR3
**Estimate:** S

As a builder in a client fork,
I want to add a module by copying a template,
So that a new tool takes minutes, not a day of wiring.

**Acceptance Criteria:**

**Given** the module template (a manifest, a handler and a test)
**When** a builder copies it, fills in hub, label, resource key and archetype, and restarts
**Then** the module appears in its hub with no engine file changed

**Given** a manifest with a missing field, an unknown archetype, an unknown hub or a duplicate id
**When** `npm run check` or app startup runs
**Then** it fails naming the module and the field
**And** a short guide explains each manifest field
**And** a test copies the template into a temp fork and asserts it registers

## Epic 7: Brightside's data

Builders and the bot work against a realistic, synthetic company that builds offline in seconds, validates itself, and is shared online for collaborators.

### Story 7.1: A deterministic generator writes versioned seed files

**Implements:** FR13
**Estimate:** L

As an AP Labs builder,
I want Brightside's data generated the same way every time and committed,
So that every test, demo and collaborator sees identical, reviewable data.

**Acceptance Criteria:**

**Given** the generator and a seed recorded in the repo
**When** I run the fixture generate command
**Then** it writes the Tier-1 tables in `fixture-tables.md` as seed files plus a schema file, using the toolchain Ely chose (recommended: Node)

**Given** the committed seed files
**When** CI regenerates them
**Then** the output is byte-identical, and any difference fails CI
**And** every email ends in `.invalid`, every phone is 555-0100 to 555-0199, names are generated, and money is integer cents
**And** history ends at a fixed `as_of` date; committed seed files total under 10 MB

### Story 7.2: The fixture builds into a local DuckDB, offline

**Implements:** FR13
**Estimate:** M

As an AP Labs builder,
I want one command that builds the database from the seed files,
So that I can query Brightside with no network and no credentials.

**Acceptance Criteria:**

**Given** the committed schema and seed files
**When** I run the fixture build command
**Then** a local DuckDB file is created in a gitignored path in under 60 seconds, with every table loaded and row counts recorded in `fixture_meta`
**And** tests get an isolated temporary database from the same files, never a shared path
**And** the DuckDB dependency is pinned with its reason, and the build runs in CI with networking unused

### Story 7.3: The fixture validates itself and carries known truths

**Implements:** FR13
**Estimate:** M

As SQLsmith (and anyone writing a query),
I want the data's integrity and a few known figures checked automatically,
So that a wrong number is caught by a test, not by a client.

**Acceptance Criteria:**

**Given** a built fixture
**When** the fixture validate command runs (also registered as a verify check)
**Then** it checks every rule in `fixture-tables.md` (foreign keys, orphans, invoice totals, payments vs invoices, visit vs plan dates, synthetic-only contact data) and prints pass or each failure

**Given** the known truths stored in `fixture_meta`
**When** validation runs
**Then** each is recomputed by its query and compared exactly
**And** a deliberately broken seed in a test fixture fails each rule once

### Story 7.4: Ely publishes the fixture to MotherDuck

**Implements:** FR13
**Estimate:** M

As Ely,
I want one command that publishes the validated fixture to MotherDuck,
So that a teammate and I query the same copy online.

**Acceptance Criteria:**

**Given** a MotherDuck token in env or the macOS Keychain
**When** Ely runs the fixture publish command
**Then** it refuses unless local validation passes, then replaces the shared database with the local build and records the fixture version
**And** the token is never printed, logged or written; a missing token exits 1 with how to configure it

**Given** the published copy
**When** anyone with access runs the fixture status command with the remote flag
**Then** it compares remote and local fixture versions and row counts and says whether they match
**And** tests use an injected fake connection; agents never run publish (Ely does, per AGENTS.md)

### Story 7.5: The bot shows which dataset it is using

**Implements:** FR13
**Estimate:** S

As a person at the client,
I want to see what data the bot is answering from,
So that I trust (or question) the numbers.

**Acceptance Criteria:**

**Given** the app's data source is the local fixture by default, or MotherDuck when configured
**When** an allowed person picks the Dataset entry
**Then** they see privately the source (local or shared), fixture version, `as_of` date and table row counts

**Given** the data source cannot be opened
**When** the app starts or the entry runs
**Then** the person is told plainly the data is unavailable, and the app keeps running
**And** the runtime opens the data source read-only, and tests cover local, missing and a fake remote source

## Epic 8: Safe connections

Any system connects one standard way, the bot cannot write through SQL or reveal forbidden columns, and Brightside's mock CRM and email tool are ready to receive.

### Story 8.1: SQL guardrails block writes and forbidden columns

**Implements:** FR8
**Estimate:** M

As a client admin,
I want every generated query checked before it runs,
So that the bot can never change data or expose a protected column.

**Acceptance Criteria:**

**Given** forbidden columns declared in the profile
**When** a query is checked
**Then** it is blocked if it is not a single read-only statement, names a forbidden column, or selects a wildcard while any forbidden column is configured (including inside a CTE, after `TOP n`, or as a quoted `"t".*`)
**And** a comment marker inside a string literal does not hide anything, and an unterminated string or comment fails closed

**Given** a blocked query
**When** the result is returned
**Then** it names the rule that blocked it, and the query does not run
**And** tests cover every case above plus DDL, DML and stacked statements

### Story 8.2: One connector contract and a template

**Implements:** FR6
**Estimate:** M

As a builder in a client fork,
I want one shape for every external system,
So that each new integration is safe by default and reviewable the same way.

**Acceptance Criteria:**

**Given** the connector template
**When** a builder fills it in for a system
**Then** it declares its auth env var names (never values), its read and write operations, dry-run, idempotency keys, a kill-switch env var and a rate limit

**Given** any connector
**When** the shared contract test suite runs against it
**Then** it checks that writes honour dry-run and the kill switch, a repeated idempotency key changes nothing, rate limits are respected, and errors never include credentials
**And** the suite passes against the template adapter, and a connection-standard document template is provided for Connector to fill per system

### Story 8.3: Brightside's mock CRM

**Implements:** FR7
**Estimate:** M

As an AP Labs builder,
I want a CRM stand-in over the fixture,
So that modules can look up and update clients without a real vendor.

**Acceptance Criteria:**

**Given** the built fixture
**When** a module looks up a client by id, email or name
**Then** the mock CRM returns the client record from the fixture

**Given** an update to a client
**When** it is written
**Then** it lands in the local outbox (gitignored) and later lookups reflect it, while the fixture database is unchanged
**And** the mock CRM passes the 8.2 contract suite, and a config toggle simulates failures and rate limits for tests

### Story 8.4: Brightside's mock email tool and the Outbox

**Implements:** FR7
**Estimate:** M

As a person at the client,
I want to see what was sent to the email tool,
So that I can confirm a push landed.

**Acceptance Criteria:**

**Given** the mock email tool
**When** a connector call creates a list or adds contacts
**Then** the outbox records each list and contact with the idempotency key, and a repeated key adds nothing

**Given** an allowed person
**When** they pick the Outbox entry
**Then** they see privately the latest lists, their contact counts and a sample, newest first
**And** the mock passes the 8.2 contract suite, and tests cover create, add, repeat and the Outbox view

## Epic 9: Ask for data in plain English

A person asks for a list in plain English, confirms what the bot understood, and gets a private, explained result, within an LLM budget.

### Story 9.1: An LLM service with a spend breaker and kill switch

**Implements:** FR5
**Estimate:** M

As a client admin,
I want one LLM client that knows our company and cannot run up a bill,
So that every module gets good answers within budget.

**Acceptance Criteria:**

**Given** an API key in env or the macOS Keychain
**When** a module calls the LLM service
**Then** the system prompt is assembled from the profile's client name and `.aplabs/context/` files when present, and tool calls are dispatched to declared tool handlers with a cap on tool rounds and a timeout

**Given** estimated spend in the last hour above the configured limit, or the kill-switch env var set
**When** a call is attempted
**Then** it is refused before any request, and the caller gets a typed error the module turns into a plain message
**And** the Anthropic SDK is pinned with its reason; the model is configurable
**And** tests use a stubbed client and cover prompt assembly, tool dispatch, round cap, timeout, breaker trip and kill switch; no test calls a model

### Story 9.2: Slack formatting, chunking and thread context

**Implements:** FR11
**Estimate:** S

As a person at the client,
I want answers that read well in Slack, however long,
So that I never get a cut-off or garbled reply.

**Acceptance Criteria:**

**Given** markdown output
**When** it is sent to Slack
**Then** headings, bold, links, lists and code convert to Slack formatting, and text is split on line boundaries into sections under 2,900 characters

**Given** a reply in a thread
**When** a module needs earlier messages
**Then** the thread's messages are fetched oldest first and converted to the LLM's message format, bot messages marked as assistant
**And** a TTL cache helper (get, set, expiry) is available to modules
**And** tests cover each conversion, a long body, a thread fetch with a fake client and cache expiry

### Story 9.3: A plain-English request becomes confirmed parameters

**Implements:** FR9
**Estimate:** L

As a person at the client,
I want to describe the list I need in my own words and check what the bot understood,
So that I get the right data without learning a query tool.

**Acceptance Criteria:**

**Given** a scoped-pull module whose manifest declares its parameters (name, type, allowed values or range, default, required)
**When** a person types a request into the module
**Then** the engine extracts values for those parameters only and shows them privately with Confirm and Change buttons

**Given** a missing required parameter or a value outside the declared range
**When** extraction finishes
**Then** the engine asks one plain question for it instead of guessing

**Given** an open session
**When** 30 minutes pass without activity
**Then** it closes, and a later reply is told the session expired, not silently ignored
**And** the first consumer is the Brightside example module "Win-back list" (`demo-flow.md` step 2), shipped as an example, not engine
**And** tests with a stubbed LLM cover a full request, a missing value, an out-of-range value, Change, and expiry

### Story 9.4: The guarded query runs and the results arrive privately

**Implements:** FR9
**Estimate:** M

As a person at the client,
I want my confirmed request turned into results I can use,
So that I get the list in Slack and as a file.

**Acceptance Criteria:**

**Given** confirmed parameters
**When** the engine runs
**Then** it builds the module's query from them, passes it through the SQL guardrails (8.1), runs it read-only against the data source (7.5), and replies privately with the row count, the first rows and a CSV of all rows

**Given** a guardrail block, a query error or zero rows
**When** the engine finishes
**Then** the person gets a plain message saying which, and nothing partial is delivered as complete
**And** a second Brightside example module (for example "Unpaid invoices") uses the same engine with only a manifest and query, proving no copy is needed
**And** tests on a temp fixture assert the exact rows for a scripted request on both modules

### Story 9.5: "How was this made?"

**Implements:** FR11
**Estimate:** S

As a person at the client,
I want to see how a result was produced,
So that I can trust it or challenge it.

**Acceptance Criteria:**

**Given** any scoped-pull result
**When** it is delivered
**Then** it carries a "How was this made?" button

**Given** a click on it by the person who ran the pull
**When** the action arrives
**Then** they see privately the confirmed parameters, the exact SQL that ran, the data source and fixture version, and the run time
**And** after the cache expires, the button says the details are no longer available rather than failing
**And** tests cover the shown SQL matching the SQL executed, a different person clicking, and expiry

## Epic 10: Score, approve, push

The demo flow: a scored list goes to the mock email tool only after the person approves it, exactly once. Done-definition 3.

### Story 10.1: Deterministic scoring with a reason per row

**Implements:** FR14
**Estimate:** M

As a person at the client,
I want the list ranked with a reason I can read,
So that I work the best prospects first and can explain why.

**Acceptance Criteria:**

**Given** a module manifest that declares scoring inputs and weights
**When** pull results are scored
**Then** each row gets a score and a one-line reason naming its top contributing inputs, and rows are ordered by score with a stable tie-break

**Given** the same data and weights
**When** scoring runs twice
**Then** scores and order are identical
**And** no LLM is involved, the Win-back module declares the inputs in `demo-flow.md`, and tests assert exact scores on fixture rows

### Story 10.2: Preview and approve before anything is pushed

**Implements:** FR10
**Estimate:** M

As a client admin,
I want every push previewed and approved by the person who asked,
So that nothing reaches an external tool by accident.

**Acceptance Criteria:**

**Given** a scored result and a module with an approval-gated write
**When** the person clicks Push
**Then** they see privately the destination, the row count and a sample, with Approve and Cancel

**Given** the preview
**When** it is created
**Then** an opaque random token (at least 128 bits) bound to that person and that row set is stored for 30 minutes, and the button carries only the token

**Given** an Approve click
**When** the token is expired, unknown, or belongs to someone else
**Then** the same "this preview is no longer valid" reply is given in each case, and nothing is pushed or consumed
**And** Cancel ends the session with a confirmation, and tests cover each case

### Story 10.3: Push once, report honestly, escalate quietly

**Implements:** FR10
**Estimate:** M

As a person at the client,
I want an approved push to happen once and tell me exactly what happened,
So that I never double-send or think a failed push worked.

**Acceptance Criteria:**

**Given** a valid Approve
**When** the push runs
**Then** the token is consumed just before the first write, the rows are re-derived server-side from the token's stored set, and each row is written through the connector with an idempotency key

**Given** a double click or a replayed payload
**When** the second Approve arrives
**Then** nothing more is pushed and the person is told it was already done

**Given** some rows fail, or the connector's kill switch is on
**When** the push finishes or is refused
**Then** the person sees pushed, skipped and failed counts with reasons, and a failure posts one escalation to the profile's ops channel, suppressing repeats of the same reason within a window
**And** tests cover success, double click, partial failure, kill switch and suppression with the mock email tool

### Story 10.4: The demo flow, end to end

**Implements:** FR14
**Estimate:** M

As Ely,
I want the whole demo to run in CI and live,
So that I can show a client the template working on Brightside.

**Acceptance Criteria:**

**Given** a fresh copy of the template configured with the Brightside profile and example modules
**When** the acceptance test drives fake Slack through every step in `demo-flow.md`
**Then** the mock email tool's outbox holds exactly the approved, scored list once, and every message went privately to the requesting person
**And** with the LLM kill switch on, step 3 says so plainly and the flow stops cleanly

**Given** a demo script in the repo
**When** Ely follows it in the live Slack app
**Then** Ely sees the same steps (human check, recorded in the PR)
**And** the test runs offline in CI

## Epic 11: Ready to fork

A new engagement forks the template, adds its profile and modules, and runs; scheduled jobs and a container are ready; two forks prove the engine is shared.

### Story 11.1: Scheduled jobs declared as data

**Implements:** FR12
**Estimate:** S

As a builder in a client fork,
I want to add a scheduled job as one registry entry,
So that recurring reports need no new plumbing.

**Acceptance Criteria:**

**Given** registry entries (name, schedule, run, enabled)
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

As an AP Labs consultant,
I want a generic container definition,
So that a fork can deploy on whatever host the client uses.

**Acceptance Criteria:**

**Given** the container definition
**When** it is built and started with the required env
**Then** the app boots as in 6.1 and exposes a health signal the host can check
**And** no secret is baked into the image, and the host choice is left to the fork
**And** CI builds the image or, where Docker is unavailable, a check validates the definition and reports skipped, never passed

### Story 11.3: Two forks differ only by profile and modules

**Implements:** FR15
**Estimate:** M

As an AP Labs consultant,
I want proof that the engine is shared,
So that a fix in the template reaches every engagement.

**Acceptance Criteria:**

**Given** two fixture clients, each with its own profile and modules
**When** the acceptance test builds two forks in temp directories
**Then** every engine file is identical between them, and the only differences are each fork's profile, hubs and modules

**Given** each fork booted with a fake Slack client
**When** the same person id opens each fork's hub
**Then** each shows its own client name, menus and access from its own profile
**And** the test runs offline in CI

### Story 11.4: The engagement fork guide

**Implements:** FR15
**Estimate:** S

As an AP Labs consultant starting an engagement,
I want a day-one checklist,
So that a new fork is running before the deep dive ends.

**Acceptance Criteria:**

**Given** the guide
**When** a consultant follows it in a fresh fork
**Then** it covers: write the client profile, remove the Brightside examples, create the Slack app from the manifest, store tokens and the LLM key with a spend cap, build or connect the data source, add the first module from the template, and run the onboarding build
**And** each human-only step (anything with a credential) is marked as such
**And** a structural test fails when the guide names a command or file that does not exist
