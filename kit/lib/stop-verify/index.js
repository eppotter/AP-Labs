'use strict';

// The end-of-turn hook (Story 3.2): when a turn ends in a governed repo where
// the session changed files, run the profile's verify checks and block the
// turn end only on a failed check. The Node entry is kit/hooks/stop-verify.js.
//
// Runs only when ALL hold, checked cheapest first:
//   - APLABS_STOP_VERIFY is not "0" (per-person opt-out)
//   - the hook input does not say stop_hook_active (never loop)
//   - the repo is governed and its profile is valid
//   - there is at least one check: the profile's verify checks plus the known
//     truths in .aplabs/context/data.md (Story 4.2)
//   - the session changed files: the tree is dirty, or HEAD moved since the
//     session started (recorded by SessionStart), or, when nothing was
//     recorded, HEAD has commits not on origin/main
//
// Outcomes: a FAIL blocks with the failing ids and a short output tail. SKIP,
// TIMEOUT and a spent hook budget are reported, never blocked, never a pass.
// All PASS is one short line. Any other case prints nothing. A run's outcomes
// are recorded in <git-dir>/aplabs/verify/last.json for the session banner.

const { findProfilePath, loadProfile, ProfileError } = require('../profile');
const { childEnv, tail } = require('../verify');
const { runChecks } = require('../verify/runner');
const { truthChecksFor } = require('../truths');
const { git, readSessionHead } = require('../session/head');
const { writeLastResult } = require('../verify/last');

// The whole Stop run is capped here, below the 660s registered in
// .claude/settings.json, so the hook always reports instead of being killed.
const DEFAULT_BUDGET_SECONDS = 600;
const BLOCK_TAIL_LINES = 15;
const BLOCK_TAIL_CHARS = 2000;

const optedOut = (env) => env.APLABS_STOP_VERIFY === '0';

// APLABS_STOP_VERIFY_BUDGET_SECONDS overrides the budget (a positive integer).
function budgetSeconds(env) {
  const v = env.APLABS_STOP_VERIFY_BUDGET_SECONDS;
  return v && /^[1-9][0-9]*$/.test(v) ? Number(v) : DEFAULT_BUDGET_SECONDS;
}

// True when the session changed something. `sessionHead` is the HEAD recorded
// at session start (null if none); `aheadOfOrigin` is the fallback signal.
function sessionChanged({ dirty, head, sessionHead, aheadOfOrigin }) {
  if (dirty) return true;
  if (!head) return false;
  if (sessionHead) return head !== sessionHead;
  return Boolean(aheadOfOrigin);
}

function shortTail(text) {
  const t = tail(text, BLOCK_TAIL_LINES);
  return t.length > BLOCK_TAIL_CHARS ? `…${t.slice(-BLOCK_TAIL_CHARS)}` : t;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Lines naming every check that neither passed nor failed, plus a spent budget.
function notPassedLines(results, notRun, budget) {
  const lines = [];
  for (const r of results) {
    if (r.outcome === 'skip') lines.push(`SKIP ${r.id}${r.reason ? ` (${r.reason})` : ''}`);
    else if (r.outcome === 'timeout' && r.deadlineHit) lines.push(`TIMEOUT ${r.id} (hook budget of ${budget}s reached)`);
    else if (r.outcome === 'timeout') lines.push(`TIMEOUT ${r.id} after ${r.seconds.toFixed(0)}s`);
  }
  if (notRun.length) lines.push(`NOT RUN ${notRun.join(', ')} (hook budget of ${budget}s reached)`);
  return lines;
}

// Maps a run to the Claude Code Stop hook output. Pure.
function report(results, notRun = [], { budget = DEFAULT_BUDGET_SECONDS } = {}) {
  const failed = results.filter((r) => r.outcome === 'fail');
  const passed = results.filter((r) => r.outcome === 'pass');
  const others = notPassedLines(results, notRun, budget);

  if (failed.length) {
    const ids = failed.map((r) => r.id).join(', ');
    const parts = [`Verify failed: ${ids}. Fix these before ending the turn; a broken check must not reach review.`];
    for (const r of failed) {
      parts.push(`--- ${r.id}${r.reason ? ` (${r.reason})` : ''} ---`);
      for (const [name, text] of [['stderr', r.stderr], ['stdout', r.stdout]]) {
        const t = shortTail(text);
        if (t) parts.push(`[${name}, last lines]\n${t}`);
      }
    }
    if (others.length) parts.push(`Also not passed: ${others.join('; ')}`);
    return { decision: 'block', reason: parts.join('\n'), systemMessage: `AP Labs verify: FAILED ${ids} (turn blocked)` };
  }

  if (others.length) {
    return {
      systemMessage: `AP Labs verify: ${passed.length} of ${plural(results.length + notRun.length, 'check')} passed; ${others.join('; ')}. Not a pass, not blocked.`,
    };
  }

  const seconds = results.reduce((s, r) => s + r.seconds, 0);
  return { systemMessage: `AP Labs verify: all ${plural(results.length, 'check')} passed (${seconds.toFixed(1)}s).` };
}

// Did the session at `root` change files? Null when git cannot tell.
function changedFiles(root, sessionId) {
  const status = git(root, ['status', '--porcelain', '--untracked-files=normal']);
  if (status === null) return null;
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']);
  const sessionHead = readSessionHead(gitDir, sessionId);
  let aheadOfOrigin = false;
  if (head && !sessionHead && git(root, ['rev-parse', '--verify', '-q', 'origin/main'])) {
    aheadOfOrigin = Number(git(root, ['rev-list', '--count', 'HEAD', '--not', 'origin/main'])) > 0;
  }
  return sessionChanged({ dirty: status !== '', head, sessionHead, aheadOfOrigin });
}

// The Stop hook for a turn ending in `startDir`. Resolves to the hook output,
// or null for "say nothing". Throws only on bugs; the entry fails open.
async function stopVerify(input, { startDir, env = process.env } = {}) {
  if (optedOut(env)) return null;
  if (input && input.stop_hook_active === true) return null;

  let profile;
  let file;
  try {
    file = findProfilePath(startDir);
    if (!file) return null;
    profile = loadProfile(file);
  } catch (err) {
    // An invalid profile is reported by SessionStart and the write gate.
    if (err instanceof ProfileError) return null;
    throw err;
  }
  // The same checks as `npm run verify`: the profile's, then the known truths.
  const checks = [...profile.verify.checks, ...truthChecksFor(file)];
  const envAllow = profile.verify.env_allow;
  if (!checks.length) return null;

  const root = git(startDir, ['rev-parse', '--show-toplevel']);
  if (!root || !changedFiles(root, input && input.session_id)) return null;

  const budget = budgetSeconds(env);
  const { results, notRun } = await runChecks(checks, childEnv(env, envAllow), root, { budgetMs: budget * 1000 });
  writeLastResult(root, results, 'stop-hook');
  return report(results, notRun, { budget });
}

module.exports = { DEFAULT_BUDGET_SECONDS, budgetSeconds, optedOut, sessionChanged, report, changedFiles, stopVerify };
