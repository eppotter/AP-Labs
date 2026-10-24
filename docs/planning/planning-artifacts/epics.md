---
status: final
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - docs/planning/specs/spec-orchestrator/SPEC.md
  - docs/orchestrator/DESIGN.md
  - docs/planning/specs/spec-orchestrator/harvest-map.md
---

# AP-Labs - Epic Breakdown: the Orchestrator

## Overview

This document breaks the Orchestrator spec (`SPEC.md`, standing in for a PRD) and its design (`DESIGN.md`, standing in for the architecture) into implementable epics and stories. Each epic is one build phase. Each story is one PR.

## Requirements Inventory

### Functional Requirements

- FR1: In a fork, Claude Code or Codex loads one AP Labs rule set that routes each core stage to its skill and agent. (CAP-1)
- FR2: Nine agents are defined with tool access matched to their jobs, and a test pins each tool list. (CAP-2)
- FR3: A governed repo (one with `.aplabs/profile.yml`) announces the Orchestrator at session start and refuses to proceed silently on an invalid or missing profile. (CAP-3)
- FR4: The write gate blocks main-session edits until a specialist has engaged or the work is planned. Paths exempted by the profile are allowed; a hook error allows the edit (fail-open). (CAP-4)
- FR5: Ceremony follows the computed tier: T0–T1 proceed and report; T2–T3 and onboarding builds need plan approval; T3 adds plan review. (CAP-5)
- FR6: The verify harness runs the profile's checks (argv, no shell, env allowlist, timeout); a skip never counts as passed; the Stop hook blocks only on a failed check. (CAP-6)
- FR7: Cross-model review: the P1/P2 rubric, round counting, refusal of a 4th round without an explicit go, P1-only from round 2, the same-file-twice flag, a `Review rounds: n/3` PR line, and a labelled same-model fallback. (CAP-7)
- FR8: A P1 blocks only when the Refuter reproduces it. (CAP-8)
- FR9: The Onboarder writes the client files for SQLsmith, Architect and Connector, plus the org-context doc, each known truth backed by a check and a client sign-off. It is proven on Brightside in the fixture phase. (CAP-9)
- FR10: Add-on stages enabled in the profile slot between core stages without removing any. (CAP-10)
- FR11: Every build leaves a ledger row, and a retro script measures merged PRs against the budgets. (CAP-11)

### NonFunctional Requirements

- NFR1: Node 20 and bash. Hooks are thin bash wrappers over Node.
- NFR2: Hooks fail open; libraries fail closed.
- NFR3: Deterministic checks are required. No LLM self-review loops.
- NFR4: BMAD 6.12.4 and p3-stack `09909eb` stay unmodified (p3 path fixes excepted).
- NFR5: One rules file, `AGENTS.md`, imported by `CLAUDE.md`.
- NFR6: Client specifics come only from `.aplabs/`, which always floors at T3. Tests read fixtures.
- NFR7: Agents never reach secrets. The production gate is server-side.
- NFR8: No Hometown specifics in harvested code.
- NFR9: Hooks ship as repo-local config in each fork (`.claude/settings.json`, `.codex/hooks.json`), not as a plugin.
- NFR10: Review budget of 3 rounds per PR; Codex is the default reviewer.
- NFR11: One session runs every stage of a build; heavy stages are delegated to subagents that return summaries, never to fresh sessions.

### Additional Requirements

- Reuse `kit/lib/profile`, `kit/lib/permissions` and `kit/lib/tier` (built in #3–#5).
- Replace the stub `kit/verify/run-all.sh`.
- Client files go in `.aplabs/context/{org,data,guardrails,connectors}.md`.
- The ledger goes in `docs/ledger.md`, in Varsity's row and DEP format.
- Stage routing follows DESIGN §4. Ceremony follows DESIGN §3a.
- PR bodies carry `Kind:` and `Review rounds:` lines.
- Review exemptions: docs only, config changes of 10 lines or fewer, reverts.
- Prior art for each capability is listed in `harvest-map.md`.

### UX Design Requirements

None. The Orchestrator has no UI beyond session messages.

### FR Coverage Map

- FR1: Epic 2 - one rule set routes stages to skills and agents
- FR2: Epic 2 - nine agents with pinned tool lists
- FR3: Epic 2 - session-start banner and profile check
- FR4: Epic 2 - write gate
- FR5: Epic 2 - ceremony by computed tier
- FR6: Epic 3 - verify harness and Stop hook
- FR7: Epic 1 - cross-model review with budgets
- FR8: Epic 1 - Refuter gate on P1
- FR9: Epic 4 - onboarding build
- FR10: Epic 2 - add-on stages
- FR11: Epic 5 - ledger and measured retro

## Epic List

### Epic 1: Independent review
Every PR gets a bounded review from the other model (Codex by default, Claude as fallback), with the P1/P2 rubric, a 3-round budget, the same-cause stop, and the Refuter reproducing each P1 before it blocks. Built first, so every later Orchestrator PR uses it.
**FRs covered:** FR7, FR8

### Epic 2: Guided, governed build
A builder opens a fork and gets the Orchestrator: a session banner and profile check, intake, BMAD planning, the write gate, plan approval by tier, the nine agents, and profile-enabled add-on stages.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR10

### Epic 3: Changes prove themselves
The profile's checks run deterministically at verify and at the end of each turn, and a skipped check never counts as passed.
**FRs covered:** FR6

### Epic 4: Client onboarding
An onboarding build turns discovery into checked, client-signed files that SQLsmith, Architect and Connector load, plus the org-context doc. It is proven on Brightside in the fixture phase.
**FRs covered:** FR9

### Epic 5: Memory and retro
Every build leaves a ledger record, and a retro measures merged PRs against the budgets.
**FRs covered:** FR11

## Epic 1: Independent review

Every PR gets a bounded review from the other model (Codex by default, Claude as fallback), with the P1/P2 rubric, a 3-round budget, the same-cause stop, and the Refuter reproducing each P1 before it blocks. Built first, so every later Orchestrator PR uses it. Node 20 has no TypeScript stripping, so CanonCRM's `codex-review.ts` is ported to JS. CI never calls a real model.

### Story 1.1: Codex reviews a Claude-written PR within budget

**Implements:** FR7

As an AP Labs builder,
I want one command that has Codex review my PR read-only under the P1/P2 rubric,
So that every change gets an independent check that cannot loop forever.

**Acceptance Criteria:**

**Given** an open PR on the current branch
**When** I run `npm run review`
**Then** Codex runs read-only with stdin closed against `origin/main...HEAD` with the rubric, and only the verdict is printed
**And** with no open PR it refuses and says to open a draft first

**Given** round 2 or 3
**When** the review runs
**Then** the prompt asks for P1 findings only and lists earlier rounds' findings

**Given** 3 rounds used on the branch
**When** a 4th is requested
**Then** it is refused unless `--over-budget "<the human's reason>"` is passed
**And** the PR body carries `Review rounds: n/3` and the reviewed head SHA; the round state persists per branch outside tracked files
**And** tests cover every case above with a stub reviewer

### Story 1.2: Claude reviews Codex-written work, with a no-Codex fallback

**Implements:** FR7

As an AP Labs builder,
I want the reviewer always to be the other model, with a labelled fallback,
So that review independence holds even when a client has no Codex.

**Acceptance Criteria:**

**Given** the PR's commits carry an `Agent: codex …` trailer
**When** I run `npm run review`
**Then** the reviewer is a read-only Claude CLI (Read, Glob, Grep only; no shell, no MCP, no saved session)

**Given** Codex is not installed
**When** a Claude-written PR is reviewed
**Then** a fresh read-only Claude session reviews it and the PR body says `Review: same-model fallback`
**And** a failed or incomplete reviewer run counts neither as a round nor as a pass

### Story 1.3: Triage, follow-ups, exemptions and the same-cause stop

**Implements:** FR7

As an AP Labs builder,
I want findings sorted and non-blockers parked,
So that a PR fixes only what blocks it.

**Acceptance Criteria:**

**Given** a review verdict
**When** it is processed
**Then** findings split into P1 and P2, and all P2s go into one `review-followup` issue linked from the PR body

**Given** the same file draws a P1 in two consecutive rounds
**When** the second verdict is processed
**Then** the output says "same class twice: fix the premise" and the PR body records it

**Given** a docs-only PR, a config-only change of 10 lines or fewer, or a revert
**When** review is requested
**Then** it is skipped and the exemption reason is recorded
**And** every PR body carries a `Kind:` line

### Story 1.4: The Refuter must reproduce a P1 before it blocks

**Implements:** FR8

As an AP Labs builder,
I want each P1 tested before it blocks,
So that false alarms do not cost review rounds.

**Acceptance Criteria:**

**Given** P1 findings in a round
**When** triage runs
**Then** each P1 goes to a generic Refuter agent (`.claude/agents/refuter.md`; read and run, never edit) with the head SHA

**Given** a Refuter verdict
**When** it is recorded
**Then** *confirmed* blocks, *not reproduced* is recorded but does not block, and *cannot verify locally* is escalated to the human, never silently dropped
**And** verdicts are recorded per round, and tests cover all three outcomes

## Epic 2: Guided, governed build

A builder opens a fork and gets the Orchestrator: a session banner and profile check, intake, BMAD planning, the write gate, plan approval by tier, the nine agents, and profile-enabled add-on stages.

### Story 2.1: The session announces the Orchestrator and checks the profile

**Implements:** FR3

As a builder opening a fork,
I want the session to say it is governed and to check the client profile,
So that I never build against a broken setup unknowingly.

**Acceptance Criteria:**

**Given** a repo with `.aplabs/profile.yml`
**When** a Claude Code or Codex session starts
**Then** a banner names the Orchestrator, the client, and the core stages

**Given** an invalid profile
**When** the session starts
**Then** the banner lists every validation error and says the profile must be fixed before building
**And** with no profile the repo is ungoverned and the session stays silent
**And** hooks are repo-local (`.claude/settings.json`, `.codex/hooks.json`), thin bash over Node, and fail open
**And** tests cover valid, invalid and missing profiles with fixture repos

### Story 2.2: Nine agents with job-matched tools

**Implements:** FR2

As a builder,
I want the full agent roster defined generically,
So that the Orchestrator can route work on day one.

**Acceptance Criteria:**

**Given** `.claude/agents/`
**When** the roster is loaded
**Then** it holds Onboarder, SQLsmith, Architect, Connector, Builder, Scribe, Verifier and Refuter, with the main session as the Orchestrator
**And** a test pins each tool list (SQLsmith and Architect read only; Verifier and Refuter read and run; Builder edits; Scribe proposes)
**And** SQLsmith, Architect and Connector load `.aplabs/context/*` when present, say plainly when it is absent, and carry no Hometown canon

### Story 2.3: The rules layer routes every stage

**Implements:** FR1

As a builder,
I want one rule set that walks me from intake to ship,
So that every build follows the same path in any harness.

**Acceptance Criteria:**

**Given** a build request
**When** the session follows the `AGENTS.md` Orchestrator section
**Then** it asks the three intake questions, computes the tier, runs the reuse check, and routes each stage to its BMAD skill, p3 skill or agent per DESIGN §4
**And** a structural test fails when the rules name a skill or agent that is not installed
**And** the rules run every stage in the one session, delegating heavy stages (BMAD planning, reviews, research) to subagents that return summaries, and never tell the builder to start a fresh session

### Story 2.4: The write gate

**Implements:** FR4

As a builder,
I want edits blocked until work is routed,
So that nobody writes production code by accident before planning.

**Acceptance Criteria:**

**Given** a governed repo
**When** the main session attempts its first edit
**Then** it is denied with a plain-language reason
**And** an invalid profile (Story 2.1) also denies edits until it is fixed

**Given** a profile-exempt path, an edit inside a subagent, or an engagement marker written by the SubagentStart hook (never by the model)
**When** an edit is attempted
**Then** it is allowed
**And** a hook error allows the edit, every bypass is logged, and tests cover each allow and deny rule

### Story 2.5: Plan approval scales with the computed tier

**Implements:** FR5

As a builder,
I want small work to flow and risky work to wait for approval,
So that ceremony matches blast radius.

**Acceptance Criteria:**

**Given** an edit whose target tiers T0–T1
**When** a specialist has engaged
**Then** the edit is allowed and the session reports the calls it made

**Given** a T2–T3 target, or a plan declared `kind: onboarding`
**When** an edit is attempted
**Then** it is blocked until the human's own message in the session transcript contains `approve plan <slug>`
**And** a T3 plan also needs a `bmad-review` pass before the phrase is accepted
**And** tests cover each tier and the onboarding case

### Story 2.6: Clients switch on add-on stages

**Implements:** FR10

As a builder,
I want client-specific stages without changing the process,
So that each engagement can add a dev test, a dark launch or a review queue.

**Acceptance Criteria:**

**Given** `stages.addons` in the profile
**When** the profile loads
**Then** the schema accepts only `dev_test`, `dark_launch` and `review_queue`, and the resolved stage list slots each one between its core stages without removing any
**And** the banner (2.1) and the rules (2.3) show the resolved list, and tests cover each add-on

## Epic 3: Changes prove themselves

The profile's checks run deterministically at verify and at the end of each turn, and a skipped check never counts as passed.

### Story 3.1: The verify harness runs the profile's checks

**Implements:** FR6

As a builder,
I want the client's checks run the same way every time,
So that "done" means the checks actually ran.

**Acceptance Criteria:**

**Given** `verify.checks` in the profile
**When** I run `npm run verify`
**Then** each check runs in order as argv without a shell, from the repo root, with an env allowlist and a per-check timeout
**And** each reports pass, fail, skip (could not run) or timeout, and skip or timeout never counts as pass
**And** the last output line is a JSON summary; exit 0 ok, 1 a check failed, 2 usage; the stub `run-all.sh` is replaced
**And** tests cover pass, fail, skip and timeout with fixture profiles

### Story 3.2: The end-of-turn hook runs verify

**Implements:** FR6

As a builder,
I want checks to run automatically when a turn ends,
So that broken code is caught before anyone reviews it.

**Acceptance Criteria:**

**Given** a governed repo where the session changed files
**When** the turn ends
**Then** the harness runs and blocks the turn only on a failed check
**And** skip and timeout are reported, never blocked on and never treated as pass
**And** a per-person env variable opts out, and tests cover each outcome

## Epic 4: Client onboarding

An onboarding build turns discovery into checked, client-signed files that SQLsmith, Architect and Connector load, plus the org-context doc. Proven on Brightside in the fixture phase.

### Story 4.1: Onboarding build and the client files

**Implements:** FR9

As an AP Labs consultant,
I want an onboarding build that turns discovery into the files every agent loads,
So that the specialists start out knowing the client.

**Acceptance Criteria:**

**Given** an onboarding build request
**When** the Orchestrator routes it
**Then** the Onboarder runs discovery (rule cards per `docs/reference/05-discovery-process.md`, BMAD research and codebase skills) and writes `.aplabs/context/{data,guardrails,connectors}.md` from templates, while Scribe drafts `org.md`
**And** the plan gate always applies (Story 2.5), and every file records its client owner and sign-off date

### Story 4.2: Known truths come with checks

**Implements:** FR9

As an AP Labs consultant,
I want every data fact the Onboarder writes to carry a test against the client's own number,
So that SQLsmith never trusts an unchecked claim.

**Acceptance Criteria:**

**Given** a known truth in `data.md`
**When** verify runs
**Then** its query, expected value, tolerance and owner run as a verify check type (Story 3.1)
**And** a truth with no check, or a failing one, is flagged in the banner and blocks plan approval for data work
**And** tests use a fixture database

### Story 4.3: Prove onboarding on Brightside

**Implements:** FR9

As an AP Labs consultant,
I want onboarding proven on a realistic client,
So that we trust it before the first real engagement.

**Acceptance Criteria:**

**Given** the Brightside dataset exists (fixture phase)
**When** an onboarding build runs
**Then** all four context files are produced and every known-truth check passes
**And** this story is scheduled in the fixture phase, not the Orchestrator phase

## Epic 5: Memory and retro

Every build leaves a ledger record, and a retro measures merged PRs against the budgets.

### Story 5.1: A ledger row for every build

**Implements:** FR11

As a builder,
I want a record of every build and every deferral,
So that nothing deferred is lost.

**Acceptance Criteria:**

**Given** a PR
**When** CI runs
**Then** it fails unless the PR adds or updates a row in `docs/ledger.md`, or is exempt (docs-only or a revert)
**And** deferrals and blocked dependencies get `DEP-NNN` rows with an owner and status

### Story 5.2: The measured retro

**Implements:** FR11

As a builder,
I want the process measured against its own budgets,
So that rules tighten on evidence.

**Acceptance Criteria:**

**Given** a date range or PR list
**When** I run `npm run retro`
**Then** it prints a per-PR table (Kind, review rounds, commits, hours open, fix or not) from merged PRs and flags each budget breach
**And** the rules trigger a retro at each epic boundary and after every 5 merged PRs (ported from CanonCRM's `p3-retro.ts`)
