# kit/hooks

Harness hooks for repos built on this template. Each hook is one thin bash wrapper that calls a Node entry; the logic lives in `kit/lib/`.

| Hook | Event | What it does |
|---|---|---|
| `session-start.sh` → `session-start.js` | SessionStart (Claude Code and Codex) | In a governed repo (one with `.aplabs/profile.yml`), announces the AP Labs Orchestrator, the client name and the 8 core stages. If the profile is invalid it lists every validation error and says the profile must be fixed before building. In any other repo it prints nothing. Logic: `kit/lib/session`. |

Registered in `.claude/settings.json` (via `$CLAUDE_PROJECT_DIR`) and `.codex/hooks.json` (via `git rev-parse --show-toplevel`). Both harnesses get the same JSON on stdout: `systemMessage` for the user, `hookSpecificOutput.additionalContext` for the model.

## Hooks fail open

A hook must never stop a session. If `node` is missing, `npm ci` has not been run, or the script throws, the wrapper exits 0 with one short `aplabs-hooks:` note on stderr and nothing on stdout. Node's output is buffered and printed only when the script succeeds, so a crash cannot leave half a JSON payload. The cost: a broken hook looks like an ungoverned repo, so check stderr (`claude --debug`) when the banner is missing.

`APLABS_SESSION_START_JS` replaces the Node entry. It exists for tests only (to prove fail-open); do not set it otherwise.

## Codex: one-time trust step

Codex loads project hooks only from the **main checkout** (never from a linked worktree), and only after the user trusts the project and each hook in `~/.codex/config.toml`. Until the main checkout has `.codex/hooks.json` and the trust entries are in place, a Codex session is unguarded and nothing says so. The hooks do not try to detect this themselves.

To trust it, add the project and the hook's `trusted_hash` to `~/.codex/config.toml` (Codex shows the hash when it offers to trust the hook), and repeat after any edit to `.codex/hooks.json`, because the hash changes.
