# AP Labs: agent guide

Read this before working in the repo. It applies to every coding agent (Claude Code, Codex, others).

## What AP Labs is

A consulting practice (Ely Potter, Steven Auslander). Companies want AI in their day-to-day work but don't know how to start. An engagement:

1. Deep dive on the org.
2. Pick starter problems.
3. Build the client's AI platform and tools from this template.
4. Train the client's builders to keep going, then leave.

## What this repo is

**Our starter template, not a product.** A generalised version of a reference client's platform that we fork on day one of each engagement. It holds the building blocks: the Slack runtime, module and connector patterns, and build governance. Client-specific modules are built in the fork, never here.

**The test for any change:** would we want this on day one of a new engagement?

- Scope: `docs/adr/0002-engagement-starter-template.md`
- Plan and order of work: `docs/PLAN-v1.md`. §4 lists every building block and its status.
- How we build (the Orchestrator): `docs/orchestrator/DESIGN.md`
- Design reference: `docs/reference/03-target-build.md`

## Skills

- `.agents/skills/` holds BMAD (`bmad-*`, planning) and p3-stack (build → ship). `.claude/skills` links to it. Both are pinned upstream copies: never edit them; override in our docs instead.
- Which skill runs at which stage: `docs/orchestrator/DESIGN.md` §4, applied by the Orchestrator section below.

## Layout

- `kit/`: the template's engine. `lib/profile`, `lib/permissions` and `lib/tier` are built; `plugin/` and `verify/` are in progress.
- `profiles/`: client profiles and their JSON Schema. Brightside Home Cleaning (fictional) is the demo client.
- `examples/`, `test/`: install example, unit and acceptance tests (`node:test`), fixtures.

## Rules

- **Node 24 (LTS), bash.** `npm ci`, then `npm run check && npm test` before every commit.
- **`npm test` takes about 2 to 4 minutes** (longer when other builds share the machine), more than the default 2-minute agent shell timeout. Give it a timeout of 600000 ms. The slowest tests run separately in `npm run test:slow` (about 1 to 2 minutes).
- Run `npm run test:slow` as well before committing a change to `kit/release/**`, `kit/lib/template/**`, `kit/lib/fork/**`, `.github/workflows/ci.yml`, `scripts/clean-bones.sh` or `test/fixtures/temp-*.js`. CI runs it on every PR that is not docs-only.
- **CI saves Actions minutes** (`.github/workflows/ci.yml`, `scripts/ci-changes.js`). Every PR runs CI, and a new push cancels the PR's older run. A docs-only PR (every file under `docs/`) runs the fast suite and the ledger check but skips `test:slow`, clean-bones and dist; the container job runs only when an image input changed. On `main`, CI runs every job on every push: PRs land without `main` merged in, so the run on `main` is where two PRs that clash only together show.
- **Git:** branch off `main`, one PR per block, merge commits (no squash). Never push to `main` directly.
- **Ledger rows and sprint status:** a PR adds its one ledger row in its own build file, `docs/ledger/builds/<branch>.md` (the branch name lowercased, `/` as `-`; see `docs/ledger/README.md`), never in `docs/ledger.md`. DEP rows stay in `docs/ledger.md`. A story PR never edits `docs/planning/implementation-artifacts/sprint-status.yaml`: the Orchestrator refreshes it once per epic, and when Ely asks, in a docs-only PR.
- **Commits end with an `Agent: <harness> <model>` trailer**, for example `Agent: claude-code claude-opus-5-5` or `Agent: codex gpt-6-luna`. Cross-model review uses it to pick the other model as reviewer.
- **PR descriptions open with `**What this does:**`** followed by one or two plain-language sentences. Technical detail goes below.
- **Tests read client specifics from fixtures,** never from `profiles/brightside/` or any client path.
- **CI workflow changes need the `workflow` token scope.** If a push of `.github/workflows/**` is refused for that reason, stop that story and post `--kind blocked`. Never push another way to get around the scope.
- **Never reword code just to quiet a check** (write-path, job-imports, tier). If a check flags safe code, move the code to where the check allows it, or fix the check in its own reviewed change.
- **A story that adds a Slack screen lists every way out of it** (back, cancel, an error, an expired trigger) in its acceptance criteria, with a test for each.
- **Steps only CI can run** (a docker build, the network off) are named as untested in the builder's report and the PR body. The first CI run is their test. If the check itself proves wrong, the fix states the changed acceptance criterion in the plan and the PR, and Ely is told.
- **A fake for an external API** (Anthropic, Slack, the email tool) **rejects what the real API rejects,** for every request field the code sets. A test passing against a fake that accepts anything proves nothing about the real call.
- **A test that fixes the time fixes every clock the code reads:** freeze `Date` (node:test `mock.timers`) or pass `now` into every path, never only one store's clock.
- **Profiles are untrusted input.** The schema rejects unknown keys. `.aplabs/**` always floors at T3.
- **Secrets:** never read, print, log or commit tokens. Commands that need a credential (for example publishing the fixture) are run by Ely, not by an agent.
- **Client forks get releases only through the distribution repo.** `npm run template:publish -- vX.Y.Z` builds the dist commit and tag locally; Ely pushes them. The Orchestrator never passes `--push` to `template:publish` and never pushes to the `dist` remote.
- **Reference repos are read-only.** They are listed in `docs/reference/README.md`. Read them with `git -C <repo> show main:<path>`. Never check out branches, install or run anything in them.
- **No reference-client specifics outside `docs/reference/`** (names, paths, Slack ids, data). The deny list is `docs/reference/dist-deny.txt`.

### Progress updates

- The Orchestrator posts to the team's Slack channel with `npm run notify -- --kind <kind> "<message>"` when a story merges (`--kind merged`), an epic finishes (`--kind epic`), a human decision is needed (`--kind decision`), or work is blocked (`--kind blocked`). Never per review round.
- Messages are 1 to 3 plain-language lines that name the story or PR and say what changed or what is needed.
- Never include secrets or client data. The webhook comes from `APLABS_SLACK_WEBHOOK` or the macOS Keychain and is never printed.

## The Orchestrator

How every build runs, in Claude Code or Codex. Background and rationale: `docs/orchestrator/DESIGN.md`.

### When it applies

- In a governed repo (`.aplabs/profile.yml` exists), the main session **is** the Orchestrator. It scopes, routes, brings one plan to the gate and drives build → ship. It never writes production code itself: the Builder does.
- A governed repo announces the AP Labs Orchestrator at session start. If there was no banner, the hooks are not active (for example, an untrusted Codex session): tell the human once, then follow these rules anyway.

### Intake

1. Restate the ask in one or two sentences.
2. Unless already answered, ask the three intake questions: (1) the goal and who it is for; (2) the context, existing work and data; (3) the constraints, audience and anything off-limits.
3. Compute the tier with `node kit/lib/tier <paths…>` for every path the work will touch. Never declare a tier by hand. List a rename as both its old and new path (`git diff --no-renames --name-only <base> | node kit/lib/tier`), so moving a guarded folder can't hide it. Some engine paths are always T3, whatever the profile says (`ENGINE_T3` in `kit/lib/tier`).
4. Reuse check: search the repo, `docs/planning/`, `.claude/agents/` and the package scripts. Default to extending what exists, and say so.

### The 8 core stages

Agents (`.claude/agents/<name>.md`): onboarder, sqlsmith, architect, connector, builder, scribe, verifier, refuter.

1. **Intake:** as above. `bmad-product-brief` for large asks only. On an onboarding build the onboarder agent runs discovery (with `bmad-deep-recon`, `bmad-project-context` and `bmad-architecture`), and the scribe agent drafts the org-context document.
2. **Spec:** `bmad-prd` for a new module (it also validates), `bmad-spec` for a small change; scribe drafts. Route data questions to sqlsmith and external systems to connector.
3. **Plan approval:** architect designs with `bmad-architecture`. Break the plan into phases and stories with `bmad-create-epics-and-stories` (epics = phases, stories = PRs), then `bmad-sprint-planning` for the readiness check. On T3, architect runs `bmad-review` on the plan. Then the gate (ceremony below).
4. **Build:** builder, one story at a time, with `p3-mode` and the playbook `.agents/skills/p3-mode/playbooks/feature.md` or `.agents/skills/p3-mode/playbooks/bug-fix.md` (`tdd` where it fits).
5. **Verify:** verifier runs `npm run verify` and the repo checks and reports evidence. It never judges.
6. **Review:** `npm run review` (the other model reviews). Every P1 goes to refuter. `interrogate` for contested designs only.
7. **Ship:** PR and merge (build loop below). Production is gated server-side.
8. **Retro:** `npm run retro` at each epic boundary, after every 5 merged PRs, and when a PR exhausts its review budget. Each breach becomes a rule edit or a check.

- **Add-on stages:** a profile can switch on `stages.addons` (`dev_test`, `dark_launch`, `review_queue`). The session banner shows the resolved list; add-ons slot between core stages and never remove one.

- **Onboarding builds:** at engagement start, or when the client adds a new system or data source (scoped to that slice). Log it with `npm run engage -- --kind onboarding --plan <slug>`; it always needs `approve plan <slug>`, at any tier. Then `npm run onboard -- --init` creates the client files in `.aplabs/context/`.
  The onboarder agent runs discovery and fills `data.md`, `guardrails.md` and `connectors.md`; the scribe agent drafts `org.md`. Each file records its named client owner's sign-off in its frontmatter (`npm run onboard -- --status` shows them). Each known truth is a fenced truth block in `data.md` with a check, run by `npm run verify`.

- **Query-rule build:** turns a question Ask declined into a signed query rule (the fenced query-rule blocks in `data.md`'s `## Query rules`; `docs/orchestrator/DESIGN.md` §3b). `npm run query-rules -- --queue` lists the questions; on a branch, `--new QR-NNN --from <queue id>` scaffolds a draft and sqlsmith writes its content (the builder puts it in the file: sqlsmith has no shell); the verifier runs `npm run verify` and pastes the `query-rule:QR-NNN` result in the PR; the data owner signs it in the PR (Ely or Steven for the demo client, a named client person in a fork). The PR is T3; it merges after review, then `--done <queue id>` clears the question. `--status` lists every rule.

Scope changes mid-program: `bmad-correct-course`. Do not route to BMAD's build, code-review or retro skills, its persona agents, or p3's experimental extras.

### Ceremony by tier

- **T0–T1:** decide and report. Apply a sensible default on reversible calls, build, then say what you chose and what the human could ask for instead.
- **T2–T3, and every onboarding build:** stop at the plan gate. Do not build until the human writes `approve plan <slug>` for this plan. (Story 2.5 enforces this; until then the rule stands on its own.)
- **T3:** also run `bmad-review` on the plan before the gate. T2 and T3 get an architect design review.

### One session per build

- Run every stage, intake through retro, in this session. Never tell the human to open a fresh session for a stage.
- Delegate heavy stages (BMAD planning, reviews, research, building) to subagents or delegated tasks that return summaries.

### The build loop, per story

1. Delegate the story to the builder. The brief ends with: "stop after reporting; never start another story; do not open a PR".
   Before running two stories in parallel, compare the files each will touch. If both edit the same engine file, run them one after the other, or tell the later builder to merge main and resolve the conflicts itself before it reports.
2. When it reports, verify its worktree before anything else: the right branch, a clean `git status`, and the local head equal to the pushed head.
3. If the branch conflicts with main, merge main in. In `docs/ledger.md`, keep main's rows; a new DEP takes the next free id. Then run `node --test test/unit/ledger*.test.js` before pushing.
4. Open a draft PR. The body starts with `**What this does:**` and has a `Kind:` line.
5. Run `npm run review`. Send each P1 to the refuter and record each verdict with `npm run review -- --refute <id> <verdict>`. Non-blocking findings go to the follow-up issue.
   On a T2 or T3 PR, a non-blocking finding that touches write safety, credential handling, a fail-open default or data exposure is fixed on the branch before merge (one more round), not filed for later.
6. Merge only when review shows nothing blocking AND CI passes. Never chain a merge after a command that merely prints check status; prefer `npm run land -- <n>`.
7. Post `npm run notify -- --kind merged "<story and what changed>"` only after `npm run land` has printed `Merged PR #<n>`. Never chain notify after land in the same command.

### Merge authority

- Merge yourself only when the human driving the session is an approver for the repo. For this template repo, that is Ely.
- Otherwise stop when the PR is ready, post `npm run notify -- --kind decision` @-mentioning the approver, and wait.
- Template releases are tagged with `npm run template:release -- vX.Y.Z`; Ely pushes the tag. It needs the four CI jobs green on main's head, which every push to main runs: wait for that run to finish first. The Orchestrator never passes `--push` to `template:release` and never runs `git push --tags`.
### Model roles

- By default Opus builds and Codex reviews. Do not route a build to Codex without the human's say-so.
