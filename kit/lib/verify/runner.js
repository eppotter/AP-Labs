'use strict';

// Verify harness: the I/O half that spawns checks. Shared by `npm run verify`
// (kit/verify/run-all.js) and the Stop hook (kit/hooks/stop-verify.js).
//
// Each check runs in its own process group (detached spawn), and the whole
// group is SIGKILLed on timeout. spawnSync's timeout killed only the direct
// child, so a check that started children (`npm test` → node) kept its pipes
// open and stalled the run past its timeout (issue #24). The group is also
// killed when the check exits, so nothing a check left running outlives it.

const { spawn } = require('node:child_process');
const { classify } = require('./index');

const MAX_BUFFER = 64 * 1024 * 1024;

// Process groups still running, so a signal to the parent can take them down:
// a detached group does not receive the parent's Ctrl-C.
const live = new Set();

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: the group is already gone.
  }
}

function killAll() {
  for (const pid of live) killGroup(pid);
  live.clear();
}

let cleanupInstalled = false;
// On SIGINT, SIGTERM or SIGHUP: kill every running check group, then exit
// with 128 + the signal number. Installed once per process.
function installSignalCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.on(sig, () => {
      killAll();
      process.exit(128 + n);
    });
  }
}

const elapsed = (started) => Math.round(Number(process.hrtime.bigint() - started) / 1e7) / 100;

// Runs one check. Resolves (never rejects) to
// { id, seconds, outcome, reason?, stdout, stderr, deadlineHit? }.
// `timeoutMs` overrides the check's own timeout_seconds (the Stop hook passes
// the smaller of the two and its own remaining budget); `deadlineHit` is true
// when the run was killed by that override rather than by the check's timeout.
//
// Two optional fields serve known truths (kit/lib/truths): a check with a
// `problem` fails with that reason and spawns nothing; a check with a
// `judge(stdout)` that exits 0 gets its outcome from the judge instead.
function runCheck(check, env, cwd, { timeoutMs } = {}) {
  if (check.problem) {
    return Promise.resolve({ id: check.id, seconds: 0, outcome: 'fail', reason: check.problem, stdout: '', stderr: '' });
  }
  const ownMs = check.timeout_seconds * 1000;
  const limitMs = timeoutMs === undefined ? ownMs : Math.min(ownMs, timeoutMs);
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const out = { stdout: [], stderr: [], bytes: 0 };
    let error = null;
    let done = false;
    let child;

    const finish = (status, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child && child.pid) {
        killGroup(child.pid);
        live.delete(child.pid);
      }
      const r = { status, signal, error };
      const stdout = Buffer.concat(out.stdout).toString('utf8');
      let verdict = classify(r);
      if (verdict.outcome === 'pass' && check.judge) verdict = check.judge(stdout);
      resolve({
        id: check.id,
        seconds: elapsed(started),
        ...verdict,
        stdout,
        stderr: Buffer.concat(out.stderr).toString('utf8'),
        ...(error && error.code === 'ETIMEDOUT' && limitMs < ownMs ? { deadlineHit: true } : {}),
      });
    };

    const stop = (code) => {
      if (error) return;
      error = Object.assign(new Error(code), { code });
      if (child && child.pid) killGroup(child.pid);
    };

    const timer = setTimeout(() => stop('ETIMEDOUT'), limitMs);

    try {
      child = spawn(check.run[0], check.run.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      error = err;
      finish(null, null);
      return;
    }
    if (child.pid) live.add(child.pid);

    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (chunk) => {
        out.bytes += chunk.length;
        if (out.bytes > MAX_BUFFER) return stop('ENOBUFS');
        out[name].push(chunk);
      });
    }
    child.on('error', (err) => {
      // A spawn failure (ENOENT, EACCES): no process, no 'close' to wait for.
      if (!child.pid) {
        error = err;
        finish(null, null);
      }
    });
    // 'exit' fires when the check itself ends; its leftovers may still hold
    // the pipes open, so kill the group now and let 'close' collect output.
    child.on('exit', () => {
      if (child.pid) killGroup(child.pid);
    });
    child.on('close', (status, signal) => finish(status, signal));
  });
}

// Runs checks in order. `budgetMs` (optional) caps the whole run: each check
// gets at most what is left, and once it is spent the remaining checks are
// returned in `notRun`. `onResult` is called after each check.
async function runChecks(checks, env, cwd, { budgetMs, onResult } = {}) {
  const results = [];
  const deadline = budgetMs === undefined ? undefined : Date.now() + budgetMs;
  for (let i = 0; i < checks.length; i += 1) {
    const left = deadline === undefined ? undefined : deadline - Date.now();
    if (left !== undefined && left <= 0) return { results, notRun: checks.slice(i).map((c) => c.id) };
    const result = await runCheck(checks[i], env, cwd, { timeoutMs: left });
    results.push(result);
    if (onResult) onResult(result);
  }
  return { results, notRun: [] };
}

module.exports = { runCheck, runChecks, installSignalCleanup, killAll };
