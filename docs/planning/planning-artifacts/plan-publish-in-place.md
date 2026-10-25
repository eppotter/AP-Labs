# Publish in place: plan for Ely

Status: **approved** by Ely (`approve plan publish-in-place`, 2026-10-25), with the recommended decisions. Architect design review and plan review done 2026-10-25, all findings folded in.

**In short:**
1. Tonight's publish failed: MotherDuck won't replace a database while a share is attached, and the bot reads through a share.
2. Publish will update `brightside_fixture` *in place* in one transaction, instead of replacing the whole database, so the share stays attached. When a table's layout is unchanged, only its rows are swapped. When the layout changed, the table is rebuilt.
3. Tonight's live test passed for rebuilds. The bot's share saw the new data after about 90 seconds, but in between it got **errors, not the old data**. Swapping rows only should avoid that window for normal re-publishes; this story tests that first.

## What you're approving

- [ ] **Swap step changes:** today publish replaces the database (`CREATE OR REPLACE DATABASE … FROM staging`). From now on it updates the database from the checked staging copy, inside one transaction with the target as the current database (MotherDuck refuses foreign keys that name another database):
  1. **Same layout** (same columns, types and keys as the build): delete the rows, then insert the new ones.
  2. **Changed layout, new table or removed table:**
     - Drop the old tables, children first by the target's own foreign keys.
     - Create the new ones from the build's definitions, parents first.
     - Insert their rows.
  3. **`fixture_publish`** (the version record) is replaced last, inside the same transaction, so the version commits with the data. It's never dropped and left out, because the next publish would refuse a database without it.
  4. Commit. If anything fails: roll back, then report "unchanged" only if the rollback succeeded. If the commit itself fails, report "unknown, check with `npm run fixture:status -- --remote`".
- [ ] **First publish is unchanged:** when the target doesn't exist yet, no share can exist either, so publish keeps today's `CREATE DATABASE <db> FROM <staging>`.
- [ ] **Everything else stays:** the staging upload and its check, the "not written by publish" refusal, token handling, and the final check against the local build.
- [ ] **You accept a short gap after layout changes:** after a publish that changes a table's layout (like tonight's v2 → v3), the bot may answer "data unavailable" for 1–2 minutes while MotherDuck catches up. If that's not OK, say so, and a follow-up story makes the bot ride it out.

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
2. Swap as above: same-layout tables swap rows, changed tables are rebuilt, the drop order comes from the target's own foreign keys, the definitions are the ones the upload already computed, and `fixture_publish` goes last.
3. On failure the transaction rolls back and the message tells the truth (see above). Tests prove it with a real local DuckDB, after the test fake is extended to seed existing targets as real tables with foreign keys, `fixture_publish` included. They fail mid-copy and assert the old tables and rows are intact.
4. First publish keeps `CREATE DATABASE … FROM staging`, and the "not written by publish" refusal still sends only reads.
5. After commit, the existing check compares the shared copy with the local build, then drops the staging copy.
6. `docs/runtime/motherduck-publish.md` describes the new swap, the lag, and the gap after layout changes, and drops "a re-publish replaces the database".
7. `npm run check` and `npm test` pass.
8. **Live:** the Orchestrator publishes version 3, re-runs `fixture:probe` until checks 8 and 9 match (the share survived; the lag is measured), and records whether the bot recovered on its own before restarting it.

**Files:** `kit/fixture/publish.js`, `test/unit/fixture-publish.test.js` (and its fake), `docs/runtime/motherduck-publish.md`, `docs/ledger.md`.

## Risks

- **The gap after layout changes:** 1–2 minutes of "data unavailable" (above). It's rare: only when the data's shape changes.
- **Row swaps may still show errors during the lag.** AC1(c) finds out before any code is written. If they do, the gap applies to every publish, and I come back to you before building.
- **Big transactions:** about 290,000 rows today. Fine at this size; a much bigger client dataset would need a re-check.
- **Tonight's leftover:** the staging copy from the failed publish is cleared by the next publish.
- **Blast radius:** the bot's restricted share and Steven's share, on synthetic data only. No new shared infrastructure.

## To approve

Type `approve plan publish-in-place`, with any changes in the same message.
