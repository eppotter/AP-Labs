# Build files

Each build adds its one ledger row in its own file here, `docs/ledger/builds/<slug>.md`, so two open PRs never edit the same lines of [`docs/ledger.md`](../ledger.md) and never conflict over the ledger.

**The name.** The slug is the PR's branch name, lowercased, with every `/` turned into `-`: branch `feat/routing-15-3-map-renderer` writes `docs/ledger/builds/feat-routing-15-3-map-renderer.md`. The name must match `^[a-z0-9][a-z0-9.-]*\.md$`, so a branch name with other characters (an underscore, a space) needs renaming first. A branch name used before already has its file on `main`: add a suffix to the new branch (`-2`).

**What the file holds.** The Builds table's header, its separator and exactly one row, in the format `docs/ledger.md` describes, and nothing else:

```markdown
| PR | Date | Story | Kind | Tier | Summary | DEPs |
|---|---|---|---|---|---|---|
| pending | 2026-10-26 | 9.9 | feature | T1 | One plain-language line. | — |
```

Use `pending` in the PR column until the PR has a number, then replace it. A deferral or blocker the build opens is a `DEP` row in `docs/ledger.md` (the next free id), never here; the row names it in its DEPs cell.

**The check.** CI's `node scripts/ledger-check.js` passes a PR that adds its own build file. It fails a PR that deletes any build file, adds or edits another branch's, adds its own when that name is already on the base, or adds a row both here and in `docs/ledger.md`. `npm test` re-checks `docs/ledger.md` and every build file together, so two PRs that each passed alone but clash (the same PR number, a DEP with no row) show up on the next run on `main`.

Older rows stay in `docs/ledger.md`; they are never moved here. A client fork made before this folder existed keeps its rows in `docs/ledger.md`, which still passes. Build files never ship to client forks (the distribution tree leaves `docs/ledger/builds/` out); this README does.
