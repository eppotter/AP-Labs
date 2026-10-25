---
name: ap-labs-venture
description: AP Labs — Ely + Steven's venture repo, a from-scratch build of the governance kit; replaces AI-Governance-Layer; standing rules and state
metadata:
  type: project
---

Repo `~/Projects/AP-Labs` (private, github.com/eppotter/AP-Labs). Decided 2026-10-23: **build up from scratch** instead of pruning the Hometown port in `~/Projects/AI-Governance-Layer` (that repo is to be archived; its 0.3c branch was abandoned uncommitted). The kit is the product; the Varsity Slack runtime is not assumed.

**Why:** pruning kept breaking tests that pinned Hometown specifics, the scrub had no clear finish line, the ported history carries Hometown code plus licensed STK Bureau fonts, and IP provenance is cleaner with design-only reference.

**How to apply:**
- Seeded 2026-10-23 (`052f740`): README, `docs/reference/` 02 competitive research, 03 target build (the spec), 05 discovery (Hometown cards cut), research_notes. 01 inventory, 04 proposal, old plan and wave-0 findings stay in the old repo as reference only.
- Reference `~/Projects/bi-platform` **read-only**, preferably committed `main` via `git -C ~/Projects/bi-platform show main:<path>`. Never run npm/node/tests/checkout/pull there; Ely has work in flight. Don't load its CLAUDE.md (about 29k tokens).
- Git: repo-local credential helper uses `gh auth token --user eppotter`; prefix gh with `GH_TOKEN=$(gh auth token --user eppotter)`. Never switch the global gh login (`elypotter-ht`). Branch + PR from here on.
- Open before planning: V1 scope (kit only vs kit + runtime); IP check cleared by Ely 2026-10-23.
- Next: plan session (Opus). V1 scope → profile schema → engine skeleton → port list (copy nearly verbatim vs rewrite against the profile).
- Token economy: one session per PR, no subagents unless asked, output to files, start sessions inside AP-Labs (not AI-Governance-Layer, whose hooks block pushes and load its big CLAUDE.md).
