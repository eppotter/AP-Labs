# Epic 10, score, approve, push: plan for Ely

Status: **approved** under Ely's conditional pre-approval (2026-10-25: "approve plan epic-10 if the architect and plan review leave no unresolved blocking finding"). Architect design review and plan review done 2026-10-25: ready with changes; all 5 blocking findings folded in below, none left unresolved.

The stories and their acceptance criteria are the ones you approved in the runtime phase plan (#52, `epics-runtime.md` Epic 10). This plan adds what has changed since then: the connector contract hardening (#88, #99, #102, #104), the mock email tool's outbox fixes (#97), the hub modal (#113), the Epic 9 plan (`plan-epic-9.md`), and the two open ledger items that block Story 10.3 (DEP-013, DEP-017).

**In short:**
1. After a person gets their Win-back list, the bot ranks it with a short reason on every row. The person clicks "Push to email tool", sees exactly what will be sent, and approves it. The mock email tool gets that list once, however many times anyone clicks.
2. Nothing is sent without the same person's approval. Each push reads only its own saved copy of the approved rows, so it can never send rows the person didn't see. If a push half-fails, the person sees honest counts, and a quiet note goes to an ops channel with counts only, never client data.
3. Five stories: the four you approved, plus a small new 10.0 that closes a gap left by the connector work. Epic 10 can't finish before Epic 9's form, results and "How was this made?" stories (9.3, 9.5, 9.6) merge. 10.4, the full demo, counts as done only after you run it live in Slack. The six decisions below were adopted as recommended (with the review's changes) under your pre-approval.

## What you're approving

- [ ] **The four stories as approved in #52, plus a new 10.0**, in the build order below.
- [ ] **The prerequisites below**, as preconditions. Three are already done. Two are Epic 9 stories still being built.
- [ ] **A new optional profile setting, `slack.ops_channel`** (a Slack channel id, never a secret). With it unset, an escalation is only logged. Reviewed like any profile change.
- [ ] **The Win-back list moves from `scoped-pull` to `approval-write`.** Its resource (`WIN_BACK`, added by 9.3) becomes `admin_grantable: false`, so the admin role alone no longer opens it. It is granted by name to the people who may push (Dana for the demo). The architecture requires this (AD-16).
- [ ] **Manifest additions for scored and pushing modules** (decisions 1 to 3): how a score is declared, which approved fields reach the email tool, and how the list name is built.
- [ ] **10.4 merges as "built (tests only)"**, and becomes "done" only after your live demo in Slack, recorded in the PR.
- [x] **The six decisions** below, adopted as recommended with the review's changes folded in.

## The stories

| Story | Who runs it | Size | Tier | You will see |
|---|---|---|---|---|
| 10.0 Save push progress after every request (new, DEP-017) | Builder | S | T3 | Nothing in Slack. Tests prove a push stopped by a crash or redeploy halfway never sends a contact twice when retried |
| 10.1 Deterministic scoring with a reason per row | Builder | M | T1 | Win-back results ranked by score, each row with a one-line reason such as "client 31 months; $4,120 paid; price rise before lapse" |
| 10.2 Preview and approve before anything is pushed | Builder | M | T3 | A "Push to email tool" button on Win-back results. It shows the list name (with today's date), the row count and a sample, with Approve and Cancel |
| 10.3 Push once, report honestly, escalate quietly | Builder | M | T3 | Approve shows "Pushed 25, skipped 0, failed 0". A second click says "already done". The Outbox entry shows the list once |
| 10.4 The demo flow, end to end | Builder writes the test and script; **you** run the live demo | M | T1 | The whole demo, start to finish, in CI and then live in Slack |

**Tiers** were computed by the Orchestrator with `node kit/lib/tier` on each story's file list (2026-10-25): 10.0 T3, 10.1 T1, 10.2 T3, 10.3 T3, 10.4 T1. The epic as a whole is T3.

**Files added by the 2026-10-25 review** (10.2: `kit/runtime/archetypes/approval-write/connectors.js`, `kit/runtime/app/index.js`, `kit/templates/connector.md`, `scripts/check-write-path.js` floor, its connector-loading test; 10.3: `kit/runtime/store/index.js`): tiers not yet computed, recompute at build. The Orchestrator reruns `node kit/lib/tier` on each story's full file list before the story starts. A story's tier can only go up from what is shown above.

**10.1 gets an architect diff review** before merge, although it is T1: it changes the scoped-pull engine's query checks and binding that every later story relies on.

## Prerequisites, in build order

| # | Prerequisite | State | What it unblocks |
|---|---|---|---|
| P1 | **DEP-012**: only the approval-write archetype may write live; one shared idempotency store per connector | **Done.** Closed by #99 (`kit/verify/write-path.js`, run by `npm run check`, `npm test` and every `npm run verify`) | 10.2, 10.3 |
| P2 | **#92**: the mock email tool's outbox fails closed on a torn or unreadable file, with one writer at a time | **Done.** Fixed by #97 | 10.3 |
| P3 | **#90**: a credential-less connector passes the suite; a partly applied batch raises `PartialFailure` with honest counts | **Done.** Fixed by #102 (opened DEP-013) | 10.3 |
| P4 | **Story 9.3** (typed form, sessions, Win-back module) and **Story 9.5** (the bound query runs, results arrive, CSV to the DM) merged | **Not yet.** In builder worktrees, not on `main` | 10.1 |
| P5 | **Story 9.6** ("How was this made?" and the run record in store `provenance`) merged | **Not yet.** Not started | 10.2 |
| P6 | **Story 9.4** (plain English fills the form) merged | **Not yet** | 10.4 (its AI-off path) |
| P7 | **10.0** (DEP-017) merged | This plan | 10.3 |

Before 10.2 starts, the Orchestrator confirms on GitHub that issues #90 and #92 are closed (the ledger says they were fixed by #102 and #97). If either is still open, it goes to Ely before any write story.

## Build order

1. **10.0** now. It touches only the connector contract and the mock email tool, which Epic 9 doesn't touch.
2. **10.1**, after 9.5 merges. It can run beside 10.0 (no shared files).
3. **10.2**, after 10.1 and 9.6 merge.
4. **10.3**, after 10.0 and 10.2 merge. Then your live check of a push (needs `#brightside-ops`, below).
5. **10.4**, after 10.3 and 9.4 merge. Then your live demo.

From 10.1 on, stories run one at a time: they share the scoped-pull engine, `kit/runtime/slack/hubs.js`, `kit/runtime/messages.js` and the Win-back module.

### Story 10.0: save push progress after every request (new)

Not in the epics you approved in #52. It closes DEP-017, which #104 left open and which blocks 10.3's live check.

**Acceptance criteria:**

- A live batched write saves its progress record after **every** completed request, not only when the write stops. So a crash or redeploy halfway through a push leaves an accurate record, and a retry with the same key and input resumes after what went and sends nothing twice.
- The record keeps the rules #104 set: only counts, flags and id-shaped refs; bound to the input and batch size; a mangled record fails closed.
- If a save fails mid-write, the write stops before the next request (it does not carry on unrecorded). The person is told how many went and that the admin should check before anyone retries (`details.sent.recorded: false`), as today.
- **A `perItemIdempotency` write that ends in `PartialFailure` still drops its record.** If any progress was saved on this or an earlier try, the contract overwrites it with `completed: []`. If that save fails, `retrySafe` is false. Test: a per-item write saves after batch 1 and partly fails in batch 2. The retry with the same key and input calls the system for every batch, and the tool adds only the failed items.
- The mock email tool's outbox keeps each saved record (`type: 'progress'`, latest wins), and a restart reads it back.
- The shared contract suite gains a "process dies after request k" case: a fresh connector over the same store, same key and input, sends only requests k+1 onwards.
- Tests cover a stop after the first, a middle and the last request, a failed save, and the mock email tool restarted over its outbox.
- **The fork note** in `kit/templates/connector.md` says 10.0's guarantee needs a durable idempotency store: with an in-memory store, a restart loses the progress record.

**Changed since the epics:** new story. #104 recorded progress only as a write stops, and noted that a process dying mid-write records nothing.

Tier: T3 (computed: `kit/runtime/connectors/**` floors at T3 in Brightside's profile)

**Files:** `kit/runtime/connectors/contract.js`; `kit/runtime/connectors/suite.js`; `examples/brightside/app/connectors/email/outbox.js`; `examples/brightside/app/connectors/email/outbox.test.js`; `examples/brightside/app/connectors/email/connector.test.js`; `test/unit/connector-contract.test.js`; `kit/templates/connector.md` (the progress note and the durable-store note for forks); `docs/planning/planning-artifacts/architecture-runtime.md` (AD-15 progress sentence); `docs/ledger.md` (closes DEP-017).

### Story 10.1: deterministic scoring with a reason per row

**Acceptance criteria:**

- A module manifest declares its scoring inputs (decision 1). Each input names a column the module's query returns, a weight, a fixed range and a plain label.
- Each row gets a score from 0 to 100 (whole number) and a one-line reason naming its top two contributing inputs in plain words. Rows are ordered by score, ties broken by the declared row id (`client_id` for Win-back).
- **The formula is pinned** (decision 1): each input is clipped to `[min, max]` and scaled to 0–1; S is the sum of weight × scaled value; score = round-half-up(100 × (S − Σneg) / (Σpos − Σneg)), where Σpos is the sum of the positive weights and Σneg the sum of the negative weights. Startup refuses an input with `min >= max`, and a module whose weights are all zero.
- Same data and weights give identical scores and order every time. No AI is involved. Scores are computed in the engine from the returned rows. Query rows never reach the AI (the 9.5 spy test still passes).
- **"Top 25" means top 25 by score** (decision 2). A scored module's SQL ends with an `ORDER BY` whose last key is the row id, then a literal `LIMIT 5001` (ROW_CAP + 1). Startup checks both. If 5,001 rows return, the person is told the ranking covers only the first 5,000. The engine scores the rows, then keeps the top `limit`. `scoring.limit_parameter` is never bound: `checkQuery` exempts it from "declared but never used" and refuses SQL that names it, and `bindValues` leaves it out.
- **Numbers.** Scoring accepts JavaScript numbers, strict numeric strings (BIGINT, HUGEINT and DECIMAL come back as strings) and booleans as 0/1. A nullable input must be `COALESCE`d in the SQL; a null value stops the run, and the startup message and `kit/templates/module.md` say so.
- A declared input missing from the query's columns, or a non-numeric value, stops startup (a startup check) or the run (a value), naming the module and input. It never scores as 0.
- The scored results show the score and reason in the module view and the CSV (two new columns). The run record (9.6) gains `score` per row for a module with a write, and keeps only the rows after the cut, in rank order.
- The Win-back module declares the inputs in `demo-flow.md`: months as a client, lifetime paid spend, days since last completed visit, the lapsed plan's price, and a price rise before the lapse. Each uses its definition in `fixture-tables.md`. Its SQL returns those columns.
- Tests assert exact scores, reasons and order on fixture rows, a tie, two identical runs, a missing input, numeric strings and booleans, a null value, `min >= max` and all-zero weights, SQL that names the limit parameter, SQL without the `ORDER BY` or `LIMIT 5001`, and the 5,000 cap.

**Changed since the epics:** the manifest schema today has `scoring.inputs` (names) and `scoring.weights` (numbers) only. It can't say which direction is good, how to scale an input, or how to word the reason (decision 1). The epics don't say whether "top 25" is cut before or after scoring (decision 2). Results show in the hub modal (#113), not an ephemeral reply.

Tier: T1 (computed). Gets an architect diff review before merge (see Tiers above).

**Files:** new `kit/runtime/scoring/index.js`; `kit/runtime/schema/module.schema.json` (`scoring` shape, row id); `kit/runtime/registry/index.js` (startup checks); `kit/runtime/archetypes/scoped-pull/run.js` (`checkQuery` and `bindValues` handle the limit parameter; the `ORDER BY` and `LIMIT 5001` checks) and `kit/runtime/archetypes/scoped-pull/results.js` (score before the cut; show score and reason); `kit/runtime/archetypes/scoped-pull/csv.js` (score and reason columns); `kit/runtime/slack/provenance.js` (`score` in the run record; only the rows after the cut); `kit/runtime/errors.js`, `kit/runtime/messages.js` (a scoring config fault); `kit/templates/module.md` (the `scoring` fields); `examples/brightside/app/modules/win-back/manifest.json`, `examples/brightside/app/modules/win-back/win-back.sql` (from 9.5) and its test under `examples/brightside/test/`; new `test/unit/runtime-scoring.test.js`; `test/unit/runtime-registry.test.js`; `test/unit/scoped-pull-run.test.js`; new fixtures under `test/fixtures/runtime/`; `docs/ledger.md`.

The file names inside `kit/runtime/archetypes/scoped-pull/` and the module's SQL file follow the 9.5 worktree (`run.js`, `results.js`, `csv.js`, `win-back.sql`). If 9.5 merges with different names, the Orchestrator updates this list and recomputes the tier before 10.1 starts.

### Story 10.2: preview and approve before anything is pushed

**Acceptance criteria:**

- **Turning on the archetype.** `approval-write` is added to the archetypes startup accepts. An `approval-write` module is a scoped pull plus a `write` block: it reuses the scoped-pull engine for the form, query, scoring, results and "How was this made?", and adds Push. It is not a second copy of that engine.
- **Connector loading.** At startup, `kit/runtime/archetypes/approval-write/connectors.js` loads `<app dir>/connectors/<write.connector>/connector.js` by discovery, only for connectors an approval-write module names. It checks `write.operation` against that connector's declared write operations. It creates exactly one instance per connector per process with the app's logger and env (`create({ log, env })`). The registry's refusals call this check and never read `.write` themselves. No other engine file imports a connector. A connector folder that is missing, fails to load or fails `checkDeclaration` stops startup, naming the module and the connector. Tests: one instance per connector per process; a missing connector stops startup; `npm run check` passes.
- **Startup refuses** an `approval-write` module whose resource is not declared `admin_grantable: false` in the profile. It also refuses one with no `row_id`, or whose `row_id` is not in `write.fields`, whose `write.connector` is not a connector in the app dir, whose `write.operation` is not one of that connector's write operations (both through the connector-loading check above), whose send mapping names a field not in `write.fields`, or whose list name uses a placeholder that is not a declared enum parameter or the run date (decision 3). Each refusal names the module and the field.
- **Push.** Results from an `approval-write` module carry a "Push to email tool" button, shown only to the person who ran the pull. The button carries a random run id, never a guessable one. Clicking it updates the module view (never a new view) to a private preview: the destination list name (it includes the run date), the row count, rows skipped and why (for example no email), a sample of 5 rows (escaped), and Approve and Cancel.
- **The preview runs the write's dry-run `plan`**, so rows the tool would refuse show as "skipped", with the reason, before approval.
- **Handlers re-check access.** The Push, Approve and Cancel handlers re-check the person's resource grant and the environment the same way dispatch does (`hubs.js`), on every click.
- **The approval entry.** At preview time an opaque CSPRNG token (at least 128 bits) is stored in store namespace `approval` (30 minutes) with `{ person, runId, destination, listName, rows, idempotencyKey }`. `rows` is a **copy** of the approved rows' declared push fields (Win-back: `client_id`, `email`, `first_name`, `score`) taken from the run record. The button carries only the token.
- **Idempotency key** = sha256 of the canonical JSON `[listName, sortedIdsAsStrings]`, where `sortedIdsAsStrings` is the approved rows' `row_id` values as strings, sorted (AD-15, `connector-review.md`). The run date in the list name is the UTC date of the pull's `ranAt`, not the fixture's `as_of` and not the click time.
- **`pushList`** (decision 3 option A). The mock email tool's `pushList` declares `perItemIdempotency: true`. Every `ctx.request` it makes returns only counts and id-shaped refs: the list step returns `{ listId }` and never `name`; each contact batch returns `{ added, alreadyAdded, failedRefs }` with no reason text. The list id always contains a digit. The email connector's tests run the 10.0 "process dies after request k" case on `pushList` for k = 1 (after the list step), a middle batch and the last batch. A retry with the same key and input finishes the list and sends nothing twice.
- **Run record already expired** when Push is clicked: the person is told the results expired and to run the pull again. No token is created.
- **Approve with a token that is expired, unknown or someone else's:** the same "this preview is no longer valid" reply in each case (`PreviewInvalid`, new in AD-17). Nothing is pushed or consumed. (10.3 does the push itself.)
- **Cancel** consumes the token and ends the session with a confirmation.
- **T3 floors** (decision 4): `ENGINE_T3` in `kit/lib/tier` gains `kit/runtime/archetypes/approval-write/**`, `kit/runtime/connectors/**`, `kit/verify/write-path.js`, `scripts/check-write-path.js`, `kit/runtime/slack/channel.js` and `kit/runtime/store/**`.
- Brightside's profile: `WIN_BACK` becomes `admin_grantable: false` and is granted to Dana by name. The Win-back manifest becomes `archetype: approval-write` with a `row_id` and a `write` block for the mock email tool.
- Tests cover each case above, including that the entry still holds its own rows after the run record has expired, that the button payload is only the token, a different person's Push and Approve, a person who lost the grant between Push and Approve, the dry-run skips, the key on fixture ids, and each startup refusal.

**Changed since the epics:** the manifest's `write.operation` names one operation, but the mock email tool needs two calls (`createList`, then `addContacts`), and its contacts take `external_ref`, `email` and `first_name` only (an extra field like `score` is refused). Hence decision 3. The preview lives in the hub modal (#113): every click updates the module view. Startup also checks the `write` block against the connector, which the epics left implicit, and nothing loaded connectors until now.

Tier: T3 (computed: approval-write and the profile). The files added by the review: recompute at build.

**Files:** new `kit/runtime/archetypes/approval-write/` (`index.js`, `preview.js`, `entry.js`, `connectors.js`); `kit/runtime/app/index.js` (calls connector loading at startup); `kit/runtime/archetypes/scoped-pull/index.js` and `kit/runtime/archetypes/scoped-pull/results.js` (the Push button and the reuse hook); `kit/runtime/slack/provenance.js` (push fields in the run record); `kit/runtime/registry/index.js` (accept the archetype; the startup refusals, through `connectors.js`); `kit/runtime/schema/module.schema.json` (`row_id`, send mapping, list name); `kit/runtime/slack/hubs.js` (Push, Approve, Cancel routing and their access re-checks); `kit/runtime/errors.js`, `kit/runtime/messages.js` (`PreviewInvalid`); `kit/runtime/sdk/index.js` (only if a new export is needed; the builder says so); `kit/templates/module.md` (the `write` fields and `row_id`); `kit/templates/connector.md` (the D3 rule: one write operation per push); `examples/brightside/app/modules/win-back/manifest.json` and its test; `examples/brightside/app/connectors/email/connector.js` and `connector.test.js` (`pushList`); `profiles/brightside/profile.yml` (`WIN_BACK` `admin_grantable: false`, granted to Dana); `examples/brightside/test/profile.test.js`; new `test/unit/runtime-approval-preview.test.js`; new `test/unit/runtime-approval-connectors.test.js`; `test/unit/runtime-registry.test.js`; `test/unit/write-path.test.js` (the archetype folder passes the check); `kit/lib/tier/index.js` and its test (decision 4); fixtures under `test/fixtures/runtime/`; `docs/planning/planning-artifacts/architecture-runtime.md` (one AD-15 sentence: connectors are loaded only by `approval-write/connectors.js`, at startup, one instance per connector per process); `docs/ledger.md`.

### Story 10.3: push once, report honestly, escalate quietly

**Acceptance criteria:**

- **Approve order** (AD-15). Look up the token (`get`). If it is gone, read `done`: the person who pushed gets "already done" with the counts (or "already running"); anyone else gets the generic "no longer valid" (decision 5). Then check the person matches, else the generic reply. Then check the connector and global kill switches (`BRIGHTSIDE_EMAIL_OFF`, `APLABS_WRITES_OFF`), refusing without consuming. Then `consume` synchronously just before the first write. No `await` between the check and the `consume`.
- **`consume(ns, key, marker)`** in `kit/runtime/store/index.js`: consuming a token leaves a marker (the person, and "running" or the counts), so "already running" and "already done" are tied to the person (decision 5).
- **The push reads only the approval entry's own rows**: never the run record, never the button. Each row is written through the connector with the entry's idempotency key (contact key = list key plus `client_id`, as the mock email tool already does).
- **Exactly once.** Two Approve clicks in the same tick, a double click, or a replayed payload: exactly one push. The second click is told "already done" with the counts, or "already running" while the first is in flight.
- **Honest counts.** The person sees pushed, skipped and failed counts with reasons, worded by `kit/runtime/messages.js` (`PartialFailure`, `KillSwitchOn` with `details.sent`, `ConnectorFailed`, `ConnectorAuthFailed`). Nothing partial is called complete. A push whose key was already used (the same list sent earlier today) is reported as "already sent today; nothing new sent", never "Pushed 25".
- **Retry after a partial failure (DEP-013).** A partly failed push can be retried only with the **same idempotency key and the same input** as the first try: never a new key, never re-planned rows. The re-stored entry and its "Retry the failed ones" button are offered only when `details.retrySafe === true`: the archetype re-stores the same entry under a new token (same person, same rows, same key, 30 minutes) (decision 6). Otherwise the person gets the AD-17 admin message and no button. Tests cover both.
- **The Retry handler** re-checks the person's resource grant and the environment the same way dispatch does (`hubs.js`), like Push, Approve and Cancel in 10.2.
- **Escalation.** A failed push (`PartialFailure`, `ConnectorFailed`, `ConnectorAuthFailed`, `IdempotencyConflict`, or a kill switch flipped mid-push) posts one message to the profile's `slack.ops_channel`. This is the one declared channel-delivery exception (AD-14), and it goes through one channel-post function that accepts only declared exceptions. A grep test asserts nothing outside `kit/runtime/slack/channel.js` posts to a non-DM channel. The message carries module, reason and counts only, never row data: a test asserts no row value (email, name, client id) appears. A kill switch that refused before anything was sent, and an invalid or expired preview, are not escalated. Repeats of the same module and reason within 15 minutes are suppressed (namespace `escalation`). With no `ops_channel` set, or if Slack refuses the post (for example the bot isn't in the channel), the escalation is logged only and the person's reply is unaffected.
- **New profile key** `slack.ops_channel` (optional, a channel id matching `^[CG][A-Z0-9]{8,}$`), in the schema with no default.
- **Setup note:** create `#brightside-ops` in `aplabs-demo`, invite the bot, and put the channel id in the profile.
- Tests with the mock email tool cover success, same-tick double Approve, a second click during and after the push (by the pusher and by someone else), replay, a same-day key reuse, partial failure and its retry (only the failed contacts are sent, and the outbox holds each contact once), a partial failure with `retrySafe` false (no button), both kill switches (before and mid-push), the run record expired before Approve, escalation content, `IdempotencyConflict` escalated, suppression, no `ops_channel`, a malformed `ops_channel` refused by the schema, and a refused channel post.

**Changed since the epics:** the contract now raises `PartialFailure` with honest counts and a `retrySafe` flag (#102), resumes a stopped write from its progress record (#104, and 10.0), and refuses a reused key with different input (`IdempotencyConflict`, #88). DEP-013 says the archetype must retry with the first try's key and input. The epics didn't say how a person retries once the token is used up (decision 6), or which failures escalate.

Tier: T3 (computed: approval-write and the profile). `kit/runtime/store/index.js`, added by the review: recompute at build (T3 under decision 4's floor).

**Files:** `kit/runtime/archetypes/approval-write/` (`index.js`, new `push.js`, new `escalate.js`); new `kit/runtime/slack/channel.js` (the one channel-post function and its exception list); `kit/runtime/store/index.js` (`consume(ns, key, marker)`); `kit/runtime/slack/hubs.js` (Approve and Retry routing and their access re-checks); `kit/runtime/messages.js` (push outcome wording, "already sent today"); `kit/runtime/app/index.js` (passes `ops_channel` to the archetype); `profiles/_schema/profile.schema.json` (`slack.ops_channel` and its pattern); `kit/lib/profile/index.js` (only if a default or validation is needed; the builder says so); `profiles/brightside/profile.yml` (the `ops_channel` id, once Ely gives it); `examples/brightside/test/profile.test.js`; `docs/runtime/slack-app-setup.md` (the `#brightside-ops` note); new `test/unit/runtime-approval-push.test.js`; new `test/unit/runtime-escalation.test.js` (including the channel-post grep test); `test/unit/runtime-store.test.js` (`consume` with a marker); fixtures under `test/fixtures/runtime/` and `test/fixtures/profiles/`; `docs/planning/planning-artifacts/architecture-runtime.md` (AD-15 retry rule, AD-17 `PreviewInvalid`); `docs/ledger.md` (closes DEP-013).

### Story 10.4: the demo flow, end to end

**Acceptance criteria:**

- **In CI.** The template is configured with the Brightside profile (`APLABS_PROFILE`), the example app dir (`APLABS_APP_DIR`), a temporary `APLABS_VAR_DIR` and a temporary local fixture, with every kill-switch env var cleared. No physical copy of the repo is made. A test drives fake Slack through every step in `demo-flow.md`. At the end, the mock email tool's outbox holds exactly the approved, scored list, once. Every message went privately to the requesting person (modal or ephemeral), and the CSV went to their DM.
- With `APLABS_LLM_OFF` set, step 2 says so plainly and the typed form completes the same flow.
- The test runs offline: no Slack, no model, no MotherDuck. It lives under `examples/brightside/test/` (the example carve-out; open question Q7), so it is deleted with the example in a fork, and the "template runs with the example deleted" CI job still passes.
- **A demo script** in `docs/runtime/demo-script.md`: the eight steps, what you type, what you should see, and how to reset (clear `var/outbox/email.jsonl`). It notes that the list name uses the UTC date, and that two pulls on the same day with different rows make two lists with the same name (the same rows are "already sent today").
- **Live, by Ely.** You follow the script in the live Slack app and see the same steps. The PR records what you saw.
- **Done-definition.** The PR merges as **"built (tests only)"** once CI and review pass. 10.4, and Epic 10, count as **done** only after your live demo, recorded in the PR (or a follow-up comment) and in the ledger row. Until then the Orchestrator reports it as built, not live-checked.

**Changed since the epics:** results and the preview show in the hub modal (#113). The live demo can read the local fixture or MotherDuck (#110). Brightside stays on the local file unless you switch it.

Tier: T1 (computed)

**Files:** new `examples/brightside/test/demo-flow.test.js`; a fake-Slack helper under `examples/brightside/test/` (or reuse of an existing one under `test/`, if it reads no client specifics); new `docs/runtime/demo-script.md`; `docs/planning/implementation-artifacts/sprint-status.yaml` (Epic 10 status); `docs/ledger.md`.

## Decisions (adopted as recommended, 2026-10-25)

1. **How a score is declared.** Today the manifest has `scoring.inputs` (a list of names) and `scoring.weights` (numbers). That can't say whether "more days since the last visit" is good or bad, how to compare months with dollars, or how to word the reason.
   - **Recommendation:** replace both with one list, `scoring.inputs: [{ name, label, weight, min, max }]`, plus a top-level `row_id` (Win-back: `client_id`). Each input is clipped to its fixed range, scaled to 0–1, multiplied by its weight (negative means "lower is better") and summed, then scaled to 0–100: score = round-half-up(100 × (S − Σneg) / (Σpos − Σneg)). Startup refuses `min >= max` and all-zero weights. Fixed ranges, not ranges taken from each result, so a client's score doesn't change with who else came back. No module uses `scoring` yet, so the change breaks nothing.
2. **"Top 25": cut before or after scoring?** If the SQL keeps `LIMIT $limit`, the bot ranks 25 arbitrary clients, not the best 25.
   - **Recommendation:** for a scored module, the engine scores every candidate (up to the 5,000 cap) and then keeps the top `limit`. The SQL ends with an `ORDER BY` whose last key is the row id, then a literal `LIMIT 5001`; startup checks both. The module declares which parameter is the limit (`scoring.limit_parameter`); it is never bound, and startup refuses SQL that names it.
3. **One push, two calls, and which fields are sent.** The manifest's `write.operation` is one operation, but the email tool needs `createList` then `addContacts`. The approved rows carry `client_id`, `email`, `first_name` and `score`, but the tool takes `external_ref`, `email` and `first_name` only.
   - **Option A (recommended):** the mock email tool gains one write operation, `pushList({ name, contacts, idempotencyKey })`, which creates the list and adds the contacts in batches, under one key. It declares `perItemIdempotency: true`, and its requests return only counts and id-shaped refs (`{ listId }`, then `{ added, alreadyAdded, failedRefs }`). The archetype stays "one write, one key", and DEP-013's retry rule is simple (same operation, same key, same input). The manifest adds `write.send` (for Win-back `{ "external_ref": "client_id", "email": "email", "first_name": "first_name" }`) and `write.list_name` (`"win-back-{zone}-{run_date}"`). `score` stays in the approval entry for the preview only. `createList` and `addContacts` stay for other callers.
   - Option B: `write.operations` becomes an ordered list and the archetype learns "create then add". That's more engine code, and every future tool needs its own shape.
4. **Lock the write code at T3 for every fork?** Today `kit/runtime/archetypes/approval-write/**` and `kit/runtime/connectors/**` are T3 only because Brightside's profile says so. A fork's profile could drop those rows. `kit/verify/write-path.js` (the check that keeps writes inside the archetype) has no floor at all.
   - **Recommendation:** yes. Add those three, plus `scripts/check-write-path.js`, `kit/runtime/slack/channel.js` and `kit/runtime/store/**`, to the engine's T3 floors (`ENGINE_T3` in `kit/lib/tier`) in 10.2, as plan epic-9 did for the AI code. This adds `kit/lib/tier/index.js` and its test to 10.2's files.
5. **Who hears "already done"?** The `done` marker isn't tied to a person. As written, a replayed Approve from someone else would be told "already done" with the counts.
   - **Recommendation:** the `done` result records the person (through `consume(ns, key, marker)` in the store). Only they get "already done" or "already running". Anyone else gets the generic "no longer valid".
6. **How does a person retry a half-failed push?** The Approve token is used up by the first push, and the epics don't give a way back in.
   - **Recommendation:** on a `PartialFailure` with `details.retrySafe === true`, re-store the **same** approval entry (same rows, same key) under a fresh token, bound to the same person for 30 minutes, behind "Retry the failed ones". The contract skips what already went. A new pull the same day with the same rows would reach the same key anyway, but a button is clearer. When `retrySafe` is not true, the person gets the AD-17 admin message and no button. No retry is offered after an auth failure (that's a setup fault for the admin).

## Open questions found in the epics

Apart from the decisions above, these are places where `epics-runtime.md` is unclear or no longer matches what's built. Each has the answer this plan uses. Change any of them in your approval message.

| # | Question | Where | Recommended answer (used in this plan) |
|---|---|---|---|
| Q1 | Epic 10 needs pull results and the run record, but 9.3, 9.5 and 9.6 aren't on `main` (`kit/runtime/archetypes/` doesn't exist yet; 9.3 and 9.5 are in builder worktrees, 9.6 is not started) | Epic 9 / 10 boundary | Treat them as preconditions P4 and P5. 10.0 can start now |
| Q2 | DEP-012, #90 and #92 were listed as Epic 10 prerequisites, but the ledger shows them done (#99, #102, #97). The open items blocking 10.3 are **DEP-013** and **DEP-017** | `docs/ledger.md` | Record P1 to P3 as satisfied; build DEP-017 as Story 10.0; make DEP-013 an acceptance criterion of 10.3 |
| Q3 | Is "run date" in the list name the pull's date, the click date, or the fixture's `as_of`? The Dataset entry shows US Eastern (#131) | 10.2, 10.3, AD-15 | The UTC date of the pull's `ranAt` (AD-15 says UTC). Never `as_of`, which would make every demo list the same day |
| Q4 | Which failures escalate? "A failure" is not defined | 10.3 | `PartialFailure`, `ConnectorFailed`, `ConnectorAuthFailed`, `IdempotencyConflict`, and a kill switch flipped mid-push. Not a kill switch that refused before anything went, and not an invalid or expired preview |
| Q5 | What is "skipped"? | 10.3, demo step 7 | Rows the archetype can't send, decided at preview time by the write's dry-run `plan` and shown there (for example no email). Failed rows are ones the tool refused |
| Q6 | `admin_grantable: false` on `WIN_BACK` means admins lose the pull too, not only the push | 10.2, AD-16 | Accept it for V1 (one resource per module). Grant `WIN_BACK` to Dana by name. A fork that wants a read-only pull for more people adds a separate scoped-pull module |
| Q7 | Where does the 10.4 test live? It uses Brightside's profile and data, which engine tests under `test/**` may not read | 10.4, AGENTS.md test rule | `examples/brightside/test/demo-flow.test.js` (the example carve-out), so it goes with the example in a fork |
| Q8 | The epics say "a fresh copy of the template". A separate CI job, or a test? | 10.4 | A test inside `npm test` with a temp `APLABS_VAR_DIR` and fixture, no physical copy. The existing "runs with the example deleted" job (6.5) stays as is |
| Q9 | Does the escalation need a new Slack scope? | 10.3, AD-5 | No. `chat:write` covers posting to a channel the bot has been invited to. A "not in channel" error is logged, never shown to the person |
| Q10 | Does the push cap rows? | 10.2 | It pushes the rows the person saw (the scored, cut list), never more than the 5,000-row cap. The email tool batches at 100 |

## Review findings folded in

Architect design review and plan review, 2026-10-25. Verdict: ready with changes. None needed Ely.

**Blocking (all five folded in):**

| # | Finding | Where it is now |
|---|---|---|
| B1 | 10.2 had no way to load connectors, and the registry couldn't do it without failing `kit/verify/write-path.js` | 10.2 "Connector loading" AC; `approval-write/connectors.js`, `kit/runtime/app/index.js`, the test and the AD-15 sentence in 10.2's files |
| B2 | `pushList` must be per-item idempotent and return only counts and id-shaped refs, with the "process dies after request k" case run on it | 10.2 "`pushList`" AC; decision 3 option A |
| B3 | A per-item write ending in `PartialFailure` must drop its saved progress, or a retry skips failed items | 10.0 AC |
| B4 | The score-then-cut rule needs a fixed `ORDER BY … row id` and `LIMIT 5001`, and the limit parameter must never be bound | 10.1 "Top 25" AC (replaces "startup refuses a scored module whose SQL applies the limit itself"); decision 2 |
| B5 | The retry entry and button are offered only when `details.retrySafe === true` | 10.3 retry AC; decision 6 |

**Non-blocking, folded in:** N1 (`consume(ns, key, marker)`, 10.3), N2 (numeric strings, booleans, `COALESCE`, 10.1), N3 (pinned formula and its startup refusals, 10.1 and decision 1), N4 (preview runs the dry-run `plan`, 10.2 and Q5), N5 (`row_id` required and in `write.fields`; canonical key, 10.2), N6 ("already sent today", 10.3; same-name lists, demo script), N7 (`IdempotencyConflict` escalated, 10.3 and Q4), N8 (`ops_channel` pattern, 10.3), N9 (wider T3 floors and the channel-post grep test, 10.2, 10.3 and decision 4), N10 (architect diff review on 10.1), N11 (run record keeps only the rows after the cut, 10.1), N12 (handlers re-check access; random run id, 10.2 and 10.3), N13 (`win-back.sql`, 10.1 files), N14 (durable-store note in `kit/templates/connector.md`, the template in 10.2's files, and the crash-window risk), N16 (temp `APLABS_VAR_DIR`, kill switches cleared, no repo copy, 10.4), N17 (UTC date in the demo script, 10.4).

**Follow-ups (not folded in; filed for later):** the review's remaining non-blocking items, not listed in this plan by number (N15 and any others the review raised), go to the Epic 10 follow-up issue. The Orchestrator files them before 10.0 starts.

## Risks

- **Epic 9 timing.** 10.1 to 10.4 wait on 9.3, 9.5, 9.6 and 9.4. If 9.5 changes the scoped-pull file layout, the Orchestrator updates 10.1's and 10.2's file lists and recomputes their tiers before they start.
- **A double send.** The guards are the token (consumed once, synchronously), the `done` marker, the idempotency key per list and per contact, the progress record after every request (10.0), and the outbox's single-writer lock (#97). The remaining gaps: a request that timed out after the tool processed it can't be recorded (#104), and a crash between a request answering and its progress save can still re-send that one request. The mock never times out. A real tool needs its own dedupe keys (fork guide, 11.4).
- **10.0 needs a durable idempotency store.** The guarantee holds only if the progress record survives the process. The mock email tool's outbox does; a fork's real connector must too (`kit/templates/connector.md`).
- **The store is in memory.** A restart loses pending approvals and `done` markers. A person who clicks Approve after a restart is told the preview is no longer valid and runs the pull again. The idempotency key (same rows, same day) still stops a second list. One replica only (AD-8).
- **Row data in the ops channel.** Escalations carry counts and reasons only, tested by asserting no row value appears. Reasons are fixed strings from the engine, never connector text.
- **The scoring model is ours, not the client's.** Weights and ranges for Win-back are a demo choice. A real client decides them, and the reason line is how they can challenge it.
- **"Done" is tests only until you check it live.** 10.3 gets a live push check (needs `#brightside-ops`). 10.4 is done only after your live demo (`--kind decision` when each is ready).
- **Stale docs.** The architecture's AD-15 doesn't have the retry rule or where connectors are loaded, AD-17 lacks `PreviewInvalid`, and AD-4's `scoring` and `write` shapes change with decisions 1 and 3. Each story updates its AD lines in the same PR.

## New ledger items (proposed)

The Orchestrator assigns the next free DEP ids when it adds these (plan epic-9 proposed DEP-019 to DEP-021).

| Row | Owner | What |
|---|---|---|
| DEP-(next) | **Ely** | Create `#brightside-ops` in `aplabs-demo`, invite Brightside Bot (dev), and give the agent the channel id. Blocks the live check after 10.3, not the build. |
| DEP-(next+1) | **Ely** | The live demo of 10.4 in Slack, recorded in the PR. Until it's done, Epic 10 is "built (tests only)". |
| DEP-017 | Orchestrator | Closed by 10.0. |
| DEP-013 | Orchestrator | Closed by 10.3. |

## Steps only you can do

1. Before 10.3's live check: in `aplabs-demo`, create `#brightside-ops`, invite Brightside Bot (dev), and paste the channel id (it starts with `C`, it's not a secret) into the session.
2. After 10.3 merges: push a Win-back list in Slack, check the Outbox entry, click Approve a second time, and paste what you saw.
3. After 10.4 merges: follow `docs/runtime/demo-script.md` in Slack, start to finish, once with the AI on and once with `APLABS_LLM_OFF=1`. Paste what you saw. That makes 10.4 done.

## Not in this plan

- A real email tool or CRM. Only the Brightside mocks. A fork's first real connector is its own plan.
- A durable store or a second replica (architecture, Deferred).
- Scheduled pushes (Epic 11.1 declares jobs; the template ships none).
- AI-written reasons or AI-chosen weights. Scoring stays deterministic (NFR9).
- Any push to a channel other than the one escalation exception.
- Retro: `npm run retro` runs at the Epic 10 boundary as usual. It's not a story here.

## To approve

Type `approve plan epic-10`, with your six decisions in the same message. For example: `approve plan epic-10, scoring as recommended, score then cut, pushList with write.send and write.list_name, lock write code at T3, done result bound to the person, retry button`.
