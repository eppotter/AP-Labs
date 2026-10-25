# Epic 11, ready to fork: plan for Ely

Status: **approved** under Ely's conditional pre-approval (2026-10-25: "approve plan epic-11 if the architect and plan review leave no unresolved blocking finding"). Architect design review and plan review done 2026-10-25: not ready as written; all 10 blocking findings folded in below, none left unresolved. One item needs Ely before the first REAL client fork (template history, DEP row below); it blocks no build in this epic.

The stories and their acceptance criteria are the ones you approved in the runtime phase plan (#52, `epics-runtime.md` Epic 11). This plan adds what has changed since then: the template's example-free CI job (6.5, `npm run clean-bones`), the engine path list (`kit/runtime/paths.js`), the bot reading MotherDuck (#110) and the open item it left for the container (DEP-016), the engine's T3 floors (#115, plan epic-9, plan epic-10 decision 4), and the fact that Docker is not installed on your Mac. It also folds in the architect design review and plan review of 2026-10-25 (section "Review findings folded in" below).

**In short:**
1. A new engagement can copy the template, add its own profile and modules, and run it. The bot can run small recurring jobs written as one line of data (none ship with the template), and it comes with a container recipe any host can run.
2. Tests prove the engine really is shared: two practice copies built in temporary folders differ only in their profile and their own modules, and a template improvement flows into a copy with one command and no hand-merging. Nothing creates a real GitHub repo; everything happens in throwaway folders.
3. Six stories: the five you approved, with 11.5 split in two (11.5 releases and the "engine untouched" check, 11.6 the update command). The container is built and tested by GitHub, not on your Mac; your local tests skip it and say so. 11.3 can start now. 11.1 and 11.2 can start before Epic 10 finishes but not alongside 10.2 or 10.3 (same startup file). 11.4, the fork guide, waits for 10.3. Your only hands-on step is pushing the release tags.
4. The review tightened the plan: job files must stay inside the jobs folder and never run while jobs are off, the health check now fails closed, the container's app files are read-only, the "engine untouched" check can't be skipped by deleting its record, and an update can't quietly overwrite the fork's own files. Four stories are now T3 (11.1, 11.2, 11.5, 11.6).
5. One decision for you, before the first real client fork only: cloning the template gives the client the template's whole git history, including `docs/reference/`. It blocks nothing in this epic.

## What you approved

- [x] **The five stories as approved in #52, with 11.5 split into 11.5 and 11.6** (Q13), in the build order below.
- [x] **A new optional profile setting, `jobs.enabled`** (true or false, default false), as the architecture already lists (AD-16). Reviewed like any profile change.
- [x] **A new off switch, `APLABS_JOBS_OFF`**, which stops every job whatever the profile says, like `APLABS_LLM_OFF` and `APLABS_WRITES_OFF`. Any non-empty value means off, including "0" (Q2).
- [x] **Jobs can read, not write or post** in V1 (Q3). A job gets the logger, the read-only query runner and the clock. It can't push to the email tool or any connector (the write-path check already refuses that in app code), and it can't post to Slack. A fork that wants a scheduled report in a channel adds that through its own plan.
- [x] **The container is checked in GitHub Actions only.** A new CI job builds the image and runs a smoke test inside it with no network. On a machine without Docker (your Mac), the local tests check the recipe's text and report the build test as **skipped**, never passed.
- [x] **The health check is built in 11.2.** The architecture describes it (AD-13), but it doesn't exist yet (Q7).
- [x] **Releases are git tags with a changelog entry,** and the command never pushes a tag unless asked. You push `v0.1.0` (retroactive, Orchestrator phase) yourself (Q14).
- [x] **A fork records its template version and an engine fingerprint in `.aplabs/template-version`** (Q15). The fork's CI fails if the engine (`kit/**`, `profiles/_schema/**`) no longer matches it, or if the record is missing.
- [x] **The open questions below: adopted as recommended, with the review's changes.**

## The stories

| Story | Who runs it | Size | Tier | You will see |
|---|---|---|---|---|
| 11.1 Scheduled jobs declared as data | Builder | M | **T3** | Nothing in Slack (the template ships no jobs). Tests with a fake clock show a job running on time, logging start, finish or failure, and the bot staying up when a job throws |
| 11.2 The app runs in a container | Builder | M | **T3** | A new `container` check on every PR in GitHub: the image builds and its smoke test passes. Locally, `npm test` shows the container build test as skipped ("docker not installed") |
| 11.3 Two forks differ only by profile and modules | Builder | M | T1 | A test that builds two practice client copies in temp folders, opens each one's hub as the same person, and sees each client's own name and menu |
| 11.4 The engagement fork guide | Scribe drafts the guide; Builder writes its structural test | S | T1 | `docs/fork-guide.md`: the day-one checklist, with every step that needs a password or token marked "you, not the agent" |
| 11.5 Template releases and the "engine untouched" check | Builder | M | **T3** | `npm run template:release -- v0.2.0` refuses until `main` is green, then tags it. A fork whose `kit/` was edited, or that has no template record, fails CI, naming the files |
| 11.6 Template updates flow into forks (split from 11.5) | Builder | M | **T3** | `npm run template:update -- vX.Y.Z` in a fork makes a branch, merges the release, runs the checks and opens a PR naming the version. Proven only on temp-folder forks |

**Tiers.** The epics said Epic 11 is T2, raised by `Dockerfile` and `.github/workflows/**` (11.2). That was before the engine floors (#115, plan epic-9, plan epic-10 decision 4), before `.aplabs/**` writes entered 11.5 and 11.6, and before the floors this epic adds in 11.1 (below). Final tiers after the review: 11.1 T3, 11.2 T3, 11.3 T1, 11.4 T1, 11.5 T3, 11.6 T3. The Orchestrator still recomputes each story's tier with `node kit/lib/tier` on its full file list before the story starts, and a story's tier can only go up from that computation. T2 and T3 stories get an architect design review.

## Prerequisites and dependencies

| # | Prerequisite | State | What it unblocks |
|---|---|---|---|
| P1 | **Story 6.5**: the module template, `test/fixtures/temp-fork.js`, `scripts/boot-smoke.js` and the `clean-bones` CI job | **Done** (#74) | 11.2 (smoke pattern), 11.3, 11.5 (release refuses unless `clean-bones` is green) |
| P2 | **`kit/runtime/paths.js`**: the identical-engine set and `listEngineFiles` | **Done** | 11.3, 11.5, 11.6 |
| P3 | **DEP-016**: the container must install the MotherDuck extension at image build | **Open**, closed by 11.2 | 11.2 |
| P4 | **Story 10.3** merged (approval-write, `slack.ops_channel`, the push and escalation) | **Not yet** | 11.4 (the guide describes write modules, the ops channel and tier rows for them) |
| P5 | **Story 10.2** merged (plan epic-10 decision 4: more engine T3 floors) | **Not yet** | 11.4 (the guide's tier rows) |
| P6 | **Epic 10 done and live-checked** (10.4's live demo) | **Not yet** | Cutting the first runtime release (`v0.2.0`), not any build |
| P7 | **Ely's decision on template history** (DEP row below) | **Not yet** | The first real client fork only, not any build in this epic |

### How Epic 11 depends on Epic 10

- **No story needs Epic 10's code to work.** Scheduled jobs can't push (Q3), so "a job that pushes" doesn't exist in this epic. Epic 10's own plan lists scheduled pushes as out of scope.
- **Shared files.** 11.1 and 11.2 edit `kit/runtime/app/index.js`, which 10.2 and 10.3 also edit. 11.1 edits `profiles/_schema/profile.schema.json`, which 10.3 also edits (`slack.ops_channel`). 11.1 edits the `ENGINE_T3` array in `kit/lib/tier/index.js`, which 10.2 also edits: whichever story merges later resolves the conflict. 11.1 edits `test/unit/write-path.test.js`, which 10.2 also edits. 11.2, 11.5 and 11.6 edit `.github/workflows/ci.yml`. By the build-loop rule, these never run in parallel with each other or with 10.2 or 10.3. Otherwise the later builder merges `main` and resolves the conflicts itself before it reports.
- **Can be built before Epic 10 finishes:** 11.3 (now, no shared files), 11.1 and 11.2 (one at a time, not alongside 10.2 or 10.3), 11.5 and 11.6 (the tooling).
- **Must wait for Epic 10:** 11.4 (after 10.3) and the first real release (after 10.4's live demo).
- Any Epic 9 story still in flight that touches `kit/runtime/app/index.js` follows the same rule.

## Build order

1. **11.3** now. It adds a test, fixtures and one new engine helper (`kit/lib/fork`), and touches no file Epic 9 or 10 touches.
2. **11.1**, when no 10.2 or 10.3 builder is active (or the 11.1 builder merges `main` before reporting).
3. **11.2**, after 11.1 (both edit `kit/runtime/app/index.js`).
4. **11.5**, after 11.2 (both edit `ci.yml`) and 11.3 (it reuses `kit/lib/fork`).
5. **11.4**, after 10.3, 11.1, 11.2, 11.3 and 11.5. The guide names their commands and files, and its structural test fails on any that don't exist.
6. **11.6**, after 11.4 and 11.5. It adds the "taking an update" section to the guide.

### Story 11.1: scheduled jobs declared as data

**Acceptance criteria:**

- **The registry.** A fork declares jobs in `<app dir>/jobs.json`: a list of `{ name, schedule, run, enabled }`. It is validated at startup against a new `kit/runtime/schema/jobs.schema.json` (`additionalProperties: false`), the same way module manifests are. The file is checked even when jobs are off, so a broken entry fails tests and startup naming the entry and field. No `jobs.json` means no jobs.
- **`name`** is a kebab-case slug, unique. **`run`** is a path relative to `<app dir>/jobs/`. After `fs.realpathSync`, it must resolve inside `<app dir>/jobs/` itself. A path with `..`, an absolute path, or a symlink that leaves `jobs/` stops startup, naming the job. Test: a `run` pointing into `<app dir>/connectors/<id>/` is refused. When jobs are on, the file must export an async `run(ctx)`; a missing or non-exporting file stops startup, naming the job.
- **`schedule`** (Q1) is a five-field cron expression evaluated in **UTC**: numbers, `*`, lists (`,`), ranges (`-`) and steps (`/`). No names, no seconds, no time zones. An invalid expression stops startup, naming the job. No new dependency. The next-run search is bounded (at most 5 years ahead). An expression with no run in that window stops startup, naming the job ("never runs"). Timers are armed for at most 24 hours and re-armed, never for the full delay. An expression that limits both day-of-month and day-of-week is refused. A schedule that can run more often than every 5 minutes is refused at startup, naming the job.
- **Turning on.** A job runs only when the profile's `jobs.enabled` is true, its own `enabled` is true, and `APLABS_JOBS_OFF` is not set (Q2). Any non-empty value of `APLABS_JOBS_OFF` means off, including "0", matching `APLABS_WRITES_OFF` (fail safe). The startup line says "jobs: on (n scheduled)", "off (profile)" or "off (APLABS_JOBS_OFF)".
- **Jobs off loads no job code.** With jobs off (profile or `APLABS_JOBS_OFF`), `jobs.json` is schema-checked and each `run` file is checked to exist under `<app dir>/jobs/`, but no job file is loaded. The `run(ctx)` export is checked only when jobs are on, and in `npm test`. Test: with `APLABS_JOBS_OFF` set, a job file whose top-level code throws does not stop startup and is never evaluated.
- **`jobs.enabled`** lands in `profiles/_schema/profile.schema.json` as an optional boolean, default false (filled by `validateProfile`), as AD-16 says.
- **What a job gets** (Q3): `ctx = { log, data, now, name }`. `log` is the redacting logger, `data` is the read-only query runner (`kit/runtime/data`, guardrails included) and `now` is the injected clock. No Slack client, no store, no connector. A job's limits come only from `ctx` plus review: job code is trusted app code and is not sandboxed (AD-1). A test asserts a job file in `<app dir>/jobs/` that reaches a connector's `write` fails `npm run check` (the write-path check already scans the whole app dir).
- **No Slack or connector imports in jobs.** `npm run check` fails a file under `<app dir>/jobs/` that imports `@slack/`, `#sdk` or a connectors path, naming the file.
- **Each run logs** one line at start and one at finish or failure, with the job name and duration in milliseconds. A failure logs the error through the redacting logger. Never query rows.
- **A job that throws or rejects** is logged and the app keeps running. The next run still happens on schedule.
- **No overlap, no catch-up** (Q4). If a run is still going when the next one is due, the next one is skipped and logged ("still running"). Runs missed while the app was down are not made up. Single-run relies on AD-8's stop-then-start deploys (one process at a time).
- **Stopping.** On SIGTERM or SIGINT, the scheduler stops scheduling new runs before the app stops. A run in progress is not awaited past shutdown.
- **The template ships no jobs.** A test asserts that no app dir listed in `package.json` `aplabs.appDirs`, nor `<repo>/app`, nor the dir named by `APLABS_APP_DIR`, has a `jobs.json` with entries.
- **New engine T3 floors.** `ENGINE_T3` in `kit/lib/tier/index.js` gains `kit/runtime/jobs/**`, `kit/runtime/schema/jobs.schema.json`, `Dockerfile`, `.dockerignore`, `.github/workflows/**`, `kit/release/**`, `kit/lib/template/**` and `kit/lib/fork/**`, with a test for each and the header comment updated. 10.2 edits the same array; whichever story merges later resolves the conflict.
- **A short how-to** (`kit/templates/job.md`): a `jobs.json` entry, a job file, what `ctx` holds, UTC schedules, the 5-minute minimum, no writes, no Slack. It says `ctx.log` never logs rows, and that job queries use `LIMIT`.
- **Tests with a fake clock** cover: enabled, disabled by the entry, disabled by the profile, `APLABS_JOBS_OFF` (including the value "0"), a failing job, a slow job skipping its next run, an invalid schedule, a `run` path leaving `jobs/` (by `..`, absolute path, symlink, and into `<app dir>/connectors/<id>/`), a duplicate name, a missing `jobs.json`, and the cron fields (a list, a range, a step, month and weekday boundaries, 29 February). Also: an impossible date (30 February) refused as "never runs", a next run more than 25 days away (no early fire), both day fields set (refused), and a schedule under 5 minutes (refused).

**Changed since the epics:** the epics left the schedule format, the global off switch's name, what a job may do, overlap and catch-up undecided (Q1 to Q4). An in-house UTC cron parser is more code than "S" allowed, so the size is M. The review added the `jobs/` containment (B1), no job loading while off (B2), the bounded schedule search and capped timers (B3), and the epic's engine floors.

Tier: T3 (computed: `kit/lib/profile/**` and `kit/lib/tier/**` are engine floors)

**Files:** new `kit/runtime/jobs/index.js` (load, validate, schedule, run, log); new `kit/runtime/jobs/schedule.js` (the cron parser and next-run time); new `kit/runtime/schema/jobs.schema.json`; `kit/runtime/app/index.js` (load jobs at startup, the startup line, stop on shutdown); `profiles/_schema/profile.schema.json` (`jobs.enabled`); `kit/lib/profile/index.js` (the default); `kit/lib/tier/index.js` (the new floors); `test/unit/tier.test.js`; `kit/runtime/messages.js` (only if a job config fault needs words; the builder says so); the `npm run check` script that scans app code (the jobs import rule; the builder names the file); new `kit/templates/job.md`; new `test/unit/runtime-jobs.test.js`; new `test/unit/runtime-schedule.test.js`; `test/unit/runtime-app.test.js`; `test/unit/profile.test.js`; `test/unit/write-path.test.js` (a job reaching a connector write fails; shared with 10.2); new fixtures under `test/fixtures/runtime/jobs/`; `docs/planning/planning-artifacts/architecture-runtime.md` (CAP-12 and AD-16 confirmed; `APLABS_JOBS_OFF` in the config conventions); `docs/ledger.md`.

### Story 11.2: the app runs in a container

**Acceptance criteria:**

- **The health check** (AD-13, Q7). The listener is on only when `APLABS_HEALTH_PORT` is set. It binds 0.0.0.0, the port is validated as 1 to 65535, and a malformed port or `EADDRINUSE` refuses startup, naming the variable. It serves `GET /healthz` and nothing else (any other path or method gets 404). The reply body is a fixed word ("ok" or "down"), never the client name, a path or a token. The listener starts before Slack connects, so the boot grace covers the connect.
- **Health fails closed.** The connection state starts as *down* at boot. Only a real `connected` event sets it up. The reply is 200 for the first 90 seconds after start. After the 90-second grace, 200 needs a `connected` event seen and no current outage over 60 seconds, so an app that never connected gets 503. The outage clock starts at boot when no `connected` event has been seen yet. A test checks that the event names the listener subscribes to are ones the installed `@slack/socket-mode` client actually emits.
- **Tests with an injected clock** cover the boot grace, a short reconnect staying 200, an outage over 60 seconds turning 503, recovery back to 200, never connected → 503 at 91 seconds, an unknown path, a malformed port, `EADDRINUSE`, and the listener off when unset. The fake Slack app (`test/fixtures/fake-slack.js`) gains connect and disconnect events.
- **The container definition** (`Dockerfile`, `.dockerignore`) runs the app as in 6.1, env only: `APLABS_NO_KEYCHAIN=1` is set in the image. `APLABS_PROFILE` and `APLABS_APP_DIR` are set by whoever runs it, never baked in. The command is `node kit/runtime/app` in exec form, so SIGTERM reaches the app's existing shutdown.
- **Base image** (Q8): `node:24-bookworm-slim`, pinned by digest with a one-line reason (glibc, which DuckDB's prebuilt binaries need; not Alpine). Runs as a non-root user. The image is amd64 only.
- **Read-only app files.** The app's files are owned by root and not writable by the runtime user (no `--chown` to that user on app code). The only writable paths are `APLABS_VAR_DIR`, set in the image to a dedicated directory, and `/tmp`. The CI smoke test runs with `--read-only --tmpfs /tmp` and a tmpfs or volume at `APLABS_VAR_DIR`. The static check asserts no `--chown`/`chown` of the app dir to the runtime user.
- **Dependencies are installed inside the image** with `npm ci` for the image's platform. `node_modules` is never copied from the host (`.dockerignore` excludes it).
- **The MotherDuck extension is installed at image build** for the pinned DuckDB version, into the extension folder of the user the app runs as (DEP-016), by `scripts/install-duckdb-extensions.js`. That script is the only image-build installer; the Dockerfile never inlines DuckDB code in a `RUN` line. The script goes on the `@duckdb/node-api` import allow-list in `test/unit/runtime-data.test.js` with the reason "image build only; the app never loads it", plus an assertion that nothing under `kit/runtime/` requires it. The bot itself still never installs anything (auto-install stays off). This closes DEP-016.
- **Proving the extension loads.** `kit/runtime/data/index.js` gains `extensionLoads(name)`: an in-memory instance with the existing lockdown runs `LOAD <name>`, with no install, no network and no token. Tested in `test/unit/runtime-data.test.js`.
- **`.dockerignore`** keeps out at least `node_modules`, `.git`, `var/`, `.env*`, `*.duckdb`, `.claude/`, `.codex/`, `.agents/`, `_bmad/`, `docs/`, `.aplabs/context/` and `test/`. The runtime reads `org.md` and `data.md` from the profile's context folder (AD-11), so the context is mounted at run time with the profile, never baked in; `docs/runtime/container.md` says so. No secret is baked into the image.
- **A static check runs everywhere, in `npm test`**: no `ENV` or `ARG` whose name has a `_`-separated segment equal to TOKEN, KEY, SECRET, PASSWORD or PASS, or ends in `_KEY`/`_TOKEN` (`APLABS_NO_KEYCHAIN` is the one named exception); no value in the Dockerfile matches `xox[abp]-`, `xapp-`, `sk-ant-` or a MotherDuck token shape; no `COPY` or `ADD` of `.env*`; `APLABS_NO_KEYCHAIN=1` present; `npm ci` present; no copy of `node_modules`; a pinned base image; a non-root `USER`; no `--chown`/`chown` of the app dir to the runtime user; exec-form `CMD`; and the `.dockerignore` entries above.
- **A build test runs only where Docker is** (Q10). It needs both docker present AND `APLABS_DOCKER_TEST=1`. Otherwise it is skipped with the reason "docker not installed" (or "set APLABS_DOCKER_TEST=1 to build the image") and reported by `node:test` as **skipped**, never passed. On your Mac it always skips.
- **The CI job** (`container`, in `.github/workflows/ci.yml`) builds the image and runs `scripts/container-smoke.js` inside it with `--network none`, `--read-only --tmpfs /tmp`, a tmpfs or volume at `APLABS_VAR_DIR`, and the test fixtures mounted read-only (Q9). It uses plain `docker build` and `docker run`, no third-party actions, `permissions: contents: read`, no secrets and no `--build-arg`. The smoke test boots the real runtime with a fake Slack client and a stub profile, gets 200 from `/healthz`, and calls `extensionLoads('motherduck')` with network off (proving DEP-016 without reaching MotherDuck). No real token, no Slack, no MotherDuck.
- **The docs** (`docs/runtime/container.md`) say: exactly one replica (in-memory state, AD-8); deploys are stop-then-start, never rolling, naming the host setting (for example "Recreate" rather than "RollingUpdate"); no secret is baked into the image, and secrets come from the host's env; set `APLABS_PROFILE`, `APLABS_APP_DIR` and `APLABS_HEALTH_PORT`; mount the profile and its context folder; the data comes from MotherDuck (env token) or a mounted file (`APLABS_DATA_PATH`), never baked in; the app files are read-only and only `APLABS_VAR_DIR` and `/tmp` are writable (run with `--read-only`); the image is amd64 only; the DuckDB extension lives under the runtime user's `$HOME/.duckdb`, so a host that runs the image as an arbitrary UID won't find it; the host choice is the fork's. Each step that needs a credential is marked as a human step.
- **Architecture docs updated.** AD-13 gains: "The connection state starts down; after the grace period, 200 needs a seen `connected` event (fails closed)." AD-9 adds `scripts/install-duckdb-extensions.js` (image build only) to the files allowed to import `@duckdb/node-api`.
- **"Done" for 11.2** is the `container` job passing on the PR. A real deploy on a host belongs to the first fork that needs one (proposed ledger row below).

**Changed since the epics:** the health listener the epics assumed from 6.1 isn't built yet (Q7). DEP-016 (from #110) adds the MotherDuck extension step. Docker isn't on your Mac, so the image is only built in CI. Size M, not S. The review made health fail closed (B4), the app files read-only (B5), the secret check precise (B6), and moved the extension install into one allow-listed script with an `extensionLoads` proof in the data runner (B7), which raises the tier to T3.

Tier: T3 (computed: `kit/runtime/data/**` is an engine floor, and `Dockerfile`, `.dockerignore` and `.github/workflows/**` are floors from 11.1)

**Files:** new `Dockerfile`; new `.dockerignore`; new `kit/runtime/app/health.js`; `kit/runtime/app/index.js` (start the listener, feed it Socket Mode connection state); `kit/runtime/data/index.js` (`extensionLoads(name)`); new `scripts/container-smoke.js`; new `scripts/install-duckdb-extensions.js` (mandatory: the only image-build installer); `.github/workflows/ci.yml` (the `container` job); `test/fixtures/fake-slack.js` (connect and disconnect events); new `test/unit/runtime-health.test.js`; new `test/unit/container.test.js` (the static check, and the build test that skips without Docker); `test/unit/runtime-app.test.js`; `test/unit/runtime-data.test.js` (`extensionLoads`, the allow-list entry and the "nothing under `kit/runtime/` requires it" assertion); new `docs/runtime/container.md`; `docs/planning/planning-artifacts/architecture-runtime.md` (AD-13 as built and fail-closed; AD-8 names the container doc; AD-9 allow-list); `docs/ledger.md` (closes DEP-016).

### Story 11.3: two forks differ only by profile and modules

**Acceptance criteria:**

- **Two fixture clients**, neither of them Brightside: the existing stub client (`test/fixtures/fork/`) and a new second one (`test/fixtures/fork-b/`), each with its own profile, a context folder, an app dir with one hub and one module, and a different client name, hub command and resource keys. Engine tests read only these fixtures, never `profiles/brightside/` or `examples/brightside/`.
- **The fixture edits keep 6.5 green.** The edits to `test/fixtures/fork/profile.yml` keep the 6.5 tests and `scripts/boot-smoke.js` passing.
- **Real copies, not links** (Q11). The test builds each fork in its own temp directory by copying the repo's tracked files (as `clean-bones` does), deleting `examples/brightside/` and `profiles/brightside/`, and adding the client's `.aplabs/profile.yml`, `.aplabs/context/` and `app/`. Only `node_modules` is linked. One fork appends a dependency to its `package.json`. Nothing is written outside the temp directories, and both are removed at the end.
- **The comparison** uses a new engine helper, `kit/lib/fork` (`compareForks(rootA, rootB)` and `packageDelta(templatePkg, forkPkg)`). Every path in the identical-engine set (`kit/**`, `profiles/_schema/**`, from `kit/runtime/paths.js`) is byte-identical between the two forks. The only differences are each fork's profile, context, app dir and the appended dependency. `packageDelta` allows the lockfile changes that follow from an appended dependency.
- **Negative cases.** One byte changed under `kit/` in one fork is reported, naming the file. A dependency in `package.json` changed or removed (rather than appended) is reported, naming it.
- **Each fork boots** with the real runtime (`main()`) and a fake Slack client, offline. The same Slack person id is a user in both profiles. Opening each fork's hub shows that fork's own client name, menu entries and access, from its own profile: a module the person may use in fork A and not in fork B appears only in A.
- **Governance resolves per fork.** In each temp fork, `node kit/lib/tier <path>` gives the tier from that fork's profile (the two fixture profiles tier the same path differently), `npm run verify` runs that fork's own checks, and the write gate (`kit/lib/gate`) blocks an unplanned write in that fork.
- **Offline and bounded.** No Slack, no model, no MotherDuck, no network. The test aims to finish in under 30 seconds. If it can't, the builder reports the time and the Orchestrator decides whether it moves to its own CI step.

**Changed since the epics:** `test/fixtures/temp-fork.js` (6.5) links `kit/` rather than copying it, so "byte-identical" would be true by construction. This story copies (Q11). The comparison becomes a small engine helper so 11.5 and 11.6 reuse it.

Tier: T1 (computed; if it merges after 11.1, `kit/lib/fork/**` is a floor and the Orchestrator recomputes, upward only)

**Files:** new `kit/lib/fork/index.js` (`compareForks`, `packageDelta`); new `test/acceptance/two-forks.test.js`; new `test/unit/fork.test.js`; `test/fixtures/temp-fork.js` (a copy mode beside today's linked mode); `test/fixtures/fork/profile.yml` (a tier row and a verify check, and the shared person id); new `test/fixtures/fork/context/org.md`; new `test/fixtures/fork-b/profile.yml`; new `test/fixtures/fork-b/context/org.md`; new `test/fixtures/fork-b/hubs/<hub>.json`; new module fixtures for each fork under `test/fixtures/fork/modules/` and `test/fixtures/fork-b/modules/` (or filled from the module template by the helper; the builder says which); `test/acceptance/README.md` (the new test); `docs/planning/planning-artifacts/architecture-runtime.md` (CAP-15 names `kit/lib/fork`); `docs/ledger.md`.

### Story 11.4: the engagement fork guide

**Acceptance criteria:**

- **One guide**, `docs/fork-guide.md` (Q20), opening with a plain-language summary of what a fork is and what day one produces.
- **It opens with a stop sign:** "do not create a real client fork until Ely has decided what template history ships" (DEP row below).
- **It covers, in order:**
  - Create the client repo **by cloning the template at a release tag**, so the template's history comes along and updates can merge (Q17). Not GitHub's "Use this template" button, which drops history. Rename the template remote to `upstream`.
  - Write the client profile at `.aplabs/profile.yml`, with tier rows for the runtime's risky paths as in Brightside's, plus the fork's own `app/connectors/**` and write modules at T3, and `app/jobs/**` at T2 or higher. Note which paths the engine already floors at T3 whatever the profile says.
  - Delete `examples/brightside/` and `profiles/brightside/`, and start an empty `docs/ledger.md` (Q16). Leave `package.json` `aplabs.appDirs` as it is.
  - Record the template version (`npm run template:check -- --record vX.Y.Z`, from 11.5).
  - Create the runtime Slack app from the generated manifest (`npm run slack:manifest`), separate from any notify webhook app.
  - Store the Slack tokens and the AI key, with a spend cap set in the Anthropic console.
  - Build or connect the data source, linking `docs/runtime/motherduck-publish.md` where relevant.
  - Add the first module from the template (`kit/templates/module`).
  - Run the onboarding build (`npm run engage -- --kind onboarding --plan <slug>`, then `npm run onboard -- --init`).
  - Deploy one replica, stop-then-start, linking `docs/runtime/container.md` (11.2).
- **It says** a fork may append dependencies to `package.json` but never edits `kit/**` or `profiles/_schema/**`, nor `ci.yml`, `Dockerfile`, `.dockerignore` or `scripts/**`. Fixes go to the template.
- **It says** a fixture check's `-- protected-columns` exception is for synthetic data only: the validator refuses it on any file `npm run fixture:build` did not write, so never point `--db` at real data to lift one (issue #77).
- **It says** a real connector needs a durable idempotency store and its own dedupe keys (plan epic-10, 10.0 and its risks), and that scheduled jobs can't write or post (11.1).
- **Every human-only step** (anything with a credential, creating the Slack app, creating the GitHub repo, setting the spend cap, pushing tags) is marked "you, not the agent".
- **A structural test** fails when the guide names an `npm run` script that isn't in `package.json`, or a repo file or folder (in backticks, repo-relative) that doesn't exist. Paths the fork creates (`.aplabs/profile.yml`, `app/…`) are listed as allowed in the test, with a reason each.
- **No Hometown specifics.**

**Changed since the epics:** the guide now also covers creating the repo by cloning (Q17), resetting the ledger (Q16), recording the template version (11.5), and the durable-store note from Epic 10. The review removed the `aplabs.appDirs` edit (a fork never edits template-owned config, B10) and added the template-history stop sign.

Tier: T1 (computed)

**Files:** new `docs/fork-guide.md` (Scribe); new `test/unit/fork-guide.test.js` (Builder); `docs/runtime/slack-app-setup.md` (one line linking the guide); `docs/ledger.md`.

### Story 11.5: template releases and the "engine untouched" check (split from the approved 11.5)

**Acceptance criteria:**

- **A release** is an annotated git tag `vX.Y.Z` on `main` with a matching `CHANGELOG.md` entry (`## vX.Y.Z`, with "What changed" and "What a fork must do"). The entry is written in a normal PR (Scribe drafts it, it is reviewed) before the release. The command checks it, never writes it (Q19). `CHANGELOG.md` carries a short release checklist that includes "re-pin the base image digest".
- **`npm run template:release -- <version>`** refuses, naming the reason, unless all of these hold:
  - it runs in the template, not a fork (no `.aplabs/profile.yml`);
  - the worktree is clean, on `main`, with the local head equal to `origin/main`;
  - the version is valid semver and higher than the newest `v*` tag, and the tag does not already exist on `origin`;
  - `CHANGELOG.md` has its entry;
  - every check on `main`'s head commit passed and the three named jobs (`test`, `clean-bones`, `container`) are present, read through `gh` (`APLABS_GH_BIN`, as `npm run land` does). A missing, failed or still-running check refuses.
- **It creates the tag locally and pushes it only with `--push`** (Q14). `package.json` `version` is left alone (Q19). AGENTS.md gains one line: "The Orchestrator never passes `--push` to `template:release` and never runs `git push --tags`."
- **`v0.1.0`** marks the Orchestrator phase. It goes on the `main` merge commit just before the runtime phase plan (#52) merged. The Orchestrator finds that commit with `git log`, shows it to you, and you create and push the tag (proposed ledger row). `CHANGELOG.md` starts with entries for `v0.1.0` and an "Unreleased" section.
- **The template version record** (Q15): `.aplabs/template-version`, two YAML keys, `version: vX.Y.Z` and `engine_sha256: <hex>`. The fingerprint is a sha256 over `git ls-files -z kit profiles/_schema`, each file framed as path, NUL, length, bytes.
- **Fork status comes from the profile.** Fork status is decided by `.aplabs/profile.yml`, not by the record. With a profile and no readable record, `template:check` fails ("fork without a template record; run `npm run template:check -- --record vX.Y.Z`"), and so does the CI step. Only a repo with no profile (the template) reports "not a fork; skipped".
- **`npm run template:check`** recomputes the fingerprint and compares. It fails naming the files that differ from the recorded version, when it can tell. Offline, it can only say "the engine changed". With the `upstream` remote and the tag available it names each file. **`--record <version>`** writes the record on day one, after checking that the engine matches that tag.
- **CI.** A new step in `.github/workflows/ci.yml` runs `npm run template:check` under `if [ -f .aplabs/profile.yml ]`. So it runs in every fork (and fails one with no record) and not in the template.
- **Fixture steps in a fork without the example.** The three fixture steps in `ci.yml` skip only in a fork whose example was deleted: `if [ -f .aplabs/profile.yml ] && [ ! -d examples/brightside ]; then echo "skipped: no example client in this fork"; exit 0; fi`. The template still always runs them. A test checks that a clean-bones-style copy with a stub `.aplabs/profile.yml` passes every `ci.yml` run step that doesn't need the network.
- **AD-1 updated:** "Template-owned. A fork appends dependencies to `package.json` (merged structurally by `template:update`) and otherwise never edits `package.json` scripts, `package-lock.json` by hand, `.github/workflows/**`, `Dockerfile`, `.dockerignore` or `scripts/**`." Plus the record and the check.
- **Tests** run on temp git repos only: a bare "template" repo with tags and a cloned "fork", with a fake `gh`. They cover each refusal (including a tag already on `origin` and a missing named job), a passing release (tag created, nothing pushed without `--push`), `--record`, an untouched fork passing, one edited `kit/` file failing with its name, a fork with a profile and no record failing, and the template (no profile) skipping. No test reaches GitHub or touches anything outside the repo and its temp dirs.

**Changed since the epics:** split from the approved 11.5 (Q13). The epics didn't say what `.aplabs/template-version` holds or how CI checks it offline (Q15), who writes the changelog (Q19), or who pushes tags (Q14). The release also requires the new `container` job. The review made a missing record fail in a fork (B8), made the fixture CI steps fork-safe (B10), fixed the fingerprint framing (N9) and renamed `kit/template/` to `kit/release/` (N12).

Tier: T3 (computed: `kit/release/**`, `kit/lib/template/**`, `kit/lib/fork/**` and `.github/workflows/**` are floors from 11.1)

**Files:** new `kit/lib/template/index.js` (fingerprint, record read and write, release checks); new `kit/release/release.js`; new `kit/release/check.js`; `kit/lib/fork/index.js` (reuse; only if a shared helper moves; the builder says so); `package.json` (`template:release`, `template:check` scripts); `.github/workflows/ci.yml` (the check step and the fork-safe fixture steps); `AGENTS.md` (the no-push line); new `CHANGELOG.md` (Scribe: the `v0.1.0` entry, "Unreleased" and the release checklist); new `test/unit/template-release.test.js`; new `test/unit/template-check.test.js`; new `test/unit/ci-fork.test.js` (the clean-bones-style copy passes the `ci.yml` run steps); new temp-git helper `test/fixtures/temp-git.js`; `docs/planning/planning-artifacts/architecture-runtime.md` (AD-1: template-owned files, the record and the check); `docs/ledger.md`.

### Story 11.6: template updates flow into forks (new, split from 11.5)

**Acceptance criteria:**

- **`npm run template:update -- vX.Y.Z`**, in a fork, refuses, naming the reason, unless all of these hold: it is a fork (`.aplabs/profile.yml` and `.aplabs/template-version` exist), an `upstream` remote exists, the worktree is clean, it is on `main` and local `main` equals `origin/main`, the target version is newer than the recorded one, and `npm run template:check` passes. If the fork has edited anything under `kit/**` or `profiles/_schema/**` since its recorded version, it refuses, naming the files.
- **Then it:** fetches the tag from `upstream`, makes a new branch `template/vX.Y.Z` from the fork's `main`, and merges the tag with a merge commit (no squash, no rebase).
- **Conflicts** (Q16). Template files the fork deleted on purpose (`examples/brightside/**`, `profiles/brightside/**`) stay deleted. Files the fork owns that the template also ships (`docs/ledger.md`, `docs/planning/**`) keep the fork's version. Both lists live in one constant in `kit/lib/fork` with a test, and each file resolved this way is listed in the PR body. Any other conflict aborts the merge, deletes the branch, returns to the starting branch, leaves the fork as it was, and names the files.
- **`package.json` and `package-lock.json`:** take the template's `package.json`, re-apply the fork's appended dependencies (`packageDelta` against the recorded version's `package.json`), regenerate the lock with `npm install --package-lock-only --ignore-scripts`, and list both in the PR. If a fork-appended dependency is one the template now ships, abort with nothing changed.
- **After the merge, before committing**, the command lists every path the merge changed against the fork's `main` (`git diff --no-renames --name-only main...MERGE_HEAD` plus the conflicted paths), and then:
  - a path under the deleted-on-purpose roots is removed again;
  - a path in the fork-owned list is reset to the fork's `main`;
  - a path under `.aplabs/**` or the fork's app dir (`app/**` or `APLABS_APP_DIR`) aborts the update with the fork unchanged, naming the paths.

  The only `.aplabs/` writes allowed are the command's own `.aplabs/template-version` update and the profile migration (Q18). Every path handled this way is listed in the PR body.
- **Profile migrations** (Q18). If the release raises the profile `schema_version`, every migration step in `kit/lib/template/migrations/` runs in order from the fork's `schema_version` to the template's, upgrading `.aplabs/profile.yml` and keeping its comments, and the result must pass the new schema. The update refuses if the fork's version is newer than the template's. The update PR shows the profile diff for human review. Today the schema is version 1 and the list of steps is empty. A test fails if the schema's `schema_version` has no migration chain from 1, so a future bump must ship its step.
- **It runs `npm run check && npm test`** on the branch, running `npm ci` first when the lockfile changed. On failure it stops, keeps the branch, and opens no PR.
- **On success** it updates `.aplabs/template-version` (version and fingerprint), commits, pushes the branch to the fork's `origin`, and opens a PR in the fork with `gh` (`APLABS_GH_BIN`). The PR body opens with `**What this does:**`, names the version, links its `CHANGELOG.md` entry, copies the entry's "What a fork must do" lines, and lists conflict resolutions, the paths handled after the merge, the package files and the profile diff.
- **The guide** (`docs/fork-guide.md`) gains a plain-language section: what a fork is, what `upstream` is, "clients add, never edit the engine", and how to take an update.
- **Tests on temp repos only:** a bare template repo with `v1.0.0` and `v1.1.0`, a fork cloned from it (examples deleted, its own ledger, its own module), and a bare repo as the fork's `origin`. A fake `gh` records the PR, and an injected runner stands in for `npm run check && npm test`. Cases: a clean update (branch, merge commit, record updated, PR body); an edited `kit/` file refused by name; a deleted example file changed upstream, kept deleted; a new upstream file under `examples/brightside/` stays absent; the fork's ledger kept on a conflict; a clean upstream edit to `docs/ledger.md` not applied; an upstream file under `.aplabs/` aborting with the fork unchanged; the fork appended a dependency and upstream bumped another, giving a clean update; a fork-appended dependency the template now ships, aborting; any other conflict aborted with the fork unchanged and the starting branch restored; failing checks, so no PR; an injected test migration from version 1 to 2 applied with comments kept; a fork schema version newer than the template's, refused; no `upstream` remote; a dirty tree; not on `main`; local `main` behind `origin/main`. No test reaches GitHub or touches anything outside the repo and its temp dirs.
- **AD-1 updated** with how updates merge (the post-merge path rules and the package rule).

**Changed since the epics:** new story, split from 11.5 (Q13). The epics didn't say how an update survives the fork having deleted the example client or keeping its own ledger, which would otherwise conflict on every update (Q16), or how migrations work while the schema is at version 1 (Q18). The review added the post-merge path rules (B9) and the package rule (B10).

Tier: T3 (computed: `kit/release/**`, `kit/lib/template/**` and `kit/lib/fork/**` are floors from 11.1)

**Files:** new `kit/release/update.js`; `kit/lib/template/index.js` (update steps); new `kit/lib/template/migrations/index.js` (the empty list of steps and the runner); `kit/lib/fork/index.js` (the deleted-on-purpose and fork-owned lists); `package.json` (`template:update` script); `docs/fork-guide.md` (Scribe: the update section); `test/unit/fork-guide.test.js` (the new commands are known); new `test/unit/template-update.test.js`; new `test/unit/template-migrations.test.js`; `test/fixtures/temp-git.js`; `docs/planning/planning-artifacts/architecture-runtime.md` (AD-1: how updates merge); `docs/ledger.md`.

## Open questions found in the epics: adopted as recommended, with the review's changes

These are places where `epics-runtime.md` is unclear or no longer matches what's built. Each answer below was adopted as recommended, with the review's changes folded in.

| # | Question | Where | Answer (adopted) |
|---|---|---|---|
| Q1 | What format is `schedule`, and does it need a library? | 11.1 | Five-field cron in UTC: numbers, `*`, `,`, `-`, `/`. No names, seconds or time zones. Written in-house with fake-clock tests, no new dependency. UTC avoids daylight-saving surprises. Review: bounded search (5 years), timers capped at 24 hours, both day fields refused, 5-minute minimum |
| Q2 | What is "the global off switch"? | 11.1 | A new env var, `APLABS_JOBS_OFF`, that stops every job whatever the profile says, matching `APLABS_LLM_OFF` and `APLABS_WRITES_OFF`. Review: any non-empty value means off, including "0", matching `APLABS_WRITES_OFF` (fail safe) |
| Q3 | What may a job do? Could a scheduled job push to the email tool? | 11.1, AD-14, AD-15 | Read only: `{ log, data, now, name }`. No connector writes (AD-15 allows writes only after a person approves, and the write-path check already refuses them in app code) and no Slack posts (AD-14 allows one channel exception). A fork that needs a scheduled report or push plans it on its own. Review: job limits come only from `ctx` plus review (AD-1, not sandboxed); `npm run check` also refuses Slack and connector imports in `jobs/` (N2) |
| Q4 | What if a run is still going when the next is due, or the app was down? | 11.1 | Skip the overlapping run and log it. No catch-up for missed runs. One process only (AD-8). Review: single-run relies on AD-8's stop-then-start deploys |
| Q5 | Is `jobs.json` checked when jobs are off? | 11.1 | Yes, at startup and in tests, so a broken file is caught before anyone turns jobs on. Review: while off, only the schema and each `run` file's existence are checked; no job file is loaded (B2) |
| Q6 | Which `enabled` wins? | 11.1 | All three must allow it: profile `jobs.enabled`, the entry's `enabled`, and no `APLABS_JOBS_OFF` |
| Q7 | The epics treat `/healthz` as already there "as in 6.1", but it isn't built (AD-13 only describes it) | 11.2 | 11.2 builds it, as AD-13 says. Size M. Review: it fails closed (B4) |
| Q8 | Which base image? | 11.2 | `node:24-bookworm-slim`, pinned by digest with its reason. Not Alpine, because DuckDB's prebuilt binaries need glibc. amd64 only (N6) |
| Q9 | How can CI smoke-test the image without Slack tokens? | 11.2 | Run `scripts/container-smoke.js` inside the image with `--network none`, `--read-only` and `test/fixtures/` mounted read-only. It boots with a fake Slack client, checks `/healthz` and calls `extensionLoads('motherduck')` offline. `test/` stays out of the image |
| Q10 | Docker isn't on your Mac. What does `npm test` do? | 11.2 | A static check of the recipe always runs. The build test requires both docker present AND `APLABS_DOCKER_TEST=1`, and is otherwise reported as skipped with its reason, never passed. CI builds the image in its own job |
| Q11 | 6.5's temp fork links `kit/`, so "byte-identical" proves nothing | 11.3 | 11.3 copies the tracked files into each temp fork (as `clean-bones` does) and links only `node_modules` |
| Q12 | Where does the fork comparison live? | 11.3, 11.5, 11.6 | A small engine helper, `kit/lib/fork`, so the acceptance test, the engine check and the update command use one definition of "allowed differences" |
| Q13 | The approved 11.5 (release command, retroactive tag, update command, conflict handling, CI check, migrations, guide section) is more than one M story | 11.5 | Split it: 11.5 releases, the version record and the CI check; 11.6 the update command, conflicts, migrations and the guide section. All the approved acceptance criteria are kept |
| Q14 | Who pushes release tags, and which commit is `v0.1.0`? | 11.5 | The command tags locally and pushes only with `--push`. You push `v0.1.0` and each later release. `v0.1.0` is the `main` merge commit just before the runtime phase plan (#52) merged. The Orchestrator shows you the commit first. The first runtime release (`v0.2.0`) waits until Epic 10 is live-checked and Epic 11 has merged. Review: AGENTS.md gains "The Orchestrator never passes `--push` to `template:release` and never runs `git push --tags`" (an 11.5 file and AC) |
| Q15 | What is in `.aplabs/template-version`, and how does a fork's CI check the engine without reaching the template? | 11.5 | The version plus a sha256 fingerprint of the engine files (framed per N9). CI recomputes it offline. With `upstream` available, the check names each changed file. The file is under `.aplabs/`, which is always T3, so editing it gets full review |
| Q16 | Every update would conflict: the fork deleted the example client and keeps its own ledger and planning docs | 11.4, 11.5, 11.6 | The update keeps deleted example files deleted and keeps the fork's version of `docs/ledger.md` and `docs/planning/**`, listing each in the PR. Any other conflict aborts with nothing changed. The guide tells the fork to start an empty ledger. Review: fixed by B9 (post-merge path rules, so a clean upstream change can't slip into fork-owned, deleted or `.aplabs/` paths) and B10 (fork-safe CI fixture steps, no fork edits to template-owned config, the package rule) |
| Q17 | How is the client repo created so updates can merge? | 11.4 | Clone the template at a release tag and rename the remote to `upstream`. Never GitHub's "Use this template", which drops the shared history the merge needs. What history ships is Ely's decision before the first real fork (DEP row below) |
| Q18 | Migrations are required, but `schema_version` is fixed at 1 | 11.6 | Build the runner with an empty list of steps, test it with an injected 1-to-2 step, and add a test that fails when the schema's version has no migration chain. Comments in the profile are kept. Review: every migration step runs in order from the fork's `schema_version` to the template's; the update refuses if the fork's version is newer |
| Q19 | Does `template:release` write the changelog? Does it bump `package.json`? | 11.5 | No to both. The changelog entry is written and reviewed in a normal PR first, and the command only checks it's there. `package.json` stays `0.0.0` (the package is private); the tag is the version |
| Q20 | Where do the guide and container docs live? | 11.2, 11.4 | `docs/fork-guide.md` and `docs/runtime/container.md` |
| Q21 | Where does the template's own CI run the engine check? | 11.5 | It doesn't. Review (B8): the CI step runs under `if [ -f .aplabs/profile.yml ]`, so it runs in every fork and fails a fork with no record; only a repo with no profile (the template) skips. Unit tests cover the check in the template |

## Review findings folded in

Architect design review and plan review, 2026-10-25. Verdict: not ready as written, with 10 blocking findings, each with an exact edit and none needing Ely. All 10 are folded in; none is left unresolved.

| # | Finding (short) | Story | Where it now lives |
|---|---|---|---|
| B1 | A job `run` path could leave `jobs/` (symlink, or into a connector) | 11.1 | The `name`/`run` AC (realpath inside `<app dir>/jobs/`); the containment tests |
| B2 | Job files were loaded even with jobs off | 11.1 | New AC "Jobs off loads no job code" and its test |
| B3 | The cron search and timers were unbounded | 11.1 | The `schedule` AC (5-year bound, "never runs", 24-hour timers, both day fields refused); the 30 February, 25-day and both-day-field tests |
| B4 | Health returned 200 for an app that never connected | 11.2 | New AC "Health fails closed"; the never-connected test; AD-13 doc AC |
| B5 | App files were writable by the runtime user | 11.2 | New AC "Read-only app files"; the CI job and static check; `docs/runtime/container.md` AC |
| B6 | The secret-name check was vague | 11.2 | The static-check AC (segment rule, token shapes, no `.env*` copy) |
| B7 | The extension install had no allow-listed home and no load proof | 11.2 | The MotherDuck AC (mandatory script, allow-list, nothing in `kit/runtime/` requires it); new `extensionLoads` AC; the files list; the AD-9 doc AC; tier T3 |
| B8 | Deleting the record skipped the engine check | 11.5 | New AC "Fork status comes from the profile"; the CI step condition; the no-record test; Q21 |
| B9 | A clean upstream change could land in fork-owned, deleted or `.aplabs/` paths | 11.6 | New AC "After the merge, before committing"; the three new tests |
| B10 | Forks broke CI by deleting the example, edited template-owned config, and conflicted on `package.json` | 11.4, 11.5, 11.6 | 11.5 fork-safe fixture steps and the `ci-fork` test; 11.4 dropped the `appDirs` edit and lists files a fork never edits; 11.6 the package rule and its test |
| Floors | The epic's new engine paths had no T3 floor | 11.1 | New AC "New engine T3 floors"; `kit/lib/tier/index.js` and `test/unit/tier.test.js` in the files; the shared-files note on 10.2 |

**Non-blocking items, folded in:**

- **N1** (tiers): the story table shows the final tiers (11.1 T3, 11.2 T3, 11.3 T1, 11.4 T1, 11.5 T3, 11.6 T3), matching each story's tier line.
- **N2** (jobs reach Slack or connectors): 11.1 import rule in `npm run check`; `job.md` says `ctx.log` never logs rows; 11.4 tier rows put `app/jobs/**` at T2 or higher.
- **N3** (job load): 11.1 5-minute minimum interval, refused at startup; `job.md` tells job queries to use `LIMIT`.
- **N4** (image contents): 11.2 `.dockerignore` adds `.aplabs/context/`, `.claude/`, `.codex/`, `.agents/`, `_bmad/` and `docs/`. Checked against AD-11: the runtime reads `org.md` and `data.md`, so the context is mounted with the profile, and container.md says so.
- **N5** (health listener): 11.2 on only when `APLABS_HEALTH_PORT` is set, binds 0.0.0.0, port 1 to 65535, `EADDRINUSE` refuses startup naming the variable.
- **N6** (host caveats): 11.2 container.md documents `$HOME/.duckdb` and the arbitrary-UID caveat and amd64 only; the first-deploy DEP row repeats them.
- **N7** (stale base image): 11.5 `CHANGELOG.md` release checklist includes "re-pin the base image digest".
- **N8** (CI job supply chain): 11.2 plain docker build and run, no third-party actions, `permissions: contents: read`, no secrets, no `--build-arg`.
- **N9** (fingerprint framing): 11.5 sha256 over `git ls-files -z kit profiles/_schema`, framed as path, NUL, length, bytes.
- **N10** (release checks): 11.5 every check on main's head must pass, the three named jobs must be present, and the tag must not already exist on `origin`.
- **N11** (update safety): 11.6 refuses when not on `main` or local `main` ≠ `origin/main`, runs `npm ci` before the checks when the lockfile changed, and returns to the starting branch after an abort.
- **N12** (confusable folder): `kit/template/` renamed to `kit/release/` throughout (11.1 floors, 11.5 and 11.6 files), so it isn't confused with `kit/templates/`.
- **N13** (fixture edits, lockfile): 11.3 fixture edits keep the 6.5 tests and `scripts/boot-smoke.js` passing; `packageDelta` allows lockfile changes that follow from an appended dependency.
- **N14** ("ships no jobs" scope): 11.1 test also checks `<repo>/app` and `APLABS_APP_DIR`.
- **N15** (outage clock): 11.2 the outage clock starts at boot when no `connected` event has been seen yet.
- **N16** (FR12 trace): the FR12 trace is marked **partial** (scheduled jobs are read-only in V1; scheduled pushes and posts stay deferred, see "Not in this plan"). The deferral is kept.
- **N17** (shared files): `test/unit/write-path.test.js` added to the shared-files list (it overlaps with 10.2).

**Proposed doc updates**, each an AC on the story that touches the doc: AD-1 template-owned files (11.5, with 11.6 adding how updates merge), AD-13 fails closed (11.2), AD-9 allow-list (11.2).

## Risks

- **Shared files with Epic 10.** `kit/runtime/app/index.js`, the profile schema, `kit/lib/tier/index.js`, `test/unit/write-path.test.js` and `ci.yml` are edited by several stories. Run them one at a time (build order above) or have the later builder merge `main` first.
- **The container is only proven in CI.** No one runs it on a real host in this epic. The first fork that deploys will find host-specific gaps (ports, health check paths, the stop-then-start setting, arbitrary UIDs, non-amd64 hosts). Proposed ledger row below.
- **The MotherDuck extension version.** It must match the pinned DuckDB version. A DuckDB bump without rebuilding the image leaves a MotherDuck fork with "data unavailable". The smoke test loads the extension offline to catch that in CI.
- **Test time.** 11.3 copies the repo twice and boots two apps; 11.5 and 11.6 make temp git repos. `npm test` is already about 2.5 minutes. Each story reports its added time, and one over about 30 seconds goes to its own CI step.
- **Template history in forks.** Updates merge only if the fork shares the template's history (Q17). A fork made any other way must be re-based once, by hand, before its first update. Cloning with history also ships everything in the template's history to the client; that is Ely's decision (DEP row below).
- **The fingerprint can be rewritten.** A fork could edit `kit/` and re-record the fingerprint. That's a guard against accidents, not a lock: the record is under `.aplabs/` (always T3, full review), and `template:update` re-checks against `upstream` when it can. Deleting the record no longer skips the check (B8).
- **Jobs run on one process's clock.** A restart during a job's minute skips that run. No catch-up, by design (Q4).
- **Stale docs.** AD-1 (template-owned files, the version record, how updates merge), AD-8, AD-9, AD-13, AD-16 and CAP-12/15 change. Each story updates its own lines in the same PR.

## New ledger items (proposed)

The Orchestrator assigns the next free DEP ids when it adds these (plans epic-9 and epic-10 already proposed ids from DEP-019).

| Row | Owner | What |
|---|---|---|
| DEP-016 | Orchestrator | Closed by 11.2 (the image installs the MotherDuck extension at build). |
| DEP-(next) | **Ely** | Create and push the `v0.1.0` tag on the commit the Orchestrator shows you (after 11.5 merges). Blocks nothing but the changelog's accuracy. |
| DEP-(next+1) | **Ely** | Cut the first runtime release (`npm run template:release -- v0.2.0 --push`) once Epic 10 is live-checked and Epic 11 has merged. |
| DEP-(next+2) | Orchestrator (in the first fork) | First real deploy of the container on a host: confirm the health check and the stop-then-start setting there, check the `$HOME/.duckdb` extension path under the host's UID and that the host is amd64, and feed fixes back to the template. |
| DEP-(next+3) | **Ely** | Decide what template history ships to client forks. Cloning with history ships the template's whole history to every client, including `docs/reference/` (Hometown references) and `docs/reference/agent-memory/`. Options: (a) accept it and keep those files fit for clients; (b) a separate distribution repo whose history starts at v0.2.0; (c) purge them from history before v0.2.0. Blocks the first real client fork, not any build in this epic. |

## Steps only you can do

1. Nothing before the builds start. Docker is not needed on your Mac.
2. After 11.5 merges: look at the commit the Orchestrator names for `v0.1.0`, then run the tag and push commands it gives you.
3. Optional: in GitHub's branch protection for `main`, add the new `container` check as required, beside `test` and `clean-bones`.
4. After Epic 10's live demo and Epic 11 merge: write or approve the `v0.2.0` changelog entry, then run `npm run template:release -- v0.2.0 --push`.
5. Before the first real client fork: decide what template history ships (options a, b or c above).

## Not in this plan

- Any real client fork or real GitHub repo. Forks exist only in temp folders inside tests.
- A chosen host, deploy scripts for a host, or more than one replica (architecture, Deferred).
- Jobs that write to a connector, post to Slack, or run on more than one process. FR12 is traced as **partial** for this reason.
- HTTP (Events API) mode for Slack.
- A durable store.
- Automatic updates on a schedule (a person runs `template:update`).
- Retro: `npm run retro` runs at the Epic 11 boundary as usual. It's not a story here.

## Approval

Approved under Ely's conditional pre-approval of 2026-10-25 ("approve plan epic-11 if the architect and plan review leave no unresolved blocking finding"). The review's 10 blocking findings are all folded in above. To change any adopted answer, say so before the story it affects starts.
