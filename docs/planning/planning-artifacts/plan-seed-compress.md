# Seed compression: plan for Ely

Status: **approved** by Ely (`approve plan seed-compress`, 2026-10-25), with the recommended decisions. Architect design review and plan review done 2026-10-25, all findings folded in.

**In short:**
1. The new Brightside data made the committed seed files 14.4 MB, so you raised the cap to 20 MB for now and asked to bring 10 MB back.
2. Compressing the seed files (gzip) shrinks them to about **2.8 MB**, well under 10 MB, with room to grow.
3. The cap goes back to 10 MB everywhere it's written down, and the data and its version number don't change at all.

## What you're approving

- [ ] **Seeds stored as `seeds/*.csv.gz`** instead of `*.csv`. One exception: `fixture_meta.csv` stays plain, because it's tiny and keeps the version readable on GitHub.
- [ ] **The engine reads both forms:** plain `.csv` (every kit test fixture, and every new engagement, starts that way) and `.csv.gz`. One seed-listing helper handles both and refuses a seed present in both forms.
- [ ] **Stable across machines:** gzip bytes can differ between a Mac and CI's Linux, so the check compares the *unzipped* content instead. The generator rewrites a `.gz` file only when its unzipped content changed, so files never churn.
- [ ] **Same version number:** the fixture version hash is computed from the unzipped content under the old `.csv` names, so it stays `3+80453e2a90d0`. MotherDuck and the bot see no change.
- [ ] **The 10 MB cap is back** in `SPEC.md`, `fixture-tables.md`, the epic acceptance criteria and the size test, and the note about the temporary raise is removed.
- [ ] **One trade-off:** GitHub can't show a line-by-line diff of a `.gz` file. A small follow-up story adds `npm run fixture:diff`, which prints a readable diff between two commits, for any fixture.

## The story

| Story | Who runs it | Size | You will see |
|---|---|---|---|
| Seed compression | Builder | S–M | `examples/brightside/fixture/seeds` at about 2.8 MB, the cap back at 10 MB, and every check passing |

Tier **T3**, computed: the version hash lives in `kit/fixture/remote.js`, an engine floor since #115.

**Acceptance criteria:**

1. The generator writes `seeds/*.csv.gz` (no stored name or time, fixed level, OS byte set to 255), except `fixture_meta.csv`. It leaves a `.gz` alone when its unzipped content already matches, and deletes stale `seeds/*.csv` for compressed tables.
2. One seed-listing helper in `kit/fixture/build.js` accepts `x.csv` or `x.csv.gz` and refuses both together. `plan`, `readHeader` (which must unzip), `seedsHash` and `seedMeta` all use it.
3. `fixture:check` compares unzipped content plus a valid gzip header, never raw gzip bytes, so it passes on macOS and Linux alike.
4. `seedsHash` hashes each seed under its `seeds/x.csv` name, with the unzipped length and body. The fixture version is unchanged, and a test proves it against the current version.
5. Built from the compressed seeds, `brightside.duckdb` holds exactly the same rows as before. The build loads with `COPY` into typed tables, so types and values don't change.
6. The size test is back at 10 MB, and the docs are updated.
7. `npm run check`, `npm test`, `fixture:check`, `fixture:validate` and `verify` all pass, on this Mac and in CI.

**Files:**
- `examples/brightside/fixture/generate.js`
- `examples/brightside/fixture/__tests__/` (`activity`, `operations`, `build`, `validate` and `generate` tests). validate's edited-copy tests must delete the matching `.gz`.
- `kit/fixture/build.js`, `remote.js` and `status.js`
- the seeds
- `SPEC.md`, `fixture-tables.md`, `epics-runtime.md`, `docs/runtime/motherduck-publish.md` (line 40)
- `docs/ledger.md`

## Risks

- **Reviewing seed changes:** the GitHub web view gets harder until the `fixture:diff` follow-up lands.
- **The repo history still holds the old 14 MB CSVs.** Removing them from history isn't worth it at this size.
- **Blast radius:** CI's `fixture:check` and every fixture test. The version stays the same, so MotherDuck and the bot see no change.
- **Order:** it shares only `docs/ledger.md` with publish-in-place, so either can go first.

## To approve

Type `approve plan seed-compress`, with any changes in the same message.
