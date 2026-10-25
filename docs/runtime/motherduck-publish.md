# Publishing the fixture to MotherDuck (Ely only)

A human step. Agents never run `fixture:publish`, `fixture:status -- --remote` or `fixture:probe`, and never handle a token. CI and tests use a fake connection. The bot never reads MotherDuck: it reads the local fixture only (DEP-011).

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
4. replaces `brightside_fixture` with it (`CREATE OR REPLACE DATABASE … FROM …`), checks it again, and drops the staging copy.

If anything fails before step 4, the shared database stays as it was. If the final drop fails, the next publish clears the leftover staging copy. To publish under another name, pass `-- --database <name>`: a new name, or one `fixture:publish` wrote before. Names are lower-case letters, digits and `_`.

The **fixture version** is `<generator_version>+<12 hex>`. The hex comes from a hash of `schema.sql` and `seeds/*.csv`, so a seed edit shows even without a generator version bump.

## 3. Check it

```bash
npm run fixture:status               # local only, offline: version, as-of, row counts
npm run fixture:status -- --remote   # also compares the shared copy (needs the token)
```

`--remote` prints `match` when the remote version and every table's row count equal the local build. Otherwise it prints `differs` and lists each difference, and exits 1.

## Sharing

After the first publish, share `brightside_fixture` read-only with the teammate from the MotherDuck UI. A re-publish replaces the database, so check that the share still points at it.

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
