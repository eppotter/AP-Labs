# Steven: getting set up on the AP Labs template

Written 2026-10-26 by the Orchestrator for Ely. This file lives under `docs/planning/`, which never ships to clients.

## 1. Where things stand

- **The repo** (`github.com/eppotter/AP-Labs`) is our starter template, not a product. We fork it on day one of each engagement. Read `AGENTS.md` first: it is the rulebook for you and for every agent.
- **V1 is built.** It includes the Orchestrator (governed builds, cross-model review, the ledger), the Slack runtime, the AI request reader and the approval-write path. The demo client is Brightside Home Cleaning, which is fictional.
- **v0.2.0 is released** to `github.com/eppotter/aplabs-template`. That is the clean copy client forks clone from: no internal history, no reference-client material.
- **Not yet checked live in Slack:** Epic 10's push to the email tool, and the Win-back demo from "Push" onward. Everything passes its tests and CI; the live checks come in the next week or two.

## 2. Access (Ely does these)

1. Ely invites your GitHub account to `eppotter/AP-Labs` with write access. You don't need `aplabs-template` access to build.
2. Ely adds you to the `aplabs-demo` Slack workspace, if you're not in it already.
3. **Secrets never travel in chat, email or the repo.** Use your own accounts where you can (Anthropic, OpenAI/Codex). Ely shares the `#dev-updates` webhook through a password manager.

## 3. Set up your Mac

1. **Install:** Node 24 LTS, git, the GitHub CLI (`gh`), `shellcheck`, Claude Code, and the Codex CLI. Log in to Codex with your own account: `npm run review` calls `codex` so the other model reviews every PR.
2. **GitHub:** run `gh auth login` as your own account. Set your git name and email.
3. **Get the code and check it:**
   ```bash
   git clone https://github.com/eppotter/AP-Labs.git ~/Projects/AP-Labs
   cd ~/Projects/AP-Labs
   npm ci
   npm run check && npm test     # npm test takes 2 to 4 minutes
   npm run test:slow             # 1 to 2 minutes
   ```
4. **The demo data** is built from git, offline, in under a second:
   ```bash
   npm run fixture:build && npm run fixture:validate
   ```
   The expected truths include 2,000 clients and 815 active plans, 38 North win-back candidates (17 with a price rise), and September 2026 billed $364,023.50.
5. **BMAD personal config:** create `_bmad/config.user.toml` (gitignored) with your name, English, and your skill level. Copy the format from `_bmad/config.toml`.
6. **Slack progress updates** (optional at first): store the webhook Ely shares, at the Keychain prompt:
   ```bash
   security add-generic-password -s aplabs-slack-webhook -a aplabs -w
   ```
   Or let your agent save it from the clipboard ("copied"); it never prints it.

## 4. Running the bot yourself (when you want to)

- **One copy per Slack app.** Two bots on the same Socket Mode token split Slack's events between them. Make your own dev app ("Brightside Bot (Steven dev)") from the manifest in `docs/runtime/slack-app-setup.md`, so you and Ely never collide. Then store its two tokens as that doc shows.
- **The AI helper:** create your own Anthropic key with a monthly spend cap, as in `docs/runtime/ai-setup.md`. Without a key the bot still runs; "Read my request" falls back to the form.
- **Your Slack member id:** mapped to the user `steven` in `profiles/brightside/profile.yml` (an admin, with every grant Ely has, on every hub: plan brightside-v1), so you get the same Brightside menus as Ely.
- **The demo itself:** `docs/runtime/demo-script.md`. The bot reads the local fixture by default; MotherDuck isn't needed.

## 5. How work runs

- **Open Claude Code in the repo.** The session banner announces the AP Labs Orchestrator. Tell it what you want built; it runs intake, computes the tier, plans, delegates the build to a builder agent, runs the Codex review, opens the PR and merges through `npm run land`.
- **Approvals and merges:** this repo's approver is Ely (`AGENTS.md`, Merge authority).
  - **T0–T1 work:** your session builds and opens the PR, then posts a `--kind decision` update for Ely to merge.
  - **T2–T3 work:** your session stops at the plan gate until Ely writes `approve plan <slug>`.
  - If Ely makes you an approver, that line in `AGENTS.md` changes and your sessions merge too.
- **Hard rules** (the full list is in `AGENTS.md`):
  - Never put secrets in the repo, a PR or a chat.
  - No reference-client specifics outside `docs/reference/`.
  - Never pass `--push` to `template:release` or `template:publish`, and never push to the `dist` remote. Ely pushes releases.
  - Merge only through `npm run land`.
- **Commits** end with an `Agent: <harness> <model>` trailer, for example `Agent: claude-code claude-opus-5-5`.

## 6. Good first things to build

1. **Verify your setup:** checks, tests and the fixture truths all pass (step 3).
2. **Dry-run a client fork.** Clone `aplabs-template` at `v0.2.0` into a scratch folder and follow `docs/fork-guide.md` end to end, as if Brightside were a real client. This is the first real test of v0.2.0, and it will teach you the template faster than reading it. Report every step that was unclear or wrong; fixes go to the template as PRs. You need read access to `aplabs-template` for this; ask Ely.
3. **Run the demo in your own Slack app** (step 4) and note anything that breaks or reads badly. That helps the live checks Ely has pending.
4. **Then pick from the backlog with Ely:**
   - small open issues, such as #182 and #185;
   - the two follow-up plans: engine write safety, and running the bot day to day;
   - preparing for the first engagement.
