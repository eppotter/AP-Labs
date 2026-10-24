'use strict';

// Verify harness (Story 3.1): the pure half. Argument parsing, the child
// environment, outcome classification, the summary and the exit code. No I/O
// here; kit/verify/run-all.js loads the profile and spawns the checks.
//
// Contract ported from the AI-Governance-Layer harness: checks run in order,
// the last stdout line is a JSON summary, and a skip or timeout is never a
// pass. An empty run is not a pass either.

// Always passed through when set. Everything else needs verify.env_allow.
const BASE_ENV = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'CI']);
const TAIL_LINES = 40;
const LABEL = Object.freeze({ pass: 'PASS', fail: 'FAIL', skip: 'SKIP', timeout: 'TIMEOUT' });
// Spawn errors that mean the check could not run at all.
const SKIP_CODES = new Set(['ENOENT', 'EACCES']);

const USAGE = `usage: npm run verify [-- --strict]
  Runs the checks in the profile's verify.checks, then the known truths in
  .aplabs/context/data.md (as truth:<id>), in order, from the repo root.
  --strict  also exit 1 when a check is skipped or timed out, or none ran.
Exit: 0 no check failed, 1 a check failed, 2 usage or profile error.`;

function parseArgs(argv) {
  const args = { strict: false, help: false };
  for (const a of argv) {
    if (a === '--strict') args.strict = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else return { ...args, error: `unknown argument "${a}"` };
  }
  return args;
}

// The child's environment: the fixed allowlist plus the profile's env_allow,
// copied only when set in the parent. No secret reaches a check unless named.
function childEnv(parentEnv, envAllow = []) {
  const out = {};
  for (const name of [...BASE_ENV, ...envAllow]) {
    if (Object.prototype.hasOwnProperty.call(parentEnv, name) && parentEnv[name] !== undefined) out[name] = parentEnv[name];
  }
  return out;
}

// Maps a spawnSync result to { outcome, reason? }.
function classify(r) {
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') return { outcome: 'timeout' };
    if (SKIP_CODES.has(r.error.code)) return { outcome: 'skip', reason: `spawn ${r.error.code}` };
    return { outcome: 'fail', reason: `spawn error ${r.error.code || r.error.message}` };
  }
  if (r.status === 0) return { outcome: 'pass' };
  if (r.status === null) return { outcome: 'fail', reason: `killed by ${r.signal}` };
  return { outcome: 'fail', reason: `exit ${r.status}` };
}

function tail(text, n = TAIL_LINES) {
  const lines = String(text || '').replace(/\n+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') return '';
  return lines.slice(-n).join('\n');
}

function checkLine(result) {
  return `${LABEL[result.outcome]} ${result.id} ${result.seconds.toFixed(2)}s${result.reason ? ` (${result.reason})` : ''}`;
}

function summarize(results) {
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const passed = count('pass');
  return {
    check: 'run-all',
    ok: results.length > 0 && passed === results.length,
    passed,
    failed: count('fail'),
    skipped: count('skip'),
    timed_out: count('timeout'),
    results: results.map((r) => ({ id: r.id, outcome: r.outcome, seconds: r.seconds, ...(r.reason ? { reason: r.reason } : {}) })),
  };
}

// 1 when a check failed; under --strict also when the run was not a clean pass
// (a skip, a timeout, or nothing ran). Otherwise 0.
function exitCode(summary, { strict = false } = {}) {
  if (summary.failed > 0) return 1;
  if (strict && !summary.ok) return 1;
  return 0;
}

module.exports = { BASE_ENV, TAIL_LINES, USAGE, parseArgs, childEnv, classify, tail, checkLine, summarize, exitCode };
