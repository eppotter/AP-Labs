# Handoff: moving to a new computer (2026-10-24)

**What this is:** everything needed to pick the build back up on another machine. Read this first, then `AGENTS.md`. The agent's working memory from the old machine is in `docs/reference/agent-memory/` (restore steps below).

## 1. Where the build stands

- **Main:** `#104` plus this handoff PR. Nothing is open: no open PRs, no unpushed work. Every local branch on the old machine is either merged or abandoned.
- **Kit phase (Epics 1–5):** done.
- **Runtime phase (Epics 6–11, 30 stories):** 15 stories built.

| Epic | What | Status |
|---|---|---|
| 6 | Slack bot, hub menu, access, welcome/help, module template | Built and **live-checked**: the bot answered Ely in the aplabs-demo workspace. The `/brightside` menus still need Ely's click-through. |
| 7 | Synthetic Brightside data (fixture) | Built. Local DuckDB is live-checked: 14 tables, 173,078 rows, 14/14 checks, truths match. Story 7.7 (publish to MotherDuck) is waiting on Ely's account. |
| 8 | Connector contract, mock CRM, mock email and its outbox | Built (tests only). |
| — | Fix sweep before Epic 10 | Done: #97, #99 (DEP-012), #101, #102, #103, #104. |
| 9 | LLM service, typed forms, plain-English parameters | Not started. Ely said "focus on the fixes": **do not start it unasked**. Its live check needs an Anthropic key. |
| 10 | Scoring, preview → approve → push, the demo flow | Not started. Blocked by DEP-013 and DEP-017 (both in `docs/ledger.md`). |
| 11 | Scheduled jobs, container, two forks, fork guide, releases | Not started. |

Story-level status lives in `docs/planning/implementation-artifacts/sprint-status.yaml`.

## 2. Next steps, in order

1. **Agent: write the fix-sweep retro.** `npm run retro -- --prs 94,96,97,99,101,102,103,104` breached: fix share 75% against a 25% budget.
   - The cause: a deliberate sweep of follow-ups filed during Epics 7–8, before the AGENTS.md rule that T2/T3 safety P2s are fixed before merge (#93).
   - Write `docs/planning/implementation-artifacts/retro-fix-sweep.md`, and turn the breach into a check or rule edit. For example, retro could leave out PRs from a planned debt sweep, or record that the #93 rule already prevents a repeat.
   - In the same PR, add to DEP-017's text that 10.3 must route opaque progress-record keys to the admin.
   - Update `sprint-status.yaml` and the handoff memory.
2. **Ely: Slack live check.** Start the bot (section 4), then in the aplabs-demo workspace run `/brightside` and click through the three modules.
3. **Ely: MotherDuck** (`docs/runtime/motherduck-publish.md`).
   1. Create the account with the venture email.
   2. Store the publish token as `aplabs-motherduck-token`.
   3. Run `npm run fixture:publish`.
   4. Share the database with Steven.
   5. Create a read-only service account and store its read-scaling token as `aplabs-motherduck-read-token`.
4. **Ely: approve or change the plan** in `docs/planning/planning-artifacts/plan-motherduck-read.md`.
   - It makes the bot read MotherDuck instead of the local file.
   - To approve, write `approve plan motherduck-read`.
5. **Ely:**
   - Story 4.3 (onboarding build): write `approve plan onboarding-brightside`.
   - Issue #68: decide whether access code stays at T1.
6. After those: Epic 9, but only when Ely says so. Epic 10 waits on DEP-013 and DEP-017.

Open follow-up issues (non-blocking): #100, #95, #63, #61, #58, #56, #54, #49, #47.

## 3. Set up the new machine

1. **Install the tools:**
   - Node 24 LTS
   - git
   - the GitHub CLI (`gh`)
   - `shellcheck` (`npm run check` uses it)
   - Claude Code
   - the Codex CLI, logged in (`npm run review` calls `codex`)
2. **GitHub.** Log in to `gh` as `eppotter`. If the machine also has a work login, never switch the global login: prefix commands with `GH_TOKEN=$(gh auth token --user eppotter)`.
3. **Get the code and check it:**
   ```bash
   git clone https://github.com/eppotter/AP-Labs.git ~/Projects/AP-Labs
   cd ~/Projects/AP-Labs
   npm ci
   npm run check && npm test   # npm test takes about 2.5 minutes
   ```
4. **Secrets.** These go into the macOS Keychain, never into git. Each command prompts for the value.

   | Keychain name | What it is | Where to get it |
   |---|---|---|
   | `aplabs-slack-bot-token` | Bot token (`xoxb-…`) | api.slack.com/apps → Brightside Bot (dev) → OAuth & Permissions |
   | `aplabs-slack-app-token` | App-level token (`xapp-…`) | Same app → Basic Information → App-Level Tokens (generate a new one if you can't copy it) |
   | `aplabs-slack-webhook` | `#dev-updates` webhook for `npm run notify` | Same app (or the webhook's own app) → Incoming Webhooks |
   | `aplabs-motherduck-token` | Publish token (not created yet) | MotherDuck settings, at step 3 above |
   | `aplabs-motherduck-read-token` | Read-only token (not created yet) | MotherDuck service account, at step 3 above |

   ```bash
   security add-generic-password -s aplabs-slack-bot-token -a aplabs -w
   security add-generic-password -s aplabs-slack-app-token -a aplabs -w
   security add-generic-password -s aplabs-slack-webhook   -a aplabs -w
   ```
5. **BMAD personal config.**
   - `_bmad/config.user.toml` is gitignored and holds three answers: name Ely Potter, language English, skill level intermediate.
   - Re-run the BMAD installer, or recreate the file with those values.
6. **Agent memory.** Copy `docs/reference/agent-memory/*.md` into Claude Code's memory folder for the new checkout: `~/.claude/projects/<checkout path with / replaced by ->/memory/`. For example, `~/.claude/projects/-Users-ely-Projects-AP-Labs/memory/`.

   Your personal `~/.claude/CLAUDE.md` and `~/.claude/rules/` are not in this repo. Copy them across yourself if you want the same response format and advisor hats.

## 4. Local data: what moves and how

**Nothing needs copying by hand.** The only data on the old machine is `var/fixture/brightside.duckdb`, and it is a build output, not a source.

- **The source is already in git.** It is `examples/brightside/fixture/`: 14 seed CSVs (6.3 MB), the schema, the checks and the generator.
- **The build is exact.** `npm run fixture:build` turns the seeds into the database, offline, in under a second. On 2026-10-24 a fresh build from a clean `git archive` gave the same content digest as the old machine's file: `…0ba52318614cb4abe6c9668d`.
- **Rebuild and check on the new machine:**
  ```bash
  npm run fixture:build      # writes var/fixture/brightside.duckdb
  npm run fixture:validate   # 14/14 checks and the known truths
  ```
- **Expected truths:** 2,000 clients; 815 active plans; 38 North win-back candidates, 17 with a price rise; September 2026 billed $364,023.50 and paid $350,186.40; outstanding at as-of $198,753.25 (`profiles/brightside/context/data.md`).

**Why the database file itself stays out of git:**
- It is 18 MB of binary, rebuilt on every seed change.
- Committing it would put a second copy of the truth beside the seeds that could drift.
- Publish (#103) already refuses to upload any file that is not exactly a fresh build of the committed seeds.

**Plan: git → MotherDuck**

1. **Git holds the source of truth:** the committed seeds.
   - A change to the data is a PR that changes the generator and the seeds together; CI's `npm run fixture:check` fails if they disagree.
2. **Any machine rebuilds** the local database from git.
3. **MotherDuck gets a copy.** Ely runs `npm run fixture:publish` (agents never do).
   - It uploads that build to MotherDuck as `brightside_fixture`.
   - It adds a `fixture_publish` table recording the seeds hash and version, so anyone can tell which commit's data is online.
4. **The bot reads MotherDuck** once `plan-motherduck-read` is approved and built.
   - Reads go through a read-only token.
   - There is no silent fallback to the local file.
   - The Dataset entry shows the source and version, so Steven and the bot see the same numbers.
5. **When the data changes:** merge the seed PR, rebuild, then republish.
   - Publish replaces the MotherDuck database whole, through a staging copy.
   - It refuses a stale or hand-made file.

**Two other things on the old machine that do not move:**
- **The mock email outbox** (`var/outbox/`): it was never created, because no write has run.
- **Old worktrees:** about 55 under `~/.t3/worktrees/AP-Labs/` and `.claude/worktrees/`. They are all merged or abandoned and safe to delete.

## 5. Running the bot

**Run it on one machine at a time.** Two copies on the same Socket Mode token split Slack's events between them. The old machine's bot is stopped.

```bash
APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" \
APLABS_APP_DIR="$PWD/examples/brightside/app" npm start
```

- The Slack app is "Brightside Bot (dev)" in the aplabs-demo workspace.
  - Scopes: `commands`, `chat:write`, `im:write`, `im:history`, `files:write`, `users:read`.
  - Events: `message.im`, `team_join`.
  - Interactivity is on.
- Ely's member id `U0CB6HDBBQX` is Dana (the admin) in `profiles/brightside/profile.yml`.
- When an agent runs the bot as a background job, give it a long time limit; the default kills it after 30 minutes.

## 6. How the work runs (short version; `AGENTS.md` is the rule)

- **Roles.** Opus builds and Codex reviews. BMAD plans and p3 builds. One session runs a whole build, and heavy stages are delegated.
- **Merging.** The agent merges its own PRs when Ely drives the session (`npm run land -- <n>`). Ely does not merge in GitHub.
- **Per story:**
  1. The builder works in a worktree.
  2. The Orchestrator checks the worktree, then merges main and checks for conflict markers.
  3. It opens a draft PR that has a `**What this does:**` line and `Kind:`, `Story:` and `Tier:` lines.
  4. It swaps the ledger row's `pending` for the PR number.
  5. It runs `npm run review` on the current branch (no argument), plus specialist reviews on T3.
  6. It runs `gh pr ready`, then `npm run land -- <n> --notify "…"`.
- **Updates.** Post progress with `npm run notify`, and @-mention Ely as `<@U0CB6HDBBQX>`.
- **"Done" means checkable.** Report "built (tests only)" separately from "live-checked".
