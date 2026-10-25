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
3. Wait until every check on `main`'s head has passed (`test`, `clean-bones` and `container` among them).
4. On a clean, up-to-date `main`, run `npm run template:release -- vX.Y.Z`. It tags locally and refuses, naming the reason, if anything above is not true.
5. Ely pushes the tag (`git push origin refs/tags/vX.Y.Z`, or the command again with `--push`). The Orchestrator never pushes tags.

## Unreleased

### What changed

- The runtime phase: the Slack runtime (hubs, modules, scoped pulls, the approval-write archetype and connectors), the AI parameter filler, the fixture tooling, scheduled jobs, the container and its health check, and template releases with the "engine untouched" check.

### What a fork must do

- Written with the v0.2.0 entry, once Epic 10 is live-checked and Epic 11 has merged.

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
