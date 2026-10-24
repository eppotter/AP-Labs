# Retro: Epics 7 and 8 (Brightside's data, and safe connections)

Run at the Epic 8 boundary, 2026-10-24, with `npm run retro -- --prs 76,78,79,80,83,86,88,91`. (#60, #65 and #70 from Epic 7 were covered in `retro-epic-6.md` and `retro-runtime-1.md`.)

| PR | Kind | Rounds | Title |
|---|---|---|---|
| #76 | groundwork | 1/3 | Story 7.6: the fixture validates itself and carries known truths |
| #78 | groundwork | 2/3 | Story 7.7: publish the fixture to MotherDuck |
| #79 | fix | 1/3 | Hardening: #66, #71, #73 |
| #80 | groundwork | 1/3 | Story 8.1: connector contract |
| #83 | groundwork | 1/3 | Story 8.2: mock CRM |
| #86 | fix | 1/3 | Fixture follow-ups (#77) |
| #88 | fix | 1/3 | Connector contract hardening (#82, #84) |
| #91 | groundwork | 1/3 | Story 8.3: mock email tool and the Outbox |

**Breach: fix share 38% (3 of 8), against a 25% budget.**

## What happened

- No PR had a blocking finding. Every fix PR was a batch of P2s that the specialist reviewers (SQLsmith, architect, connector) raised on a story after it had already merged.
- Several of those P2s were fail-open or write-safety defects, not polish:
  - the validator ran with no forbidden columns when it found no profile (#77);
  - a kill switch didn't stop a running push (#82);
  - a retry could lose rows (#82).
- Deferring them meant a second PR, a second review and a second CI run each time.
- The one place we fixed before merge, 7.7's unredacted `close()` error, cost one extra round and no extra PR.
- #80 took 2.4 hours because of a usage limit, not because of review churn. The rate limit stopped two reviewers and a builder at once. They were resumed rather than restarted (#77 kept 2 of its 9 fixes).
- The review parser accepted a Codex finding in which Codex was reasoning aloud (#81).

## Rule (added to `AGENTS.md`, build loop step 5)

On a T2 or T3 PR, a non-blocking finding that touches **write safety, credential handling, a fail-open default or data exposure** is fixed on the story branch before merge, with one more review round, not filed for later. Other P2s still go to the follow-up issue.

## Open

- **Ely:** #68 (tier floors for the access, credential and publish code), 4.3 (`approve plan onboarding-brightside`), and the MotherDuck publish.
- **Before 10.x:** DEP-012 (approval-only writes), #90 (suite gap, structured partial failure), #92 (outbox fail-closed and list-scoped keys).
- **Follow-ups:** #81, #85, #87, #89.
