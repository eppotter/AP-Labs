# kit/hooks

Harness hooks for repos built on this template. Each hook is one thin bash wrapper that calls a Node entry; the logic lives in `kit/lib/`.

| Hook | Event | What it does |
|---|---|---|
| `session-start.sh` → `session-start.js` | SessionStart (Claude Code and Codex) | In a governed repo (one with `.aplabs/profile.yml`), announces the AP Labs Orchestrator, the client name and the 8 core stages. If the profile is invalid it lists every validation error and says the profile must be fixed before building. In any other repo it prints nothing. Logic: `kit/lib/session`. |
| `write-gate.sh` → `write-gate.js` | PreToolUse on edit tools (Claude Code and Codex), SubagentStart (Claude Code) | The write gate: in a governed repo, blocks edits until the work is routed (below). SubagentStart writes the engagement marker. Logic: `kit/lib/gate`. |

Registered in `.claude/settings.json` (via `$CLAUDE_PROJECT_DIR`) and `.codex/hooks.json` (via `git rev-parse --show-toplevel`). For SessionStart both harnesses get the same JSON on stdout: `systemMessage` for the user, `hookSpecificOutput.additionalContext` for the model.

## Hooks fail open

A hook must never stop a session. If `node` is missing, `npm ci` has not been run, or the script throws, the wrapper exits 0 with one short `aplabs-hooks:` note on stderr and nothing on stdout. Node's output is buffered and printed only when the script succeeds, so a crash cannot leave half a JSON payload. The cost: a broken hook looks like an ungoverned repo, so check stderr (`claude --debug`) when the banner is missing.

`APLABS_SESSION_START_JS` replaces the Node entry. It exists for tests only (to prove fail-open); do not set it otherwise.

## The write gate

**Threat model: a tripwire against the accidental case, not a hard security control.** It stops a main session from writing code before the work is routed. A model that wants past it can run `npm run engage`, spawn a throwaway subagent, or write through a shell, and the gate does not try to stop that. It fails open on any internal error. The hard controls stay server-side: review, CI and merge gating (DESIGN §6).

Decision for one edit, first match wins:

1. Not an edit tool: allow.
2. Repo not governed (no `.aplabs/profile.yml`): allow.
3. Every target is outside the repo: allow.
4. Profile invalid: **deny** with the validation errors ("fix the profile first"). An edit to the profile file itself is allowed, so it can be fixed.
5. Every target matches the profile's `gate.exempt` globs (repo-relative, exact case, the `kit/lib/tier` glob dialect): allow.
6. The edit is made inside a subagent (Claude Code's hook input carries `agent_id`): allow.
7. A fresh engagement marker exists for this session or this worktree: allow.
8. Otherwise: **deny**, telling the session to route the work to a Builder subagent or run `npm run engage`.

Allows are silent and not logged. Every deny and every engage appends one tab-separated line to `<git-dir>/aplabs/gate.log`.

**Engagement markers** live in `<git-dir>/aplabs/engaged/`, inside `.git`, so they are never tracked. In a linked worktree `<git-dir>` is that worktree's own git dir, so a marker opens one worktree only.

| Marker | Written by | Opens |
|---|---|---|
| `session-<session_id>` | the SubagentStart hook (Claude Code), when any subagent starts | that session |
| `worktree` | `npm run engage -- --reason "<story or task>"` | every session in that worktree |

A marker is fresh for the profile's `gate.engagement_ttl_minutes` (default 60) from its mtime. Older markers, or ones stamped more than a minute in the future, are ignored.

**`npm run engage -- --reason "<story or task>"`** writes the worktree marker and logs the time, reason, git user name and branch. It exists because AP Labs builders run as separate delegated sessions, where SubagentStart never fires. It is model-runnable by design: a builder session runs it for the story it was handed. That is why the gate is a logged tripwire and not a control.

**Output contract.** Allow: exit 0, no output. Claude Code deny: exit 0 with `hookSpecificOutput.permissionDecision: "deny"` and `permissionDecisionReason` on stdout. Codex deny: exit 2 with the reason on stderr, the pattern CanonCRM's guard uses. Fail-open: exit 0 with one `aplabs-hooks:` note on stderr.

**What is matched.** Claude Code: `Edit|Write|MultiEdit|NotebookEdit`. Codex: matcher `*`, the only form proven in CanonCRM against a live codex-cli (0.160); the gate itself acts only on `apply_patch` (and the Claude tool names) and reads target paths from the patch's `*** Add/Update/Delete File:` and `*** Move to:` lines. Not yet proven here against a live Codex session. A Codex `apply_patch` whose paths cannot be read is still gated (no marker means deny). Shell writes (`Bash`, `exec_command`) are not gated in either harness.

`APLABS_WRITE_GATE_JS` replaces the Node entry. It exists for tests only (to prove fail-open); do not set it otherwise.

## Codex: one-time trust step

Codex loads project hooks only from the **main checkout** (never from a linked worktree), and only after the user trusts the project and each hook in `~/.codex/config.toml`. Until the main checkout has `.codex/hooks.json` and the trust entries are in place, a Codex session is unguarded and nothing says so. The hooks do not try to detect this themselves.

To trust it, add the project and the hook's `trusted_hash` to `~/.codex/config.toml` (Codex shows the hash when it offers to trust the hook), and repeat after any edit to `.codex/hooks.json`, because the hash changes.
