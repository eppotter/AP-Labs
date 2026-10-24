# Demo flow (CAP-14)

Recommended scenario: **win-back campaign**. Ely confirms or replaces it (Open Questions); the steps below stay the same whichever pull and push are chosen. Data definitions: `fixture-tables.md`.

| # | Person sees | Stories |
|---|---|---|
| 1 | Types the hub command (for example `/brightside`); a menu shows only the entries their profile grants | 6.2, 6.3 |
| 2 | Picks "Win-back list" and types: "clients in the North zone whose plan lapsed in the last 90 days, top 25" | 9.4 |
| 3 | The bot replies with the parameters it understood (zone = North, lapsed within 90 days, limit 25) and Confirm / Change buttons. Change opens the typed form | 9.3, 9.4 |
| 4 | On Confirm, a private result: count, the top rows with a score and a one-line reason each, a "How was this made?" button, and a CSV sent to the person's DM | 9.5, 9.6, 10.1 |
| 5 | "How was this made?" shows the parameters and the exact SQL | 9.6 |
| 6 | Clicks "Push to email tool": a preview names the destination list, the count and a sample, with Approve / Cancel | 10.2 |
| 7 | Approves: the bot reports pushed, skipped and failed counts. A second click does nothing new | 10.3 |
| 8 | The Outbox entry shows the list the mock email tool received | 8.3 |

## Scoring

Deterministic, declared in the module's manifest, with a reason per row. Recommended inputs: months as a client (`created_on` to `as_of`), lifetime paid spend, days since last completed visit, the lapsed plan's `price_cents`, and whether a price change preceded the lapse. Same data and weights give the same scores and order every time.

## What must hold

- Rows come only from the module's static query, run through the runner with the confirmed parameters bound; the push re-derives rows server-side from the approval token, never from button payloads.
- Every step is private to the person who started it; files go only to their DM.
- With the LLM switched off (kill switch or breaker), step 2 says so plainly and offers the typed form; the flow continues from step 3.
- Query rows never reach the LLM.
