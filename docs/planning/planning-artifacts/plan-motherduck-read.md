# MotherDuck read: plan for Ely

Status: draft, waiting for `approve plan motherduck-read` (closes ledger DEP-011)

**In short:**
1. Today the bot reads a local copy of Brightside's data; this plan lets it read the shared MotherDuck copy instead, still read-only.
2. First you run a test (Story A) that proves MotherDuck can be locked down as tightly as the local copy. If it can't, we stop and redesign.
3. Only then does the bot switch over (Story B), with its own read-only key, and it says "data unavailable" rather than crash if MotherDuck is down.

## What you're approving

- [ ] **Two stories, in order:** A (the lockdown test) must pass before B (the switch) starts.
- [ ] **Two new profile settings:** `data.source` (`local` or `motherduck`, default `local`) and `data.database` (the database name).
- [ ] **A new read-only key** (`MOTHERDUCK_READ_TOKEN`) from a separate MotherDuck service account that can see only the Brightside share.
- [ ] **No fallback:** if MotherDuck is down, the bot says so. It does not quietly switch to local data.
- [ ] **The network lock stays on** unless the Story A test proves it has to come off (it may block MotherDuck itself). If it does, the bot's other locks and the SQL checker replace it, and you see the evidence first.

## The two stories

| Story | Who runs it | Size | You will see |
|---|---|---|---|
| A. Lockdown test | Builder writes it, **Ely** runs it | S | A pass/fail line for each of 9 checks |
| B. The bot reads MotherDuck | Builder | M | Dataset entry on /brightside shows "MotherDuck", the database, version and publish time |

Tiers, computed with `node kit/lib/tier` on each story's files: **Story A is T2** (the query runner's DuckDB allow-list), **Story B is T3** (profile schema and the secrets path: full review, architect design review, `bmad-review`).

### Story A: the lockdown test (Ely runs it)

A new command, `npm run fixture:probe`, opens MotherDuck the locked way and reports what holds.

**Acceptance criteria.** The probe prints pass or fail for each of these:

1. The MotherDuck add-on is installed ahead of time and loaded on purpose; automatic install and load are off.
2. `md:<db>?attach_mode=single&saas_mode=true` connects with `access_mode=READ_ONLY` and the token passed as a setting.
3. Whether `enable_external_access=false` blocks MotherDuck itself. **This is the biggest unknown.** If it does, `saas_mode` plus the SQL checker take its place.
4. `lock_configuration` still holds after connecting.
5. Attaching other databases, `COPY`, `read_csv`, writes and other databases are all refused.
6. A slow query can be stopped when it runs past its time limit.
7. The add-on works with the DuckDB version we pin (`@duckdb/node-api` 1.5.6-r.2).
8. Whether Steven's share survives a re-publish (publish replaces the database).
9. How far behind the read copy lags after a publish.

If any check fails, we stop and redesign. The lockdown is never loosened quietly.

**Files:** new `kit/fixture/md-probe.js`; a `fixture:probe` script in `package.json`; the probe added to the list of files allowed to import DuckDB (`kit/runtime/data/index.js`, lines 5-7) and to that list's grep test.

**Risks:** the probe is the first thing in the repo that connects to MotherDuck as a reader; it runs only on your machine, never in CI.

### Story B: the bot reads MotherDuck

**Acceptance criteria:**

- The profile gains `data.source` (`local` or `motherduck`, default `local`) and `data.database` (a checked name). Reviewed like any profile change. CI and the clean-bones check stay local and offline.
- A new key, `MOTHERDUCK_READ_TOKEN` (Keychain: `aplabs-motherduck-read-token`), is registered with the log scrubber before connecting. If it's missing, startup fails and names the setting. If it equals the publish key, startup refuses.
- The connection uses only the settings Story A proved, then `USE <db>`, then `lock_configuration`. The SQL checker is unchanged.
- Time limits on connecting and on every query. If MotherDuck is down, slow or the key is bad, the person sees "data unavailable" and the app keeps running.
- No fallback to local data in V1.
- The Dataset entry shows source (local or MotherDuck), database, fixture version, as-of date and publish time.
- Tests use a fake connection. A grep check proves no new file imports `@duckdb/node-api`.

**Files:** `kit/runtime/data/index.js`, new `kit/runtime/data/motherduck.js`, `kit/runtime/app/index.js`, `profiles/_schema/profile.schema.json`, `kit/lib/profile`, the Dataset handler and its `.sql`, `docs/runtime/motherduck-publish.md`, the architecture's AD-9 and Deferred section, tests.

## Risks

- **A read key can see every database in its account.** So the bot gets its own MotherDuck service account holding only the `brightside_fixture` share. If our plan doesn't offer service accounts, a second account instead. *Unverified: whether our MotherDuck plan has service accounts.*
- **The bot's first outbound connection.** Until now it never left the machine.
- **The read copy can lag** just after a publish. The Dataset entry shows the version, so you can tell.
- **Cost:** MotherDuck charges for compute. No cap in V1; there's room to add one.
- **Upgrades:** moving to DuckDB 2.0 has to wait until MotherDuck supports it.
- **Dataset is open to everyone** in the demo. Fine for Brightside; client forks should restrict it.

## New ledger items (proposed)

| Row | Owner | What |
|---|---|---|
| DEP-014 | **Ely** | The MotherDuck service account and its read key (`MOTHERDUCK_READ_TOKEN`) |
| DEP-015 | **Ely** | The new `data.source` and `data.database` profile settings |
| DEP-016 | Orchestrator | Installing the MotherDuck add-on ahead of time changes the Story 11.2 container file |

DEP-011 closes with Story B's PR.

## Steps only you can do

1. Create a MotherDuck account with the venture email (not Hometown) and a token for publishing.
2. Store it: `security add-generic-password -s aplabs-motherduck-token -a aplabs -w` (it prompts for the token).
3. Run `npm run fixture:build`, then `fixture:validate`, then `fixture:publish` (full commands in `docs/runtime/motherduck-publish.md`).
4. Share `brightside_fixture` read-only with Steven.
5. Create the service account, share `brightside_fixture` to it read-only, make a read-scaling token for it, and store it as `aplabs-motherduck-read-token`.
6. Run the Story A probe and paste the results into the session.
7. Publish again, then re-run the probe to check that Steven's share survived and how long the lag was.

Never paste a token into the repo, the profile, a PR or a chat with an agent.

## To approve

Type: `approve plan motherduck-read`. Change anything above in the same message, for example: `approve plan motherduck-read, add a cost cap in Story B`.
