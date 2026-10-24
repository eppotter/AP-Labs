# Runtime phase: summary for Ely

Status: approved by Ely 2026-10-24 (recommended decisions: Node fixture, Claude API with breaker, no MotherDuck read in V1, win-back demo, schema as drafted)

**What it delivers:** the part of the template the client's people use. By the end, in a fresh fork set up for Brightside, you type a command in Slack, ask in plain English for lapsed clients to win back, check what the bot understood, see a scored list, approve it, and watch it land once in a mock email tool. That is PLAN-v1 done-definition 3, plus 1, 2, 5 and 6.

**Size:** 6 phases (Epics 6–11), 30 stories, one PR each: 8 S, 21 M, 1 L. Plan: `epics-runtime.md`. Design rules: `architecture-runtime.md`. Spec: `../specs/spec-runtime/SPEC.md`.

**What changed since round 1:** a written architecture; the bot's SQL is locked down harder (one read-only runner, no file or network access, the LLM never writes SQL or sees rows); the bot doesn't read MotherDuck yet; CSVs go only to your DM; the existing `aplabs-demo` workspace instead of a new one; two big stories split; known truths use the checks Story 4.2 built.

**What changed in round 3:** an approved push carries its own copy of the rows, so it can't break when the "How was this made?" record expires; the SQL checker also blocks DuckDB's sneakier ways to read files or whole rows; the LLM no longer sees thread history (it could contain result rows); Brightside's profile now marks the bot's risky folders as T2/T3, so the write path, connectors and secrets get the full review; a double click says "already done"; health checks tolerate a normal reconnect; deploys are stop-then-start.

## What you will see at the end of each phase

| Phase | Tier | You will see |
|---|---|---|
| 6. Hello from Slack (5 stories) | T3 | The bot replies in Slack. A hub command shows a menu that only lists what your profile allows. A new module is added by copying a template |
| 7. Brightside's data, queried safely (7) | T2 | A synthetic Brightside database built offline in under a minute, checked automatically with known figures, every query going through one locked-down reader, a Dataset entry in Slack, and your MotherDuck copy |
| 8. Safe connections (3) | T3 | A standard connector shape, a mock CRM and mock email tool, and an Outbox entry in Slack showing what the email tool received |
| 9. Plain English (6) | T2 | Fill a short form or ask in your own words, confirm the parameters, and get a private result with a CSV in your DM and a "How was this made?" button showing the SQL |
| 10. Score, approve, push (4) | T3 | The full demo: scored list → preview → approve → pushed once, even if you double-click. Also runs as a CI test |
| 11. Ready to fork (5) | T2 | Scheduled-job registry, a container with a health check, a test proving two forks share the engine, a day-one fork guide, and template releases that flow into client forks with one command |

Tiers come from `node kit/lib/tier` with Brightside's profile plus the tier rows Story 6.1 adds (T3: the approval-write path, the connector contract, the secrets library; T2: the SQL checker, the query runner, the LLM service). A phase's tier is its highest story: 6 is T3 because of the secrets library (6.1), 8 because of the connector contract (8.1), 10 because of the write path (10.2, 10.3); 7, 9 and 11 are T2. It is still one plan gate for the whole phase; tiers decide how much review each story gets inside it.

## Steps only you can do

1. **Slack app (before Phase 6 live checks):** in the existing `aplabs-demo` workspace, create a separate bot app ("Brightside Bot (dev)") from the repo's manifest. Keep it apart from the "AP Labs Orchestrator" webhook app so notify and the bot never share credentials. Store the bot token (`xoxb-`) and app-level token (`xapp-`); no signing secret needed. Add your `aplabs-demo` member id to a Brightside user in the profile.
2. **LLM key (before Phase 9 live checks):** a venture Anthropic API key with a spend cap set in the console.
3. **Ops channel (before Story 10.3 live check):** create `#brightside-ops` in `aplabs-demo` and invite the bot. Failed pushes post counts there, never data.
4. **MotherDuck (after Phase 7):** venture-email account, invite your teammate, then run the publish command (Story 7.7).

**Clean bones (added 2026-10-24):** from Story 6.5 on, CI proves the template works with the Brightside example deleted. Story 11.5 adds numbered template releases and `npm run template:update`, so improvements reach every client fork without hand-merging.

## Decisions for you (my recommendation in bold)

| Decision | Recommendation |
|---|---|
| Fixture generator language | **Node throughout.** One toolchain; DuckDB is needed in Node anyway |
| LLM in the bot | **Claude API with a kill switch, a per-person limit and an hourly breaker (USD 2/hour default)**; cheaper model for reading requests; the form works when it's off |
| Bot reading MotherDuck | **Not in V1.** The bot reads the local fixture; MotherDuck is for people. Logged as a deferred item needing your approval of a read-only token |
| Demo scenario | **Win-back:** North-zone clients whose plan lapsed in the last 90 days, scored, top 25 pushed to the email tool |
| Profile schema | **Add the new keys as optional under version 1**; nothing is deployed yet |
| Deploy files | **A generic container, one replica only**; each fork picks its host |

Orchestrator Story 4.3 (prove onboarding on Brightside) becomes buildable after Phase 7 and reuses its known truths.

## To approve

Type: `approve plan runtime-phase`. Change any decision above in the same message, for example: `approve plan runtime-phase, fixture in Python`.
