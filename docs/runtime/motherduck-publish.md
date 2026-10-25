# Publishing the fixture to MotherDuck (Ely only)

A human step. Agents never run `fixture:publish` or `fixture:status -- --remote`, and never handle the token. CI and tests use a fake connection. The bot reads the local fixture unless its profile says `data.source: motherduck`; then it reads with its own read-only key, never this publish token (see "The bot reading MotherDuck" below).

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

**What /brightside → Dataset shows:** the source (MotherDuck), the database, the fixture version, the as-of date and the publish time, read in one query from `fixture_meta` and `fixture_publish`. Just after a publish the read copy can lag; the version tells you which copy you see.
