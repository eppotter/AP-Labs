# Plan review: ledger-rows (T3)

Architect design review plus adversarial and edge-case lenses, 2026-10-26, on the first draft of SPEC.md. 12 findings; all folded into the revised SPEC.md.

1. Blocking: dist `EXCLUDED` drops whole folders only, and emptying row files would still ship branch names as paths. Fix: README at `docs/ledger/README.md`, exclude `docs/ledger/builds`.
2. Blocking: `'docs/ledger/'` in `forkOwned` never matches (`under()` appends `/`). Fix: `'docs/ledger'`.
3. Blocking: a README inside `builds/` would fail the one-row check. Fixed by 1.
4. Blocking: "touches any build file" lets a PR edit or delete another PR's row. Fix: `--name-status`; only add or edit your own file; deletes fail.
5. Should-fix: cross-PR clashes (same DEP) invisible to per-PR checks. Fix: build files hold one Builds row only; `npm test` checks the whole set.
6. Should-fix: slug collisions and case. Fix: lowercase name rule, matched to the head branch, reused name fails.
7. Should-fix: keep `parseLedger` pure; add `parseLedgerSet`; errors as file:line.
8. Should-fix: existing forks lack `docs/ledger/`. Fix: AC for an old fork, CHANGELOG note, fork guide.
9. Should-fix: sprint-status.yaml still conflicts. Fix: story PRs stop editing it; refreshed per epic.
10. Human call: landing on CI against an older main. Ely chose: CI on every push to main (2026-10-26).
11. Should-fix: missing docs and messages (DESIGN.md, ledger.md check paragraph, the failure message, scribe.md).
12. Nit: AC1 tested git only. Fix: run ledger-check on the merged tree; cover switchover and pending rows.

Verdict after revision: ready for the gate. Ely: `approve plan ledger-rows`, 2026-10-26.
