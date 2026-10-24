# kit/hooks

Harness hooks for repos built on this template. Each hook is one thin bash wrapper that calls a Node entry; the logic lives in `kit/lib/`.

| Hook | Event | What it does |
|---|---|---|
| `session-start.sh` → `session-start.js` | SessionStart (Claude Code and Codex) | In a governed repo (one with `.aplabs/profile.yml`), announces the AP Labs Orchestrator, the client name and the 8 core stages, plus one onboarding line while any client file in `.aplabs/context/` is missing or awaiting sign-off (Story 4.1). If the profile is invalid it lists every validation error and says the profile must be fixed before building. In any other repo it prints nothing. Logic: `kit/lib/session`. |
| `write-gate.sh` → `write-gate.js` | PreToolUse on edit tools (Claude Code and Codex), SubagentStart and UserPromptSubmit (Claude Code) | The write gate: in a governed repo, blocks edits until the work is routed, and T2/T3 edits until the plan is approved (below). SubagentStart writes the engagement marker; UserPromptSubmit records `approve plan <slug>`. Logic: `kit/lib/gate`. |
| `stop-verify.sh` → `stop-verify.js` | Stop (Claude Code only) | Runs the profile's verify checks when a turn ends, and blocks the turn end only on a failed check (below). Logic: `kit/lib/stop-verify`. |

Registered in `.claude/settings.json` (via `$CLAUDE_PROJECT_DIR`) and `.codex/hooks.json` (via `git rev-parse --show-toplevel`). For SessionStart both harnesses get the same JSON on stdout: `systemMessage` for the user, `hookSpecificOutput.additionalContext` for the model. In a governed git repo SessionStart also records the session's starting HEAD in `<git-dir>/aplabs/session/<session_id>.head` for the Stop hook.

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
6. The edit is not inside a subagent (Claude Code's hook input carries `agent_id`) and no fresh engagement marker exists for this session or this worktree: **deny**, telling the session to route the work to a Builder subagent or run `npm run engage`.
7. Plan approval, by the tier `kit/lib/tier` computes for the in-repo targets (an edit whose paths cannot be read counts as T3: fail high):
   1. T0/T1, and the worktree marker is not `--kind onboarding`: allow. Deciding and reporting is the session's job.
   2. No plan record: **deny**, "T2/T3 work needs the human's approval: ask them to type `approve plan <slug>`".
   3. The plan has no approval, or only a stale one: **deny**, same ask.
   4. T3 and no plan-review record: **deny**, a `bmad-review` pass on the plan is required first.
   5. Otherwise: allow.

Subagent edits go through step 7 too: an edit by a subagent is no longer allowed outright, only past step 6.

Allows are silent and not logged. Every deny, every engage and every recorded approval appends one tab-separated line to `<git-dir>/aplabs/gate.log`.

**Engagement markers** live in `<git-dir>/aplabs/engaged/`, inside `.git`, so they are never tracked. In a linked worktree `<git-dir>` is that worktree's own git dir, so a marker opens one worktree only.

| Marker | Written by | Opens |
|---|---|---|
| `session-<session_id>` | the SubagentStart hook (Claude Code), when any subagent starts | that session |
| `worktree` | `npm run engage -- --reason "<story or task>"` | every session in that worktree |

A marker is fresh for the profile's `gate.engagement_ttl_minutes` (default 60) from its mtime. Older markers, or ones stamped more than a minute in the future, are ignored.

**`npm run engage -- --reason "<story or task>"`** writes the worktree marker and logs the time, reason, git user name and branch. It exists because AP Labs builders run as separate delegated sessions, where SubagentStart never fires. It is model-runnable by design: a builder session runs it for the story it was handed. That is why the gate is a logged tripwire and not a control. Optional flags, recorded on the marker and the log line:

| Flag | Meaning |
|---|---|
| `--plan <slug>` | The approved plan this work belongs to. Slug: `[a-z0-9][a-z0-9-]{0,63}`, lower-cased first (`Story-2-5` is `story-2-5`). |
| `--kind onboarding` | An onboarding build: approval is needed at every tier. The default kind is `build`. |
| `--plan-reviewed <path>` | Needs `--plan`. Copies the `bmad-review` output (a file inside this repo) to `<git-common-dir>/aplabs/plan-reviews/<slug>.md`, with a header naming the source, time, user and branch. |

## Plan approval (Story 2.5)

Ceremony scales with the computed tier (DESIGN §3a): T0/T1 flow, T2/T3 and every onboarding build wait for the human.

1. The Orchestrator brings the plan to the gate. The human types `approve plan <slug>` in the Orchestrator's Claude Code session.
2. The UserPromptSubmit hook sees the phrase and writes `<git-common-dir>/aplabs/approvals/<slug>.json`: `{ slug, at, session_id, user, by }` (ISO time, the hook's session id, the git user name). It never blocks the prompt, prints only a `systemMessage` confirming the record, and does nothing in an ungoverned repo.
3. On T3 the Orchestrator also records the `bmad-review` output with `--plan-reviewed`.
4. The Builder, in its own worktree, runs `npm run engage -- --reason "<story>" --plan <slug>`. Its T2/T3 edits are allowed while the approval holds.

**Where.** `<git-common-dir>` is `git rev-parse --git-common-dir`: the main checkout's `.git`, shared by every linked worktree. Approvals and plan reviews live there because the human approves in one worktree and the Builder builds in another. Engagement markers stay per worktree in `<git-dir>`.

**The phrase.** `approve plan <slug>` as whole words, any case, with spaces or tabs between the words, anywhere in the prompt. Every distinct phrase in a prompt is recorded. `approve planning x`, `preapprove plan x`, `approve plan foo_bar`, an over-long slug and `approve plan <slug>` (a placeholder) are ignored. A phrase inside a code block or a quote **is** recorded: the hook cannot tell quoting from intent.

**Which approval counts.** The plan record comes from the fresh worktree marker's `--plan`, or, failing that, any approval recorded in the same session (a Claude subagent carries its parent session's id, so subagents of the Orchestrator session share its approval). An approval counts when it is at most 7 days old, not stamped in the future, and no more than 24 hours older than the plan's engage time (approve, then build within a day).

**Threat model: still a tripwire.** It catches a session that starts T2/T3 work before the human approved it. It does not stop a model that wants past it: a model can type the phrase into a delegated child's brief (delegated-task briefs arrive as user prompts, and the hook records them like the human's), write the approval file through a shell, or run `npm run engage` with any plan. Every approval is logged with its session id so a review can check it came from the human's session. The hard controls remain review, CI and gated merges.

**Codex.** Approvals are recorded by Claude Code only. Codex knows a UserPromptSubmit event (CanonCRM's trust-hash code lists it), but no hook of ours on it has been proven against a live Codex session, so `.codex/hooks.json` does not register one. A Codex session can still build an approved plan (the approval files are shared), but it cannot record one: its T2/T3 deny says the human must type the phrase in a Claude Code session in this repo.

**Output contract.** Allow: exit 0, no output. Claude Code deny: exit 0 with `hookSpecificOutput.permissionDecision: "deny"` and `permissionDecisionReason` on stdout. Codex deny: exit 2 with the reason on stderr, the pattern CanonCRM's guard uses. Fail-open: exit 0 with one `aplabs-hooks:` note on stderr.

**What is matched.** Claude Code: `Edit|Write|MultiEdit|NotebookEdit`. Codex: matcher `*`, the only form proven in CanonCRM against a live codex-cli (0.160); the gate itself acts only on `apply_patch` (and the Claude tool names) and reads target paths from the patch's `*** Add/Update/Delete File:` and `*** Move to:` lines. Not yet proven here against a live Codex session. A Codex `apply_patch` whose paths cannot be read is still gated (no marker means deny). Shell writes (`Bash`, `exec_command`) are not gated in either harness.

`APLABS_WRITE_GATE_JS` replaces the Node entry. It exists for tests only (to prove fail-open); do not set it otherwise.

## The Stop hook: verify at the end of a turn

When a turn ends, the hook runs the checks in the profile's `verify.checks` through the same harness as `npm run verify` (`kit/lib/verify/runner`), so broken code is caught before anyone reviews it.

**When it runs.** All of these must hold, checked cheapest first; otherwise it prints nothing:

1. `APLABS_STOP_VERIFY` is not `0`. This is the per-person opt-out: set it in your own shell or `.claude/settings.local.json`, never in the shared settings.
2. The hook input does not carry `stop_hook_active: true` (below).
3. The repo is governed and its profile is valid. An invalid profile is silent here: SessionStart and the write gate already report it.
4. The profile has at least one verify check.
5. The session changed files: the working tree is dirty (tracked or untracked), or HEAD differs from the HEAD SessionStart recorded for this session. With no record (SessionStart did not run, or no `session_id`), HEAD having commits not on `origin/main` counts instead.

**Outcomes.**

| Run | Output |
|---|---|
| Any check FAILED | `{"decision":"block","reason":…}`: the failing ids and the last 15 lines (at most 2000 characters) of each one's stderr and stdout. Claude must fix it before the turn can end. Skips and timeouts in the same run are listed too. |
| No failure, but a SKIP, TIMEOUT or spent budget | `systemMessage` naming each one. Never blocks, and never counted as a pass. |
| Every check passed | `systemMessage`: one line with the count and total time. |

**Never loops.** When Claude Code re-runs the Stop hook after a block, its input carries `stop_hook_active: true`, and the hook then does nothing. So one block per turn at most: the model gets one chance to fix the failure, and the next turn end is checked fresh.

**Time budget.** The whole run is capped at 600 seconds (`APLABS_STOP_VERIFY_BUDGET_SECONDS` overrides it). Each check gets the smaller of its own `timeout_seconds` and what is left of the budget; once the budget is spent the remaining checks are reported as not run. A budget timeout is reported, never blocked. The hook is registered with a 660-second harness timeout so the hook always reports before Claude Code would kill it.

**Process groups.** Every check runs in its own process group, killed as a group on timeout and when the check exits, so a check that starts children (`npm test` → node) cannot stall past its timeout or leave processes behind (issue #24). This applies to `npm run verify` too. On SIGINT, SIGTERM or SIGHUP the harness kills every running check group before exiting.

**Codex: not registered.** No Stop event is proven for Codex here (CanonCRM's `.codex/hooks.json` registers PreToolUse only), so the Stop hook is Claude Code only. A Codex builder runs `npm run verify` itself.

**Fails open.** Like the other hooks: a missing `node` or a crash exits 0 with one `aplabs-hooks:` note on stderr and no stdout; an internal error caught in Node prints a one-line `systemMessage` saying the hook did not block. `APLABS_STOP_VERIFY_JS` replaces the Node entry. It exists for tests only (to prove fail-open); do not set it otherwise.

## Codex: one-time trust step

Codex loads project hooks only from the **main checkout** (never from a linked worktree), and only after the user trusts the project and each hook in `~/.codex/config.toml`. Until the main checkout has `.codex/hooks.json` and the trust entries are in place, a Codex session is unguarded and nothing says so. The hooks do not try to detect this themselves.

To trust it, add the project and the hook's `trusted_hash` to `~/.codex/config.toml` (Codex shows the hash when it offers to trust the hook), and repeat after any edit to `.codex/hooks.json`, because the hash changes.
