# Publishing the fixture to MotherDuck (Ely only)

A human step. Agents never run `fixture:publish` or `fixture:status -- --remote`, and never handle the token. CI and tests use a fake connection. The bot never reads MotherDuck: it reads the local fixture only (DEP-011).

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
