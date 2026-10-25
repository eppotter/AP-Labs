# Tier floors: plan for Ely

Status: **approved** by Ely (`approve plan tier-floors`, 2026-10-24); closes #68. Architect design review and plan review (adversarial and edge-case lenses) done 2026-10-24: "ready with changes", and all changes are folded in below.

**In short:**
1. Some of the riskiest code in the kit scores only T1 or T2 today, depending on the client's profile. A change there gets lighter review and may skip the plan gate.
2. This plan locks those paths at T3 inside the engine, the same way `.aplabs/**` is locked. Every client fork inherits the rule, and no client profile can lower it: not through its tier rows, and not through the gate's exemption list.
3. It's one small story: a list of paths in `kit/lib/tier`, one rule in the gate, tests, and docs.

## What you're approving

- [ ] **These paths always score T3** (an engine floor, not a profile setting):

  | Path | What it does | Why T3 |
  |---|---|---|
  | `kit/runtime/access/**`, `kit/lib/permissions/**` | Decide who can use which tool (access asks permissions for the answer) | A bug lets the wrong person see data |
  | `kit/lib/profile/**` | Reads and checks the client's profile | The profile is untrusted input |
  | `kit/lib/secrets/**` | Reads every key (Keychain or env) | Today it's T3 only in Brightside's profile; a fork wouldn't inherit that |
  | `kit/fixture/publish.js`, `kit/fixture/remote.js`, `kit/fixture/motherduck.js`, `kit/fixture/md-probe.js` | Publish to MotherDuck with the write key; the probe reads that key to refuse it | They handle a key that can change shared data |
  | `kit/runtime/data/**` | The bot's data connection and its lockdown (local and MotherDuck) | It's what keeps the bot read-only |
  | `kit/runtime/sql/**` | The SQL checker every bot query passes | It's the only barrier for the accepted `my_db` exception |
  | `kit/lib/tier/**`, `kit/lib/gate/**`, `kit/hooks/**`, `.claude/settings.json`, `.codex/hooks.json` | The tier rules, the plan gate, the hooks, and the settings that switch the hooks on | Weakening them, or unhooking them, quietly weakens every other rule |

- [ ] **No exemption for these paths.** Today a profile's `gate.exempt` list lets matching files skip the gate before the tier is checked. From now on, a file under an engine T3 path, `.aplabs/**` included, is never exempt.
- [ ] **Already T3, unchanged:** `.aplabs/**` (engine). In the Brightside profile only: `profiles/**`, `kit/runtime/connectors/**` and `kit/runtime/archetypes/approval-write/**`. A fork gets those only if its profile lists them (follow-up below).
- [ ] **No change to the Brightside profile.** The engine floor covers every profile, so a copy in `profiles/brightside/profile.yml` would only repeat it.
- [ ] **Treated as T3 by decision.** The change computes T1 today, because `kit/lib/tier` isn't T3 yet. You chose T3 on #68, so it gets the full T3 ceremony. To make that real rather than nominal:
  - the `ENGINE_T3` edit is the builder's **first commit**, so every later edit on the branch is gated at T3;
  - the Orchestrator records the plan and its review with `npm run engage -- --plan tier-floors --plan-reviewed <review file>` before the build starts.

## The story

| Story | Who runs it | Size | You will see |
|---|---|---|---|
| Tier floors | Builder | S | `node kit/lib/tier <path>` prints T3 for each path above, under any profile |

**Acceptance criteria:**

1. `ENGINE_T3` in `kit/lib/tier/index.js` lists the paths above, alongside `.aplabs/**`.
2. A profile can't lower them. Putting one of these paths under `tiers.T1`, `tiers.T2`, `inert` or `gate.exempt` still scores T3, and the write-gate still gates it. Tests prove each case with a fixture profile.
3. A change touching any of these paths scores T3. Paths nearby but outside the list, such as `kit/fixture/build.js`, `kit/runtime/slack/` and `kit/lib/review/`, keep their current tier. Tests cover both.
4. Matching follows the engine's existing rules: case-insensitive, `**` matches any depth, a path that leaves the repo still floors at T3, and an edit through a symlink resolves to the real path.
5. Docs:
   - The tier engine's header comment and `kit/hooks/README.md` are updated. The README gains a short **break-glass** paragraph: if the gate itself wrongly blocks work, the human edits by hand or briefly removes the hook entry, then puts it right through a normal PR.
   - AGENTS.md intake step 3 says to compute the tier with renames listed as both old and new path (`git diff --no-renames --name-only`), so moving a guarded folder can't hide it.
   - The Builds row goes into `docs/ledger.md`.
6. `npm run check` and `npm test` pass.

**Files:** `kit/lib/tier/index.js`, `kit/lib/gate/index.js`, `test/unit/tier.test.js`, `test/unit/write-gate.test.js`, a new fixture profile under `test/fixtures/`, `kit/hooks/README.md`, `AGENTS.md`, `docs/ledger.md`.

## Risks

- **Slower edits in those folders.** Every change there needs a plan, a design review and your approval. Tonight, the publish fix (#106) and the probe (#108) would both have waited for you.
- **More files become T3 than you might expect.** `kit/hooks/README.md` becomes T3 (the engine floor beats the "docs are inert" rule), and so do `.claude/settings.json` and `.codex/hooks.json`. Adding a permission to `.claude/settings.json` will need a plan from now on.
- **Open branches keep the old rules until they merge `main`.** The hook runs each worktree's own copy of the code. That covers the fixture branch in progress tonight and #112.
- **The gate is a tripwire, not a lock.** It fails open if it crashes, and shell writes get past it. CI, the review and your merge authority stay the backstop.
- **Forks that move the kit.** The floors match `kit/...` paths. A fork that renames `kit/` loses them. Forks don't rename it today; this plan doesn't guard against that.
- **The order relative to #112.** #112 (compressing the seeds) changes the seeds hash in `remote.js`. If it hasn't merged by the time this lands, it runs as T3.

## Not in this plan (follow-ups to file)

- `kit/runtime/connectors/**` and `kit/runtime/archetypes/approval-write/**` as engine floors, so forks inherit them.
- `kit/lib/review`, `kit/lib/land` and `kit/lib/verify`. They don't read the tier, and CI plus merge gating backstop them, but they're worth a look.
- Changing what T3 requires.

## To approve

Type `approve plan tier-floors`. To change anything, say so in the same message, for example `approve plan tier-floors, drop .claude/settings.json`.
