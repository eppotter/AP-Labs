# Runtime phase: summary for Ely

Status: draft, awaiting approval · 2026-10-24

**What it delivers:** the part of the template the client's people use. By the end, in a fresh fork set up for Brightside, you type a command in Slack, ask in plain English for lapsed clients to win back, check what the bot understood, see a scored list, approve it, and watch it land once in a mock email tool. That is PLAN-v1 done-definition 3, plus 1, 2, 5 and 6.

**Size:** 6 phases (Epics 6–11, continuing the Orchestrator's 1–5), 27 stories, one PR each: 8 S, 17 M, 2 L. Full plan: `epics-runtime.md`. Spec: `../specs/spec-runtime/SPEC.md`.

## What you will see at the end of each phase

| Phase | You will see |
|---|---|
| 6. Hello from Slack (5 stories) | The bot replies in Slack. A hub command shows a menu that only lists what your profile allows. A new module is added by copying a template |
| 7. Brightside's data (5) | A synthetic Brightside database built offline in under a minute, checked automatically, published to MotherDuck by you, and a Dataset entry in Slack showing its version |
| 8. Safe connections (4) | The bot can't write through SQL or show blocked columns. A mock CRM and mock email tool exist, and an Outbox entry in Slack shows what they received |
| 9. Plain English (5) | You ask for a list in your own words, confirm the parameters, and get a private result with a CSV and a "How was this made?" button showing the SQL |
| 10. Score, approve, push (4) | The full demo: scored list → preview → approve → pushed once, even if you double-click. Also runs as a CI test |
| 11. Ready to fork (4) | Scheduled-job registry, a container file, a test proving two forks share the engine, and a day-one fork guide |

## Steps only you can do

1. **Slack app:** create it from the repo's manifest in a non-Hometown workspace, install it, and store the bot, app-level and signing tokens locally. Needed to see Phase 6 live; CI doesn't need it.
2. **LLM key:** a venture Anthropic API key with a spend cap set in the console. Needed to see Phase 9 live.
3. **MotherDuck:** venture-email account, invite your teammate, then run the publish command (Story 7.4).

## Decisions for you (my recommendation in bold)

| Decision | Recommendation |
|---|---|
| Fixture generator language | **Node throughout.** One toolchain; DuckDB is needed in Node anyway |
| Slack workspace and mode | **A dedicated AP Labs dev workspace, Socket Mode** (no public URL) |
| LLM in the bot | **Claude API with an hourly breaker (USD 2/hour default) and a kill switch**; cheaper model for reading requests |
| Mock connector shape | **In-process, writing to a local outbox** shown in Slack; no mock HTTP server |
| Demo scenario | **Win-back:** clients in a zone whose plan lapsed in the last 90 days, scored, top N pushed to the email tool |
| Profile schema | **Add the new keys as optional under version 1**; nothing is deployed yet |
| Deploy files | **A generic container only**; each fork picks its host |

Orchestrator Story 4.3 (prove onboarding on Brightside) becomes buildable after Phase 7; it stays in the Orchestrator plan.

## To approve

Type: `approve plan runtime-phase`. Change any decision above in the same message, for example: `approve plan runtime-phase, fixture in Python`.
