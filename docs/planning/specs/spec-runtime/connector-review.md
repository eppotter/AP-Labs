# Connector review: the contract and Brightside's mocks (CAP-6, CAP-7)

Recorded by a Connector pass in round 2, for Stories 8.1–8.3 and 10.3. Brightside has no `connectors.md` yet (it hasn't been onboarded), so this works from the generic rules; Story 8.1 extends the context template so a client's file can record the same fields.

## The contract every adapter exports

| Field | Rule |
|---|---|
| `id`, `system` | Slug and plain name |
| `auth.env` | Names of the env vars it reads (via `kit/lib/secrets`), never values. Mocks declare none |
| `read` operations | Read-only, least privilege; fail closed on an auth error; fetch only the fields named in the call |
| `write` operations | Each takes an `idempotencyKey`; honours `dryRun` (returns what would be written, writes nothing) |
| `killSwitchEnv` | Env var name; when set, every write refuses with `KillSwitchOn` before any I/O. Reads keep working |
| `rateLimit` | Calls per second and batch size; the adapter batches and waits, never drops |
| errors | Typed; messages pass `redact()` so no credential, token or URL with a secret appears |

Callers: only the approval-write archetype calls `write` operations (architecture AD-15). Any module may call `read` operations.

## Brightside mocks

| Mock | Path | Operations | Notes |
|---|---|---|---|
| CRM | `examples/brightside/app/connectors/crm/` | `read.lookupClient({ clientId \| email })` → `client_id`, `first_name`, `last_name`, `email`, `zone_id` | Read path only (round-1 "update a client" dropped: no consumer). Reads the fixture through the query runner. Never returns phone or address |
| Email tool | `examples/brightside/app/connectors/email/` | `write.createList({ name, idempotencyKey })`; `write.addContacts({ listId, contacts[], idempotencyKey })` | Contacts carry `email`, `first_name`, `external_ref` (= `client_id`) only. Batch size 100, 5 calls/s. Kill switch `BRIGHTSIDE_EMAIL_OFF` |

- **Outbox:** each mock appends JSON lines to `var/outbox/<connector-id>.jsonl` (`APLABS_VAR_DIR`, gitignored, outside `.aplabs/`). Each line: time, operation, idempotency key, and the payload. A repeated idempotency key returns the first result and appends nothing.
- **Idempotency key for a push:** list key = sha256 of the sorted approved `client_id`s plus the destination list name, and the list name includes the run date (UTC, for example `win-back-north-2026-10-24`) so re-sending the same set on a later day makes a new list; contact key = list key plus `client_id`. A second Approve, a replay or a retry after partial failure writes nothing new for rows already written.
- **Failure simulation:** a test-only option makes chosen rows fail or the rate limit trip, so partial failure and back-off are tested without a real system.

## Verdict

The contract covers the guardrails (one auth path, batch and rate limits, idempotency, kill switch, least privilege, minimal fields, redacted errors). No real connection or credential is needed in this phase, so there are no missing connections to route. The one real-system gap is the bot reading MotherDuck (a DEP row, approver Ely).
