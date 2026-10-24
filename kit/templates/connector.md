# Adding a connector

A connector is the one way the app reaches an external system (a CRM, an email tool, billing, any API). Every connector has the same shape, declared with `defineConnector` from `#sdk`, and passes the same contract suite. The engine enforces the guardrails; the adapter only says how to talk to the system. Adding one is a folder in the app dir. No engine file (`kit/**`, `profiles/_schema/**`) changes.

Before you write one, check `.aplabs/context/connectors.md` and ask Connector: a system has one approved path per operation, and a new connection or credential is a gated human action, never created inside a build.

## Steps

1. Copy the template into the app dir, naming the folder after the connector's id:

   ```bash
   cp -r kit/templates/connector app/connectors/crm
   ```

   The template is two files: `connector.js` (the adapter) and `connector.test.js` (its test).
2. Fill in the declaration (fields below) from the system's entry in `connectors.md`.
3. Replace `connect` with the system's real client, and each operation's body with real calls. Delete the in-memory stand-in.
4. Give the contract suite one sample input per operation in `connector.test.js`, then run `npm test`.
5. Add the system's contract fields to `connectors.md` (kill switch, idempotency, batch size; see the template there) through Scribe and the owner's sign-off.

## The declaration

| Field | What it is |
|---|---|
| `id` | Lower-case slug (`crm`). Matches the folder name. |
| `system` | The system's plain name (`Acme CRM`). People see it in "switched off" and "couldn't reach" messages. |
| `auth.env` | The **names** of the env vars holding its credentials (`["ACME_CRM_TOKEN"]`), never values; `[]` for a system with no credential (a mock). Read once through `kit/lib/secrets`, cached with the client, and registered with the log so no line shows them. Only declared names can be read. |
| `killSwitchEnv` | The connector's own kill switch (`ACME_CRM_OFF`). When set, every write refuses before any I/O. |
| `rateLimit` | `{ perSecond, batchSize }` from the system's documented limits. Calls are spaced to `perSecond` (the engine waits, never drops); a request over `batchSize` is refused. A call the system refuses with status 429 is retried by the engine through the same limiter, waiting what its `Retry-After` asks (`err.retryAfter` in seconds, or a `retry-after` header on `err.headers`), up to 3 attempts; a wait over 60 s, or a fourth 429, fails with `ConnectorFailed`. The adapter only has to throw an error with `status: 429`. |
| `connect({ secret, registerSecret, data, simulate })` | Builds the client once per process. It may be async (an OAuth exchange): the engine awaits it, and a rejected connect is not cached, so the next call connects again; a rejection with `status` 401 or 403 is a `ConnectorAuthFailed`. `secret(name)` returns a declared credential. `registerSecret(value)` masks a token `connect` obtains itself (an OAuth access token) in errors and every log line, and returns it. On a 401 or 403 the client must throw an error with that `status` (or a `ConnectorAuthFailed`). `data` is the query runner when the connector was created with `{ data }` (a connector over the client's own data, such as a mock); its SQL then passes the guardrail and the profile's forbidden columns. `simulate` is the test-only `deps.simulate`, for the adapter's own failure simulation. |
| `read.<name>(input, ctx)` | A read operation. Read-only and least privilege: fetch only the fields the call names. The engine can't see what an adapter fetches, so the contract and its suite don't check this: it is a review item for Connector on every connector. |
| `write.<name>` | `{ plan(input), apply(input, ctx) }`. `plan` says what would be written, with no I/O; `apply` writes. |

The app creates one instance per process with `connector.create({ log, ... })`. `log`, the app's logger (`kit/runtime/log`), is required: `create` fails without it, so every credential the connector reads is masked in every log line (AD-12). A test passes `testLog()` from `#sdk`.

Inside an operation, `ctx` has `client` (from `connect`), `request(fn, { size })` (every call to the system goes through it), `batches(items)` (splits a list by `batchSize`), `operation`, and on a write `idempotencyKey`. Pass the key on to the system when its API takes one. For a list, give each item its own key, the write's key plus the item's id (`${ctx.idempotencyKey}:${item.id}`), never a per-batch suffix: a retry after a partial failure then resends only the items the system has not seen, however the rows are ordered or batched.

## The safe defaults

- **Writes are dry runs unless the caller says otherwise.** A write without `dryRun: false` returns `{ dryRun: true, operation, wouldWrite }` from `plan` and calls nothing. Only the approval-write archetype passes `dryRun: false` (AD-15).
- **Two kill switches.** The connector's `killSwitchEnv` and the global `APLABS_WRITES_OFF` each refuse every write, dry runs included, with `KillSwitchOn`, before credentials are read. Any non-empty value is on, even `0` or `false`: unset it to turn writes back on. Reads keep working. The env is read on every call and again before every request a write makes, so a switch takes effect at once: flipped partway through a push, it refuses the batches still to come (the write fails with `KillSwitchOn` and does not use up its key).
- **Idempotency.** Every write needs an `idempotencyKey`. A repeated key with the same input returns the first result and calls nothing; a failed write does not use up its key. The input is fingerprinted under its key, so a reused key with a different input is refused with `IdempotencyConflict` (a `ConnectorFailed`) and calls nothing. Keys live in memory for the process unless the connector is created with `idempotency: { get, set }` (a mock's outbox, or a durable store); the store holds `{ input, result }` per key.
- **Fail closed.** A missing credential or an auth error from the system fails the call with `ConnectorAuthFailed`; a read never returns empty or partial data instead. Any other failure is a `ConnectorFailed`.
- **No credential in an error.** Every error is rebuilt from a redacted message: the connector's credentials, tokens passed to `registerSecret`, `Bearer` and `Basic` headers, `token=`-style query values, passwords in URLs and JSON `access_token`, `refresh_token` and `id_token` fields are masked. The original error is not kept, so nothing on it leaks.

`kit/runtime/messages` turns `KillSwitchOn` and `ConnectorFailed` into a plain message for the person; the reason goes to the log only.

## The contract suite

`connectorContract(connector, samples)` from `#sdk` registers the shared tests: the declaration, dry run, both kill switches, idempotency, the rate limit, batching, fail-closed reads and redacted errors. It runs the connector with fake credentials, a fake clock and a fake system failure, so it never needs the real system. `samples.read` and `samples.write` must cover every operation; `samples.bulk` (one write that takes a list) is optional and checks batching. A third argument's `deps` is passed to every instance the suite creates, for what the connector needs besides credentials (for example `{ deps: { data } }` with a stand-in runner); the suite's own env, clock and `onRequest` still win.

## Connector code is trusted, not sandboxed

Like a module handler, a connector is trusted, reviewed code that runs in the app's process and can reach `process.env`. Review it as engine code: never log a credential, never put one in an error, and keep every call inside `ctx.request`.
