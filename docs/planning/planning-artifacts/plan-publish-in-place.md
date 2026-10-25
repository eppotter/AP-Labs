# Publish in place: plan for Ely

Status: **approved** by Ely (`approve plan publish-in-place`, 2026-10-25), with the recommended decisions. Architect design review and plan review done 2026-10-25, all findings folded in.

**In short:**
1. Tonight's publish failed: MotherDuck won't replace a database while a share is attached, and the bot reads through a share.
2. Publish will update `brightside_fixture` *in place* in one transaction, instead of replacing the whole database, so the share stays attached. Every table is rebuilt (the AC1 live tests ruled out swapping only the rows; see below).
3. AC1's live tests (2026-10-25): after a rebuild of existing tables, the bot's share kept seeing the **old rows** for about 60 seconds, then switched cleanly to the new ones, with no errors. Errors happen only for tables that are new in that publish, until it propagates.

## What you're approving

- [ ] **Swap step changes:** today publish replaces the database (`CREATE OR REPLACE DATABASE … FROM staging`). From now on it updates the database from the checked staging copy, inside one transaction with the target as the current database (MotherDuck refuses foreign keys that name another database):
  1. **Every table is rebuilt**, whatever its layout (AC1(c): DuckDB does not defer foreign-key checks inside a transaction, so a rows-only swap is refused):
     - Drop the old tables, children first by the target's own foreign keys.
     - Create the new ones from the build's definitions, parents first.
     - Insert their rows.
  2. **`fixture_publish`** (the version record) is replaced last, inside the same transaction, so the version commits with the data. It's never dropped and left out, because the next publish would refuse a database without it.
  3. Commit. If anything fails: roll back, then report "unchanged" only if the rollback succeeded. If the commit itself fails, report "unknown, check with `npm run fixture:status -- --remote`".
- [ ] **First publish is unchanged:** when the target doesn't exist yet, no share can exist either, so publish keeps today's `CREATE DATABASE <db> FROM <staging>`.
- [ ] **Everything else stays:** the staging upload and its check, the "not written by publish" refusal, token handling, and the final check against the local build.
- [ ] **You accept a short gap, only when a publish adds new tables:** after a publish that adds tables (like tonight's v2 → v3), the bot may answer "data unavailable" for 1–2 minutes on queries that touch them, while MotherDuck catches up. Rebuilt existing tables show the old rows until then, without errors. If that's not OK, say so, and a follow-up story makes the bot ride it out.

## The story

| Story | Who runs it | Size | You will see |
|---|---|---|---|
| Publish in place | Builder writes it; the Orchestrator runs the live tests and the publish | S–M | `fixture:publish` succeeds with the bot's share attached, and Dataset in Slack shows version 3 and 16 tables |

Tier **T3**, computed: `kit/fixture/publish.js` and `remote.js` are engine floors since #115.

**Acceptance criteria:**

1. **Before coding,** the Orchestrator re-runs the throwaway live test on MotherDuck and records the results in the PR:
   - (a) the rows are copied in from a second database, as publish does from staging;
   - (b) existing tables linked by foreign keys are dropped inside the transaction;
   - (c) a same-layout row swap: what the share sees during the lag, old rows or errors.

   **Results (run by the Orchestrator on MotherDuck, 2026-10-25):**
   - (a) **pass:** `INSERT INTO t SELECT * FROM <other_db>.main.t`, with the target as the current database (`USE <target>`), works inside a transaction.
   - (b) **pass:** dropping existing tables linked by foreign keys (children first) and recreating them (parents first) inside one transaction works, and `COMMIT` succeeds.
   - (c) **fail, so the design changed:** `DELETE FROM child; DELETE FROM parent; INSERT …` inside one transaction is refused ("Violates foreign key constraint because key … is still referenced"). DuckDB does not defer foreign-key checks within a transaction, so there is no row-swap path: publish always rebuilds.
   - **The lag, seen through the bot's share:** after a rebuild of existing tables, the reader kept seeing the old rows for about 60 seconds, then switched cleanly to the new ones, with no errors. Errors happen only for tables that are new in that publish, until it propagates.
2. Swap as above: every table is rebuilt, the drop order comes from the target's own foreign keys, the definitions are the ones the upload already computed, and `fixture_publish` goes last.
3. On failure the transaction rolls back and the message tells the truth (see above). Tests prove it with a real local DuckDB, after the test fake is extended to seed existing targets as real tables with foreign keys, `fixture_publish` included. They fail mid-copy and assert the old tables and rows are intact.
4. First publish keeps `CREATE DATABASE … FROM staging`, and the "not written by publish" refusal still sends only reads.
5. After commit, the existing check compares the shared copy with the local build, then drops the staging copy.
6. `docs/runtime/motherduck-publish.md` describes the new swap, the lag, and the gap when a publish adds new tables, and drops "a re-publish replaces the database".
7. `npm run check` and `npm test` pass.
8. **Live:** the Orchestrator publishes version 3, re-runs `fixture:probe` until checks 8 and 9 match (the share survived; the lag is measured), and records whether the bot recovered on its own before restarting it.

**Files:** `kit/fixture/publish.js`, `test/unit/fixture-publish.test.js` (and its fake), `docs/runtime/motherduck-publish.md`, `docs/ledger.md`.

## Risks

- **The gap when a publish adds new tables:** 1–2 minutes of "data unavailable" on queries that touch them (above). It's rare: only when the data gains tables.
- **Row swaps ruled out.** AC1(c) showed DuckDB refuses them inside a transaction, so every publish rebuilds. The live lag test showed rebuilt existing tables serve the old rows, without errors, until the share catches up, so the gap does not apply to every publish.
- **Big transactions:** about 290,000 rows today. Fine at this size; a much bigger client dataset would need a re-check.
- **Tonight's leftover:** the staging copy from the failed publish is cleared by the next publish.
- **Blast radius:** the bot's restricted share and Steven's share, on synthetic data only. No new shared infrastructure.

## To approve

Type `approve plan publish-in-place`, with any changes in the same message.
