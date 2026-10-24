---
id: SPEC-runtime
companions:
  - harvest-map.md
  - fixture-tables.md
  - demo-flow.md
sources:
  - ../../../PLAN-v1.md
  - ../../../adr/0002-engagement-starter-template.md
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
  - **intent:** Each hub is a slash command whose menu is built from registry data; adding an entry is data only.
  - **success:** Tests build menus from fixture entries, a click dispatches the right handler, and a hidden entry is rejected at dispatch as well as left off the menu.
- **CAP-3**
  - **intent:** A module is one manifest (hub, label, resource key, archetype, parameters) plus one handler.
  - **success:** A module made from the template appears in its hub with no engine edit; a malformed manifest fails the check.
- **CAP-4**
  - **intent:** Menu visibility and every dispatch are decided by `kit/lib/permissions` against the profile, through the person's Slack identity.
  - **success:** Tests cover allow, deny-beats-allow, an unknown person and a misconfigured resource key, each with a distinct plain message.
- **CAP-5**
  - **intent:** One LLM service assembles prompts from the profile and `.aplabs/context/`, defines and dispatches tools, and stops at an hourly spend limit or a kill switch.
  - **success:** Stubbed-client tests cover prompt assembly, tool dispatch, breaker trip, kill switch and timeout; no test calls a model.
- **CAP-6**
  - **intent:** Every external-system adapter has one shape (auth from named env vars, read vs write operations, dry-run, idempotency key, kill switch, rate limit).
  - **success:** One shared contract test suite passes against the template adapter and the mock connector.
- **CAP-7**
  - **intent:** Brightside has a mock CRM (look up, update a client) and a mock email tool (create a list, add contacts) over the fixture.
  - **success:** Both pass the contract tests; a repeated push changes nothing; every write is visible in a local outbox and never touches the fixture.
- **CAP-8**
  - **intent:** Generated SQL runs only if it is one read-only statement that avoids the profile's forbidden columns.
  - **success:** Tokenizer tests block DDL, DML, multiple statements, forbidden columns (including any wildcard select while forbidden columns are configured, through CTEs, `TOP n *` and quoted stars), and fail closed on unterminated strings or comments; comment markers inside literals do not confuse it.
- **CAP-9**
  - **intent:** One scoped-pull engine turns a plain-English request into the module's declared parameters, confirms them with the person, runs a guarded query and delivers the results privately.
  - **success:** A scripted conversation on the fixture yields the expected parameters and rows; a second module configures the same engine without copying it.
- **CAP-10**
  - **intent:** An approval-gated write shows a preview (count, sample, destination), pushes only after the same person approves, and reports the outcome.
  - **success:** Tests cover approve, cancel, expiry, wrong person, double click, partial failure, kill switch and suppressed repeat escalations.
- **CAP-11**
  - **intent:** Slack basics every module reuses: thread context, markdown to Slack with long-output chunking, a provenance button (parameters and SQL), first-run onboarding and help per hub, a TTL cache.
  - **success:** Unit tests per helper; the provenance button shows the exact SQL that ran.
- **CAP-12**
  - **intent:** Scheduled jobs are declared as data (name, schedule, run, enabled), and their runs are logged.
  - **success:** Fake-clock tests show enabled jobs run, disabled ones skip, and a failing job is logged without crashing the app; the template ships no jobs.
- **CAP-13**
  - **intent:** The Brightside Tier-1 dataset (`fixture-tables.md`) is generated deterministically into versioned seed files, built offline into a local DuckDB, validated, and publishable to MotherDuck by Ely.
  - **success:** The same seed gives identical files; the offline build takes under 60 seconds; integrity, synthetic-only and known-truth checks pass; CI needs no network.
- **CAP-14**
  - **intent:** In a fresh fork configured for Brightside, a person in Slack goes from a plain-English request through scoped pull, scoring and approval to a push to the mock email tool (`demo-flow.md`).
  - **success:** An end-to-end acceptance test through fake Slack, the fixture and the mock passes in CI; Ely runs the same flow live in Slack.
- **CAP-15**
  - **intent:** Two forks differ only in their profile and their own modules.
  - **success:** An acceptance test builds two forks from fixture profiles: engine files identical, each boots its own hubs and access.

## Constraints

- Runtime is Node 20 and bash. Only the fixture toolchain is open.
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
- No Hometown specifics outside `docs/reference/`. Varsity is read for patterns only (`harvest-map.md`).

## Non-goals

- Real client connectors, a CRM vendor choice, or a production warehouse or data.
- Surfaces other than Slack.
- Archetypes beyond scoped pull and approval-gated write.
- A conversational chat agent.
- The FAST lane.
- A durable session store (in-memory with TTL only).
- Cost rollups or dashboards beyond the breaker.
- A production hosting choice.
- Real scheduled jobs.

## Success signal

- In a fresh fork configured for Brightside, Ely types the hub command in Slack, asks in plain English for lapsed clients to win back, confirms the parameters, sees a scored list, approves, and the mock email tool's outbox shows exactly that list once, even after a second click on Approve. The same flow passes as a CI acceptance test with no network.

## Assumptions

- Slack runs in Socket Mode for dev (no public URL). HTTP mode is a fork deploy choice.
- Tier 1 means about 1–3k clients and 24 months of visits; committed seed files stay under 10 MB.
- Seed data is versioned as committed generated files plus the generator. CI regenerates and fails on any diff.
- Mock tools persist to a gitignored local outbox. The runtime never writes the fixture database.
- Story 4.3 of the Orchestrator epics (prove onboarding on Brightside, DEP-004) stays there and becomes buildable once this phase's fixture lands.

## Open Questions

- **Fixture language:** Python 3.12 + `uv` for `fixtures/` only, or Node throughout? Recommend Node throughout: one toolchain in CI and forks, DuckDB is needed in Node anyway, and a seeded JS generator is enough for Tier 1.
- **Slack app (Ely):** create the app from the repo manifest in which workspace? Recommend a dedicated AP Labs dev workspace (not Hometown), Socket Mode; Ely stores the bot, app-level and signing tokens locally.
- **MotherDuck (Ely):** confirm the venture-email account, the invited collaborator, and that a read-only share fits the plan. Recommend Ely runs `fixture:publish` after the fixture epic merges; agents never run it.
- **LLM in the bot:** Claude API with a metered venture key, an hourly breaker (default USD 2/hour), a kill-switch env var and a console spend cap; or form-only parameters with no LLM? Recommend the Claude API with the breaker, a cheaper model for parameter extraction, configurable.
- **Mock connector shape:** in-process adapters writing a local outbox shown in Slack, or a local HTTP mock server? Recommend in-process: offline, simpler, same contract test.
- **Demo scenario (PLAN §5):** recommend a win-back campaign (`demo-flow.md`).
- **Profile schema:** add runtime keys as optional, additive keys under `schema_version: 1`, or bump to 2? Recommend additive under v1; nothing is deployed.
- **Deploy files:** ship a generic container definition and leave the host to each fork? Recommend yes.
