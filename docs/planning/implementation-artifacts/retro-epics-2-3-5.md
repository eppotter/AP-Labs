# Retro: Epics 2, 3 and 5, plus Story 1.5

Date: 2026-10-24 · Run by the Orchestrator during Ely's autonomous build window · `npm run retro` per epic

## Measured

=== Epic 2
| PR | Kind | Rounds | Reviewer | Commits | Hours | Fix | Title |
|---|---|---|---|---|---|---|---|
| #26 | infra | 1/3 | — | 2 | 0.0 | no | Story 2.2: the agent roster, each with only the tools its job needs |
| #27 | infra | 1/3 | — | 2 | 0.0 | no | Story 2.1: the session announces the Orchestrator and checks the profile |
| #28 | infra | 1/3 | — | 2 | 0.0 | no | Story 2.3: the rules layer routes every stage |
| #29 | infra | 1/3 | — | 2 | 0.0 | no | Story 2.4: the write gate |
| #30 | infra | 1/3 | same-model fallback | 2 | 0.0 | no | Story 2.6: clients switch on add-on stages |
| #35 | infra | 1/3 | — | 4 | 0.0 | no | Story 2.5: plan approval scales with the computed tier |

No budget breaches.

6 PRs (6 reviewed by the tooling, 0 pre-tooling); 0 fix of 6 with a known Kind (0%); 0 breach(es).
=== Epic 3
| PR | Kind | Rounds | Reviewer | Commits | Hours | Fix | Title |
|---|---|---|---|---|---|---|---|
| #23 | infra | 1/3 | — | 2 | 0.0 | no | Story 3.1: the verify harness runs the profile's checks |
| #37 | infra | 1/3 | — | 3 | 0.0 | no | Story 3.2: the end-of-turn hook runs verify |

No budget breaches.

2 PRs (2 reviewed by the tooling, 0 pre-tooling); 0 fix of 2 with a known Kind (0%); 0 breach(es).
=== Epic 5
| PR | Kind | Rounds | Reviewer | Commits | Hours | Fix | Title |
|---|---|---|---|---|---|---|---|
| #16 | infra | 1/3 | — | 1 | 0.1 | no | Story 5.3: npm run notify, Slack progress updates |
| #19 | infra | 1/3 | — | 2 | 0.0 | no | Story 5.2: npm run retro, the measured retro |
| #33 | infra | 1/3 | — | 4 | 0.0 | no | Story 5.1: a ledger row for every build |

No budget breaches.

3 PRs (3 reviewed by the tooling, 0 pre-tooling); 0 fix of 3 with a known Kind (0%); 0 breach(es).
=== Epic 1.5
| PR | Kind | Rounds | Reviewer | Commits | Hours | Fix | Title |
|---|---|---|---|---|---|---|---|
| #39 | infra | 1/3 | — | 3 | 0.0 | no | Story 1.5: npm run land merges only what is verified |

No budget breaches.

1 PRs (1 reviewed by the tooling, 0 pre-tooling); 0 fix of 1 with a known Kind (0%); 0 breach(es).

## What happened

- **Every story landed in one review round.** The VERDICT line (#32) ended the Codex paraphrase fallbacks; the only fallback after it was #30, the round just before that fix.
- **Reviewers were wrong twice and right several times.** False claims, disproved and closed: #20 (a module "missing") and #38 (a "removed export" nobody imports). Real findings: #22 (my shellcheck block in the wrong place), #34 (duplicate ledger tables), #36 (a reused plan review), #40 (repeated exempt lines). The Refuter role earns its place even for P2s.
- **Parallel builders worked, at the cost of merge conflicts.** Up to five Opus builders ran at once. Conflicts were confined to `package.json` scripts, the hook settings, and tests asserting the exact hook list. All were resolved by merging `main` in and keeping both sides.
- **Design calls made autonomously** (all posted to Slack):
  - `npm run engage` as a second engagement-marker writer
  - profile edits allowed while the profile is invalid
  - Codex matcher `*`
  - plan approvals recorded by a UserPromptSubmit hook in the git common dir
  - blocking the end of a turn on any failing check (DEP-008)
- **#19 merged with CI red, and `npm run retro` cannot see it.** The retro only reads PR bodies, not each PR's CI state at merge. `npm run land` (#39) now prevents a repeat structurally, but the retro should also flag it if it ever happens.

## Actions

| Action | Owner | Where |
|---|---|---|
| Teach `npm run retro` to flag a PR merged while a check was failing | Orchestrator | New DEP |
| Prove the Codex hook formats in a live, trusted Codex session | **Ely** + Orchestrator | DEP-005, DEP-007 |
| Watch whether blocking turn-ends on red checks slows builders | Orchestrator | DEP-008 |
| Clear the small P2 follow-ups in one hardening pass after Epic 4 | Orchestrator | #13, #15, #24, #31, #34, #36, #40 |
