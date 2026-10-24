# Epic 1 retro: Independent review

Date: 2026-10-24 · Stories 1.1–1.4 (#11, #12, #14, #17) · Run by the Orchestrator during Ely's autonomous build window

## Measured (`npm run retro -- --prs 11,12,14,17`)

| PR | Kind | Rounds | Reviewer | Commits | Hours | Fix | Title |
|---|---|---|---|---|---|---|---|
| #11 | infra | 2/3 | — | 2 | 0.1 | no | Story 1.1: npm run review, one budgeted Codex round per call |
| #12 | infra | 1/3 | — | 1 | 0.0 | no | Story 1.2: Claude reviews Codex-written work, with a same-model fallback |
| #14 | infra | 3/3 | same-model fallback | 3 | 0.2 | no | Story 1.3: review triage, follow-up issues, exemptions, same-cause stop |
| #17 | infra | 2/3 | — | 2 | 0.1 | no | Story 1.4: the Refuter must reproduce a P1 before it blocks |

No budget breaches.

4 PRs (4 reviewed by the tooling, 0 pre-tooling); 0 fix of 4 with a known Kind (0%); 0 breach(es).

## What happened

- **Cross-model review paid for itself.** Round 1 on #11 exposed a parser bug that silently dropped findings. Claude's round 2 on #14 found a second way to forge a revert exemption. Codex's round 1 on #17 found that an unfixed blocker could vanish between rounds. All three were fixed before merge.
- **Reviewers can be wrong.** Codex claimed a module didn't exist (#20). It did, and the claim was disproved and closed. This is the Refuter's job, built in Story 1.4.
- **The brief can be the bug.** I specified the revert exemption by commit title. The Builder flagged it as forgeable, and both reviewers missed it. Lesson: read the Builder's risk section as a review input.
- **Scope creep by a builder.** The Codex builder on 1.2 started Story 1.3 unasked and left uncommitted edits. Briefs now end with "stop after reporting; never start another story".
- **The reviewer's phrasing defeated the parser.** Codex wrote "no new blocking issues", which forced Claude fallbacks on #14 rounds 2–3. Fixed in #17; the looser pattern's false-positive risk is tracked in #15.
- **Process failure outside Epic 1 (#19):** I merged with CI red. Fixed in #21, and merges are now gated on the CI check's exit status.

## Actions

| Action | Owner | Where |
|---|---|---|
| Builder briefs end with the stop rule; verify the worktree's branch and `git status` before review | Orchestrator | Story 2.3 rules layer |
| Merges are gated on CI and on the reviewed head equalling the merge head. Script it (`npm run land`) instead of relying on discipline | Orchestrator | Proposed new story (Epic 1 follow-up) |
| Watch `isClean` for false "clean" reads | Orchestrator | #15 |
