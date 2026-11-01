# Changelog

Releases of the AP Labs starter template. A release is an annotated git tag
`vX.Y.Z` on `main`. Each entry is written and reviewed in a normal PR before
the release; `npm run template:release` checks the entry is here and never
writes it. `package.json` stays at `0.0.0`: the tag is the version.

A fork records the release it is built from in `.aplabs/template-version`
(`npm run template:check -- --record vX.Y.Z`), and its CI checks the engine
(`kit/`, `profiles/_schema/`) is still that release's.

## Release checklist

1. Write this release's entry below in a normal PR, with "What changed" and "What a fork must do", and get it reviewed and merged.
2. Re-pin the base image digest in `Dockerfile` (the newest `node:24` Debian slim, amd64) in its own PR, and let the `container` job pass on it.
3. Wait until every check on `main`'s head has passed (`test`, `clean-bones`, `container` and `dist` among them).
4. On a clean, up-to-date `main`, run `npm run template:release -- vX.Y.Z`. It tags locally and refuses, naming the reason, if anything above is not true.
5. Ely pushes the tag (`git push origin refs/tags/vX.Y.Z`, or the command again with `--push`). The Orchestrator never pushes tags.
6. Run `npm run template:publish -- vX.Y.Z`; Ely pushes the dist commit and tag (the command it prints, or the command again with `--push`). The Orchestrator never pushes to the `dist` remote.

## Unreleased

### What changed

- `THIRD_PARTY_NOTICES.md` carries BMAD-METHOD's MIT licence, which the bundled `_bmad/` copy needs in every copy, and points to p3-stack's.
- Ledger rows without merge conflicts: each PR adds its one ledger row in its own build file, `docs/ledger/builds/<branch>.md` (`docs/ledger/README.md` says what it holds), so two open PRs no longer conflict over `docs/ledger.md`. DEP rows stay in `docs/ledger.md`. `scripts/ledger-check.js` fails a PR that deletes a build file, edits another PR's, reuses a branch name or adds a row in two places, and `npm test` checks every row together. A template update keeps the fork's `docs/ledger/` as it is (fork-owned), and no build file ships.
- CI runs every job on every push to `main` again.
- Request a tool posts from any hub, including one that sees business context or data (plan brightside-v1, D12, gate item 7; on by default). Its summary call still sends no business context (`withContext: false`, now asserted at call time), so the post holds only the person's previewed words, the AI's summary of them, the hub's name and the requester. Before, a hub that saw context or data said "not available on this hub yet".
- Ask points a route question to a routing-map tool on the hub (Run), once the hub's data and rules are set up, and Data sources says how many rule cards are approved.

### What a fork must do

- Keep `THIRD_PARTY_NOTICES.md` in the fork.
- Before taking this release, check who reads the fork's `slack.build_requests_channel`: a hub that sees data or context with a Request a tool module can now post there. To keep such a hub from posting, take its Request a tool module off it.
- Nothing for the ledger: a fork made before `docs/ledger/` keeps adding rows to `docs/ledger.md`, which still passes `ledger-check`, and the update adds no `docs/ledger/` to it. To switch to build files (no ledger conflicts between the fork's own PRs), copy the README in from the release, `git checkout vX.Y.Z -- docs/ledger/README.md`, and put each new PR's row in `docs/ledger/builds/<branch>.md`.
## v0.2.0

The runtime phase, and the first release client forks can take. It is published to the distribution repo (`aplabs-template`), whose history starts here.

### What changed

- The Slack runtime: hubs, modules, scoped pulls, "How was this made?", the approval-write archetype and connectors with kill switches and idempotency (Epics 8 to 10).
- The AI parameter filler ("Read my request"), which fills a module's form from a plain-language ask and falls back to the form (Epic 9).
- The fixture tooling and the MotherDuck read path for the demo data.
- Scheduled jobs, the container and its health check (Epic 11).
- Template releases and updates: `template:release`, the "engine untouched" check, `template:update`, and `template:publish` with the distribution repo and its `dist` CI job.
- The test suite split into `npm test` and `npm run test:slow`.
- Known gap: Epic 10's write path (push to the email tool) passes its tests and CI, including the whole Win-back demo offline, but has not yet been checked live in Slack. That check comes in a later release.

### What a fork must do

- Start the fork from this release: follow `docs/fork-guide.md`. Clone `aplabs-template` at `v0.2.0`, never the AP Labs source repo, and rename the remote to `upstream`.
- Run the fork guide's day-one checklist: write the client profile, record the engine with `npm run template:check -- --record v0.2.0`, and keep or remove the Brightside example.
- Before any module writes to a real client system, check the write path live in the client's Slack: a dry run first, then a small real push.

## v0.1.0

The Orchestrator phase: the template as it stood just before the runtime phase plan (#52) merged.

### What changed

- The client profile, its JSON Schema, permissions and computed tiers (`kit/lib/profile`, `kit/lib/permissions`, `kit/lib/tier`).
- The Orchestrator: the session banner, the agent roster, the rules layer, the write gate, the plan-approval gate and add-on stages.
- Cross-model review with the Refuter (`npm run review`), and `npm run land`.
- The verify harness and the end-of-turn verify hook (`npm run verify`), onboarding builds and known truths (`npm run onboard`).
- The build ledger, the measured retro (`npm run retro`) and Slack progress updates (`npm run notify`).

### What a fork must do

- Nothing: no fork was built from this release. It marks the starting point of the template's history.
