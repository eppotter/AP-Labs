# The slow tests get their own CI step: plan for Ely

Status: **approved by Ely 2026-10-25** (T3: `.github/workflows/**` is an engine floor). Architect design review and plan review done 2026-10-25: 5 blocking findings, all folded in below, none left unresolved.

**In short:**
1. `npm test` stops running the two slow tests: the ci-fork test (about 30 s) and the template-update test (about 50 s). A new step in CI's `test` job runs them with `npm run test:slow`. The `clean-bones` job runs them too. Every test still runs in CI.
2. `npm run verify`'s `unit` check runs `npm test`, so it skips them as well. That gives issue #152 headroom without raising the 300 s limit.
3. The tests stay where they are. Each slow test skips unless `APLABS_SLOW_TESTS=1`, and `node:test` reports it as **skipped**, never passed, the same way the container build test already works. The slow runner fails if anything it runs is skipped.
4. One story. There is nothing for you to do by hand.

## What you are approving

- [ ] **Selection by an env gate, not by file location.** Node's default discovery runs every `.js` file under `test/` and every `*.test.js` in `examples/` and `kit/templates/`. So a folder or glob split would mean listing every test location in `package.json`, and a new location could be missed without anyone noticing. A gate in a shared helper keeps `npm test` as plain `node --test`.
- [ ] **A new step in the `test` job, not a new job.** The release command's required jobs (`test`, `clean-bones`, `container`) stay as they are.
- [ ] **Verify does not run the slow tests.** They test template releases and updates, and CI runs them. A fork that wants them in verify can add `APLABS_SLOW_TESTS` to `verify.env_allow`.

## Story CS.1: the slow tests get their own CI step

**Acceptance criteria:**

- **The gate.** New `test/fixtures/slow.js` exports `slowSkip()`. It returns `false` when `APLABS_SLOW_TESTS` is exactly `1`. Otherwise it returns the reason "slow: runs in CI's 'Slow tests' step (npm run test:slow)". Only the long tests use it, through `{ skip: slowSkip() }`: in `test/unit/ci-fork.test.js`, the fork-copy test; in `test/unit/template-update.test.js`, each test the builder measures at 5 s or more. The fast tests in both files (the ci.yml shape check, the fork guard) stay in `npm test`.
- **The runner.** New `scripts/run-slow-tests.js` exports `SLOW_FILES` (the two files) and, when run, spawns `node --test` on them with `APLABS_SLOW_TESTS=1`. It writes human output to stdout and a TAP copy to a temp file. It fails if `node --test` fails, if any test was skipped, or if no test passed (fail closed). The name must not match Node's default test patterns: `scripts/test-slow.js` would match `**/test-*.js` and `npm test` would pick it up. `package.json` gains `"test:slow": "node scripts/run-slow-tests.js"`. `"test"` stays `node --test`.
- **CI.** `.github/workflows/ci.yml`, `test` job, right after "Tests (unit, hook, acceptance)": a step named `Slow tests (fork copy, template update)` with `run: npm run test:slow`. It has no `if:` and no fork guard, so it runs in the template and in every fork.
- **No recursion in the ci-fork test.** The ci-fork test runs every ci.yml step that isn't in `NOT_RUN`. Without an entry, a fork copy would run `test:slow`, which runs ci-fork again in another copy, and so on. `NOT_RUN` gains `'test/Slow tests (fork copy, template update)'` with the reason "runs the ci-fork test itself (and the template-update test); CI runs it". The reason for the "Tests" entry changes to "the fast suite; CI runs it, not this copy".
- **clean-bones keeps its coverage.** `scripts/clean-bones.sh` runs `npm run test:slow` after `npm test`, so both slow tests still run in a copy without Brightside, as they do today.
- **A guard test** (new `test/unit/slow-tests.test.js`, fast) fails if any of these is false:
  - the tracked test files that call `slowSkip` are exactly `SLOW_FILES`;
  - `package.json` `test:slow` is the runner and `test` is still `node --test`;
  - the ci.yml step exists in the `test` job, runs `npm run test:slow` and has no `if:`;
  - `NOT_RUN` lists that step;
  - `clean-bones.sh` calls `npm run test:slow`;
  - no tracked file outside `test/` and the existing test files matches Node's default patterns (`**/test-*.js`, `**/test.js`, `**/*-test.js`, `**/*_test.js`).
- **Timing is reported.** The builder reports wall time for `npm test` and `npm run test:slow`, before and after, in the report and the PR body. Node runs test files in parallel, so the saving can be less than 80 s.
- **Issue #152.** The Orchestrator comments on #152 with the measured `npm test` time against verify's 300 s limit. It closes the issue if the margin is 60 s or more, and otherwise leaves it open with the number. The timeout is not raised.
- **AGENTS.md.** The line "`npm test` takes about 2.5 minutes" gets the new figure. A new line: "Run `npm run test:slow` as well before committing a change to `kit/release/**`, `kit/lib/template/**`, `kit/lib/fork/**`, `.github/workflows/ci.yml`, `scripts/clean-bones.sh` or `test/fixtures/temp-*.js`. CI runs it either way."
- **Untested locally:** none. Every step runs on the Mac. Shellcheck still skips the ci-fork step where shellcheck isn't installed, as it does today.

**Tests:** new `test/unit/slow-tests.test.js` covers the guard above, plus the runner failing on a fixture file with a skipped test and on one with zero tests. It does this by injecting the file list (`SLOW_FILES` override via an argument, used only in tests). Updated `test/unit/ci-fork.test.js` (the `NOT_RUN` entry and the gate). Updated `test/unit/template-update.test.js` (the gate). Every case is run once with `npm test` (slow tests reported as skipped) and once with `npm run test:slow` (all pass, none skipped).

Tier: T3 (computed floor: `.github/workflows/**`)

**Files:** `package.json`; `.github/workflows/ci.yml`; `scripts/clean-bones.sh`; new `scripts/run-slow-tests.js`; new `test/fixtures/slow.js`; new `test/unit/slow-tests.test.js`; `test/unit/ci-fork.test.js`; `test/unit/template-update.test.js`; `AGENTS.md`; `docs/ledger.md`.

## Review findings folded in

| # | Finding | Where it now lives |
|---|---|---|
| B1 | The ci-fork test runs every new ci.yml step in a fork copy, so `test:slow` would run ci-fork inside itself until the 300 s timeout | The `NOT_RUN` AC and the guard test |
| B2 | A runner called `scripts/test-slow.js` matches Node's default `**/test-*.js` pattern, so `npm test` would run the slow suite | The runner AC (`run-slow-tests.js`) and the guard's default-pattern check |
| B3 | If the gate variable were ever missing, the slow step would report skips and still pass | The runner fails on any skip or on zero passes; tested |
| B4 | clean-bones would stop running the slow tests in a copy without Brightside | The clean-bones AC |
| B5 | A gated file left out of the runner list would never run anywhere | The guard test (gated files equal `SLOW_FILES`; the step has no `if:`) |

**Non-blocking, folded in:** the fast tests in the two files run in both suites, which costs under a second (N1). The AGENTS.md line about local `test:slow` (N2). Wall time is measured, not assumed (N3). The release's required jobs are unchanged (N4). Verify gets no code change (N5).

**Non-blocking, for the builder to confirm:** whether `node --test`'s default discovery picks up `.claude/worktrees/**` on the Mac (now gitignored, but still on disk). If it does, that alone could explain local times; say so in the report, and fix it in a separate change.

## Not in this plan

- Raising verify's timeout or the stop-hook budget.
- Moving any other test. The next one over about 30 s goes through the same gate.
