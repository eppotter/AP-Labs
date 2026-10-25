---
id: SPEC-runtime
companions:
  - fixture-tables.md
  - demo-flow.md
  - connector-review.md
sources:
  - ../../../PLAN-v1.md
  - ../../../adr/0002-engagement-starter-template.md
  - ../../planning-artifacts/architecture-runtime.md
  - ../../../reference/runtime-harvest-map.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# AP Labs runtime

## Why

A vision to realise. The Orchestrator gives builders a governed way to build; the runtime is what the client's people actually use. On day one of an engagement we fork this template and need a Slack app that already boots, routes people to modules they are allowed to use, talks to an LLM within a budget, connects to client systems one standard way, and ships the two module shapes Varsity proved: a plain-English scoped pull and an approval-gated write. Without it every engagement rebuilds Varsity from scratch. Brightside Home Cleaning, a fictional client with a synthetic dataset, proves the blocks end to end (PLAN-v1 done-definitions 1, 2, 3, 5 and 6).

## Capabilities

- **CAP-1**
  - **intent:** A fork's Slack app boots in dev from env and the profile, refuses to start when a setting is missing (naming it, never its value), and answers a person privately.
  - **success:** Boot tests with a fake Slack client cover ok, missing env and invalid profile; Ely sees a private reply in Slack.
- **CAP-2**
  - **intent:** Each hub is a slash command whose menu is built from registry data. Adding an entry is data only; adding a hub is data plus a regenerated Slack app manifest.
  - **success:** Tests build menus from fixture entries, a click dispatches the right handler, and a hidden entry is rejected at dispatch as well as left off the menu; a check fails when the app manifest's slash commands differ from the hub files.
- **CAP-3**
  - **intent:** A module is one manifest (hub, label, resource key, archetype, parameters) plus one handler.
  - **success:** A module made from the template appears in its hub with no engine edit; a malformed manifest fails the check.
- **CAP-4**
  - **intent:** Menu visibility and every dispatch are decided by `kit/lib/permissions` against the profile, through the person's Slack identity.
  - **success:** Tests cover allow, deny-beats-allow, an unknown person and a misconfigured resource key, each with a distinct plain message.
- **CAP-5**
  - **intent:** One LLM service assembles prompts from the profile and a declared list of context files from `contextDirFor(profilePath)` (in template dev, `profiles/brightside/context/`), makes one structured extraction call, and stops at a kill switch, a per-person rate limit or an hourly spend limit. No LLM-callable tool can run SQL or a connector write.
  - **success:** Stubbed-client tests cover prompt assembly, the declared context list, structured output, per-call token cap, rate limit, breaker trip, kill switch, timeout and the price table; no test calls a model.
- **CAP-6**
  - **intent:** Every external-system adapter has one shape (auth from named env vars, read vs write operations, dry-run, idempotency key, kill switch, rate limit).
  - **success:** One shared contract test suite passes against the template adapter and the mock connector.
- **CAP-7**
  - **intent:** Brightside has a mock CRM (look up a client: the contract's read path) and a mock email tool (create a list, add contacts: the write path) over the fixture (`connector-review.md`).
  - **success:** Both pass the contract tests; a repeated push changes nothing; every write is visible in a local outbox under `var/outbox/` and never touches the fixture.
- **CAP-8**
  - **intent:** SQL runs only through one query runner, which opens the data read-only with DuckDB's external access and extension loading off, and runs a query only if it is one read-only statement that avoids the profile's forbidden columns and DuckDB's file, network and environment functions.
  - **success:** Tokenizer tests block DDL, DML, multiple statements, `ATTACH`/`SET`/`PRAGMA`/`INSTALL`/`LOAD`/`COPY`, file, network and env table functions, forbidden columns (including any wildcard select while forbidden columns are configured, through CTEs, `TOP n *` and quoted stars), and fail closed on unterminated strings or comments; comment markers inside literals do not confuse it; a test asserts the guardrail runs on every runner call.
- **CAP-9**
  - **intent:** One scoped-pull engine fills the module's declared, typed parameters (from a typed form, or from plain English via the LLM), confirms them with the person, binds them into the module's static query, runs it through the runner and delivers the results privately (files only to the person's DM).
  - **success:** A scripted conversation on the fixture yields the expected parameters and rows; with the LLM off, the typed form gives the same rows; a second module configures the same engine without copying it.
- **CAP-10**
  - **intent:** An approval-gated write shows a preview (count, sample, destination), pushes only after the same person approves, and reports the outcome.
  - **success:** Tests cover approve, cancel, expiry, wrong person, double click, partial failure, kill switch and suppressed repeat escalations.
- **CAP-11**
  - **intent:** Slack basics every module reuses: acknowledge-first handling, markdown to Slack with long-output chunking, a provenance button (parameters and SQL), first-run onboarding and help per hub, one TTL store. (Round 3: thread context to the LLM is deferred; rows must never reach the LLM.)
  - **success:** Unit tests per helper; the provenance button shows the exact SQL that ran.
- **CAP-12**
  - **intent:** Scheduled jobs are declared as data (name, schedule, run, enabled), and their runs are logged.
  - **success:** Fake-clock tests show enabled jobs run, disabled ones skip, and a failing job is logged without crashing the app; the template ships no jobs.
- **CAP-13**
  - **intent:** The Brightside Tier-1 dataset (`fixture-tables.md`) is generated deterministically into versioned seed files, built offline into a local DuckDB, validated, and publishable to MotherDuck by Ely. Its known truths are `truth` blocks in Brightside's `context/data.md`, run by `npm run verify`.
  - **success:** The same seed gives identical files; the offline build takes under 60 seconds; integrity and synthetic-only checks pass; every known truth matches its planted value; CI needs no network.
- **CAP-14**
  - **intent:** In a fresh fork configured for Brightside, a person in Slack goes from a plain-English request through scoped pull, scoring and approval to a push to the mock email tool (`demo-flow.md`).
  - **success:** An end-to-end acceptance test through fake Slack, the fixture and the mock passes in CI; Ely runs the same flow live in Slack.
- **CAP-15**
  - **intent:** Two forks differ only in their profile and their own modules.
  - **success:** An acceptance test builds two forks from fixture profiles: engine files identical, each boots its own hubs and access.

## Constraints

- Runtime is Node 24 (LTS) and bash (ADR 0004; was Node 20). Only the fixture toolchain is open.
- Slack is the only surface. The module contract stays surface-agnostic in shape; only the Slack adapter ships.
- The consumer surface is menus and typed forms, not an open chat box. Plain English enters through a module's input.
- Private delivery by default (DM or ephemeral). Channel delivery is a declared, tested exception.
- Each new profile key lands with the story that reads it, validated by the schema; unknown keys are rejected. The profile never holds secrets.
- Secrets (Slack tokens, LLM key, MotherDuck token) come from env or the macOS Keychain at runtime. Never in the profile, repo, logs or agent-visible output.
- Tests and CI are offline and deterministic: no Slack, no model, no MotherDuck. The fixture database is built from committed seed files.
- Synthetic data only: fictional names, emails on `.invalid`, phones 555-01xx. Validation fails the build otherwise.
- Generated SQL is read-only and passes the guardrails before it runs. External writes go only through a connector, via the approval-gated archetype.
- Scoring is deterministic and explainable: declared weights, a reason per row, no LLM in the score.
- One parameterised engine per archetype. Modules configure it; they never clone it.
- Every LLM call passes the spend breaker and kill switch. When either stops a call, the person gets a plain message, never silence.
- Engine code is identical across forks. Hubs, modules and the profile are the only per-fork files. Brightside demo modules ship as examples, not engine.
- Dependencies are pinned exactly with a one-line reason each (expected: Slack Bolt, DuckDB, the Anthropic SDK).
- No Hometown specifics outside `docs/reference/`. Varsity is read for patterns only (`docs/reference/runtime-harvest-map.md`).
- The runtime finds its profile through `kit/lib/profile` (`APLABS_PROFILE`, an absolute path, in template dev and the container). The template repo never holds `.aplabs/profile.yml`.
- One process per deployment: short-lived state lives in memory.
- Architecture decisions (engine/fork paths, manifest format, store, data access, LLM isolation, secrets, health): `architecture-runtime.md`, AD-1 to AD-18.

## Non-goals

- Real client connectors, a CRM vendor choice, or a production warehouse or data.
- Surfaces other than Slack.
- Archetypes beyond scoped pull and approval-gated write.
- A conversational chat agent.
- The FAST lane.
- A durable session store (in-memory with TTL only), or more than one replica.
- The bot reading MotherDuck (V1 reads the local fixture; MotherDuck is for people).
- Cost rollups or dashboards beyond the breaker.
- A production hosting choice.
- Real scheduled jobs.

## Success signal

- In a fresh fork configured for Brightside, Ely types the hub command in Slack, asks in plain English for lapsed clients to win back, confirms the parameters, sees a scored list, approves, and the mock email tool's outbox shows exactly that list once, even after a second click on Approve. The same flow passes as a CI acceptance test with no network.

## Assumptions

- Slack runs in Socket Mode for dev (no public URL). HTTP mode is a fork deploy choice.
- Tier 1 means about 1–3k clients and 24 months of visits; committed seed files stay under 20 MiB (raised from 10 MB on 2026-10-24 (Ely) for labour/homes/scheduling; to be restored by compressing seeds).
- Seed data is versioned as committed generated files plus the generator. CI regenerates and fails on any diff.
- Mock tools persist to a gitignored local outbox (`var/outbox/`). The runtime never writes the fixture database.
- Story 4.3 of the Orchestrator epics (prove onboarding on Brightside, DEP-004) stays there and becomes buildable once Epic 7 lands; it reuses the truth blocks Story 7.6 writes into Brightside's `context/data.md`.

## Open Questions

Decided in round 2 (recorded in the memlog): Slack workspace (the existing `aplabs-demo`), the mock connector shape (in-process), email allowed and phone and address forbidden for Brightside, and the architecture (`architecture-runtime.md`).

- **Fixture language:** Python 3.12 + `uv` for the fixture only, or Node throughout? Recommend Node throughout: one toolchain in CI and forks, DuckDB is needed in Node anyway, and a seeded JS generator is enough for Tier 1.
- **MotherDuck (Ely):** confirm the venture-email account, the invited collaborator, and that a read-only share fits the plan. Recommend Ely runs `fixture:publish` after Epic 7 merges; agents never run it. The bot reading MotherDuck needs an approved read-only service token and an injection path (DEP row, approver Ely).
- **LLM in the bot:** Claude API with a metered venture key, an hourly breaker (default USD 2/hour), a kill switch and a console spend cap; or form-only parameters with no LLM? Recommend the Claude API with the breaker, a cheaper model for parameter extraction, configurable; the typed form is the fallback either way.
- **Demo scenario (PLAN §5):** recommend a win-back campaign (`demo-flow.md`).
- **Profile schema:** add runtime keys as optional, additive keys under `schema_version: 1`, or bump to 2? Recommend additive under v1; nothing is deployed.
- **Deploy files:** ship a generic container definition and leave the host to each fork? Recommend yes.
