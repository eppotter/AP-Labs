# Ledger rows without merge conflicts

Plan slug: `ledger-rows`. Tier: T3 (computed: `kit/lib/ledger`, `kit/lib/dist`, `kit/lib/fork` are engine paths). One story, one PR. Revised after the architect's T3 review (12 findings; all folded in below).

## Problem

Every PR appends its row to the end of the Builds table in `docs/ledger.md`, and every story PR flips its own line in `docs/planning/implementation-artifacts/sprint-status.yaml`. Two open PRs therefore always conflict. In the routing merge queue (2026-10-26, PRs #200 to #218) every PR conflicted with the one merged before it. Each needed `main` merged in by hand, which changed its head, so `npm run land` needed a fresh `npm run review` round. Three PRs used their last round (3/3) on these merge-only re-reviews.

## Goal

Two story PRs never conflict over the ledger or the sprint status, so a reviewed, green PR can land without merging `main` into it first (unless real code conflicts).

## Design

1. **One file per build row:** `docs/ledger/builds/<slug>.md`, where slug is the branch name lowercased with `/` turned into `-`. The name must match `^[a-z0-9][a-z0-9.-]*\.md$`. The file holds the Builds header and exactly one row, in today's format (`pending` until the PR has a number). Any other table, a DEP table in particular, is an error.
2. **`docs/ledger.md` keeps** its intro, every existing row (history is not moved) and the DEP table. DEP rows stay here, with the next free id.
3. **Pure parsing stays pure** (`kit/lib/ledger`). `parseLedger(text)` is unchanged. A new `parseLedgerSet({ ledger, builds: [{ name, text }] })` applies the rules across all files, with errors as `file:line`:
   - no PR with two rows anywhere, including a row in both `docs/ledger.md` and a build file;
   - each build file holds one row and nothing else;
   - the file name is valid;
   - every DEP named in a build row has a DEP row;
   - a missing `builds/` folder counts as empty.
4. **`scripts/ledger-check.js`** reads the files and uses `git diff --name-status`. A PR passes when it adds or edits `docs/ledger.md` or its own build file (the one named `slug(GITHUB_HEAD_REF)`), or is exempt by today's rule. It fails when the PR:
   - deletes any build file;
   - edits another PR's build file;
   - adds its own build file when that name already exists at base ("branch name reused; add a suffix").

   The failure message and its test are updated.
5. **`npm test` on main re-checks the whole set.** The "repo ledger is well formed" test (`test/unit/ledger.test.js`) runs `parseLedgerSet` over `docs/ledger.md` and every build file. That way, two PRs that each pass alone but clash together, such as both naming the same DEP, show up on the next run.
6. **Distribution (`kit/lib/dist`):**
   - `docs/ledger/builds` joins `EXCLUDED`, so no row file or file name ships.
   - `docs/ledger/README.md` (what goes in `builds/`) does ship.
   - The publish warning about mentions of excluded paths will list the docs that name `builds/`. That's expected and only a warning.
7. **Forks (`kit/lib/fork`):** `'docs/ledger'` (no trailing slash: `under()` adds it) joins `UPDATE_RULES.forkOwned`. A fork made before this change has no `docs/ledger/`; its `ledger-check` still passes with rows in either place. The CHANGELOG gets a "What a fork must do" note, and `docs/fork-guide.md` and its test are updated.
8. **Sprint status:** a story PR no longer edits `sprint-status.yaml`.
   - The Orchestrator refreshes it once per epic, and when Ely asks, in a docs-only PR (exempt from review).
   - The rule goes in AGENTS.md and the builder agent. BMAD's skill is not edited.
9. **Docs:**
   - `docs/ledger.md` intro and its check paragraph.
   - `AGENTS.md` build loop step 3, shortened to: "keep main's rows; a new DEP takes the next free id".
   - `docs/orchestrator/DESIGN.md` §ledger.
   - `.claude/agents/scribe.md`.

## Decision for Ely (finding 10)

Without the forced merge of `main`, a PR lands on CI that ran against an older `main`. Two PRs that each pass alone can break `main` together.

- **Recommended:** accept it, and turn CI back on for every push to `main`. #205 turned it off to save minutes. The repo is now public, so minutes are free. A break shows within minutes of the merge. This touches `.github/workflows/ci.yml` (it needs the `workflow` token scope and `test:slow`).
- **Alternative:** GitHub's "require branches to be up to date". That brings back the re-merges this plan removes.

## Out of scope

- Moving the existing rows out of `docs/ledger.md`.
- `npm run retro` (it reads PRs from GitHub, not the ledger).

## Rejected

- **`.gitattributes` `merge=union` on `docs/ledger.md`:** GitHub's mergeability check ignores `.gitattributes` merge settings, so PRs would still show as conflicting. Worse, union silently keeps both sides: two edits to one row, or two PRs adding the same DEP id, would merge into a wrong ledger with no conflict.
- **The row is added at merge time:** that needs a commit to `main` after the merge, and nothing pushes to `main` directly.

## Acceptance criteria

1. Two branches from the same `main`, each adding its own build file, merge one after the other with no conflict, and `ledger-check` passes on the merged tree. Also covered: a PR with a row in both `docs/ledger.md` and a build file fails, and so do two `pending` rows from one branch.
2. `parseLedgerSet` reports, as `file:line`:
   - a PR in two files;
   - a build file with zero rows, two rows, or a DEP table;
   - a bad file name;
   - a DEP named in a build file with no DEP row.
3. `ledger-check` passes a PR that adds only its own build file. It fails a code PR with none, a PR that edits another PR's build file, a PR that deletes a build file, and a reused branch name.
4. The shipped tree has `docs/ledger/README.md` and no `docs/ledger/builds/` path. The test uses fixture build files, one whose name holds a deny word and one whose doesn't, and asserts neither ships. The shipped ledger parses with no errors.
5. `UPDATE_RULES.forkOwned` is `['docs/ledger.md', 'docs/planning', 'docs/ledger']` (order as in code). A template update keeps a fork's build files. A fork with no `docs/ledger/` passes `ledger-check` after the update.
6. If Ely picks the recommended option: CI runs on every push to `main`, and `scripts/ci-changes.js` plus its tests agree.
7. `npm run check && npm test && npm run test:slow` pass.
