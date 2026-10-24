# Vendored p3-stack

`.agents/skills/` holds [p3-stack](https://github.com/uzairansaruzi/p3-stack) at upstream commit `09909eb` (2026-10-05), MIT ([LICENSE](LICENSE)). p3-stack adapts [pstack](https://github.com/cursor/plugins/tree/main/pstack) by poteto for T3 Code. It is the same commit CanonCRM vendors.

It is copied in, not installed with its `install.sh`, so the repo carries a pinned, reviewable copy. Claude Code reads it through the `.claude/skills` symlink; Codex and T3 read `.agents/skills/` directly.

## Local changes

Path fixes only:
- `agents/*.md` moved to `.agents/skills/p3-mode/agents/`.
- The two references to `agents/comment-sicko.md` (`p3-mode/playbooks/autopilot-stack.md`, `no-comments/SKILL.md`) point at the new path.

AP Labs rules that override p3 (review budgets, merge rules, when each skill runs) live in `docs/orchestrator/DESIGN.md` and the rules layer, never in these files.

## Resync

```bash
git clone https://github.com/uzairansaruzi/p3-stack /tmp/p3-stack
git -C /tmp/p3-stack diff 09909eb HEAD -- skills | git apply -3 --directory=.agents -p1
```

Then reapply the path fixes, run `npm run check && npm test`, and update the commit above.
