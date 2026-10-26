# A clean distribution repo for client forks: plan for Ely

Status: **approved by Ely 2026-10-25** (T3: `kit/release/**`, `kit/lib/template/**`, `kit/lib/tier/**`, `kit/runtime/sql/**` and `.github/workflows/**` are engine floors). Architect design review and plan review done 2026-10-25: 12 blocking findings, all folded in below, none left unresolved. This settles the template-history DEP row from plan epic-11 with option (b).

**In short:**
1. Clients never clone this repo. They clone a private distribution repo (for example `eppotter/aplabs-template`). Each release appears there as one commit: the release's files minus the internal ones (`docs/reference/`, `docs/planning/`, `docs/PLAN-v1.md`, `docs/HANDOFF.md`), with the ledger's rows emptied. Each dist commit's parent is the previous dist release, and it has the same `vX.Y.Z` tag. Forks therefore share the dist repo's history, and `template:update` keeps working with the dist repo as `upstream`. `kit/` and `profiles/_schema/` are never excluded, so the engine fingerprint is the same.
2. `npm run template:publish -- vX.Y.Z` builds that commit locally. **You push it**, as with release tags. The Orchestrator never does.
3. A deny-list check refuses any release whose dist tree still mentions Hometown. The list lives in `docs/reference/`, so it never ships. A CI job builds the dist tree on every PR and runs the full test suite inside it, so a release can't be cut if the dist tree would break.
4. Before the first dist release, 12 files that ship today need Hometown mentions removed (list below).
5. The first dist release is **v0.2.0**. v0.1.0 predates the cleanup and is never published.
6. Three stories: D.1 cleanup and deny-list, D.2 the publish command and CI job, D.3 the fork guide.

## What you are approving

- [ ] **Option (b), a distribution repo.** It replaces the fork guide's stop sign.
- [ ] **What's left out of the dist repo:** `docs/reference/**`, `docs/planning/**`, `docs/PLAN-v1.md`, `docs/HANDOFF.md`. One transform: `docs/ledger.md` ships with its introduction, headings and table header rows, and no rows.
- [ ] **The names "Hometown" and "Varsity" leave every shipped file**, as do the reference repo names and paths and Hometown table names. To keep naming them in the README, say so; the deny-list is yours to edit.
- [ ] **A new CI job, `dist`, required for releases** (added to `REQUIRED_JOBS`).
- [ ] **The dist repo's own CI** runs on each push to its `main`, which is a free extra smoke test. To save Actions minutes, turn Actions off there instead.

## Hometown risk found by scan (2026-10-25, excluding `docs/reference/`)

| Where | What | Handled by |
|---|---|---|
| `README.md` (lines 18, 62) | Hometown Ticketing, Varsity, the Salesforce/Gong example | D.1 rewrite |
| `AGENTS.md` (16, 50, 51) | Varsity; `~/Projects/bi-platform`, `AI-Governance-Layer`; "No Hometown specifics" | D.1: reference repos move to `docs/reference/README.md`; the rule becomes "no reference-client specifics outside `docs/reference/`" |
| `docs/orchestrator/DESIGN.md` (9, 39, 59, 65, 153) | Varsity, Hometown, `bi-platform` | D.1 rewrite ("the reference platform") |
| `docs/adr/0002`, `0003` | Varsity | D.1 minimal wording edit |
| `docs/runtime/ai-setup.md` (9) | "not Hometown" | D.1 |
| `kit/runtime/sql/index.js:11`, `kit/runtime/slack/modal.js:3`, `kit/lib/verify/index.js:7` | Comments naming Varsity and AI-Governance-Layer | D.1 (comment-only; changes the fingerprint, which is fine before v0.2.0) |
| `test/unit/agents.test.js` (24–27) | Deny regexes including Hometown table names | D.1: moved to the deny file, loaded by the test |
| `test/unit/fork-guide.test.js:192` | `/hometown\|varsity/i` | D.1: uses the loader |
| `docs/ledger.md:129` | DEP-008 mentions Varsity | Ledger transform (no rows ship) |
| `docs/PLAN-v1.md`, `docs/planning/**` (20+ files), `docs/HANDOFF.md` | Hometown and Varsity history; Ely's Slack id | Excluded |
| `profiles/brightside/profile.yml:79` | Ely's real AP Labs Slack member id (not Hometown) | **Ely decides** (N1); not blocking |

Clean: `.claude/agents/`, `.agents/`, `_bmad/`, `kit/` apart from the 3 comments. `.claude/worktrees/` is gitignored and never in a tag's tree. The grep only finds names. People's names, Slack ids and table names that appear only in `docs/reference/` must be added to the deny file (D.1).

## Build order

1. CS.1 (plan ci-split) first: it touches the same `ci.yml` and `ci-fork.test.js`, and the `dist` job runs `test:slow`.
2. D.1, then D.2, then D.3. D.3 removes the stop sign, so it must not merge before D.2.

### Story D.1: cleanup and deny-list

**Acceptance criteria:**

- **Exclusion list.** New engine helper `kit/lib/dist` holds `EXCLUDED` (the four paths above) and the ledger transform. A test fails if any excluded path is under `kit/` or `profiles/_schema/`, or under `ENGINE_DIRS`.
- **The deny file** is new `docs/reference/dist-deny.txt`: one case-insensitive regex per line, `#` comments allowed. The Orchestrator drafts it from the scan above and from `docs/reference/` (people, Slack ids, tables, repo names), and Ely reviews it. `loadDenyList(treeOrRoot)` refuses a missing file, an empty list or an invalid regex (fail closed).
- **`scanDist(files)`** checks every shipped path *and* every text blob. Blobs with a NUL byte are listed as binary, not skipped silently. It reports `file:line` and the pattern's number, never the matched text.
- **The tripwire** is new `test/unit/dist-scan.test.js` (fast, in `npm test`). It runs the deny scan on the tracked tree minus `EXCLUDED` and fails on any hit. It skips (reason "distribution copy: no `docs/reference/`") only when `docs/reference/` is absent. If `docs/reference/` exists without the deny file, it fails.
- **The cleanup** follows the table above (Scribe for docs, Builder for code and tests). `agents.test.js` and `fork-guide.test.js` load their reference-client patterns through `loadDenyList`, keep their generic patterns inline, and skip only the reference-client part in a distribution copy.
- **Floor.** `ENGINE_T3` gains `kit/lib/dist/**`, with a tier test and the fork guide's floor list.

Tier: T3 (computed floors: `kit/lib/tier/**`, `kit/runtime/sql/**`)

**Files:** new `kit/lib/dist/index.js`; new `docs/reference/dist-deny.txt`; new or edited `docs/reference/README.md`; new `test/unit/dist-scan.test.js`; `test/unit/agents.test.js`; `test/unit/fork-guide.test.js`; `kit/lib/tier/index.js`; `test/unit/tier.test.js`; `README.md`; `AGENTS.md`; `docs/orchestrator/DESIGN.md`; `docs/adr/0002-engagement-starter-template.md`; `docs/adr/0003-orchestrator-tooling.md`; `docs/runtime/ai-setup.md`; `kit/runtime/sql/index.js`; `kit/runtime/slack/modal.js`; `kit/lib/verify/index.js`; `docs/fork-guide.md` (floor list only); `docs/ledger.md`.

### Story D.2: `template:publish` and the `dist` CI job

**Acceptance criteria:**

- **`npm run template:publish -- vX.Y.Z [--first] [--push]`**, run in the template, refuses and names every reason unless all of these hold:
  - it is not a fork (no `.aplabs/profile.yml`);
  - a `dist` remote exists with `remote.dist.tagOpt = --no-tags`;
  - `vX.Y.Z` is a local annotated tag whose object equals `origin`'s, and its commit is reachable from `origin/main`;
  - the deny file loads from the tag's tree (not the worktree).
- **Local namespace, no clashes.** It fetches only with explicit refspecs: `+refs/heads/main:refs/dist/main` and `+refs/tags/v*:refs/dist/tags/v*`, with `--no-tags`. Dist tags never enter `refs/tags/`, where this repo's own `vX.Y.Z` tags live.
- **The tree.** `buildDistTree(root, ref)` is one function shared by publish and `--check`. It reads the tag's tree into a temp index, removes `EXCLUDED`, writes the transformed ledger blob, and writes the tree. It refuses a gitlink, or a symlink whose target resolves into an excluded path. It runs `scanDist`, and any hit refuses. It asserts `refFingerprint(source tag) == refFingerprint(dist commit)`.
- **Parent rule.** The dist commit's parent is the commit of the newest dist tag, and `refs/dist/main` must equal it. Otherwise it refuses with "the dist repo's main moved; fix by hand". The version must be higher than the newest dist tag, so only one line of releases is supported (N6).
- **Root commit only on request.** An empty dist (no `main`, no tags) refuses without `--first`. `--first` refuses if dist has any ref. A failed fetch always refuses, so an unreachable remote can't pass for an empty one.
- **Commit and tag.** Fixed author and committer `AP Labs template <template@aplabs.invalid>`. Message `AP Labs template vX.Y.Z` plus `Source: <source sha>`. An annotated tag object `vX.Y.Z` stored at `refs/dist/tags/vX.Y.Z`, with `refs/dist/main` updated. Nothing is copied from source commit messages.
- **Re-runs.** If the dist tag already exists with the same tree, it says "already published" and exits 0. A different tree refuses.
- **Push.** Without `--push` it prints the one command: `git push --atomic dist refs/dist/main:refs/heads/main refs/dist/tags/vX.Y.Z:refs/tags/vX.Y.Z`. With `--push` it runs it (fast-forward only, never `--force`). AGENTS.md gains: "The Orchestrator never passes `--push` to `template:publish` and never pushes to the `dist` remote."
- **`--check`** (no version, no remote) builds the dist tree for `HEAD` and writes it into a temp git repo with `node_modules` linked. It runs `npm run check && npm test && npm run test:slow` there, plus the scan and the fingerprint assertion. The test run can be injected in unit tests.
- **CI.** New job `dist` (`permissions: contents: read`, no secrets, no third-party actions beyond checkout and setup-node). Steps: Install, then `Distribution tree builds and passes its tests`, which runs `if [ -f .aplabs/profile.yml ] || [ ! -d docs/reference ]; then echo "skipped: not the template source repo"; exit 0; fi` followed by `npm run template:publish -- --check`. `REQUIRED_JOBS` gains `dist`. In `ci-fork.test.js`: `NOT_RUN` gains `dist/Install`, and the check step is run in the fork copy with its skip line asserted.
- **Shared code.** The tree-building code that release and publish share sits in `kit/lib/dist`. `release.js` prints the next step after tagging ("then `npm run template:publish -- vX.Y.Z`").
- **`update.js` and `check.js`: no change.** The end-to-end test below proves they work with the dist repo as `upstream`.
- **Docs.** AD-1 (in `architecture-runtime.md`) gains the dist repo, `EXCLUDED`, the parent rule and who pushes. The `CHANGELOG.md` release checklist gains step 6: "run `template:publish`; Ely pushes the dist commit and tag."

**Tests, temp repos only** (`test/fixtures/temp-git.js`; nothing reaches GitHub). Setup: a bare source origin with a work clone and annotated tags, and an empty bare `dist` remote added with `--no-tags`. Cases:

- `--first v1.0.0`: local refs only, nothing pushed. With `--push`, dist gets `main` and `v1.0.0`; the excluded paths are absent; the ledger has no rows; the fingerprints are equal; the message is fixed.
- `v1.1.0`: the parent is dist `v1.0.0`.
- **End to end:** clone a fork from dist at `v1.0.0`, `--record`, delete the example, then `template:update -- v1.1.0` with dist as `upstream` opens the PR (fake gh).
- Refusals: a fork; no `dist` remote; a remote without `--no-tags`; a lightweight tag; a tag not on origin; a tag not on `origin/main`; empty dist without `--first`; `--first` on a non-empty dist; dist main moved; version not higher; tag already published with a different tree; already published with the same tree (exit 0); a deny hit in content; a deny hit in a path; a missing deny file; an invalid regex; a symlink into `docs/reference/`; a gitlink; an injected exclusion under `kit/` refused; a failed fetch.
- `--check` with an injected runner: passes, and fails when the runner fails.
- Source-repo tags are unchanged after every case.

`template-update.test.js` makes its own `docs/planning/` file instead of reading the repo's, so it passes in a dist copy. `template-release.test.js` and the fake gh's passing runs include `dist`.

Tier: T3 (computed floors: `kit/release/**`, `kit/lib/template/**`, `kit/lib/dist/**`, `.github/workflows/**`)

**Files:** new `kit/release/publish.js`; `kit/lib/dist/index.js`; `kit/lib/template/index.js` (`REQUIRED_JOBS`); `kit/release/release.js` (next-step line); `package.json` (`template:publish`); `.github/workflows/ci.yml` (`dist` job); `AGENTS.md` (no-push line); `CHANGELOG.md` (checklist); new `test/unit/template-publish.test.js`; `test/fixtures/temp-git.js`; `test/unit/template-update.test.js`; `test/unit/template-release.test.js`; `test/unit/ci-fork.test.js`; `docs/planning/planning-artifacts/architecture-runtime.md` (AD-1); `docs/ledger.md`.

### Story D.3: the fork guide clones the dist repo

**Acceptance criteria:**

- The stop sign is replaced by: "Clone only from the distribution repo (`aplabs-template`). The AP Labs source repo carries internal history and never goes to a client."
- Step 1's clone URL is the dist repo. The clone-at-a-tag and rename-to-`upstream` steps are unchanged.
- Step 3: the ledger arrives with no rows; just check it.
- "Taking an update" says `upstream` is the dist repo.
- `fork-guide.test.js`: the stop-sign test becomes a "clones from the distribution repo, never the source repo" test, and it asserts that no `AP-Labs.git` URL appears.
- No Hometown specifics. The tripwire covers this.

Tier: T1 (computed)

**Files:** `docs/fork-guide.md` (Scribe); `test/unit/fork-guide.test.js`; `docs/ledger.md`.

## Review findings folded in

| # | Finding | Where it now lives |
|---|---|---|
| B1 | Dist tags `vX.Y.Z` clash with this repo's own tags | D.2: `refs/dist/*` namespace, `--no-tags` remote, explicit refspecs; the test that source tags are unchanged |
| B2 | The deny-list, and two tests, would themselves ship Hometown terms | D.1: the deny file lives in `docs/reference/`; tests use the loader |
| B3 | The dist tree could fail its own tests (`docs/planning` read by the update test, broken links) | D.2: the `dist` job runs check, test and test:slow in the built tree on every PR; `dist` is a required job |
| B4 | An accidental new root commit would cut every fork off from updates | D.2: `--first` is explicit; it refuses on a non-empty dist or a failed fetch |
| B5 | The `dist` job would fail in every fork's CI and in the dist repo's own CI | D.2: the guard; ci-fork asserts the skip |
| B6 | Symlinks into excluded paths and gitlinks | D.2: refused, with tests |
| B7 | File names, commit messages and tag messages were not scanned | D.1 scans paths; D.2 uses a fixed message and identity |
| B8 | Publishing out of order, or onto a moved dist `main` | D.2 parent rule; atomic fast-forward push |
| B9 | A local-only or unreviewed tag could be published | D.2: annotated, on origin, reachable from `origin/main` |
| B10 | v0.1.0 predates the cleanup | The first dist release is v0.2.0, cut after D.1 |
| B11 | The deny scan could fail open (missing or empty list, bad regex) | D.1 loader refuses; tripwire fails if `docs/reference/` exists without the file |
| B12 | Ledger rows (AP Labs history, one Varsity mention) would ship | D.1/D.2 ledger transform; D.3 step 3 |

**Non-blocking:**

- **N1:** Ely's real Slack id in the Brightside profile. Ely decides; replacing it changes the live demo.
- **N2:** AGENTS.md mixes rules for maintaining the template with rules for forks. A fork-facing version is a follow-up.
- **N3:** Check the licences of `.agents/` and `_bmad/` (pinned upstream copies) before the first client fork. They already ship today.
- **N4:** The dist repo's CI uses Actions minutes.
- **N5:** The scan never prints the matched term.
- **N6:** Linear releases only; a v0.2.1 after v0.3.0 can't be published.
- **N7:** Binary blobs are listed by publish; there are none today.
- **N8:** Shipped docs that mention excluded paths (for example the AGENTS.md rule) are printed by `--check` as a warning, not a failure.

## Steps only you can do (Ely, not the agent)

1. Review `docs/reference/dist-deny.txt` in D.1's PR.
2. Create the private GitHub repo `eppotter/aplabs-template`, empty (no README, licence or `.gitignore`). Optional: protect `main` against force-push.
3. Add the remote once: `git remote add --no-tags dist https://github.com/eppotter/aplabs-template.git`.
4. After v0.2.0 is cut and its tag pushed: `npm run template:publish -- v0.2.0 --first`, then run the push command it prints (or rerun it with `--push`).
5. Each later release: `npm run template:publish -- vX.Y.Z`, then push.
6. Give clients access to `aplabs-template` only, never to `AP-Labs`.

## Ledger

- Closes the template-history DEP row from plan epic-11 (option b). The Orchestrator finds its id.
- New Ely rows: create the dist repo and remote; publish and push v0.2.0 with `--first`; N1; N3.
