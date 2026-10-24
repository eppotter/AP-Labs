# AP Labs: agent guide

Read this before working in the repo. It applies to every coding agent (Claude Code, Codex, others).

## What AP Labs is

A consulting practice (Ely Potter, Steven Auslander). Companies want AI in their day-to-day work but don't know how to start. An engagement:

1. Deep dive on the org.
2. Pick starter problems.
3. Build the client's AI platform and tools from this template.
4. Train the client's builders to keep going, then leave.

## What this repo is

**Our starter template, not a product.** A generalised version of Hometown's Varsity platform that we fork on day one of each engagement. It holds the building blocks: the Slack runtime, module and connector patterns, and build governance. Client-specific modules are built in the fork, never here.

**The test for any change:** would we want this on day one of a new engagement?

- Scope: `docs/adr/0002-engagement-starter-template.md`
- Plan and order of work: `docs/PLAN-v1.md`. §4 lists every building block and its status.
- Design reference: `docs/reference/03-target-build.md`

## Layout

- `kit/`: the template's engine. `lib/profile`, `lib/permissions` and `lib/tier` are built; `plugin/` and `verify/` are in progress.
- `profiles/`: client profiles and their JSON Schema. Brightside Home Cleaning (fictional) is the demo client.
- `examples/`, `test/`: install example, unit and acceptance tests (`node:test`), fixtures.

## Rules

- **Node 20, bash.** `npm ci`, then `npm run check && npm test` before every commit.
- **Git:** branch off `main`, one PR per block, merge commits (no squash). Never push to `main` directly.
- **PR descriptions open with `**What this does:**`** followed by one or two plain-language sentences. Technical detail goes below.
- **Tests read client specifics from fixtures,** never from `profiles/brightside/` or any client path.
- **Profiles are untrusted input.** The schema rejects unknown keys. `.aplabs/**` always floors at T3.
- **Secrets:** never read, print, log or commit tokens. Commands that need a credential (for example publishing the fixture) are run by Ely, not by an agent.
- **Reference repos are read-only:** `~/Projects/bi-platform` (live Varsity) and `~/Projects/AI-Governance-Layer` (archived). Read them with `git -C <repo> show main:<path>`. Never check out branches, install or run anything in them.
- **No Hometown specifics** (names, paths, Slack ids, data) in this repo outside `docs/reference/`.
