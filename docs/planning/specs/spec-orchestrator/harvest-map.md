# Harvest map

Where each capability's prior art lives. All sources are read-only.

- **AGL** = `git -C ~/Projects/AI-Governance-Layer show main:<path>`: the newest generic versions of Varsity's hooks.
- **BI** = `git -C ~/Projects/bi-platform show main:<path>`: the live Varsity.
- **CC** = `git -C ~/Desktop/canoncrm show HEAD:<path>`: Ryan Iyengar's CanonCRM.

Rewrite every source against the profile. Carry no Hometown or CanonCRM specifics.

| CAP | Source | Path | Take |
|---|---|---|---|
| 1 | BI | `.claude/skills/varsity-best-practices/SKILL.md` §C.0, §C.9.1, §D | Orchestrator protocol, intake steps, ceremony table, infra-gap routing |
| 1 | CC | `AGENTS.md`; `.agents/skills/p3-mode/references/canoncrm.md` | Adapter pattern over p3; never-block-on-the-human; always-pause list |
| 2 | BI | `.claude/agents/{architect,builder,connector,refuter,scribe,sqlsmith,verifier}.md` | Role text and tool lists; strip the Hometown canon |
| 3 | AGL | `plugins/varsity-dev/hooks/varsity-session-engage.sh`, `varsity-plugin-check.sh`, `hooks/varsity-lib.sh` | Banner, plugin-version refusal, governed-iff-profile predicate |
| 4 | AGL | `plugins/varsity-dev/hooks/varsity-orchestrator-gate.sh`, `varsity-agent-banner.sh`, `hooks/hooks.json` | Gate rules 1, 2, 3 and deny; the SubagentStart marker is the only writer. Rule 3b (FAST) is left behind |
| 5 | AP Labs | `kit/lib/tier` (built) | Computed tier feeds the ceremony decision |
| 6 | AGL | `agents/varsity/verify/run-all.js`, `common.js`, `__tests__/run-all.test.js`; `plugins/varsity-dev/hooks/varsity-stop-verify.sh` + `__tests__/stop-verify.test.sh` | Ordered checks, last-line JSON, skip ≠ pass, exit 0/1/2; Stop-hook blocking rule |
| 7 | CC | `scripts/codex-review.ts`; `docs/agent-coordination.md` §5 | Round counting, rubric, refusal past budget, repeated-file flag, PR-body line; the Claude-reviews-Codex command |
| 8 | BI | `.claude/agents/refuter.md`; best-practices §C R9, R12 | Evidence rule, refute-before-record |
| 9 | AP Labs | `docs/reference/05-discovery-process.md` | Discovery stages, rule cards, client-owner sign-off |
| 10 | BI | best-practices §C stage map (dev validate, flag flip, queue) | The add-on stage definitions |
| 11 | BI, CC | BI `agents/varsity/docs/build-ledger.md` (format only); CC `scripts/p3-retro.ts`, `.agents/skills/p3-mode/playbooks/retro.md` | Ledger rows and DEP rows; the measured retro |
