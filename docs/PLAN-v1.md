# PLAN v1: the kit prototype

Status: proposed · 2026-10-23 · Owner: Ely Potter

The build plan for V1. Scope is fixed by [ADR 0001](adr/0001-prototype-scope.md): a kit-only prototype on Node 20 and bash. The spec is [`reference/03-target-build.md`](reference/03-target-build.md); IDs such as PR-01 and TA-13 refer to it.

**Done when**, all inside `examples/brightside-install/`:

1. The kit installs.
2. The gate blocks an unplanned write.
3. Tier and permissions resolve from the profile.
4. Swapping in a second profile changes behaviour with no code change.

---

## 1. Not doing

Rewrites usually run 2–3× their estimate. Holding to this list is how V1 finishes. Anything below needs a new ADR to come back in.

| Not in V1 | Why | Comes back when |
|---|---|---|
| Slack runtime, hubs, consumer surfaces (TA-17–22) | ADR 0001: kit only | A client asks |
| DuckDB, mock CRM, any warehouse | No runtime to feed | A client asks |
| FAST lane (`fast-lane.js`) | Its vocabulary is a schema design of its own. Without it, every write needs an engaged agent, which is acceptable for a prototype. | After the prototype, as its own PR |
| Review pipeline: queue run/scout/dispatch/synopsis, author-record, codeowners, carry-forward, auto-merge | Large, and `gh`-bound. Not in the done-definition. | V2 |
| Command index, statusline, stage tracker | Convenience, not governance | V2 |
| Specialist agents and the rule-body split (TA-07, TA-08) | Real design work (invariant layer vs org layer). Not needed to prove ENGINE/PROFILE/INSTANCE. | V2, first item |
| Distribution: marketplace, hard version check, plugin-cache check (TA-14) | One install, one machine | First external install |
| Windows support | Hooks are bash wrappers. Logic lives in Node so a later port is the wrapper only. | First Windows client |
| VCS adapter, telemetry, review metrics, headless sandbox | Not in the done-definition | V2+ |
| Permission backends other than the profile | Reference spec before adapters (04 §5) | A client's IdP demands it |
| Anything BMAD | MIT code, but the name is trademarked | Never in the product name |
| Hometown as a profile in this repo | Keeps IP provenance clean (see §5) | After the IP check, if ever |

---

## 2. Profile schema v1

**Rule:** ENGINE / PROFILE / INSTANCE. The kit knows mechanisms. The profile declares a client's inputs. The two resolve at runtime. Grammar stays in code and vocabulary goes in the profile (TA-13 boundary).

**Location in a client repo:** `.aplabs/profile.yml`. A repo is governed if and only if this file exists, which replaces the repo-name check (harvested PR #2 behaviour). `APLABS_PROFILE`, an absolute path, overrides the walk-up search, as `PLATFORM_PROFILE` did. The hidden directory also holds runtime markers, so they never land at the client's root.

**Format:** YAML, parsed with `yaml`. It's validated against `profiles/_schema/profile.schema.json` with `ajv` (draft 2020-12). The schema is the single source of truth and doubles as client-facing documentation. **On a malformed profile, the loader refuses to start.** Unknown keys are errors, so a typo can't fail silently.

```yaml
schema_version: 1

client:
  id: brightside                     # ^[a-z][a-z0-9-]*$
  name: Brightside Home Cleaning

# Blast radius (PR-01). The highest tier any path matches wins.
# Unmatched code floors at T1. T0 only when EVERY path is inert.
tiers:
  T3: ["billing/**", "customers/export/**"]
  T2: ["scheduling/**", "Dockerfile", ".github/workflows/**"]
  T1: ["lib/**"]
inert: ["**/*.md", "docs/**"]

# Write gate.
gate:
  exempt: ["sandbox/**"]             # paths the gate never applies to (old apps/**)
  engagement_ttl_minutes: 60

# Who can do what (PR-03: deny beats allow).
resources:
  - key: TIER3_APPROVE
    label: Approve T3 changes
    admin_grantable: false           # admin role does not confer it
  - key: VERIFY_SKIP
    label: Waive a skipped verify check
users:
  - id: dana                         # stable kit id; surface ids hang off it
    name: Dana Reyes
    role: admin                      # admin | member
    identities: { github: dana-r }
    grants: [TIER3_APPROVE]
    deny: []

# Verify harness check registry (TA-11). Generic-command adapter only in V1.
verify:
  checks:
    - id: unit
      run: "npm test"
```

**Hard-coded in the engine, not the profile:** `.aplabs/**` is always T3. A profile edit is a permission and tier change. Letting a profile lower its own floor would break PR-01, and per PR-07 configuration is untrusted input.

**Changes from the harvested model:**

- `slack_id` becomes `id` plus `identities.{slack,github,…}`, because Slack is a surface and not an identity.
- The resource catalog moves from code into the profile. The old catalog listed Hometown hubs, so it was profile content living in the engine.
- `version` becomes `schema_version`.

**Deferred to later schema versions:** ceremony profiles (TA-09), FAST vocabulary, approver-per-tier mapping, knowledge-source registry, domain authority. Each lands with the component that reads it, never ahead of it.

---

## 3. Engine skeleton

PR 1 (#1) delivered it: the layout per ADR 0001, `node:test`, and CI on Node 20 running syntax checks, shellcheck, tests and the verify harness.

Conventions from here:

- **Dependencies:** `yaml` and `ajv`, pinned exactly, with `package-lock.json` committed. Each further dependency needs a line in the PR saying why.
- **Hooks:** thin bash wrappers call a Node entry point. Hooks fail open (a parse error allows the action) and log to `.aplabs/log/`. Libraries fail closed (a malformed profile refuses to start). That split is deliberate.
- **Tests** read client specifics from fixtures under `test/fixtures/profiles/`, never from `profiles/brightside/`. The demo profile can change without breaking unit tests.
- **Stubs** throw `NOT_IMPLEMENTED` until their PR lands. The verify harness reports a skip as a skip.

---

## 4. Port list

One PR per row, in order. **Copy** = near-verbatim, tests included, with fixtures swapped. **Rewrite** = keep the semantics, re-implement against the profile. **Leave** = see §1. The source is the archived repo, read with `git -C ~/Projects/AI-Governance-Layer show main:<path>`.

| PR | Component | Source | Call | Notes | Size |
|---|---|---|---|---|---|
| 3 | Profile loader + schema v1 | `agents/varsity/permissions/profile.js` (147 ln) | Rewrite | Keep the refuse-to-start posture, the walk-up search and the env override. Validation moves to ajv and the schema. Fill in the Brightside profile. | M |
| 4 | Permissions | `permissions/index.js`, `profile.js` roster, `catalog.js`, `__tests__/{resolver,profile}.test.js` | Copy (index, tests) · Rewrite (catalog) | `decide` / tri-state / deny-wins copied as-is. The catalog moves to profile `resources`. Drop `key-consistency` and `shim` tests, which are Hometown-bound. | S |
| 5 | Tier | `plugins/varsity-dev/scripts/tier-floor.js` (323 ln) | Rewrite | Keep `globToRegExp`, the `tierOf`/`tierFloor`/`maxTier` semantics, and exit 2 on no paths (never read as T0). The four literal arrays come from the profile. Drop `autoMergeEligibility` and the ledger path. | M |
| 6 | Hook lib + governed predicate | `hooks/varsity-lib.sh` (641 ln) | Copy (subset) | Only `hook_note`/`hook_fail`/`hook_degraded`, the governed-iff-profile check and `file_mtime`. Leave dedupe, the stage tracker and the cache check. | S |
| 7 | Write gate + engagement marker | `hooks/varsity-orchestrator-gate.sh` (246 ln), `varsity-agent-banner.sh`, `hooks.json` | Copy (rules) · Rewrite (paths) | Rules 1, 2, 3 and deny carry over. Rule 1b (`apps/**`) becomes `gate.exempt`. Rule 3b (FAST) is left behind. The marker's only writer stays the SubagentStart hook, never the model. Same threat model: it deters accidents and is not a hard control. | M |
| 8 | Verify harness | `agents/varsity/verify/run-all.js`, `common.js`, `__tests__/run-all.test.js` | Copy (contract) · Rewrite (checks) | Keep ordered checks, last-line JSON, skip ≠ pass, and exit codes 0/1/2. Checks come from profile `verify.checks` through a generic-command adapter. Leave boot-smoke, flag-default-off, handler-fixtures and sql-assertions, which are Varsity-runtime checks. Replaces the stub `run-all.sh`. | M |
| 9 | Stop-verify hook | `hooks/varsity-stop-verify.sh` (388 ln) | Rewrite | On Stop, run the harness when the session wrote code. Its tests pin Hometown paths heavily (72 hits), so rewrite them against fixtures. Leave `stop-verify-select-tests`. | M |
| 10 | Brightside install + acceptance | — | New | Populate `examples/brightside-install/` (fake app tree, `.aplabs/profile.yml`, plugin wired in). Add a second fictional profile (Harbor Dental Group) as a fixture. The acceptance test checks that the same kit with two profiles gives different gate, tier and permission outcomes, and that the only diff is `.aplabs/profile.yml`. | M |

Prototype total: 8 PRs. At 2–3× overrun, plan for roughly 16–24 sessions of work, not 8.

**Coupling check on every port PR:** `grep -riE 'hometown|varsity|snowflake|bi-platform'` over the diff must return nothing outside `docs/`. In the source files, the hooks and their tests pin client specifics the most (the stop-verify test has 72 hits, the FAST-banner test 46).

---

## 5. Open items

| Item | Owner | Blocks |
|---|---|---|
| IP / employment-agreement check: Hometown-era code harvested into a venture product | **Ely** | Any client contract. Ideally before PR 3, since PRs 3–9 copy code written in the old repo. |
| OD-04: test ceremony profiles with one non-engineer | Ely + Steven | V2 ceremony work only |
| Refuter measurement is n=7 (6 confirmed, 0 not reproduced, 1 unverifiable), which is not yet a defensible rate | Carry | Any claim in a pitch |
