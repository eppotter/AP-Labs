---
owner: Dana Reyes          # the named client person who owns this file
signed_off: 2026-10-25  # pending, or the ISO date (YYYY-MM-DD) the owner signed off
signed_off_by: "Dana Reyes (Ely as Dana Reyes, 2026-10-25)"  # who signed off: the owner, recorded by a facilitator
updated: 2026-10-25        # ISO date of the last edit
---

# Connectors

Written by the Onboarder for Connector. Record how each system authenticates, never the
credential itself.

Brightside's CRM and email tool are mocks (no real vendor). Every entry is **draft** until Dana
Reyes signs it with a date.

## Systems

<!--
One entry per system the client uses:

### System name
- owner: the client person who owns the system
- purpose: what the client uses it for
- auth: the mechanism (OAuth app, service account, API key held in the secret store); never the secret
- read path: the one approved way to read, and its scope
- write path: the one approved way to write, its human gate and kill switch (or "none: read-only")
- bulk path: how large reads or writes are done, if different
- limits: rate limits, batch sizes, row caps, cost per call
- notes: known failure modes and quirks

Contract fields (what the system's connector declares; kit/templates/connector.md):
- connector id: the app's connector folder (app/connectors/<id>)
- auth env: the env var names holding its credentials, never the values ("none" for a mock)
- kill-switch env: the env var that turns its writes off (APLABS_WRITES_OFF turns off every connector)
- rate limit: calls per second the connector keeps to
- batch size: the most items in one call
- idempotency: the key each write takes and how it is built, and whether the system also dedupes
- dry run: what a dry run of each write shows
-->

### MotherDuck (the data source)
- owner: Ely (AP Labs) for the demo; in a fork, the client's data owner. Dana to confirm.
- purpose: the shared, read-only copy of the Brightside data (database `brightside_fixture`).
  Not a connector: the query runner (`kit/runtime/data`) reads it when the profile says
  `data.source: motherduck`. Brightside's profile in this repo stays `local` (the built fixture
  file), so CI and tests stay offline.
- auth: a read-scaling token for a separate read-only service account that holds only the share,
  from `MOTHERDUCK_READ_TOKEN` or the Keychain item `aplabs-motherduck-read-token`. The publish key
  (`MOTHERDUCK_TOKEN`, Keychain `aplabs-motherduck-token`) is Ely's alone; the bot refuses to start
  if the two are equal and never keeps the publish key.
- read path: one bound, read-only query at a time, through the SQL guardrail and the profile's
  forbidden columns, over the locked reader sequence (guardrails.md GRD-003).
- write path: none from the bot. `fixture:publish`, run by Ely, is the only way the data changes.
- limits: 10 seconds to connect, 30 seconds a query. A non-catalog error drops the connection and
  the bot waits 30 seconds to reconnect.
- notes: after a re-publish the share lags about 60 seconds; a publish that adds tables shows
  "data unavailable" for a minute or two. No fallback to the local file.

### Brightside CRM (mock)
- owner: Dana Reyes
- purpose: look up one client the standard way (Story 8.2): the contract's read-path example.
- auth: none: a mock over the fixture, read through the app's query runner.
- read path: `lookupClient` by `client_id` or by email (trimmed, lower-cased). Returns only
  `client_id`, `first_name`, `last_name`, `email`, `zone_id`, or the subset asked for; never phone
  or address. Unknown client: null.
- write path: none: read-only.
- connector id: `crm` (`examples/brightside/app/connectors/crm/`)
- auth env: none
- kill-switch env: `BRIGHTSIDE_CRM_OFF` (required by the contract; there are no writes to stop)
- rate limit: 5 calls a second; a 429 is retried within the limit, then fails
- batch size: 1 (one client per lookup)
- idempotency: not applicable (no writes)
- dry run: not applicable (no writes)

### Brightside email tool (mock)
- owner: Dana Reyes
- purpose: receive the win-back list (Story 8.3): the contract's write-path example. The "system"
  is the outbox file `var/outbox/email.jsonl` (under `APLABS_VAR_DIR`, gitignored). The `OUTBOX`
  entry (gated; the admin role has it) shows what it received.
- auth: none: a mock.
- read path: none through the connector. The Outbox entry reads the file for display only.
- write path: `createList` (a list named with the run date) and `addContacts` (each contact exactly
  `external_ref` = client_id, `email`, `first_name`; any other field is refused). Human gate: the
  approval-write archetype (Epic 10, not built yet). Kill switch: below.
- bulk path: `addContacts` sends in batches of at most 100.
- connector id: `email` (`examples/brightside/app/connectors/email/`)
- auth env: none
- kill-switch env: `BRIGHTSIDE_EMAIL_OFF`; `APLABS_WRITES_OFF` turns off every connector. Any
  non-empty value is on; checked on every call and before every batch.
- rate limit: 5 calls a second
- batch size: 100
- idempotency: each write takes an idempotency key. Each contact is keyed
  `<write key>:<list id>:<external_ref>`, and the tool adds only keys it hasn't seen, so a retry
  sends only the contacts that failed. The outbox file is the idempotency store, so a repeat adds
  nothing even after a restart.
- dry run: `createList` shows `{ create: 'list', name }`; `addContacts` shows the list id and how
  many contacts it would add. Nothing is sent.
- notes: if the outbox can't be read or has a torn line, every write fails closed; one process
  writes at a time (a lockfile).

## Missing connections

<!-- Connections a build needs that do not exist yet, each with the owner who must create it. -->

- **A real CRM and email tool:** none exist for Brightside (fictional). A fork replaces the mocks
  with the client's systems; owner: the client's system owner.
- **The Anthropic API key** for the AI service (`ANTHROPIC_API_KEY`, Keychain
  `aplabs-anthropic-key`) and its console spend cap: DEP-018, owner Ely. Without it the AI is off
  and the forms still work.

## Rule cards

<!-- Integration rules in the rule card form (rule, owner, evidence, status), as in guardrails.md. -->

### CON-001: One approved path per system
- rule: each system has one connector, and every call goes through it (`defineConnector`, shared
  contract tests). No module talks to a system directly.
- owner: Dana Reyes
- evidence: `kit/templates/connector.md`; `connectorContract` tests in each connector folder.
- status: draft

### CON-002: Least-privilege fields
- rule: a connector fetches or sends only the fields its job needs. The CRM returns five client
  fields; the email tool accepts three per contact. Forbidden columns never pass.
- owner: Dana Reyes
- evidence: `FIELDS` in the CRM connector; the contact check in the email connector; their tests.
- status: draft

### CON-003: Credentials by mechanism only
- rule: a connector declares the env var names of its credentials, never the values. Keys live in
  env or the macOS Keychain and are masked in every log line. The mocks declare none.
- owner: Dana Reyes
- evidence: the contract's `auth.env`; `kit/lib/secrets`; the log redactor.
- status: draft
