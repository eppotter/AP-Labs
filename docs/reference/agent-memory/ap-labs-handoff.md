---
name: ap-labs-handoff
description: START HERE — handoff for the first AP-Labs session (planning); what to produce, inputs, what to harvest, open decisions
metadata:
  type: project
---

Written 2026-10-23 at the end of the last AI-Governance-Layer session. Rules and setup: [[ap-labs-venture]]. Working style: [[token-economy]].

**Decided 2026-10-23 (Ely): V1 is a PROTOTYPE, kit only, Node 20 + bash.** No Slack runtime, DuckDB or mock CRM until a client asks.

**Status (2026-10-24 ~23:30) — MACHINE MOVE.** Ely halted to move to a new computer. The full, current handoff is in the repo: `docs/HANDOFF.md` (read it first; it supersedes the status paragraph below). Main = #104 + the handoff PR. All pre-Epic-10 fixes merged (#97 #99 #101 #102 #103 #104). Bot stopped. Next: finish the fix-sweep retro (75% fix share breach), then wait on Ely for the Slack live check, MotherDuck, `approve plan motherduck-read`, 4.3, #68. Ely said "Focus on the fixes": do not start Epic 9 unasked.

**Older status (superseded):** (2026-10-24 ~10:30) — RUNTIME PHASE APPROVED, BUILDING:** Merged #1–#52. Ely approved the runtime plan and the fixture schema with all recommended decisions (#52; epics-runtime.md status approved). 30 stories in Epics 6–11 (epics-runtime.md; design in architecture-runtime.md AD-1..18). 6.1 MERGED (#55; Socket Mode bot, kit/lib/secrets, kit/runtime/log; the live check waits on Ely's bot tokens). Node moved to 24 LTS (#57, ADR 0004; Bolt's undici needs Node ≥22.19). 7.1 MERGED (#53; 2,000 clients, seed 20241001, `npm run fixture:check` in CI). 7.2 MERGED (#59; 14 tables, targets.json planted figures, summer 2026 price-rise default; 7.6 TRAP: one plan ends ON as_of, so 'active at as_of' = 815 but status='active' = 814: use the definition). 7.3 MERGED (#60; `npm run fixture:build` → var/fixture/brightside.duckdb; @duckdb/node-api 1.5.6-r.2 pinned over 2.0 because MotherDuck compatibility is unknown). 6.2 MERGED (#62; /brightside hub, registry, store, slack:manifest generator, APLABS_ENV). #64: profiles/** at T3, isClean accepts 'no defects'. 7.4 MERGED (#65; kit/runtime/sql checkSql + profile sql.forbidden_columns; P2 #66 nested comments). New worktrees need `npm ci` (DuckDB). 6.3 MERGED (#67; kit/runtime/access, errors.js, messages.js). Retro over #42-#67 run (no breaches). #68 OPEN, needs Ely: access code tiers at T1. #69 MERGED (retro-runtime-1, conflict-marker check in npm run check). 7.5 MERGED (#70; kit/runtime/data, ctx.data.run, Dataset module, DATASET open_access; architect P2s in #71). 6.4 MERGED (#72; welcome/Help/team_join; Ely must add team_join event live; P2 #73 escape client name). 6.5 MERGED (#74; kit/templates/module, #sdk imports, clean-bones CI job). EPIC 6 DONE; retro #75 (AGENTS.md rule: no parallel builders on the same engine file; AGENTS.md edits need a ledger row because it is outside docs/). sprint-status updated. 7.6 MERGED (#76; fixture:validate, 7 truths exact in profiles/brightside/context/data.md, owner Dana Reyes pending; P2s #77). #79 MERGED (hardening; closes #66 #71 #73). 7.7 MERGED (#78; ELY to run publish per docs/runtime/motherduck-publish.md; first real MotherDuck run, may need a small fix). 8.1 MERGED (#80; connector contract + suite; follow-ups #82 MUST be fixed before 8.3 writes, incl. DEP for approval-only writes in 10.x). #81 = review parser accepted a self-contradicting Codex finding (fix in kit/lib/review). 8.2 MERGED (#83; examples/brightside/app/connectors/crm, deps.data seam). #86 MERGED (closes #77; APLABS_GOVERNING_PROFILE, build stamp; follow-ups #85 publish fail-open, #87 stamp is forgeable). #88 MERGED (closes #82 #84; DEP-012 approval-only writes blocks 10.2; P2 #89 Retry-After clock). 8.3 MERGED (#91; email connector + gated OUTBOX module; P2s #92 must be fixed before 10.3). EPIC 8 DONE; retro #93 (fix share 38% breach → AGENTS.md rule: T2/T3 safety P2s fixed before merge). Ely was pinged to compact at the Epic 8 boundary. Runtime phase: 15/30 stories (Epics 6 and 8 done; 7 done except Ely's publish run). NEXT: Epic 9 (buildable on fakes; live needs Ely's Anthropic key) or Epic 11. Before 10.x: DEP-012, #90, #92. Open follow-ups: #81 #85 #87 #89. Ely: #68, 4.3 approval, MotherDuck publish, bot tokens, team_join event. 4.3 is an ONBOARDING build: needs Ely to write approve plan <slug> first. (Superseded: 7.2 (activity tables + targets.json, branch runtime/story-7-2-fixture-activity). Follow-up: #54 (postal-code prefix, cosmetic). The build loop is per AGENTS.md; land with `npm run land`; ledger row per PR; update sprint-status in batches (builders don't touch it). Ely's human steps: Brightside Bot app plus tokens (Epic 6 live check), an Anthropic key (Epic 9), #brightside-ops (Epic 10), MotherDuck publish (7.7). Explain dev concepts plainly to Ely.

**This session's job:**
- **PR 1:** scaffold the layout below. Stubs, CI and a passing smoke test; no harvested code yet.
- **PR 2:** `docs/PLAN-v1.md`, the harvest order, one PR per component.
IP/employment-agreement check: CLEARED, Ely confirmed 2026-10-23 ("we are good to go"). Do not re-flag it.

```
kit/                       ENGINE (ships to clients)
  plugin/                  Claude Code plugin (.claude-plugin/plugin.json)
    hooks/ agents/ skills/ write gate, stop-verify, banner; generic specialists; generic rule body
  lib/profile/             load + validate profile (JSON Schema)
  lib/permissions/         access from profile (harvest PR #5)
  lib/tier/                blast radius from profile paths (tier-floor, rewritten)
  verify/                  run-all harness
profiles/_schema/profile.schema.json
profiles/brightside/profile.yml           PROFILE (demo client)
examples/brightside-install/              INSTANCE (fake client repo with the kit installed)
test/acceptance/                          two installs differ only by profile
docs/reference/ (seeded) · docs/PLAN-v1.md · docs/adr/
.github/workflows/ci.yml                  syntax, unit, hook and acceptance tests
```

**Prototype done when**, all in `examples/brightside-install`: the kit installs; the gate blocks an unplanned write; tier and permissions resolve from the profile; swapping in a second profile changes behaviour with no code change.

**PLAN-v1.md should cover, in order:**
1. The "not doing" list. Hold to it hard: rewrites usually run 2–3× their estimate.
2. Profile schema. The organising rule is ENGINE / PROFILE / INSTANCE: generic mechanism ships in the kit, client inputs are declared in a profile, and the two resolve at runtime. Acceptance test: two installs differ only in their profiles. Brightside Home Cleaning (fictional multi-branch residential cleaner) is profile #1; Hometown could be profile #2.
3. Engine skeleton: repo layout, CI, test runner.
4. Port list. For each component: copy nearly verbatim (tests included), rewrite against the profile, or leave behind. One PR per component.

**Inputs:**
- In this repo: `docs/reference/03-target-build.md` (the spec: 11 principles and 3 layers), 02 competitive research (12 capability gaps), 05 discovery process.
- In the archived old repo, reference only: `/Users/ely.potter/Projects/AI-Governance-Layer/docs/platform-kit/01-current-state.md` (125-item inventory) and `04-modernization-proposal.md`. Section 1 of 04 has the ENGINE/PROFILE/INSTANCE pattern; section 2 has per-item keep/update/remove calls (about 30 KEEP, 28 UPDATE); section 5 has its "where I may be wrong" points. Rewrite those for a build-up, not a prune.
- Live reference: `~/Projects/bi-platform`, read-only via `git -C ~/Projects/bi-platform show main:<path>`.

**Harvest first (newest generic code, written in the old repo):**
- PR #5: profile-backed permissions (`agents/varsity/permissions/catalog.js`, `profile.js`, `index.js`, with `platform.yml` users as the only access source).
- PR #2: govern by profile presence, not repo name (`plugins/varsity-dev/hooks/varsity-lib.sh`).
- The `plugins/varsity-dev` hook and test suites (Orchestrator gate, stop-verify, tier-floor, command-index). They're battle-tested, but tier-floor, command-index and stop-verify pin Hometown paths, so they need their fixtures rewritten.
- The verify harness (`agents/varsity/verify/`).
Read the merged versions with `git -C /Users/ely.potter/Projects/AI-Governance-Layer show main:<path>`.

**Known findings to carry:**
- Refuter measurement (0.5): 6 confirmed, 0 not reproduced, 1 unverifiable. n=7, so not a defensible rate yet.
- BMAD is MIT-licensed; the name is trademarked, so never use it in the product name.
- Coupling lesson: in the old repo, tests kept pinning client specifics (module dirs, hub names, file paths). New tests should read from the profile or from fixtures, never from a client's paths.

Old repo `/Users/ely.potter/Projects/AI-Governance-Layer`, archived on GitHub 2026-10-23.
