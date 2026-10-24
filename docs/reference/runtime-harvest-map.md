# Runtime harvest map

Reference for `docs/planning/specs/spec-runtime/SPEC.md` (moved here so prior-art paths stay under `docs/reference/`). Where each runtime capability's prior art lives. All sources are read-only.

- **BI** = `git -C ~/Projects/bi-platform show main:<path>`: the live Varsity. Paths below are under `agents/varsity/` unless they start with `shared/` or `.claude/`.
- **AP** = this repo.

Rewrite every source against the profile. Carry no Hometown hubs, names, Slack ids, tables or channels. "Copy" in PLAN-v1 §4 means keep the logic and its tests' cases; the identifiers and canon are replaced.

| CAP | Source | Path | Take |
|---|---|---|---|
| 1 | BI | `index.js`, `config/index.js`, `railway.toml` | Required-env check at boot, Bolt init, startup order. Leave behind the nine hard-wired hubs and the host config |
| 2 | BI | `hubs/registry.js`, `hubs/handler.js`, `hubs/user-hubs.js` | Entry shape (hub, fn, label, description, visibility, accessKey, promptFor, global), menu building, dispatch re-check, private-delivery rule and its pinned exception list |
| 3 | AP | `docs/reference/03-target-build.md` TA-16, TA-17 | Manifest fields and the surface-agnostic interaction needs; no Varsity code exists |
| 4 | BI, AP | BI `myaccess/handler.js`, the `accessKey` re-probe in `hubs/registry.js`; AP `kit/lib/permissions` | Telling a config fault from a real denial; the resolver itself is ours |
| 5 | BI | `shared/claude.js`, `services/claude.js`, `prompts/system-prompt.js`, `tools/definitions.js`, `tools/handlers.js` | Hourly budget breaker, kill switch, per-call cost estimate, tool loop cap, timeout. Org context comes from the profile and `.aplabs/context/`, not a hand-written prompt |
| 6 | BI | `services/sfdc*.js`, `services/gong.js`, `services/cw-api.js`; `.claude/skills/{sfdc,cw,jira}-connection` | Auth from env, read vs write split, batching and rate limits, the connection-standard document shape |
| 7 | — | none | New. Uses the CAP-6 contract and the fixture |
| 8 | BI | `tools/sql-guardrails.js` and its tests | The single-pass tokenizer, wildcard rule, fail-closed on unterminated input, and the bypass cases its header lists. Forbidden columns move to the profile. New here: the DuckDB function and statement denylist (architecture AD-9) |
| 9 | BI | `datapull/{handler,intent,session}.js` | Interview to confirmed parameters, 30-minute session TTL, revision window, tombstone notice. One engine, not three clones (TA-16) |
| 10 | BI | `gongcontacts/{push-session,escalation,upload,handler}.js` | Opaque CSPRNG token, user binding checked before consume, single use, 30-minute TTL, consume just before the first write, per-reason escalation suppression |
| 11 | BI | `lib/{thread-context,markdown-to-slack,provenance,provenance-actions,team-joined,cache}.js` | Thread fetch, Slack formatting, 2,900-char section chunking, provenance block and handler, first-run onboarding, TTL cache |
| 12 | BI | `crons/registry.js` | Entry shape (name, schedule, run, enabled) and logging wrapper. No jobs |
| 13 | AP | `docs/PLAN-v1.md` §3; `docs/adr/0001-prototype-scope.md` | Offline seed build, MotherDuck as the shared copy, credential rules |
| 14 | BI | `gongcontacts/` end to end | Pull → list → preview → push shape, re-targeted at Brightside win-back |
| 15 | AP | `docs/adr/0001-prototype-scope.md` organising rule | ENGINE / PROFILE / INSTANCE acceptance test |
