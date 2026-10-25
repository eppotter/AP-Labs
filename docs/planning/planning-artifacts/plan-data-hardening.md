# Data connection hardening: plan for Ely

Status: **approved** by Ely (`approve plan data-hardening`, 2026-10-25). Architect design review and plan review done 2026-10-25, findings folded in.

**In short:**
1. Two small, non-blocking review findings in the bot's data connection, from #110 (Story B).
2. Neither has caused a problem, but `kit/runtime/data` is T3 since #115, so even a small fix needs your approval.
3. One story, size XS: two fixes and their tests.

## What you're approving

- [ ] **Closing mid-connect leaves no wait.** The 30-second wait after a failure already survives `close()`; a regression test will pin that. The real gap is next to it: if `close()` lands while a MotherDuck connect is still in progress (only shutdown and the fixture tools call `close()`), the late result is dropped without setting the wait, and the old attempt stays in place, so a later query joins it. Fix: on that path, set the wait and clear the in-progress attempt.
- [ ] **No crash describing a local source with no file.** In local mode built without a file (or with an empty path), `describe()` throws (`path.basename(null)`), even though opening fails cleanly. MotherDuck mode can't reach this. Fix: the label is `(no file)` and `available` is false.

## The story

| Story | Who runs it | Size | You will see |
|---|---|---|---|
| Data hardening (#111) | Builder | XS | Nothing visible; two new tests |

Tier **T3**, computed: `kit/runtime/data/**` is an engine floor.

**Acceptance criteria:**

1. A regression test proves that after a failure sets the wait, `close()` followed by `run()` still refuses with "waiting to reconnect" until the wait is over. `close()` during a MotherDuck connect also sets the wait and clears the in-progress attempt, so a later `run()` starts fresh after the wait. Tests use the fake clock; the second one fails on today's code.
2. `describe()` never throws. In local mode with no file or an empty file path, the label is `(no file)` and `available` is false. A test proves both.
3. The local mode's `LOCKDOWN`, the MotherDuck `MD_LOCKDOWN` and every other behaviour stay the same. The existing tests pass unchanged.
4. `npm run check` and `npm test` pass.

**Files:** `kit/runtime/data/index.js`, `test/unit/runtime-data-motherduck.test.js` (or `runtime-data.test.js`), `docs/ledger.md`.

## Risks

- **Close to none:** two guard changes with tests. Live behaviour only changes when shutdown overlaps a connect. A restart still builds a fresh source with no wait, which is the process supervisor's concern, not this story's.

## To approve

Type `approve plan data-hardening`.
