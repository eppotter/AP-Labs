# Build ledger

One row per build, and one `DEP` row for anything a build defers or is blocked on, so nothing deferred is lost. The Scribe keeps it; the Orchestrator and the human approve.

**Adding a row.** Every PR adds or updates its row in **Builds** in the same PR. Use `pending` in the PR column until the PR has a number, then replace it. Story is the story id (`—` if none). Kind is the PR's `Kind:` line (`—` if none). Tier is the build's tier T0–T3 (`—` if unknown). Summary is one plain-language line. DEPs lists the DEP ids the build opened or closed, comma-separated (`—` if none). A pipe inside a cell is written `\|`.

**DEP rows.** Give each deferral or blocker the next free id (`DEP-001`, `DEP-002`, ...); ids are never reused or renumbered. Owner is who has to act. Status is `open` or `closed`: flip it to `closed` when the item is done or dropped, and keep the row. Blocks names what waits on it (`—` if nothing). Source links where it came from (a PR, an issue, a doc).

**The check.** CI runs `node scripts/ledger-check.js --base origin/<base>` on every pull request. It fails unless the PR touches this file or is docs-only (by the same rule `npm run review` uses), and it fails when this file is malformed: a missing or repeated table, a bad or repeated DEP id, a status other than `open` or `closed`, a PR with two rows, or a DEP named in Builds with no DEP row. Reverts are not exempt in CI: verifying a revert needs a diff per commit, so a revert PR adds a row too.

## Builds

| PR | Date | Story | Kind | Tier | Summary | DEPs |
|---|---|---|---|---|---|---|
| #1 | 2026-10-23 | — | — | — | Sets up the empty kit skeleton: folders, placeholder code, one smoke test and CI on every PR. | — |
| #2 | 2026-10-23 | — | — | — | Adds the V1 build plan (`docs/PLAN-v1.md`): what V1 won't do, the profile shape and the build order. | — |
| #3 | 2026-10-23 | — | — | — | Reads and strictly checks a client's profile (`.aplabs/profile.yml`), listing every mistake; fills in the Brightside demo profile. | — |
| #4 | 2026-10-23 | — | — | — | Answers "is this person allowed to do this?" from the profile only; a denial wins and unknown people are refused. | — |
| #5 | 2026-10-23 | — | — | — | Works out a change's risk tier (T0–T3) from the files it touches, using the profile's risk map. | — |
| #6 | 2026-10-23 | — | — | — | Documents the shared online DuckDB test dataset and keeps offline copies for CI. | — |
| #7 | 2026-10-24 | — | — | — | Re-scopes the repo as our engagement starter template and lists every building block and its build order. | — |
| #8 | 2026-10-24 | — | docs | — | Writes down the Orchestrator design (agents, onboarding, BMAD plans, p3 builds, cross-model review) and ADR 0003. | — |
| #9 | 2026-10-24 | — | infra | — | Installs BMAD and vendors p3-stack, both pinned to exact versions. | — |
| #10 | 2026-10-24 | — | docs | — | Adds the approved Orchestrator plan: the spec, 5 phases and 17 stories. | — |
| #11 | 2026-10-24 | 1.1 | infra | — | Adds `npm run review`: one budgeted, read-only Codex review round per call, at most 3 rounds. | — |
| #12 | 2026-10-24 | 1.2 | infra | — | Review always uses the other model, with a labelled same-model fallback. | DEP-001 |
| #14 | 2026-10-24 | 1.3 | infra | — | Review triage: follow-up issues, docs/config/revert exemptions, a required Kind line and a same-file stop. | DEP-002 |
| #16 | 2026-10-24 | 5.3 | infra | — | Adds `npm run notify` for plain-language Slack progress updates; the webhook is never printed. | — |
| #17 | 2026-10-24 | 1.4 | infra | — | A Refuter must reproduce a P1 before it blocks; unverifiable P1s go to the human. | — |
| #19 | 2026-10-24 | 5.2 | infra | — | Adds `npm run retro`, which measures merged PRs against the process budgets. | — |
| #21 | 2026-10-24 | — | fix | — | Fixes main's red CI after #19 and runs shellcheck in `npm run check`. | — |
| #23 | 2026-10-24 | 3.1 | infra | — | `npm run verify` runs the profile's checks with no shell, no secrets and a time limit each. | DEP-003 |
| #25 | 2026-10-24 | — | docs | — | Updates the sprint tracker and records the Epic 1 retro. | — |
| #26 | 2026-10-24 | 2.2 | infra | — | Adds the agent roster, each agent limited to the tools its job needs. | — |
| #27 | 2026-10-24 | 2.1 | infra | — | A session banner names the Orchestrator and client, and lists every profile error. | DEP-005 |
| #28 | 2026-10-24 | 2.3 | infra | — | AGENTS.md gains the Orchestrator's rules: the 8 stages routed to installed skills and agents, the build loop, merge authority. | — |
| #29 | 2026-10-24 | 2.4 | infra | — | The write gate: no edits in a client fork until work is routed to a specialist or logged with `npm run engage`. | DEP-005 |
| #30 | 2026-10-24 | 2.6 | infra | — | Client profiles can switch on add-on stages that slot between the 8 core stages. | DEP-006 |
| #32 | 2026-10-24 | — | fix | — | Reviewers end with a `VERDICT:` line the parser trusts first, so Codex paraphrases no longer force fallbacks. | — |
| #33 | 2026-10-24 | 5.1 | infra | — | Adds this ledger and a CI check that every PR adds a ledger row unless it is docs-only. | DEP-004 |
| #35 | 2026-10-24 | 2.5 | infra | — | Risky (T2/T3) and onboarding work waits for the human to type `approve plan <slug>`; a hook records it for every worktree. | DEP-007 |
| #37 | 2026-10-24 | 3.2 | infra | — | The end-of-turn hook runs the profile's checks and blocks only on a failed one; a check's whole process group is killed on timeout (#24). | DEP-003, DEP-008 |
| #39 | 2026-10-24 | 1.5 | infra | — | `npm run land` merges a PR only when CI passed, the reviewed head is the head being merged, and no blocker is open. | — |
| #42 | 2026-10-24 | 4.1 | infra | — | Adds the four client file templates, `npm run onboard` to create and check them, and a banner line until each is signed off by its client owner. | — |
| #44 | 2026-10-24 | 4.2 | infra | — | Each known truth in `data.md` carries a check that `npm run verify` and the end-of-turn hook run against the client's number; the banner flags truths not checked or signed off. | DEP-010 |
| #46 | 2026-10-24 | — | fix | — | Hardens review and land: later Claude rounds also get the diff since the last reviewed head, the rubric is built from parts, Claude's flags are pinned by a test, a CLEAN verdict hiding a prose blocker fails, and repeated exempt lines refuse a merge. | — |
| #48 | 2026-10-24 | — | fix | — | Hardening: T3 plan reviews must come from the current plan, duplicate ledger tables fail, add-on stage lists can't drift, odd comma numbers are rejected, the banner flags truths that failed at last verify, and fork CI runs verify strictly. | DEP-001, DEP-002, DEP-003, DEP-006 |

## Deferrals (DEP)

| DEP | Opened | Owner | Status | Blocks | What | Source |
|---|---|---|---|---|---|---|
| DEP-001 | 2026-10-24 | Orchestrator | closed | — | Non-blocking review follow-ups from PR #12 (Story 1.2). | [#13](https://github.com/eppotter/AP-Labs/issues/13) |
| DEP-002 | 2026-10-24 | Orchestrator | closed | — | Non-blocking review follow-ups from PR #14 (Story 1.3). | [#15](https://github.com/eppotter/AP-Labs/issues/15) |
| DEP-003 | 2026-10-24 | Orchestrator | closed | — | Non-blocking review follow-ups from PR #23 (Story 3.1). | [#24](https://github.com/eppotter/AP-Labs/issues/24) |
| DEP-004 | 2026-10-24 | Orchestrator | open | Story 4.3 | Story 4.3 (prove onboarding on Brightside) is deferred to the fixture phase: it needs the Brightside dataset. | `docs/planning/planning-artifacts/epics.md` (Story 4.3) |
| DEP-005 | 2026-10-24 | Orchestrator | open | — | The Codex SessionStart and gate output formats are unproven against a live, trusted Codex session. | [#27](https://github.com/eppotter/AP-Labs/pull/27) |
| DEP-006 | 2026-10-24 | Orchestrator | closed | — | Small hardening follow-ups from Story 2.6's review (add-on lists in sync, error type, unused export). | https://github.com/eppotter/AP-Labs/issues/31 |
| DEP-007 | 2026-10-24 | Orchestrator | open | — | Plan approvals are recorded only in Claude Code sessions; Codex's UserPromptSubmit hook is unproven, so Codex sessions can't record an approval. | Story 2.5 |
| DEP-008 | 2026-10-24 | Orchestrator | open | — | Watch whether blocking the turn end on any failing check (e.g. mid-TDD red tests) slows builders; Varsity only reported test failures before review. | Story 3.2 |
| DEP-009 | 2026-10-24 | Orchestrator | open | — | `npm run retro` reads only PR bodies, so it can't flag a PR merged while CI was red (as #19 was); add a CI-state-at-merge check. | docs/planning/implementation-artifacts/retro-epics-2-3-5.md |
| DEP-010 | 2026-10-24 | Orchestrator | open | — | Block plan approval for data work while a known truth fails its check; deferred from Story 4.2, which only reports failing truths in verify and the end-of-turn hook. | Story 4.2 |
| DEP-011 | 2026-10-24 | **Ely** | open | — | The runtime reads MotherDuck: needs an approved read-only service token and an injection path (approver Ely). V1 runtime reads the local fixture only. | docs/planning/planning-artifacts/architecture-runtime.md |
