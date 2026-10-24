# Retro: runtime phase, first stretch (PRs #42–#67)

Date: 2026-10-24 · Run by the Orchestrator after Story 6.3 merged · `npm run retro -- --prs 42,44,46,48,50,51,52,53,55,57,59,60,62,64,65,67`

## Measured

| PR | Kind | Rounds | Reviewer | Commits | Hours | Fix | Title |
|---|---|---|---|---|---|---|---|
| #42 | infra | 1/3 | — | 3 | 0.0 | no | Story 4.1: onboarding build and the client files |
| #44 | infra | 1/3 | — | 2 | 0.0 | no | Story 4.2: known truths come with checks |
| #46 | fix | 1/3 | — | 3 | 0.0 | yes | Hardening: review and land follow-ups (#13, #15, #40) |
| #48 | fix | 1/3 | — | 3 | 0.0 | yes | Hardening: gate, ledger, stages, truths and verify follow-ups (#24, #31, #34, #36, #45) |
| #50 | docs | — | exempt (docs only) | 6 | 0.0 | no | Runtime phase plan (spec, architecture, 29 stories) for approval |
| #51 | docs | — | exempt (docs only) | 1 | 0.0 | no | Plan: clean-bones check and template releases into client forks |
| #52 | docs | — | exempt (docs only) | 1 | 0.0 | no | Runtime-phase plan approved |
| #53 | groundwork | 1/3 | — | 2 | 0.0 | no | Story 7.1: a deterministic generator writes Brightside's reference tables |
| #57 | infra | 1/3 | same-model fallback | 3 | 0.0 | no | Move the template to Node 24 LTS (ADR 0004) |
| #55 | user-visible | 3/3 | — | 6 | 0.3 | no | Story 6.1: the bot answers in Slack |
| #59 | groundwork | 1/3 | — | 3 | 0.0 | no | Story 7.2: Brightside's plans, visits, invoices and payments |
| #60 | groundwork | 1/3 | — | 2 | 0.0 | no | Story 7.3: the fixture builds into a local DuckDB, offline |
| #62 | user-visible | 1/3 | — | 3 | 0.0 | no | Story 6.2: a hub menu built from the registry, with a hello-world module |
| #64 | fix | 1/3 | — | 2 | 0.0 | yes | Fix: profiles tier at T3; review parser accepts 'no defects' wording |
| #65 | groundwork | 1/3 | — | 3 | 0.0 | no | Story 7.4: SQL guardrail |
| #67 | user-visible | 1/3 | — | 4 | 0.0 | no | Story 6.3: access by profile |

No budget breaches.

16 PRs (16 reviewed by the tooling, 0 pre-tooling); 3 fix of 16 with a known Kind (19%); 0 breach(es).

## What happened

- **One PR used its whole review budget.** #55 (Story 6.1) took 3/3 rounds, but not for its code: CI on Node 20 failed because Slack Bolt pulls in undici 8, which needs a newer Node. #57 moved the template to Node 24 LTS (ADR 0004) and #55 went green on it. #57 itself was reviewed by the same-model fallback.
- **Three fix PRs (19%).** #46 and #48 cleared the P2 follow-ups the last retro queued. #64 fixed two things found mid-phase: profiles tiering too low, and Codex verdict wording the parser missed.
- **Lessons, each paired with the rule or check it became:**
  - (a) **Conflict markers were committed** into `package.json` during the Story 6.2 merge-main step. Now `npm run check` runs `scripts/check-conflict-markers.js`, which fails on any tracked file holding a marker (vendored skills excluded; a lone `=======` only counts inside a conflict block, so setext headings pass).
  - (b) **Fresh worktrees have no `node_modules`,** and the DuckDB tests failed with a confusing module-not-found error. The fixture-build tests now fail first with "run npm ci".
  - (c) **`profiles/**` tiered below T3,** so profile edits that change access got light review. Fixed in #64.
  - (d) **Access code still tiers at T1:** `kit/runtime/access` and `kit/lib/profile` decide who sees what but are not in the profile's T3 paths. Open as issue #68; it changes the profile, so it needs Ely's decision.
  - (e) **Codex verdict wording slipped past the parser** ("no defects", "no problems", "no bugs"). Fixed by #64's widening of `isClean`.
  - (f) **`npm test` now takes about 2.5 minutes,** longer than the default 2-minute agent shell timeout, so runs were cut off and looked like failures. `AGENTS.md` Rules now say to give it 400000 ms or more.

## Actions

| Action | Owner | Where |
|---|---|---|
| Decide whether access code (`kit/runtime/access`, `kit/lib/profile`) tiers at T3 | **Ely** | #68 |
| Conflict-marker check in `npm run check` | Orchestrator | This PR |
| Fixture-build tests fail with "run npm ci" when deps are missing | Orchestrator | This PR |
| `npm test` timeout rule in `AGENTS.md` | Orchestrator | This PR |
