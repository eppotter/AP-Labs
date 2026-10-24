# Retro: Epic 6 (the Slack app and its hubs)

Run at the Epic 6 boundary, 2026-10-24, with `npm run retro -- --prs 55,62,67,69,70,72,74`.

| PR | Kind | Rounds | Title |
|---|---|---|---|
| #55 | user-visible | 3/3 | Story 6.1: the bot answers in Slack |
| #62 | user-visible | 1/3 | Story 6.2: a hub menu built from the registry |
| #67 | user-visible | 1/3 | Story 6.3: access by profile |
| #69 | infra | 1/3 | Retro (runtime 1): conflict-marker check |
| #70 | user-visible | 1/3 | Story 7.5: the query runner and the Dataset entry |
| #72 | user-visible | 1/3 | Story 6.4: welcome and help |
| #74 | groundwork | 1/3 | Story 6.5: the module template and the clean-bones CI job |

7 PRs, no budget breaches, no fix PRs. #55's three rounds were already covered in `retro-runtime-1.md` (the Node 24 move).

## What happened

- Every story after 6.1 passed review in one round. The new `clean-bones` CI job passed on its first PR (#74).
- **Lesson: parallel builders on one engine file.** Stories 6.3, 7.5 and 6.4 ran in parallel, and all three edited `kit/runtime/slack/hubs.js`. The Orchestrator hand-merged it twice (into #70 and #72). Both merges were tested, and #70's was checked by the architect. Hand-merging production code is still Builder work in the Orchestrator's seat, and each merge risks dropping one side.
  - **Rule:** before running two stories in parallel, compare the files each will touch. If both edit the same engine file, run them one after the other, or brief the later builder to merge main and resolve the conflict itself before it reports. Added to `AGENTS.md`, build loop step 1.

## Open

- #68 (Ely): access code tiers at T1.
- Follow-ups: #66, #71, #73.
- Live Slack checks wait on Ely: the bot tokens, and the `team_join` event.
