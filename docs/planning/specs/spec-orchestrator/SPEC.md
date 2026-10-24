---
id: SPEC-orchestrator
companions:
  - ../../../orchestrator/DESIGN.md
  - harvest-map.md
sources:
  - ../../../adr/0002-engagement-starter-template.md
  - ../../../adr/0003-orchestrator-tooling.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# AP Labs Orchestrator

## Why

A vision to realise, with a pain behind it. AP Labs forks this template for every client engagement, and both our builders and, later, the client's builders need one governed way to build: plan, approve, build, verify, review, ship. Varsity proved that process at Hometown, but it is welded to Hometown. Ryan Iyengar's CanonCRM proved stronger review discipline. Every later template block (Slack app, connectors, archetypes) gets built through the Orchestrator, so it comes first.

## Capabilities

- **CAP-1**
  - **intent:** In a fork, any harness (Claude Code or Codex) loads one AP Labs rule set that routes each core stage to its skill and agent.
  - **success:** A fresh session given a T2 change request runs intake, produces BMAD stories, and stops at the plan gate.
- **CAP-2**
  - **intent:** Nine agents exist, each with tool access matched to its job.
  - **success:** Each definition exists, and a test asserts every agent's tool list (SQLsmith and Architect cannot run commands; Verifier and Refuter can; Scribe proposes only).
- **CAP-3**
  - **intent:** A governed repo (one with `.aplabs/profile.yml`) announces the Orchestrator at session start and never proceeds silently on an invalid profile.
  - **success:** Hook tests cover valid, invalid and missing profiles.
- **CAP-4**
  - **intent:** The main session cannot edit a governed repo until a specialist has engaged or the work is planned, except on profile-exempt paths.
  - **success:** Hook tests cover each allow and deny rule, including fail-open on hook errors.
- **CAP-5**
  - **intent:** Ceremony follows the computed tier: T0–T1 proceed and report; T2–T3 and onboarding builds need plan approval; T3 adds plan review.
  - **success:** Given a set of changed paths, the decision matches DESIGN §3a's table for every tier.
- **CAP-6**
  - **intent:** The profile's checks run deterministically at verify and at the end of each turn, and a skipped check never counts as passed.
  - **success:** Harness and Stop-hook tests cover pass, fail, skip and timeout; the Stop hook blocks only on a failed check.
- **CAP-7**
  - **intent:** Every PR outside the exemptions gets a read-only review from the other model under the P1/P2 rubric and the 3-round budget, with a labelled same-model fallback.
  - **success:** Script tests with a stubbed reviewer show round counting, refusal of a 4th round without an explicit go, P1-only from round 2, the same-file-twice flag, and `Review rounds: n/3` written to the PR body.
- **CAP-8**
  - **intent:** A P1 finding blocks only when the Refuter reproduces it.
  - **success:** A P1 the Refuter cannot reproduce is recorded as not blocking.
- **CAP-9**
  - **intent:** An onboarding build turns discovery into the client files SQLsmith, Architect and Connector load, plus the org-context document, each known truth backed by a check and a named client sign-off.
  - **success:** An onboarding run on the Brightside fixture produces those files, and every known-truth check passes. The agent is built in the Orchestrator phase; this proving run happens in the fixture phase.
- **CAP-10**
  - **intent:** A client profile switches on add-on stages (dev-environment test, dark launch with flag flip, batch review queue) without removing a core stage.
  - **success:** The profile schema accepts each add-on, and the rules layer places it between the right core stages.
- **CAP-11**
  - **intent:** Every build leaves a ledger record, and a retro measures merged PRs against the budgets.
  - **success:** The retro script prints a per-PR table (Kind, review rounds, commits) from merged PRs and flags each budget breach.

## Constraints

- Node 20 and bash. Hooks are thin bash wrappers over Node; hooks fail open, libraries fail closed.
- Deterministic checks are required. No LLM self-review loops.
- BMAD 6.12.4 and p3-stack `09909eb` stay unmodified (p3 path fixes excepted). Overrides live in our docs and rules layer.
- One rules file: `AGENTS.md`, imported by `CLAUDE.md`.
- Client specifics come only from `.aplabs/` (profile and client files), which always floors at T3. Tests read fixtures, never a client path.
- Agents never read or print secrets. The production gate is server-side, never only an in-session hook.
- Harvested code carries no Hometown specifics: names, paths, Slack ids, data.
- Hooks ship as repo-local config inside each fork (`.claude/settings.json`, `.codex/hooks.json`), not as a separately versioned plugin.
- Client files live in `.aplabs/context/{org,data,guardrails,connectors}.md`.
- Review budget: 3 rounds per PR. P1 means data loss or corruption, a broken auth or safety invariant, or a broken main path for today's data. Codex is the default reviewer.

## Non-goals

- Runtime blocks: the Slack app, connectors, archetypes, the fixture itself.
- The FAST-lane prompt classifier.
- Review queue, auto-merge dispatch, and the production release controller.
- Windows-native hooks.
- The Leadership Panel.
- Telemetry and cost metering.
- Real client canon.

## Success signal

- In a fresh fork configured for Brightside, a builder asks for a T2 change. Without hand-wiring: intake runs, BMAD produces stories, edits are blocked until approval, the Builder implements through the p3 feature playbook, verify runs, Codex reviews within budget, and the PR opens carrying `Kind:` and `Review rounds:` lines.

## Assumptions

- Agents are Claude Code subagent files (`.claude/agents/`). Codex gets the roles through `AGENTS.md` and T3 `delegate_task`.
- The ledger lives in `docs/ledger.md`, in Varsity's row and DEP format.
