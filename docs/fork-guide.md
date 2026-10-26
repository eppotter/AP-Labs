# Starting an engagement fork

> **Clone only from the distribution repo (`aplabs-template`). The AP Labs source repo carries internal history and never goes to a client.**

A **fork** is the client's own copy of this template: the same engine (`kit/`, `profiles/_schema/`), plus the client's profile, context, modules and data. The client **adds** to the template and never edits the engine. Fixes to the engine go to the template, and the fork takes them as a template update.

**What day one produces:** a private client repo cloned from a template release, with the client's profile and context in `.aplabs/`, the example client removed, a recorded template version, a runtime Slack app, one working module on one hub, and a plan for the first onboarding build. By the end of day one the bot answers in the client's Slack, run by hand or as one container.

Steps marked **You, not the agent** need a password, a token, a paid account or a GitHub or Slack admin. A person does them. An agent never handles a credential and never pushes to `main` or pushes a tag.

Throughout, the example client is called Acme Co (`acme`). Use the real client's name and id.

## 1. Create the client repo from a release tag

**You, not the agent:** creating the GitHub repo and the first push.

Clone the distribution repo, `aplabs-template`, **at a release tag**, so the template's release history comes with it. Updates merge only into a repo that shares that history. Never use GitHub's **Use this template** button: it drops the history, and no update can merge afterwards.

```bash
git clone --branch v0.2.0 https://github.com/eppotter/aplabs-template.git acme-aplabs
cd acme-aplabs
git switch -c main
git remote rename origin upstream
```

`v0.2.0` stands for the newest release tag: use that one (`git tag --list 'v*'` shows them; `CHANGELOG.md` says what each one changed). `upstream` now points at the distribution repo, and stays there: it is where updates come from.

Then create an **empty, private** repo for the client on GitHub (no README, no licence, no `.gitignore`), and push to it:

```bash
git remote add origin https://github.com/<client-org>/acme-aplabs.git
git push -u origin main
```

From here on, work goes through branches and PRs, as in the template. Then install and check that the copy is sound:

```bash
npm ci
npm run check && npm test
```

## 2. Write the client profile

The profile is the one file that says who the client is, who may use what, and how risky each path is. In a fork it lives at `.aplabs/profile.yml` (the schema is `profiles/_schema/profile.schema.json`; Brightside's `profiles/brightside/profile.yml` is a full example to read before you delete it in step 3). Its context lives beside it in `.aplabs/context/`.

Everything under `.aplabs/` is always T3, whatever the profile says: once the profile exists, every later change to it goes through the plan gate and review.

A starting profile:

```yaml
schema_version: 1

client:
  id: acme
  name: Acme Co

# Blast radius. Highest match wins; unmatched code floors at T1.
tiers:
  T3:
    # The fork's own write paths: every connector, and one row per write module.
    - "app/connectors/**"
    - "app/modules/crm-push/**"
  T2:
    # Scheduled jobs run with no person asking: never below T2.
    - "app/jobs/**"
    - "app/jobs.json"
    - "app/modules/**"
  T1: ["app/hubs/**"]
inert: ["**/*.md", "docs/**"]

gate:
  engagement_ttl_minutes: 60

resources:
  - key: TIER3_APPROVE
    label: Approve T3 changes
    admin_grantable: false
  - key: WEEKLY_REPORT
    label: Weekly report

users:
  - id: sam
    name: Sam Owner
    role: admin
    identities: { github: sam-acme }
    grants: [TIER3_APPROVE]
```

- **Tier rows.** Put the fork's own risky paths in: `app/connectors/**` and every write module (a module with a manifest `write` block) at T3, and `app/jobs/**` and `app/jobs.json` at T2 or higher. Add the client's own risky areas (billing, exports, anything with personal data) the way Brightside does.
- **The engine already floors these at T3**, whatever the profile says, so a fork doesn't need rows for them: `.aplabs/**`; access and the profile (`kit/runtime/access/**`, `kit/lib/permissions/**`, `kit/lib/profile/**`); secrets (`kit/lib/secrets/**`); the data connection, the SQL checker and the AI service (`kit/runtime/data/**`, `kit/runtime/sql/**`, `kit/runtime/llm/**`); the governance (`kit/lib/tier/**`, `kit/lib/gate/**`, `kit/hooks/**`); scheduled jobs (`kit/runtime/jobs/**`); the image and CI (`Dockerfile`, `.dockerignore`, `.github/workflows/**`); releases and updates (`kit/release/**`, `kit/lib/template/**`, `kit/lib/fork/**`, `kit/lib/dist/**`); and the write path (`kit/runtime/archetypes/approval-write/**`, `kit/runtime/connectors/**`, `kit/runtime/store/**`). Brightside's rows for the runtime's paths are all covered by these floors. The full list is `ENGINE_T3` in `kit/lib/tier`.
- **Resources and users.** Each module sits on a resource. Leave a resource gated (no `open_access`) unless it shows nothing about the client's business, and grant it by name. Slack ids go in `identities.slack` (Profile → ⋯ → Copy member ID); they are ids, not secrets.

Check it. This loads the profile, lists every mistake, and shows the tier a path gets:

```bash
node kit/lib/tier app/jobs/nightly-check.js app/connectors/crm/connector.js
```

## 3. Remove the example client and start an empty ledger

The template ships a demo client, Brightside. A fork deletes it:

```bash
git rm -r examples/brightside profiles/brightside
```

Leave `package.json` as it is, including `aplabs.appDirs`: it only adds folders to scan, and a missing one is fine. The `fixture:*` scripts in `package.json` name the example's folder, so they stop working in a fork; CI skips its fixture steps in a fork with no example. To build a synthetic fixture of your own, run the same tools on your folder (`node kit/fixture/build.js <your-fixture-dir>`).

Then start the fork's own build ledger. `docs/ledger.md` arrives with no rows (the introduction, both headings and both table header rows only), so there is nothing to delete; just check it. The fork's first row is the day-one PR.

```bash
node --test test/unit/ledger.test.js
```

The fork also keeps its own `docs/planning/` (the distribution repo ships none). A template update leaves the fork's ledger and planning files as they are.

## 4. Record the template version

Record the release the fork is built from. The command first checks the engine is exactly that tag's:

```bash
npm run template:check -- --record v0.2.0
```

It writes `.aplabs/template-version` (the version and a fingerprint of `kit/` and `profiles/_schema/`) and never commits. Commit it with the profile. From then on `npm run template:check` passes only while the engine is untouched, and the fork's CI runs it on every PR. A fork with a profile and no record fails it.

## 5. Create the runtime Slack app

**You, not the agent:** creating the Slack app and installing it.

The runtime bot is its own Slack app. It is separate from any app you use for an incoming webhook (such as the one `npm run notify` posts through): never add bot scopes to that one.

1. Write `app/slack-manifest.json` with what a person sets once: `display_information` (the app's name and description), `features.bot_user` and `features.app_home`. Copy the shape from the example's `examples/brightside/app/slack-manifest.json` before you delete it, and change the names.
2. Add the first hub, `app/hubs/acme.json` (an `id`, its slash `command`, a `name`, a `description` and a `welcome`), as in the example's `examples/brightside/app/hubs/`.
3. Generate the rest of the manifest (one slash command per hub, the bot scopes, Socket Mode):

   ```bash
   npm run slack:manifest
   ```

4. Create the app from that file and install it, as in `docs/runtime/slack-app-setup.md` (section 1). Don't add scopes by hand: a new scope needs an Architect review.

Run `npm run slack:manifest` again whenever you add a hub, and commit the result.

## 6. Store the Slack tokens and the AI key

**You, not the agent:** every token and key.

- **Slack:** the bot token (`SLACK_BOT_TOKEN`) and the app-level token (`SLACK_APP_TOKEN`), as in `docs/runtime/slack-app-setup.md` (section 2).
- **The AI key** (`ANTHROPIC_API_KEY`), as in `docs/runtime/ai-setup.md`. **Set a monthly spend cap in the Anthropic console first.** That cap is the one a restart can't reset. Without a key the AI is off and people fill in forms themselves.

On a laptop they go in the macOS Keychain; on a host they go in the host's secret store and reach the app as env vars. Never paste one into the repo, the profile, a PR or a chat with an agent.

## 7. Build or connect the data

The bot reads one read-only data source, set by the profile's `data` block:

- **`data.source: local`** (the default): a DuckDB file. Either a synthetic fixture built with `node kit/fixture/build.js <your-fixture-dir>`, or a file the host mounts at `APLABS_DATA_PATH`.
- **`data.source: motherduck`**, with `data.database`: one MotherDuck database, read with the bot's own read-only key (`MOTHERDUCK_READ_TOKEN`). **You, not the agent:** creating the reader account and its key. How the read key, the share and the publish key fit together is in `docs/runtime/motherduck-publish.md` ("The bot reading MotherDuck").

Columns no query may name go in the profile under `sql.forbidden_columns`. Decide them on day one with the client: personal contact details, pay rates and anything they call sensitive.

## 8. Add the first module, connectors and jobs

Every addition is a folder in the app dir, `app/`. No engine file changes.

- **A module** is one entry on a hub's menu. Copy the template and follow `kit/templates/module.md`:

  ```bash
  cp -r kit/templates/module app/modules/weekly-report
  ```

  Declare its resource in the profile and grant it, then run `npm test` and restart the app.
- **A connector** reaches an external system (a CRM, an email tool). Follow `kit/templates/connector.md`:

  ```bash
  cp -r kit/templates/connector app/connectors/crm
  ```

  A module never writes to a connector itself: a push is a manifest `write` block, run by the approval-write archetype after a person approves the preview. A real connector needs a **durable idempotency store** and the system's own dedupe keys, or a restart mid-push can send items twice (see "For forks" in `kit/templates/connector.md`). Add the connector's folder and each write module to the profile's T3 rows (step 2).
- **A scheduled job** is an entry in `app/jobs.json` and a file in `app/jobs/`, switched on with `jobs.enabled: true` in the profile. Follow `kit/templates/job.md`. Jobs read only: a job can't write to a connector or post to Slack, and `npm run check` fails one that tries. A scheduled report or push is planned on its own.

Then `npm run check && npm test`.

## 9. Run the onboarding build

The onboarding build turns the deep dive into the client's context files: `org.md`, `data.md`, `guardrails.md` and `connectors.md` in `.aplabs/context/`. It always needs a human's `approve plan <slug>`, at any tier.

```bash
npm run engage -- --kind onboarding --plan acme-onboarding
npm run onboard -- --init
npm run onboard -- --status
```

`--init` copies the empty templates from `kit/templates/context/` and never overwrites. The onboarder agent fills `data.md`, `guardrails.md` and `connectors.md`; the scribe agent drafts `org.md`. Each file records its named client owner's sign-off, and `--status` shows who has signed. Each known truth about the data is a fenced truth block in `data.md` with a check, and `npm run verify` runs them.

## 10. Run it, then deploy one replica

On a laptop, with the tokens in the Keychain:

```bash
npm start
```

It reads `.aplabs/profile.yml` and the app dir `app/`, and logs one startup line naming the client. Send the bot a direct message, then type the hub's slash command.

On a host, run the container, following `docs/runtime/container.md`. **You, not the agent:** the host account and its secrets. The rules that matter:

- **Exactly one replica**, deployed **stop-then-start**, never rolling. Two copies split Slack's events.
- Secrets come from the host's secret store as env vars; nothing is baked into the image.
- Mount `.aplabs/` read-only and set `APLABS_PROFILE`, `APLABS_APP_DIR` and `APLABS_HEALTH_PORT`.

## What a fork never edits

A fork may **append** dependencies to `package.json`. It never edits:

- `kit/**`
- `profiles/_schema/**`
- `.github/workflows/**`, including `.github/workflows/ci.yml`
- `Dockerfile`
- `.dockerignore`
- `scripts/**`
- the `package.json` scripts, or `package-lock.json` by hand

These are template-owned. A fix to any of them goes to the template as a PR there, and the fork takes it as an update. `npm run template:check` fails when `kit/` or `profiles/_schema/` changes.

## Rules to keep in mind

- **The `-- protected-columns` exception is for synthetic data only.** A fixture check that names a forbidden column (`-- protected-columns: clients.phone`) runs only on a file `node kit/fixture/build.js` wrote; the validator refuses it on any other file. Never point `--db` at real data to lift one (issue #77).
- **Real connectors need a durable idempotency store** and their own dedupe keys (step 8).
- **Scheduled jobs can't write or post** (step 8).
- **No secrets, ever,** in the repo, a log, a PR or a chat.

## Checking the engine is untouched

```bash
npm run template:check
```

It passes while `kit/` and `profiles/_schema/` match the recorded release. When they don't, it names each changed file if it can reach the tag (here, or on `upstream`); offline it only says the engine changed. Undo the edit and send the fix to the template.

## Taking a template update

**In plain words.** The fork is the client's copy of the template. `upstream` is the git remote that points at the distribution repo, `aplabs-template` (step 1 set it up), never the AP Labs source repo, and `origin` is the client's own repo. When AP Labs improves the template, it cuts a release: a tag such as `v0.3.0`, with an entry in `CHANGELOG.md` that says what changed and what a fork must do. The client **adds** to the template and never edits the engine, so a release can flow into the fork with one command and no hand-merging.

Run it on a clean, up-to-date `main`:

```bash
git switch main
git pull
npm run template:update -- v0.3.0
```

It refuses, and says why, unless: this is a fork with a recorded template version (step 4), `upstream` exists, the worktree is clean, you are on `main` and it matches `main` on `origin`, the version is newer than the recorded one, and `npm run template:check` passes. If the fork has edited anything in `kit/` or `profiles/_schema/`, it names each file: undo those edits and send the fix to the template instead.

Then it:

1. Fetches the release from `upstream` and merges it into a new branch, template/v0.3.0, made from `main`, with a merge commit.
2. Sorts out the paths the release changed:
   - files the fork deleted on purpose since its recorded release (the example client, step 3) stay deleted, and new template files under those folders stay out;
   - the fork's own `docs/ledger.md` and `docs/planning/` stay exactly as they are on `main`;
   - `package.json` becomes the template's, with the fork's appended dependencies added back, and `package-lock.json` is regenerated (`npm install --package-lock-only --ignore-scripts`);
   - if the release touches the fork's own files (`.aplabs/` or the app dir `app/`), or any other file conflicts, it stops, leaves the fork exactly as it was and back on `main`, and names the files. It also stops if the template now ships a dependency the fork appended: remove the fork's entry on `main` first.
3. Upgrades `.aplabs/profile.yml` when the release raises the profile's `schema_version`, keeping its comments, using the steps in `kit/lib/template/migrations`. It refuses a fork whose profile is on a newer version than the release.
4. Updates `.aplabs/template-version`, commits, runs `npm ci` if the lockfile changed, then `npm run check && npm test`. If the checks fail it keeps the branch for you to look at, opens no PR, and goes back to `main`.
5. Pushes the branch to `origin` and opens a PR in the fork. The PR copies the release's "What a fork must do" lines and lists every path it handled, the package files and any profile change.

Read the PR like any other: do what "What a fork must do" says, check the profile diff if there is one, and merge it through the normal review. `.aplabs/` changes are T3, so the update PR always gets the full review.

**Take the update before adding a new profile block.** The profile schema refuses unknown keys, so a kit older than a block refuses a profile that uses it. For example, a kit from before the routing block refuses a profile with a `routing:` key. Take the template update first, then add the block to `.aplabs/profile.yml`.
