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
//      (a target under an engine T3 floor, kit/lib/tier ENGINE_T3 with
//      .aplabs/** included, is never exempt)
//   6. not inside a subagent (agent_id) and no fresh engagement marker
//      (session or worktree)                      → DENY, logged
//   7. plan approval (Story 2.5), by the computed tier of the in-repo targets
//      (kit/lib/tier; no readable target paths counts as T3, fail high):
//      a. T0/T1 and the worktree marker's kind is not onboarding → allow, silent
//      b. no plan record (worktree marker --plan, or an approval recorded in
//         this session)                           → DENY, logged
//      c. no approval for the plan, or a stale one → DENY, logged
//      d. T3 and no plan-review record for this plan engagement → DENY, logged
//      e. otherwise                               → allow, silent
//
// Markers live in <git-dir>/aplabs/engaged/ (inside .git, so never tracked):
//   session-<session_id>  written by the SubagentStart hook (Claude Code)
//   worktree              written by `npm run engage -- --reason "..." [--plan <slug>] [--kind onboarding]`
// A marker is fresh for gate.engagement_ttl_minutes (default 60) from its
// mtime. Every DENY, engage and recorded approval appends one line to
// <git-dir>/aplabs/gate.log.
//
// Approvals and plan reviews live in <git-common-dir>/aplabs/, shared by every
// worktree of the repo, because the human approves in the Orchestrator's
// session and the Builder runs in another worktree:
//   approvals/<slug>.json     written by the UserPromptSubmit hook (Claude Code
//                             only) when the human types `approve plan <slug>`
//   plan-reviews/<slug>.md    written by `npm run engage -- --plan <slug> --plan-reviewed <path>`:
//                             the review text, under a one-line header
//   plan-reviews/<slug>.json  the record the gate reads, written beside it:
//                             { slug, at, engaged_at, source, user, branch }
// A plan review counts for T3 when its record names the plan's slug and was
// recorded at or after the plan's engage time or its approval time, so a
// review left over from an earlier engagement of the same slug does not.
// An approval counts when it is at most 7 days old and no older than the
// plan's engage time minus 24 hours. A model can type the phrase into a
// delegated child's brief (briefs arrive as user prompts): this is a
// tripwire too, not a control.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { globMatcher, tierFloor, isEngineFloor } = require('../tier');

// Loaded on first use: Codex runs this hook on every tool call, and a non-edit
// call should not pay for compiling the profile schema.
const profileLib = () => require('../profile');

// Claude Code's file-edit tools, plus Codex's apply_patch (the name CanonCRM's
// guard handles for codex-cli 0.160).
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const DEFAULT_TTL_MINUTES = 60;
const HOUR_MS = 60 * 60 * 1000;
// An approval may predate the plan's engage by this much (approve, then engage).
const APPROVAL_LEAD_MS = 24 * HOUR_MS;
const APPROVAL_MAX_AGE_MS = 7 * 24 * HOUR_MS;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// `approve plan <slug>` as whole words, any case, anywhere in the prompt
// (inside a code block too). A slug char right after the match (an overlong or
// underscored slug) rejects it rather than truncating.
const APPROVE_RE = /(?<![A-Za-z0-9_-])approve[ \t]+plan[ \t]+([a-z0-9][a-z0-9-]{0,63})(?![A-Za-z0-9_-])/gi;
const KINDS = ['build', 'onboarding'];
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
  const commonDir = top ? git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']) || gitDir : null;
  return { root, gitDir, commonDir };
}

const markerDir = (gitDir) => path.join(gitDir, 'aplabs', 'engaged');
const logFile = (gitDir) => path.join(gitDir, 'aplabs', 'gate.log');
const approvalDir = (commonDir) => path.join(commonDir, 'aplabs', 'approvals');
const planReviewFile = (commonDir, slug) => path.join(commonDir, 'aplabs', 'plan-reviews', `${slug}.md`);
const planReviewRecord = (commonDir, slug) => path.join(commonDir, 'aplabs', 'plan-reviews', `${slug}.json`);
/** Lower-cased slug, or null when it breaks the slug rule. */
const normSlug = (s) => (typeof s === 'string' && SLUG_RE.test(s.toLowerCase()) ? s.toLowerCase() : null);
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
 * session's repo directory; `opts.harness` is 'claude' (default) or 'codex'.
 * Returns { decision: 'allow'|'deny', rule, reason? }.
 */
function decide(input, startDir, now = Date.now(), opts = {}) {
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

  // A target under an engine T3 floor is never exempt (#68): the profile
  // cannot wave the engine's own guarded paths through.
  const exempt = (ctx.profile.gate.exempt || []).map((g) => globMatcher(g));
  const isExempt = (r) => !isEngineFloor(r) && exempt.some((m) => m(r));
  if (inRepo.length && inRepo.every(isExempt)) return { decision: 'allow', rule: 'exempt' };

  const subagent = typeof input.agent_id === 'string' && input.agent_id !== '';
  let worktree = null;
  let engaged = false;
  if (ctx.gitDir) {
    const ttlMs = ttlMinutes(ctx.profile) * 60 * 1000;
    const dir = markerDir(ctx.gitDir);
    if (isFresh(path.join(dir, 'worktree'), ttlMs, now)) worktree = readJson(path.join(dir, 'worktree')) || {};
    engaged = Boolean(worktree) || Boolean(input.session_id && isFresh(path.join(dir, `session-${sessionKey(input.session_id)}`), ttlMs, now));
  }

  const files = inRepo.length ? ` Blocked: ${inRepo.slice(0, 5).join(', ')}${inRepo.length > 5 ? ', …' : ''}.` : '';
  if (!subagent && !engaged) {
    return deny(ctx, 'no-marker', `AP Labs write gate: no edits in this repo until the work is routed.${files} ${ROUTE}`, input, inRepo, now);
  }

  const allowRule = subagent ? 'subagent' : 'marker';
  const tier = inRepo.length ? tierFloor(ctx.profile, inRepo) : 'T3';
  const onboarding = Boolean(worktree && worktree.kind === 'onboarding');
  if (!onboarding && (tier === 'T0' || tier === 'T1')) return { decision: 'allow', rule: allowRule };

  const r = planCheck(ctx, input, worktree, tier, now);
  if (r.ok) return { decision: 'allow', rule: allowRule };
  const why = onboarding ? `This is an onboarding build (${tier})` : `This is ${tier} work`;
  const where = opts.harness === 'codex'
    ? ' Codex cannot record approvals: the human must type it in a Claude Code session in this repo (any worktree), whose UserPromptSubmit hook records it.'
    : '';
  const slugText = r.slug || '<slug>';
  const ask = `T2/T3 work needs the human's approval: ask them to type \`approve plan ${slugText}\`.${where}`;
  const msg = {
    'no-plan': `${why} and no plan is recorded. ${ask} Then run \`npm run engage -- --reason "<story>" --plan ${slugText}\` and retry.`,
    'no-approval': `${why} and plan ${slugText} has no recorded approval. ${ask}`,
    'stale-approval': `${why} and the approval for plan ${slugText} is stale (older than 7 days, or more than 24 hours before the plan was engaged). ${ask}`,
    'no-plan-review': `${why}: T3 needs a \`bmad-review\` pass on plan ${slugText} first. Run it, then \`npm run engage -- --reason "<story>" --plan ${slugText} --plan-reviewed <review file>\` and retry.`,
    'stale-plan-review': `${why}: the plan review on record for ${slugText} is not from this plan engagement (recorded before the plan was engaged and before it was approved, or for another plan). Re-run \`bmad-review\` on the current plan, then \`npm run engage -- --reason "<story>" --plan ${slugText} --plan-reviewed <review file>\` and retry.`,
  }[r.rule];
  return deny(ctx, r.rule, `AP Labs write gate: ${msg}${files}`, input, inRepo, now);
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const timeOf = (iso) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

// The plan candidates for this edit, in order: the fresh worktree marker's
// --plan (engaged at its `at`), then every approval recorded in this session
// (a Claude subagent shares its parent session's id, so it shares the
// approval). The first candidate that passes every check wins; otherwise the
// failure of the first candidate is reported.
function planCheck(ctx, input, worktree, tier, now) {
  const common = ctx.commonDir;
  const candidates = [];
  const wSlug = worktree ? normSlug(worktree.plan) : null;
  if (wSlug) candidates.push({ slug: wSlug, engagedAt: timeOf(worktree.at) ?? now });
  if (common && input.session_id) {
    let names = [];
    try { names = fs.readdirSync(approvalDir(common)); } catch { /* none yet */ }
    for (const n of names.filter((x) => x.endsWith('.json')).sort()) {
      const a = readJson(path.join(approvalDir(common), n));
      const slug = a && normSlug(a.slug);
      if (slug && `${slug}.json` === n && a.session_id === input.session_id && slug !== wSlug) candidates.push({ slug, engagedAt: null });
    }
  }
  if (!candidates.length) return { ok: false, rule: 'no-plan' };
  let first = null;
  for (const c of candidates) {
    const r = checkPlan(common, c, tier, now);
    if (r.ok) return r;
    first = first || r;
  }
  return first;
}

function checkPlan(common, { slug, engagedAt }, tier, now) {
  const a = common ? readJson(path.join(approvalDir(common), `${slug}.json`)) : null;
  const at = a && normSlug(a.slug) === slug ? timeOf(a.at) : null;
  if (at === null) return { ok: false, rule: 'no-approval', slug };
  const tooOld = now - at > APPROVAL_MAX_AGE_MS || at > now + SKEW_MS;
  const beforePlan = engagedAt !== null && at < engagedAt - APPROVAL_LEAD_MS;
  if (tooOld || beforePlan) return { ok: false, rule: 'stale-approval', slug };
  if (tier === 'T3') {
    const r = reviewCheck(common, slug, engagedAt, at);
    if (r) return { ok: false, rule: r, slug };
  }
  return { ok: true, slug };
}

// T3 only: null when the plan-review record belongs to this plan engagement,
// else the deny rule. A record counts when its slug is the plan's and it was
// recorded at or after the plan's engage time (when known) or its approval.
function reviewCheck(common, slug, engagedAt, approvedAt) {
  const rec = readJson(planReviewRecord(common, slug));
  if (!rec) return fs.existsSync(planReviewFile(common, slug)) ? 'stale-plan-review' : 'no-plan-review';
  const at = timeOf(rec.at);
  if (normSlug(rec.slug) !== slug || at === null) return 'stale-plan-review';
  const current = at >= approvedAt || (engagedAt !== null && at >= engagedAt);
  return current ? null : 'stale-plan-review';
}

/** SubagentStart (Claude Code): write the session-keyed marker. Returns the file or null. */
function markSubagent(input, startDir, now = Date.now()) {
  if (!input.session_id) return null;
  const ctx = repoContext(startDir);
  if (ctx.profileFile === null || !ctx.gitDir) return null;
  return writeMarker(ctx.gitDir, `session-${sessionKey(input.session_id)}`, { by: 'SubagentStart', agent_type: String(input.agent_type || '') }, now);
}

class EngageError extends Error {}

/**
 * `npm run engage`: worktree marker plus a log line. `opts`: { plan, kind,
 * planReviewed } (Story 2.5). Returns { governed, file, log, ttl, invalid,
 * plan, kind, approved, review }.
 */
function engage(startDir, reason, now = Date.now(), opts = {}) {
  const why = oneLine(reason || '').slice(0, 500);
  if (!why) throw new EngageError('a reason is required: npm run engage -- --reason "<story or task>"');
  const plan = opts.plan === undefined ? null : normSlug(opts.plan);
  if (opts.plan !== undefined && !plan) throw new EngageError(`--plan must be a slug: a-z, 0-9 and "-", starting with a letter or digit, at most 64 characters (got "${oneLine(opts.plan).slice(0, 80)}")`);
  const kind = opts.kind === undefined ? 'build' : String(opts.kind).toLowerCase();
  if (!KINDS.includes(kind)) throw new EngageError(`--kind must be one of ${KINDS.join(', ')}`);
  if (opts.planReviewed !== undefined && !plan) throw new EngageError('--plan-reviewed needs --plan <slug>');
  if (opts.planReviewed !== undefined && !String(opts.planReviewed).trim()) throw new EngageError('--plan-reviewed needs the path of the bmad-review output');
  const ctx = repoContext(startDir);
  if (ctx.profileFile === null) return { governed: false };
  if (!ctx.gitDir) throw new EngageError('not inside a git repository, nowhere to write the marker');

  let review = null;
  if (opts.planReviewed !== undefined) {
    const rel = repoRelative(ctx.root, opts.planReviewed, startDir);
    const abs = rel && path.join(ctx.root, rel);
    let isFile = false;
    try { isFile = Boolean(abs) && fs.statSync(abs).isFile(); } catch { /* missing */ }
    if (!rel) throw new EngageError(`--plan-reviewed must be a file inside this repo: ${opts.planReviewed}`);
    if (!isFile) throw new EngageError(`--plan-reviewed: no such file: ${rel}`);
    review = { rel, abs };
  }

  const user = git(ctx.root, ['config', 'user.name']) || 'unknown';
  const branch = git(ctx.root, ['symbolic-ref', '-q', '--short', 'HEAD']) || 'detached';
  if (review) {
    const out = planReviewFile(ctx.commonDir, plan);
    const at = new Date(now).toISOString();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const header = `<!-- aplabs plan review for ${plan}: copied from ${oneLine(review.rel)} on ${at} by ${oneLine(user)} (${oneLine(branch)}) -->\n`;
    fs.writeFileSync(out, header + fs.readFileSync(review.abs, 'utf8'));
    // The record the gate reads. engaged_at is this engage's marker time.
    const record = { slug: plan, at, engaged_at: at, source: review.rel, user, branch };
    fs.writeFileSync(planReviewRecord(ctx.commonDir, plan), `${JSON.stringify(record)}\n`);
    review.file = out;
  }
  const fields = { by: 'engage', reason: why, user, branch, kind };
  if (plan) fields.plan = plan;
  const file = writeMarker(ctx.gitDir, 'worktree', fields, now);
  const extra = [];
  if (plan) extra.push(`plan=${plan}`);
  if (kind !== 'build') extra.push(`kind=${kind}`);
  if (review) extra.push(`plan_review=${review.rel}`);
  appendLog(ctx.gitDir, ['engage', `reason=${why}`, `user=${user}`, `branch=${branch}`, ...extra], now);
  const approved = plan ? fs.existsSync(path.join(approvalDir(ctx.commonDir), `${plan}.json`)) : null;
  return { governed: true, file, log: logFile(ctx.gitDir), ttl: ttlMinutes(ctx.profile), invalid: Boolean(ctx.error), plan, kind, approved, review: review && review.file };
}

/** Every distinct, valid slug in `approve plan <slug>` phrases of a prompt, lower-cased. */
function approvalSlugs(prompt) {
  const out = [];
  for (const m of String(prompt || '').matchAll(APPROVE_RE)) {
    const slug = m[1].toLowerCase();
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * UserPromptSubmit (Claude Code): record `approve plan <slug>` approvals in
 * <git-common-dir>/aplabs/approvals/<slug>.json. Never blocks. Returns the
 * recorded slugs ([] when ungoverned or there is no phrase).
 */
function recordApprovals(input, startDir, now = Date.now()) {
  const slugs = approvalSlugs(input.prompt);
  if (!slugs.length) return [];
  const ctx = repoContext(startDir);
  if (ctx.profileFile === null || !ctx.commonDir) return [];
  const user = git(ctx.root, ['config', 'user.name']) || 'unknown';
  const session = typeof input.session_id === 'string' ? input.session_id : '';
  fs.mkdirSync(approvalDir(ctx.commonDir), { recursive: true });
  for (const slug of slugs) {
    const record = { slug, at: new Date(now).toISOString(), session_id: session, user, by: 'UserPromptSubmit' };
    fs.writeFileSync(path.join(approvalDir(ctx.commonDir), `${slug}.json`), `${JSON.stringify(record)}\n`);
    if (ctx.gitDir) appendLog(ctx.gitDir, ['approve', `plan=${slug}`, `session=${session || '-'}`, `user=${user}`], now);
  }
  return slugs;
}

module.exports = {
  EDIT_TOOLS, DEFAULT_TTL_MINUTES, SLUG_RE, targetPaths, decide, markSubagent, engage, EngageError,
  approvalSlugs, recordApprovals, markerDir, logFile, approvalDir, planReviewFile, planReviewRecord,
};
