---
name: ap-labs-orchestrator-design
description: Running decisions from Ely on the AP Labs Orchestrator (the generic version of Varsity's build process) — not yet written into repo docs
metadata:
  type: project
---

These decisions come from the design conversation on 2026-10-23. Write them into the repo (an orchestrator design doc or ADR) before any build PR. Background: [[ap-labs-business-model]].

- The Orchestrator is the template's core scaffolding: Varsity's build process made generic. Ely wants to understand its phases and stories BMAD-style before building.
- **Onboarder** (new agent; Ely chose the name, not "Conductor"): runs only on onboarding builds, not regular ones. It writes the client-specific files the other agents load:
  - SQLsmith: data model, approved tables, joins, known truths, terminology
  - Architect: guardrails, tier map, protected systems, approvers
  - Connector: the client's systems, auth, read vs write paths
  
  It merges with the Discovery Guide role in docs/reference/05 (rule cards + client-owner sign-off). Canon must be checked against client numbers, not just written. Onboarding reruns for each new system or data source. After onboarding, canon grows through regular builds (Scribe proposes, a human approves).
- SQLsmith ships as a blank slate (generic reasoning only) and is trained per client by the Onboarder.
- **Leadership Panel: removed entirely** (Ely: rarely used in Varsity).
- **Org context:** a single org-context profile document in the client repo that every agent references. Scribe builds and maintains it: it drafts from the Onboarder's discovery findings during onboarding builds and keeps it current during regular builds. It replaces Varsity's multi-file org-context layer.
- **Roles kept as in Varsity:** Builder, Scribe, Verifier, Refuter (plus Orchestrator, SQLsmith, Architect, Connector and the new Onboarder).
- **Tooling split (decided):** BMAD installed as-is for planning: onboarding docs, PRD/spec, architecture, epics and stories (epics = phases, stories = PRs), readiness check, plan review, correct-course. p3-stack vendored as-is for build → ship: the feature/bug-fix playbooks, interrogate, opening-a-pr/shipping/babysit, retro. Where they overlap, BMAD's dev/code-review/retro are not used. Our thin rules layer owns stages, gates, tiers, agents and budgets. Never use the BMAD name in branding.
- **Cross-model review (decided, from Ryan's CanonCRM):** Claude-written → Codex reviews (scripted, read-only); Codex-written → Claude reviews (read-only CLI). P1/P2 rubric, 3-round budget enforced by script, "same class twice → fix the premise", P2 → follow-up issue, `Review rounds: n/3` in the PR body. The Refuter checks each P1 before it counts. Exempt: docs, config changes of 10 lines or fewer, reverts.
- **Codex fallback (decided):** Codex review is the default and part of standard engagement setup. A client without Codex gets a fresh read-only Claude session as reviewer, labelled `Review: same-model fallback` in the PR.
- These decisions are written up in PR #8: `docs/orchestrator/DESIGN.md` + ADR 0003. Once #8 merges, the repo is the source of truth and this file is history. Settled: simple 8-stage core + profile add-ons; T0–T1 decide and report, T2+ plan gate, onboarding always gated.
- **One session per build (Ely, 2026-10-23):** the Orchestrator runs every stage, intake through retro, in a single session and never hands a stage to a fresh session (this overrides BMAD's "fresh context window" advice). Heavy stages go to delegated subagents that return summaries. Don't recommend starting a new session for the next stage.
- **Model roles (Ely, 2026-10-23):** by default Opus builds and Codex reviews. Story 1.2 was an approved one-off exception: Codex built it to dogfood the reverse direction, where Claude reviews Codex-written work. Don't route builds to Codex without asking.
- **Lesson (Story 1.2, 2026-10-23):** after finishing, the Codex builder started Story 1.3 unasked, in the same worktree, and left uncommitted edits that came along on checkout. Every builder brief must say "stop after reporting; never start another story". Check `git status` and the current branch in a builder's worktree before reviewing. Story 2.3's rules should encode this.
- **Autonomy grant (Ely, 2026-10-23 ~23:40):** "continue building for as long as you can without my interaction." Default applied: I merge PRs that pass review (0 P1 after the Refuter/my own check) plus CI, and post progress to Slack #dev-updates (aplabs-demo workspace, webhook in Keychain `aplabs-slack-webhook`) instead of asking. UPDATED by Ely: merge authority depends on who is driving the session. When Ely is the builder working with Claude, Claude merges every PR itself (process files included) once review shows 0 blocking and CI passes; never ask Ely to merge. When someone else (e.g. Steven) is building in this repo, Ely is the merge gate for now. Design implication: the Orchestrator should gate merges on the runner's identity (Varsity did the same with approver fast-paths). Carry this into Story 2.x and the design doc. Report every default in Slack.
- **Slack mentions (Ely):** in Slack updates, always @-mention Ely when referring to him: `<@U0CB6HDBBQX>` (aplabs-demo workspace member id). Possible later generalisation: resolve mentions from the profile's `users[].identities.slack`.
- **Lesson (#19, 2026-10-24):** I merged with CI red because `gh pr checks --watch | tail -1` printed the failure without gating. ALWAYS gate: `if gh pr checks N --watch >/dev/null; then gh pr merge ...; fi`. shellcheck is installed locally and `npm run check` runs it.
- **Lesson (Story 6.2 merge, 2026-10-24):** my "merge main into the builder branch" step auto-resolved only docs/ledger.md, then ran `git add -A` and committed package.json WITH conflict markers (caught before push). ALWAYS run `git grep -n '^<<<<<<< \|^>>>>>>> ' -- . ':!node_modules'` and require it to find nothing BEFORE `git add`/commit. package.json script conflicts: keep both sides.
