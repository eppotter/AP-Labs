# Plan review: tier-floors

Plan: `plan-tier-floors.md` (closes #68). Reviewer: the architect agent (Claude Code, claude-opus-5-5), 2026-10-24. Covers the design review and the plan review, through the adversarial and edge-case lenses.

**Verdict: ready with changes.** Every change below is folded into the plan. Ely approved it afterwards (`approve plan tier-floors`, 2026-10-24).

## Findings

1. **BLOCKING:** `gate.exempt` lets matching targets through before the tier is checked (`kit/lib/gate/index.js`, rule 5), so a profile could wave guarded paths through, `.aplabs/**` included. *Folded in:* a target under `ENGINE_T3` is never exempt. AC2 and the Files list cover it.
2. **BLOCKING:** `kit/fixture/md-probe.js` reads the publish token. *Folded in:* added to the floor.
3. **BLOCKING:** `kit/runtime/access` relies on `resolveAccess` in `kit/lib/permissions`. *Folded in:* `kit/lib/permissions/**` added.
4. **ADVISORY:** the hook wiring (`.claude/settings.json`, `.codex/hooks.json`) is the cheapest way round the hooks floor. *Folded in:* both added.
5. **ADVISORY:** `kit/lib/secrets` is T3 only in Brightside's profile. *Folded in:* added to the engine floor. Connectors and approval-write go to a follow-up.
6. **ADVISORY:** `data` and `sql` are already T2 under Brightside. *Folded in:* reworded to "T1 or T2 today".
7. **ADVISORY:** "treated as T3" isn't enforced until `ENGINE_T3` lands. *Folded in:* that edit is the builder's first commit, and the plan is engaged with this review before the build starts.
8. **ADVISORY:** renames can hide a moved guarded folder. *Folded in:* AGENTS.md intake uses `--no-renames`.
9. **ADVISORY:** a lockout is possible if the gate wrongly denies. *Folded in:* a break-glass paragraph in `kit/hooks/README.md`.
10. **ADVISORY:** side effects. *Folded in:* the Risks section covers the README becoming T3, open branches keeping the old rules until they merge `main`, and CI staying unaffected.
11. **Checks that pass:** the paths exist (`kit/runtime/sql/index.js`, `kit/runtime/data/{index,motherduck}.js`). Engine T3 is checked first, so the inert rule can't lower it. Raise rules ignore case, paths are normalised, and edits through a symlink resolve to the real path.

**Out of scope (agreed):** `kit/lib/review`, `kit/lib/land` and `kit/lib/verify` go to a follow-up. `kit/runtime/slack` stays out, because the access decision is made in access and permissions.
