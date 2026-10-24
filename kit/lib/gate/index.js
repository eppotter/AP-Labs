'use strict';

// Write gate (Story 2.4): the pure half. Decides whether an edit tool call may
// run, writes engagement markers and the gate log. The hook entry in
// kit/hooks/write-gate.js only reads the hook input and prints; the engage
// command is kit/hooks/engage.js.
//
// THREAT MODEL: a tripwire against the ACCIDENTAL case (a main session that
// starts writing code before the work is routed), not a hard security
// control. A model that wants past it can run `npm run engage`, spawn a
// throwaway subagent, or write files through a shell; the gate does not try
// to stop that. It fails open on any internal error. The hard controls stay
// server-side: review, CI and merge gating.
//
// Decision for one edit tool call, first match wins:
//   1. not an edit tool                         → allow, silent
//   2. repo not governed (no .aplabs/profile.yml) → allow, silent
//   3. every target is outside the repo          → allow, silent
//   4. profile invalid                           → DENY with the errors, logged
//      (except an edit to the profile file itself, so it can be fixed)
//   5. every in-repo target matches gate.exempt  → allow, silent
//   6. edit made inside a subagent (agent_id)    → allow, silent
//   7. fresh engagement marker (session or worktree) → allow, silent
//   8. otherwise                                 → DENY, logged
//
// Markers live in <git-dir>/aplabs/engaged/ (inside .git, so never tracked):
//   session-<session_id>  written by the SubagentStart hook (Claude Code)
//   worktree              written by `npm run engage -- --reason "..."`
// A marker is fresh for gate.engagement_ttl_minutes (default 60) from its
// mtime. Every DENY and every engage appends one line to <git-dir>/aplabs/gate.log.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { globMatcher } = require('../tier');

// Loaded on first use: Codex runs this hook on every tool call, and a non-edit
// call should not pay for compiling the profile schema.
const profileLib = () => require('../profile');

// Claude Code's file-edit tools, plus Codex's apply_patch (the name CanonCRM's
// guard handles for codex-cli 0.160).
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const DEFAULT_TTL_MINUTES = 60;
// A marker stamped in the future (clock skew aside) is not treated as fresh forever.
const SKEW_MS = 60 * 1000;

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Raw target paths of an edit tool call, [] when none can be read, or null
// when the tool is not an edit tool.
function targetPaths(toolName, toolInput) {
  if (!EDIT_TOOLS.has(toolName)) return null;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (toolName === 'apply_patch') {
    const patch = String(input.command ?? input.patch ?? input.input ?? '');
    const re = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm;
    const out = [];
    let m;
    while ((m = re.exec(patch))) out.push(m[1]);
    return out;
  }
  const p = input.file_path ?? input.notebook_path;
  return typeof p === 'string' && p ? [p] : [];
}

// Canonical absolute path: lexical resolve, then realpath the nearest
// existing ancestor (a new file's folders may not exist yet), so /var and
// /private/var on macOS compare equal.
function canonical(abs) {
  let dir = path.resolve(abs);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...tail.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(abs);
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

// Repo-relative POSIX path, or null when the target is outside the repo.
function repoRelative(root, raw, baseDir) {
  const abs = canonical(path.resolve(baseDir, String(raw).replace(/\\/g, '/')));
  const rel = path.relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Where the repo is and what governs it. profileFile null = not governed.
function repoContext(startDir) {
  const { loadProfile, findProfilePath, ProfileError } = profileLib();
  let profileFile;
  try {
    profileFile = findProfilePath(startDir);
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    // A broken APLABS_PROFILE: governed, but there is no profile file to name.
    return { profileFile: undefined, profile: null, error: err, ...location(startDir, null) };
  }
  if (!profileFile) return { profileFile: null };
  let profile = null;
  let error = null;
  try {
    profile = loadProfile(profileFile);
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    error = err;
  }
  return { profileFile, profile, error, ...location(startDir, profileFile) };
}

function location(startDir, profileFile) {
  const top = git(startDir, ['rev-parse', '--show-toplevel']);
  const root = canonical(top || (profileFile && !process.env.APLABS_PROFILE ? path.dirname(path.dirname(profileFile)) : startDir));
  const gitDir = top ? git(top, ['rev-parse', '--absolute-git-dir']) || null : null;
  return { root, gitDir };
}

const markerDir = (gitDir) => path.join(gitDir, 'aplabs', 'engaged');
const logFile = (gitDir) => path.join(gitDir, 'aplabs', 'gate.log');
const sessionKey = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
const ttlMinutes = (profile) => (profile && profile.gate && profile.gate.engagement_ttl_minutes) || DEFAULT_TTL_MINUTES;

function isFresh(file, ttlMs, now) {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  const age = now - st.mtimeMs;
  return age >= -SKEW_MS && age <= ttlMs;
}

function writeMarker(gitDir, name, fields, now) {
  const dir = markerDir(gitDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString(), ...fields })}\n`);
  const t = new Date(now);
  fs.utimesSync(file, t, t);
  return file;
}

// Appends one tab-separated line. Untrusted values are flattened to one line
// without tabs so they cannot forge extra entries.
function appendLog(gitDir, fields, now) {
  const clean = (v) => oneLine(v).replace(/\t/g, ' ');
  fs.mkdirSync(path.dirname(logFile(gitDir)), { recursive: true });
  fs.appendFileSync(logFile(gitDir), `${[new Date(now).toISOString(), ...fields.map(clean)].join('\t')}\n`);
}

const ROUTE =
  'Route the work first: hand the build to a Builder subagent, or, if this session is the delegated builder for an approved story or task, run `npm run engage -- --reason "<story or task>"` (it is logged) and retry.';

function deny(ctx, rule, reason, input, rels, now) {
  if (ctx.gitDir) {
    try {
      appendLog(ctx.gitDir, ['deny', rule, `tool=${input.tool_name}`, `session=${input.session_id || '-'}`, `paths=${rels.join(',') || '-'}`], now);
    } catch {
      // An unwritable log must not turn a deny into an allow.
    }
  }
  return { decision: 'deny', rule, reason };
}

/**
 * Decide one PreToolUse call. `input` is the hook input; `startDir` the
 * session's repo directory. Returns { decision: 'allow'|'deny', rule, reason? }.
 */
function decide(input, startDir, now = Date.now()) {
  const paths = targetPaths(input.tool_name, input.tool_input);
  if (paths === null) return { decision: 'allow', rule: 'not-edit' };
  const ctx = repoContext(startDir);
  if (ctx.profileFile === null) return { decision: 'allow', rule: 'ungoverned' };

  const baseDir = typeof input.cwd === 'string' && input.cwd ? input.cwd : startDir;
  const rels = paths.map((p) => repoRelative(ctx.root, p, baseDir));
  const inRepo = rels.filter((r) => r !== null);
  if (paths.length && !inRepo.length) return { decision: 'allow', rule: 'outside-repo' };

  if (ctx.error) {
    const profileRel = ctx.profileFile ? repoRelative(ctx.root, ctx.profileFile, ctx.root) : null;
    if (profileRel && inRepo.length && inRepo.every((r) => r === profileRel)) return { decision: 'allow', rule: 'profile-fix' };
    return deny(ctx, 'invalid-profile', `AP Labs write gate: the profile is invalid, fix the profile first. ${oneLine(ctx.error.message)}${profileRel ? ` Edits to ${profileRel} itself are allowed.` : ''}`, input, inRepo, now);
  }

  const exempt = (ctx.profile.gate.exempt || []).map((g) => globMatcher(g));
  if (inRepo.length && inRepo.every((r) => exempt.some((m) => m(r)))) return { decision: 'allow', rule: 'exempt' };

  if (typeof input.agent_id === 'string' && input.agent_id) return { decision: 'allow', rule: 'subagent' };

  if (ctx.gitDir) {
    const ttlMs = ttlMinutes(ctx.profile) * 60 * 1000;
    const dir = markerDir(ctx.gitDir);
    const markers = [path.join(dir, 'worktree')];
    if (input.session_id) markers.push(path.join(dir, `session-${sessionKey(input.session_id)}`));
    if (markers.some((f) => isFresh(f, ttlMs, now))) return { decision: 'allow', rule: 'marker' };
  }

  const files = inRepo.length ? ` Blocked: ${inRepo.slice(0, 5).join(', ')}${inRepo.length > 5 ? ', …' : ''}.` : '';
  return deny(ctx, 'no-marker', `AP Labs write gate: no edits in this repo until the work is routed.${files} ${ROUTE}`, input, inRepo, now);
}

/** SubagentStart (Claude Code): write the session-keyed marker. Returns the file or null. */
function markSubagent(input, startDir, now = Date.now()) {
  if (!input.session_id) return null;
  const ctx = repoContext(startDir);
  if (ctx.profileFile === null || !ctx.gitDir) return null;
  return writeMarker(ctx.gitDir, `session-${sessionKey(input.session_id)}`, { by: 'SubagentStart', agent_type: String(input.agent_type || '') }, now);
}

class EngageError extends Error {}

/** `npm run engage`: worktree marker plus a log line. Returns { governed, file, log, ttl }. */
function engage(startDir, reason, now = Date.now()) {
  const why = oneLine(reason || '').slice(0, 500);
  if (!why) throw new EngageError('a reason is required: npm run engage -- --reason "<story or task>"');
  const ctx = repoContext(startDir);
  if (ctx.profileFile === null) return { governed: false };
  if (!ctx.gitDir) throw new EngageError('not inside a git repository, nowhere to write the marker');
  const user = git(ctx.root, ['config', 'user.name']) || 'unknown';
  const branch = git(ctx.root, ['symbolic-ref', '-q', '--short', 'HEAD']) || 'detached';
  const file = writeMarker(ctx.gitDir, 'worktree', { by: 'engage', reason: why, user, branch }, now);
  appendLog(ctx.gitDir, ['engage', `reason=${why}`, `user=${user}`, `branch=${branch}`], now);
  return { governed: true, file, log: logFile(ctx.gitDir), ttl: ttlMinutes(ctx.profile), invalid: Boolean(ctx.error) };
}

module.exports = { EDIT_TOOLS, DEFAULT_TTL_MINUTES, targetPaths, decide, markSubagent, engage, EngageError, markerDir, logFile };
