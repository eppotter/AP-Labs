# Demo flow (CAP-14)

Recommended scenario: **win-back campaign**. Ely confirms or replaces it (Open Questions); the steps below stay the same whichever pull and push are chosen.

| # | Person sees | Block |
|---|---|---|
| 1 | Types the hub command (for example `/brightside`); a menu shows only the entries their profile grants | R1, R2, R4 |
| 2 | Picks "Win-back list" and types: "clients in the North zone whose plan lapsed in the last 90 days, top 25" | R3, R9 |
| 3 | The bot replies with the parameters it understood (zone = North, lapsed within 90 days, limit 25) and Confirm / Change buttons | R5, R9 |
| 4 | On Confirm, a private result: count, the top rows with a score and a one-line reason each, a CSV, and a "How was this made?" button | R8, R9, R11 |
| 5 | "How was this made?" shows the parameters and the exact SQL | R11 |
| 6 | Clicks "Push to email tool": a preview names the destination list, the count and a sample, with Approve / Cancel | R10 |
| 7 | Approves: the bot reports pushed, skipped and failed counts. A second click does nothing new | R6, R7, R10 |
| 8 | The Outbox entry shows the list the mock email tool received | R7 |

## Scoring

Deterministic, declared in the module's manifest, with a reason per row. Recommended inputs: months as a client, lifetime paid spend, days since last visit, last plan's price, and whether a price change preceded the lapse. Same data and weights give the same scores and order every time.

## What must hold

- Rows come only from the guarded, read-only query; the push re-derives rows server-side from the approval token, never from button payloads.
- Every step is private to the person who started it.
- With the LLM switched off (kill switch or breaker), step 3 says so plainly and the flow stops cleanly.
