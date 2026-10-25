# Publishing the fixture to MotherDuck (Ely only)

A human step. Agents never run `fixture:publish`, `fixture:status -- --remote` or `fixture:probe`, and never handle a token. CI and tests use a fake connection. The bot reads the local fixture unless its profile says `data.source: motherduck`; then it reads with its own read-only key, never this publish token (see "The bot reading MotherDuck" below).

## 1. Store the token once

Create a token in MotherDuck (Settings → Access Tokens). Store it in the macOS Keychain. With `-w` last, `security` prompts for the token, so it stays out of your shell history:

```bash
security add-generic-password -s aplabs-motherduck-token -a aplabs -w
```

Or set `MOTHERDUCK_TOKEN` for one shell. The env var wins over the Keychain when both are set. With `APLABS_NO_KEYCHAIN=1`, only the env var is read. Never paste the token into the repo, the profile, a PR or a chat with an agent.

## 2. Build, validate, publish

```bash
npm run fixture:build
APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" npm run fixture:validate
APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" npm run fixture:publish
```

`fixture:publish` refuses, and changes nothing remotely, unless all of these hold:

- a profile governs (`--profile`, `APLABS_PROFILE` or `.aplabs/profile.yml`). With no profile the forbidden columns are unknown, so it exits 2 before any check runs, like `fixture:validate`.
- the local build exists and is not older than the seeds.
- the build carries a valid `fixture:build` stamp. The stamp names a hash of the file's whole content, so a stamp written by hand or copied onto other data does not count.
- the build holds exactly what a fresh build of the seeds holds. Publish rebuilds the seeds into a temporary file (offline, about a second) and compares. `--db` can name any file, and only the synthetic seeds are ever published.
- every check passes.

Every refusal above happens before the token is read or a connection opens. Once connected, publish also refuses when the target database already exists but has no `fixture_publish` table, which means `fixture:publish` did not write it. `--database` can name any MotherDuck database, and publish never replaces one it did not write. That refusal sends only reads: nothing remote is changed or dropped, a leftover staging copy included. A target that doesn't exist yet is fine (the first publish). It then:

1. uploads the build to `brightside_fixture__publishing`, table by table. It attaches the local build read-only, creates each table from its local definition (keys, foreign keys and `NOT NULL` rules kept), parents before the tables that reference them, copies the rows in the same order, and detaches the local build again, also when something fails. It refuses, before creating the staging copy, when the foreign keys form a cycle or the build holds anything besides tables (a view, index, sequence, macro, type or extra schema). A whole-database copy of the file is not used: MotherDuck loads its tables in an order that ignores foreign keys, which broke the first publish,
2. adds a `fixture_publish` table recording the fixture version, seeds hash, as-of date, publish time and row counts,
3. checks that copy against the local build,
4. swaps it in, checks `brightside_fixture` against the local build again, and drops the staging copy. How it swaps:
   - **First publish** (the database doesn't exist yet, so no share can either): `CREATE DATABASE brightside_fixture FROM brightside_fixture__publishing`.
   - **Re-publish:** MotherDuck refuses to replace or drop a database while a share is attached, and the bot reads through one. So publish updates `brightside_fixture` in place, in one transaction, with it as the current database (MotherDuck refuses foreign keys that name another database). It drops the old tables, children first by the database's own foreign keys. Then it creates the build's tables from the definitions the upload used, parents first, and copies their rows in from the staging copy. It replaces `fixture_publish` last, so the version commits with the data, and then commits. Every table is rebuilt, even when its layout is unchanged: DuckDB checks foreign keys statement by statement, even inside a transaction, so deleting a parent's rows while the old child rows still exist is refused. Only the `main` schema is rebuilt: tables in any other schema of the database are never read into the swap, dropped or recreated. If a `main` table has a foreign key to or from another schema, publish refuses before the transaction starts and sends no write to the database.

If anything fails before step 4, the shared database stays as it was. A failure inside the re-publish transaction rolls it back; publish says the database was not changed only when the rollback succeeded, and otherwise says it may be partly changed. If the commit itself fails, whether the database was updated is unknown: publish says so and asks you to check with `npm run fixture:status -- --remote`. A staging copy left behind (after a failed commit, rollback or final drop) is cleared by the next publish. To publish under another name, pass `-- --database <name>`: a new name, or one `fixture:publish` wrote before. Names are lower-case letters, digits and `_`.

The **fixture version** is `<generator_version>+<12 hex>`. The hex comes from a hash of `schema.sql` and `seeds/*.csv`, so a seed edit shows even without a generator version bump.

## 3. Check it

```bash
npm run fixture:status               # local only, offline: version, as-of, row counts
npm run fixture:status -- --remote   # also compares the shared copy (needs the token)
```

`--remote` prints `match` when the remote version and every table's row count equal the local build. Otherwise it prints `differs` and lists each difference, and exits 1.

## Sharing

After the first publish, share `brightside_fixture` read-only with the teammate from the MotherDuck UI. A re-publish updates the database in place, so its shares stay attached.

**The lag after a re-publish.** A share is a read copy that catches up after a publish. In the live test on 2026-10-25, a reader on the bot's share kept seeing the old rows of the rebuilt tables for about 60 seconds, then switched cleanly to the new ones, with no errors. The exception is a publish that **adds new tables**: until it propagates, a query that touches a new table fails, and the bot answers "data unavailable" for a minute or two. Re-run `npm run fixture:probe` (checks 8 and 9) to see when the read copy matches.

## Probe

`npm run fixture:probe` checks that MotherDuck can be locked down as a reader as tightly as the local fixture (plan `motherduck-read`, Story A). Run it before Story B starts, and paste its output into the session.

1. Make a read-scaling token for the read-only service account, which holds only the `brightside_fixture` share. Store it with `security add-generic-password -s aplabs-motherduck-read-token -a aplabs -w`, or set `MOTHERDUCK_READ_TOKEN` for one shell. The probe refuses to start without it, or when it equals the publish token.
2. Install the MotherDuck extension ahead of time, once per DuckDB version: `npm run fixture:probe -- --install`. This step downloads; the probe itself never installs anything.
3. Run `npm run fixture:probe`. Pass `-- --database <name>` to probe another database.

It opens an in-memory DuckDB with extension auto-install and auto-load off. Then it runs `LOAD motherduck`, `SET motherduck_token`, `SET motherduck_attach_mode = 'single'`, `ATTACH 'md:<db>' AS <db> (READ_ONLY)`, `SET enable_external_access = false` and `SET lock_configuration = true`. Every new connection runs `USE <db>`. This is the connection Story B uses. It prints one `PASS`, `FAIL` or `INFO` line per check, then a summary. The one known exception below is printed as `ACCEPTED` and does not fail the run:

| Check | Kind | What it shows |
|---|---|---|
| 1 | required | The extension was installed ahead of time and loaded on purpose; auto-install and auto-load are off. |
| 2 | required | The database attaches read-only with the token as a setting, and a new connection after `USE` sees its tables. |
| 3 | info | `enable_external_access=false`: the `md:<db>?attach_mode=single&saas_mode=true` form fails with it set at startup, and the sequence above keeps it off. |
| 4 | required | `lock_configuration` holds: no `SET` can loosen the settings. |
| 5 | required | First, only `<db>`, `md_information_schema` and `memory` are attached. Then refused, one line each: `ATTACH` (a local file, `md:sample_data`), `COPY`, `read_csv` of a local file and of an http URL (a listener the probe starts must get 0 requests), `INSTALL`/`LOAD httpfs`, `CREATE` and `INSERT` (inside a transaction that is rolled back), and reading `my_db` or `sample_data`. The local files exist (the probe makes a real DuckDB file and a CSV first), so a local-file refusal counts only as a Permission Error. A "not found" or any other error is a `FAIL`. An `ATTACH` that runs is detached again at once. `ATTACH 'md:my_db'` is the accepted exception below. |
| 6 | required | A slow query is interrupted after 2 seconds. |
| 7 | required | The DuckDB and extension versions, against the pinned `@duckdb/node-api`. |
| 8 | info | Whether a share survives a re-publish. Publish again, then re-run the probe: if it still reads and shows a newer publish time, the reader's share survived. Ask Steven to check his. |
| 9 | info | The lag. The probe compares the read copy's version and publish time with the local build. After a publish, re-run it until they match. |

### Known exception: the reader's own `my_db` (accepted)

Under the reader sequence, `ATTACH 'md:my_db'` still succeeds after the lock. `my_db` is the reader account's own default database. Live tests on 2026-10-24 found that DuckDB and MotherDuck cannot stop it:

- `SET motherduck_attach_mode = 'single'`, set before `ATTACH`, blocks `md:` and `md:sample_data`, but not `md:my_db`. The sequence keeps it because it narrows what can be attached.
- `motherduck_saas_mode=true` doesn't block it either.
- `DROP DATABASE my_db` is refused.

Ely accepted this on 2026-10-24. The barrier is the SQL checker (`kit/runtime/sql`): every query the bot runs passes through it first, and it refuses `ATTACH`, writes and multiple statements. So a query from the bot cannot attach `my_db`. The probe reports this line as `ACCEPTED` and detaches `my_db` straight away. Any other database that attaches is still a `FAIL`. The read-only service account's `my_db` should stay empty.

Exit 0 means every required check passed. Any `FAIL` exits 1: stop and redesign before Story B. The lockdown is never loosened quietly. Every MotherDuck error is printed first line only, with both tokens masked.

## The bot reading MotherDuck

By default the bot reads the local fixture file. A profile can switch it to the shared copy:

```yaml
data:
  source: motherduck            # default: local
  database: brightside_fixture  # required with motherduck, refused with local
```

The Brightside profile in this repo stays `local`, and CI and `clean-bones` stay offline. There is no env override for the source.

**Its own key.** The bot reads with a separate MotherDuck service account that holds only the client's share (for Brightside: `brightsidebotreader`, with the restricted share `brightside_fixture_share` attached as `brightside_fixture`). Its read-scaling token is `MOTHERDUCK_READ_TOKEN`, else the Keychain item `aplabs-motherduck-read-token`:

```bash
security add-generic-password -s aplabs-motherduck-read-token -a aplabs -w
```

At startup the bot registers the read key with the log scrubber first. A missing key refuses startup and names the setting. If the publish key (`MOTHERDUCK_TOKEN`) is also present, the bot registers it, compares them, refuses to start if they are equal, and never keeps the publish key; if it is absent, the log says the check was skipped. A `local` profile never reads either key.

**The locked sequence** (`MD_LOCKDOWN` in `kit/runtime/data/motherduck.js`): an in-memory DuckDB with extension auto-install and auto-load off; then `LOAD motherduck`, `SET motherduck_token`, `SET motherduck_attach_mode = 'single'` (blocks attaching other shares), `ATTACH 'md:<db>' AS <db> (READ_ONLY)`, `SET enable_external_access = false` and `SET lock_configuration = true`; then `USE <db>` on every connection. Once open, the bot checks that `current_database()` is `<db>` and that `fixture_meta` exists. It never creates a database. Only `<db>`, `md_information_schema` and the in-process scratch database `memory` are visible (the reader's `my_db` and `sample_data` are not); the SQL guardrail refuses writes and DDL on any of them. The reader's own `my_db` can still be attached by name; Ely accepted that on 2026-10-24 because the guardrail refuses ATTACH.

**The extension is installed ahead of time.** The bot never installs it. If it is missing, the data is unavailable and the log says to run `INSTALL motherduck` (for the container: DEP-016).

**When MotherDuck is slow or down.** Connecting has a 10s limit and never holds up Slack: the app starts and the data stays unavailable until a connect succeeds. Each query has a 30s limit. Any MotherDuck error shows the person "data unavailable" (the log gets a redacted reason); anything except a catalog or binder error drops the connection and the bot waits 30s before reconnecting. There is no fallback to the local file.

**What /brightside → Dataset shows:** the source (MotherDuck), the database, the fixture version, the as-of date and the publish time, read in one query from `fixture_meta` and `fixture_publish`. Just after a publish the read copy can lag (see "The lag after a re-publish" above); the version tells you which copy you see.
