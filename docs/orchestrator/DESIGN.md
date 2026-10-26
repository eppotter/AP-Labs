# The AP Labs Orchestrator: design

Status: decided where marked, open where marked · 2026-10-23 · Owner: Ely Potter

The Orchestrator is how we build on the template, and how the client's builders keep building after we leave. It is the scaffolding we build first: every later block is built through it.

It generalises two working systems:

- **The reference platform's Orchestrator** (a reference client's build process): stages, two human gates, specialists, computed risk tiers, deterministic verify.
- **Ryan Iyengar's CanonCRM process**: p3-stack playbooks, cross-model review with hard budgets, a measured retro.

Scope and order of work: [ADR 0002](../adr/0002-engagement-starter-template.md), [ADR 0003](../adr/0003-orchestrator-tooling.md), [PLAN-v1](../PLAN-v1.md).

## 1. Principles (decided)

- **The main session is the Orchestrator.** It scopes, routes to specialists, brings one plan to the gate, and drives the rest. It does not write production code itself.
- **Hub and spoke.** Specialists report only to the Orchestrator. They never talk to each other or the human.
- **One session per build.** The Orchestrator runs every stage, intake through retro, in a single session. It never hands a stage to a fresh session (this overrides BMAD's fresh-context advice). Heavy stages such as BMAD planning, reviews and research run in delegated subagents that return summaries, so the main session's context stays lean.
- **Each agent's tools match its job.** For example, SQLsmith reads but cannot run anything, the Refuter can run code to disprove a finding, and Scribe proposes doc changes rather than writing them on its own.
- **Deterministic checks are required. LLM self-review loops are forbidden.**
- **Soft front, hard back.** Planning is the model following instructions. The teeth are hooks, scripts, CI and server-side protection. Say which is which.
- **Rules become structure.** A rule that gets ignored becomes a script or a check, not more prose.
- **Iteration-first.** Ship the smallest thing that works, name the seams for the next version, and say every deferral out loud.

## 2. Roles (decided)

| Agent | Job | Trained per client? |
|---|---|---|
| **Orchestrator** (main thread) | Intake, risk tier, reuse check, routing, one plan, drives build → ship | No |
| **Onboarder** | Onboarding builds only. Runs discovery and writes the client files that SQLsmith, Architect and Connector load | No (it does the training) |
| **SQLsmith** | Data correctness: tables, grain, joins, timezones, reconciliation. Ships as a blank slate | Yes, by the Onboarder |
| **Architect** | Guardrails, blast radius, "no new shared infrastructure built inline" | Yes, by the Onboarder |
| **Connector** | The canonical way to integrate each client system: auth, read vs write paths | Yes, by the Onboarder |
| **Builder** | Executes the approved plan, story by story | No |
| **Scribe** | PRDs, docs, the ledger, and the client's org-context document | No |
| **Verifier** | Runs the deterministic checks and reports evidence. Never judges | No |
| **Refuter** | Tries to disprove every blocking review finding before it counts | No |

**Removed:** the reference platform's Leadership Panel (seven business-unit personas). It was rarely used.

**Roster:** each agent above except the Orchestrator is a file in [`.claude/agents/`](../../.claude/agents/). `test/unit/agents.test.js` pins the roster and every agent's tool list, so changing either is a design change.

## 3. Two kinds of build (decided)

**Regular build:** a feature, fix or change. The Onboarder is not involved. The specialists load the client's files.

**Onboarding build:** at engagement start, and again whenever the client connects a new system or data source (scoped to that slice). The Onboarder:

1. Runs discovery with the client's people and systems. It absorbs the Discovery Guide role and rule cards from [`reference/05-discovery-process.md`](../reference/05-discovery-process.md).
2. Writes the client files:
   - **SQLsmith:** data model, approved tables, join patterns, known truths, terminology, deprecated sources.
   - **Architect:** guardrails, protected systems, write paths, approvers. Most of this is the profile (`.aplabs/profile.yml`).
   - **Connector:** each system, how it authenticates, read vs write paths, rate limits.
3. **Checks every known truth against the client's own numbers.** Example: "last month's revenue from our query = $412,300, matching the finance report". Each check is a deterministic test, not a judgement.
4. Gets each piece signed off by a named client owner.

Scribe drafts the **org-context document** (what the company does, its teams, its tools) from the Onboarder's findings, and keeps it current on regular builds. Every agent reads it.

After onboarding, canon grows the way it did on the reference platform: regular builds and incidents add rules, Scribe proposes them, a human approves.

File locations are open (§8). They will sit under `.aplabs/`, which always floors at T3, because every agent trusts these files.

## 3a. Stages and ceremony (decided)

**A simple core that every build runs, plus add-ons a client switches on.** The reference platform's 0–12 map grew to fit its client. Client builders need something they can learn in a day.

| # | Core stage | What happens |
|---|---|---|
| 1 | Intake | Scope, computed risk tier, reuse check |
| 2 | Spec | BMAD PRD or spec |
| 3 | Plan approval | BMAD phases and stories. **Human gate** (subject to the ceremony table below) |
| 4 | Build | p3 feature or bug-fix playbook, story by story |
| 5 | Verify | Deterministic checks and the Stop hook |
| 6 | Review | Cross-model review and the Refuter (§5) |
| 7 | Ship | PR and merge. **Production gate**, server-side |
| 8 | Retro | Measured against the budgets |

**Add-ons, switched on in the client's profile:**
- a dev-environment test before production
- a dark launch with a separate flag-flip release
- a batch review queue

Each add-on slots between two core stages and never removes one. The batch review queue and then the dev-environment test run between Review and Ship; the dark launch runs after Ship (ship dark, then a separate human-attested flag flip) and before Retro.

**Ceremony by computed tier:**

| Tier | Plan gate | Extra |
|---|---|---|
| T0 (inert docs) | Skipped: the agent decides, builds and reports | |
| T1 (low risk, dark or new code) | Skipped: the agent decides, builds and reports | |
| T2 (live paths) | **Required** | Architect reviews the design |
| T3 (data, writes, guardrails, the profile) | **Required** | Architect plus BMAD plan review (edge-case hunter, adversarial) |
| Onboarding build | **Always required**, at any tier | Client owner signs off the canon |

"Decide and report" means the agent applies a sensible default on reversible calls, builds, and says what it chose and what you could tell it to do instead. Review (§5) and the production gate apply at every tier.

## 4. Tooling: BMAD plans, p3 builds (decided)

Both are installed off the shelf at pinned versions and are not modified. Our rules layer decides when each is used. Where both offer a skill for the same step, the one below wins and the other is not routed to.

| Stage | Driver | BMAD | p3-stack |
|---|---|---|---|
| Onboarding build | Onboarder | `bmad-architecture` (documents an existing codebase), `bmad-deep-recon` (research), `bmad-project-context` (agent instructions) | `how` |
| 1. Intake | Orchestrator | `bmad-product-brief` (large asks only) | |
| 2. Spec | Orchestrator, Scribe | `bmad-prd` (new module; also validates), `bmad-spec` (small change) | |
| 3. Design | Architect | `bmad-architecture` | |
| 4. Phases and stories | Orchestrator | `bmad-create-epics-and-stories` (epics = phases, stories = PRs), `bmad-sprint-planning` (readiness check + sprint status) | |
| 5. Plan review (high risk) | Architect | `bmad-review` (adversarial and edge-case lenses, on the plan) | |
| **Plan-approval gate** | **Human** | | |
| 6. Build each story | Builder | | `p3-mode` → `feature` / `bug-fix` playbooks, `architect` (code-level design), `tdd` |
| 7. Verify | Verifier | | prove-it-works; plus our verify harness and Stop hook |
| 8. Review | Other model, Refuter | | `interrogate` (contested designs only); cross-model review, §5 |
| 9. Ship | Orchestrator | | `opening-a-pr`, `shipping`, `babysit` |
| **Production gate** | **Human** (server-side) | | |
| 10. Retro | Orchestrator | | `npm run retro` (our port of CanonCRM's retro script; upstream p3 has no retro playbook), measured against the budgets |
| Scope change mid-program | Orchestrator | `bmad-correct-course` | |

**Not routed to:**
- BMAD's build, review and retro skills (`bmad-build`, `bmad-build-auto`, `bmad-code-review`, `bmad-retrospective`). p3's build playbooks, our cross-model review and `npm run retro` are used instead.
- BMAD's persona agents and creative skills (`bmad-agent-*`, `bmad-party-mode`, `bmad-brainstorming`, `bmad-forge-idea`, `bmad-prfaq`).
- p3's experimental extras (`arena`, `swarm`, `bro`).

**Pinned versions:** BMAD `6.12.4` (modules `core` + `bmm`, installed for Codex into `.agents/skills/`) and p3-stack `09909eb` (vendored, see `.agents/p3-stack/README.md`). `.claude/skills` is a symlink to `.agents/skills/`, so Claude Code, Codex and T3 read one copy. BMAD writes its planning documents to `docs/planning/`.

**Naming:** BMAD is MIT-licensed but its name is trademarked. Never use it in AP Labs branding.

## 5. Review: cross-model by default (decided)

Adapted from CanonCRM (`docs/agent-coordination.md` §5 and its p3 adapter).

- **The other model reviews.** If Claude wrote it, Codex reviews (scripted, read-only sandbox). If Codex wrote it, Claude reviews (read-only CLI: Read, Glob and Grep only). The reviewer never pushes to the author's branch.
- **Fallback when the client has no Codex:** a fresh, read-only Claude session with no shared context reviews instead. The PR body says `Review: same-model fallback`, because it is less independent. **Codex is part of the standard engagement setup**; the fallback is the exception.
- **Rubric:**
  - **P1, blocks the merge:** loses or corrupts data, breaks auth, permissions or a safety invariant, or breaks the main path the PR delivers for today's data and usage.
  - **P2, everything else:** goes into one `review-followup` issue per PR.
- **The Refuter checks every P1** before it counts. A P1 nobody can reproduce does not block.
- **Budget: 3 rounds per PR, enforced by the review script.** From round 2 onward, the reviewer reports P1s only. Fixes are batched between rounds.
- **Same class twice, stop patching.** Two consecutive rounds blocking on the same premise → restructure so the class can't occur, or cut it from scope. Still blocking after 3 rounds → split, shrink or park the PR. A 4th round needs the human's explicit go.
- **Exempt:** docs only, config changes of 10 lines or fewer, and reverts.
- **The PR body records** `Kind: user-visible|groundwork|fix|infra|docs`, `Review rounds: n/3` and the reviewed head SHA. The retro reads those lines.
- **Cost:** a small read-only Codex review measured about 100k input tokens at CanonCRM. Budget for it in the client's subscriptions.

## 6. Gates and enforcement (decided in principle)

- **Two human gates:** plan approval (§4) and production. The production gate is enforced server-side (branch protection or a release controller), never by an in-session hook alone.
- **In-session hooks:**
  - session start: banner and checks
  - write gate: no edit until a specialist has engaged or the work is planned
  - Stop hook: runs verify at the end of a turn
- **Risk tier is computed from the files touched** (`kit/lib/tier`) and decides how much ceremony runs.
- **Secrets:** agents never read or print them. Commands that need production credentials are run by a human.

**Merge authority depends on who runs the session.** When the human driving it is an approver for the repo, the Orchestrator merges a PR itself once review shows nothing blocking and CI passes. When anyone else drives, the Orchestrator stops at PR-ready, posts a decision notice that @-mentions the approver, and waits for them. The reference platform used the same idea: an approver fast path, with everyone else going through the approver gate.

## 7. Learning loop (decided)

- **A ledger row per build,** plus `DEP` rows for anything deferred or blocked. Missing shared infrastructure is routed to its owner, never built inside a feature. The ledger is `docs/ledger.md` (its intro, the older rows and the `DEP` table) plus one build file per build, `docs/ledger/builds/<branch>.md`, holding that build's one row, so two open PRs never conflict over the ledger. CI's `scripts/ledger-check.js` fails a pull request that adds no row unless it is docs-only, and one that deletes a build file, edits another PR's, reuses a branch name or adds a row in two places. `npm test` re-checks every row together, and CI runs on every push to `main`, so two PRs that clash only together show on the next run. A story PR never edits the sprint status; the Orchestrator refreshes it once per epic, in a docs-only PR.
- **A measured retro** at each phase boundary, after every 5 merged PRs, and when a PR exhausts its review budget. Each breach becomes a rule edit or a structural check.

The measurement is `npm run retro -- --since YYYY-MM-DD` (or `--prs 11,12,14` for a named set; `--json` for the raw result). Run it at each epic boundary, after every 5 merged PRs, and when a PR exhausts its review budget. It reads merged PRs through `gh` and prints one row per PR from the lines the review script writes (Kind, review rounds, fallback or exemption), plus commits and hours from open to merge. Under the table it flags each breach: more than 3 review rounds, a `Review stop:` line, fix PRs above 25% of PRs with a known Kind, and a reviewed PR with no Kind line. PRs with none of the review lines predate the tooling: they are listed but never counted as breaches.

## 8. Open

| Question | Options | Owner |
|---|---|---|
| Client file locations | e.g. `.aplabs/context/{org,data,guardrails,connectors}.md` | Claude to propose |
| Codex fallback check | Whether the same-model fallback is good enough in practice | Measure on the first engagement |
