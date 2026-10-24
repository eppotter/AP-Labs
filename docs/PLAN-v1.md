# PLAN v1: the engagement starter template

Status: proposed · 2026-10-23 · Owner: Ely Potter

Scope is set by [ADR 0002](adr/0002-engagement-starter-template.md), which replaces the kit-only scope of ADR 0001. The design reference is [`reference/03-target-build.md`](reference/03-target-build.md); IDs such as PR-01 and TA-13 refer to it.

## 0. What this is

AP Labs is a consulting practice. Companies want AI in their day-to-day work but don't know how to start. Handing out Claude licences and letting people figure it out rarely works. An engagement:

1. Deep dive on the org.
2. Pick one or more starter problems.
3. Stand up the client's AI platform from this template and build the tools that solve those problems.
4. Train a set of the client's builders to keep building on it, then leave.

Every org is different, so there is no one-size product. **This repo is our starter template:** the scaffolding and basic building blocks we fork on day one of an engagement so we never rebuild Varsity from scratch. Client modules are built in the fork, not here.

**The test for any component:** would we want it on day one of a new engagement?

The reference implementation is Hometown's Varsity. For example, sales reps open a Slack module and in plain English pull Salesforce contacts, score them as leads, build a Gong-format list and push it to Gong (or to Instantly or Apollo). The template should make that kind of module quick to build for the next client.

**Done when**, in a fresh fork configured for the Brightside demo client:

1. The Slack app boots in dev, with hub menus driven by the registry and access driven by the profile.
2. A new module is added by filling in the module template: a manifest and a handler.
3. The demo flow works against the Brightside fixture through a mock connector: a plain-English request → scoped pull → scoring → approval → push to a mock external tool.
4. The build governance works in the fork: the gate blocks an unplanned write; tier and permissions resolve from the profile; verify runs the profile's checks.
5. Two forks differ only in their profile and their own modules (ENGINE / PROFILE / INSTANCE).
6. Local development and CI build the Brightside fixture offline from versioned seed data, and Ely and a teammate can reach the same published copy online.

---

## 1. Not doing

Rewrites usually run 2–3× their estimate. Holding to this list is how V1 finishes. Anything below needs a new ADR to come back in.

| Not in V1 | Why | Comes back when |
|---|---|---|
| Client-specific modules | They live in the client's fork, not the template | Never; harvest a module back only once it has proven generic |
| Surfaces other than Slack (Teams, CRM-embedded, web) | Slack is the one surface Varsity proves; the module contract keeps others possible (TA-17) | An engagement requires one |
| All six module archetypes | V1 ships the two the demo flow needs: scoped pull and approval-gated write | An engagement needs another one |
| A full cleaning-company data model | The fixture exists to exercise the blocks; Tier 1 is enough | A demo scenario needs a specific table |
| Production warehouse, production data, or live CRM integration | V1 uses a shared online test database with synthetic data only; no client runtime or CRM vendor has been selected | A client asks, and the integration is scoped separately |
| FAST lane (`fast-lane.js`) | Its vocabulary is a schema design of its own. Without it, every write needs an engaged agent, which is acceptable for a prototype. | After the prototype, as its own PR |
| Review pipeline: queue run/scout/dispatch/synopsis, author-record, codeowners, carry-forward, auto-merge | Large, and `gh`-bound. Not in the done-definition. | V2 |
| Command index, statusline, stage tracker | Convenience, not governance | V2 |
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
  - key: HANDBOOK
    label: Read the ops handbook
    open_access: true               # everyone, incl. people not in users; deny still wins
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
      run: [npm, test]               # argv array, never a shell string
```

**Checks are argv arrays, not shell strings.** This removes shell interpretation of profile content (PR-07). It does not make a check safe, since `[sh, -c, …]` is still expressible. The controls are the T3 floor on the profile below and the execution policy in PR 8.

**Hard-coded in the engine, not the profile:** `.aplabs/**` is always T3. A profile edit is a permission and tier change. Letting a profile lower its own floor would break PR-01, and per PR-07 configuration is untrusted input.

**Changes from the harvested model:**

- `slack_id` becomes `id` plus `identities.{slack,github,…}`, because Slack is a surface and not an identity.
- The resource catalog moves from code into the profile. The old catalog listed Hometown hubs, so it was profile content living in the engine.
- `version` becomes `schema_version`.

**Deferred to later schema versions:** ceremony profiles (TA-09), FAST vocabulary, approver-per-tier mapping, knowledge-source registry, domain authority. Each lands with the component that reads it, never ahead of it.

---

## 3. Conventions

PR #1 delivered the skeleton: the layout, `node:test`, and CI on Node 20 running syntax checks, shellcheck, tests and the verify harness.

Conventions from here:

- **Dependencies:** `yaml` and `ajv`, pinned exactly, with `package-lock.json` committed. Each further dependency needs a line in the PR saying why.
- **Hooks:** thin bash wrappers call a Node entry point. Hooks fail open (a parse error allows the action) and log to `.aplabs/log/`. Libraries fail closed (a malformed profile refuses to start). That split is deliberate.
- **Tests** read client specifics from fixtures under `test/fixtures/profiles/`, never from `profiles/brightside/`. The demo profile can change without breaking unit tests.
- **Stubs** throw `NOT_IMPLEMENTED` until their PR lands. The verify harness reports a skip as a skip.

### Test data and external systems

- **The shared test dataset is online.** Ely and at least one teammate need to access and work with the same DuckDB dataset remotely. MotherDuck Lite is the leading hosting candidate, pending validation that its current plan, access controls, and collaboration workflow fit the prototype. Record the hosting choice and setup in the implementation PR.
- **Size it to the blocks.** Tier 1 (about 15 tables: clients, properties, packages, plans, crews, visits, invoices, payments and their supporting tables) is enough to drive the demo flow. Grow it only when a demo scenario needs a table.
- **Use synthetic data only.** Seed the shared database with clearly fictional records representative of the workflows under test. Keep it separate from client and production data. It is a collaborative test fixture, not a production warehouse, authorization source, or production telemetry service.
- **Keep automated tests deterministic.** Store the schema and seed data in the repository. Unit tests and CI create an isolated local DuckDB database from those same files; they must not require network access or shared-service credentials. The online database is for collaborative development and integration testing.
- **Keep credentials out of the repository and agent-visible data.** Each collaborator should authenticate through an approved user-scoped method. Do not commit service tokens, put them in profiles, or print them in test logs. Any automated access to the shared service requires a separately approved secret-injection path.
- **CRM behavior is tested through a mock adapter and synthetic records.** Implement only operations needed by acceptance scenarios (for example, look up and update a customer). The CRM vendor and any live integration remain undecided and out of V1. The mock should use the same synthetic domain and data contract as the DuckDB scenarios; whether it reads from DuckDB or separate fixtures is an implementation decision.
- Treat the database and CRM adapter as test interfaces so later client CRM or warehouse integrations do not require changes to the governance engine.
- Add and pin the DuckDB dependency when implementing the data fixture; document why it is needed in that PR, following the dependency rule above.

---

## 4. Building blocks

Each block gets a call: **Copy** (near-verbatim, tests included, fixtures swapped), **Rewrite** (keep the pattern, re-implement against the profile) or **New**. Varsity runtime sources are read-only via `git -C ~/Projects/bi-platform show main:agents/varsity/<path>`. Governance sources are in the archived repo via `git -C ~/Projects/AI-Governance-Layer show main:<path>`.

### Runtime: what the client's people use

| # | Block | What it gives us on day one | Varsity source | Call |
|---|---|---|---|---|
| R1 | App shell | Slack Bolt app, config and env loading, startup, deploy files | `index.js`, `config/`, `railway.toml` | Rewrite: Varsity's `index.js` hard-wires nine Hometown hubs |
| R2 | Hubs + registry | Slash command per hub, Block Kit menu, entries declared as data | `hubs/registry.js`, `hubs/handler.js`, `hubs/user-hubs.js` | Copy the pattern; entries and hubs come from the fork |
| R3 | Module contract | One manifest + handler per module: hub, label, resource key, archetype | none; 04 §2.8 | New |
| R4 | Access wiring | Menus and actions check `kit/lib/permissions` | `myaccess/` | Rewrite on #4 |
| R5 | LLM service | Claude client, prompt assembly, tool definitions and dispatch | `services/claude.js`, `prompts/`, `tools/definitions.js`, `tools/handlers.js` | Rewrite: org context comes from the profile |
| R6 | Connector pattern | One adapter shape for any client system, with auth from env | `services/sfdc*.js`, `gong.js`, `cw-api.js`; `.claude/skills/*-connection` | New template; Varsity's connectors are reference examples |
| R7 | Mock connector | Brightside "CRM" and "email tool" over the fixture | none | New |
| R8 | SQL guardrails | Tokenizer that blocks writes and forbidden columns in generated SQL | `tools/sql-guardrails.js` | Copy; forbidden columns move to the profile |
| R9 | Archetype: scoped pull | Plain-English request → parameters → query → results; one engine | `datapull/`, `finance/`, `marketingpull/` | Rewrite as one parameterised engine |
| R10 | Archetype: approval-gated write | Preview → approve → push, with escalation | `gongcontacts/` (`push-session.js`, `escalation.js`) | Rewrite generic |
| R11 | Slack UX basics | Thread context, markdown → Slack, provenance buttons, onboarding, cache | `lib/thread-context.js`, `markdown-to-slack.js`, `provenance*.js`, `team-joined.js`, `cache.js` | Copy, mostly generic already |
| R12 | Scheduled jobs | Declarative cron registry | `crons/registry.js` | Copy the registry, no jobs |

### Build governance: what our builders and the client's builders use

| # | Block | Status |
|---|---|---|
| G1 | Profile loader + schema | 🟢 #3 |
| G2 | Permissions | 🟢 #4 |
| G3 | Tier | 🟢 #5 |
| G4 | Hook lib + governed-repo check | Copy subset of `varsity-lib.sh` |
| G5 | Write gate + engagement marker | Copy rules; `apps/**` → `gate.exempt`; FAST lane left out |
| G6 | Verify harness | Copy the contract; checks from profile `verify.checks` (argv, no shell, env allowlist, timeout; can't spawn = skipped) |
| G7 | Stop-verify hook | Rewrite against fixtures |
| G8 | Orchestrator: rules layer, agents (incl. Onboarder), BMAD + p3 installed, cross-model review script | New; design in [`orchestrator/DESIGN.md`](orchestrator/DESIGN.md), decisions in ADR 0003 |

### Order

The Orchestrator comes first: everything after it is built through it ([ADR 0003](adr/0003-orchestrator-tooling.md)).

1. **Docs:** ADR 0002 and this plan (#7). Then the Orchestrator design and ADR 0003.
2. **The Orchestrator (G8, G4–G7):** install BMAD and p3 at pinned versions, the AP Labs rules layer, the agent definitions (including the Onboarder), the cross-model review script, the hook lib, write gate, verify harness and Stop hook. BMAD then breaks the steps below into phases and stories.
3. **R1–R4:** a forkable app that boots, with one hello-world module behind the profile.
4. **Fixture Tier 1:** generator, local DuckDB build, validation. Publishing to MotherDuck is a separate step that Ely runs.
5. **R6–R8:** connector template, mock connector, SQL guardrails.
6. **R9, R5:** scoped-pull engine on the LLM service.
7. **R10:** approval-gated write. Completes the demo flow (done-definition 3).
8. **R11, R12:** UX basics and the cron registry, folded into earlier PRs where they're needed.
9. **Acceptance test:** two forks differ only by profile and modules.

One PR per story. From step 3 on, the Orchestrator's own process applies: BMAD plans, the plan gate, p3 builds, cross-model review.

---

## 5. Open items

| Item | Owner | Blocks |
|---|---|---|
| IP / employment-agreement check: cleared by Ely, 2026-10-23 | **Ely** | Nothing |
| Orchestrator design opens (file locations, pinned versions) | Claude | Step 2; see [`orchestrator/DESIGN.md`](orchestrator/DESIGN.md) §8 |
| Fixture toolchain: Python 3.12 + `uv` for `fixtures/` only, or Node throughout | **Ely** | Step 3 |
| Demo flow: the exact Brightside pull → score → push scenario | **Ely** | Steps 5–6 |
| MotherDuck: account email (venture, not Hometown), collaborator invited | **Ely** | Publishing the fixture |
| OD-04: test ceremony profiles with one non-engineer | Ely + Steven | V2 ceremony work only |
| Refuter measurement is n=7 (6 confirmed, 0 not reproduced, 1 unverifiable), which is not yet a defensible rate | Carry | Any claim in a pitch |
