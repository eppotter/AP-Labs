'use strict';

// Runs the client's checks the same way every time (Story 3.1):
//
//   npm run verify [-- --strict]
//
// Reads verify.checks from .aplabs/profile.yml and spawns each argv in order,
// without a shell, from the repo root (cwd), stdin ignored. A check sees only
// the fixed env allowlist plus verify.env_allow, and is SIGKILLed after its
// timeout_seconds. One line per check, then a JSON summary as the last stdout
// line. Output tails of failed and timed-out checks go to stderr.
//
// No profile is a SKIP (exit 0, 1 under --strict) so an ungoverned repo's CI
// stays green. Exit codes: 0 no check failed, 1 a check failed, 2 usage or
// profile error.

const { spawnSync } = require('node:child_process');
const { findProfilePath, loadProfile, PROFILE_REL } = require('../lib/profile');
const { USAGE, parseArgs, childEnv, classify, tail, checkLine, summarize, exitCode } = require('../lib/verify');

const emit = (summary) => console.log(JSON.stringify(summary));

function runCheck(check, env, cwd) {
  const started = process.hrtime.bigint();
  const r = spawnSync(check.run[0], check.run.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: check.timeout_seconds * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e7) / 100;
  return { id: check.id, seconds, ...classify(r), stdout: r.stdout, stderr: r.stderr };
}

function main(argv, env = process.env, cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    emit({ check: 'run-all', ok: false, error: 'usage' });
    return 2;
  }

  let profile;
  try {
    const file = findProfilePath(cwd);
    if (!file) {
      console.log(`verify: SKIPPED (no ${PROFILE_REL})`);
      const summary = summarize([]);
      emit(summary);
      return exitCode(summary, args);
    }
    profile = loadProfile(file);
  } catch (err) {
    if (err.code !== 'PROFILE_INVALID') throw err;
    console.error(err.message);
    emit({ check: 'run-all', ok: false, error: 'profile' });
    return 2;
  }

  const { checks, env_allow: envAllow } = profile.verify;
  if (!checks.length) console.log('verify: SKIPPED (0 checks)');
  const childEnvironment = childEnv(env, envAllow);
  const results = [];
  for (const check of checks) {
    const result = runCheck(check, childEnvironment, cwd);
    results.push(result);
    console.log(checkLine(result));
    if (result.outcome === 'fail' || result.outcome === 'timeout') {
      for (const [name, text] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
        const t = tail(text);
        if (t) console.error(`--- ${result.id} ${name} (last lines) ---\n${t}`);
      }
    }
  }

  const summary = summarize(results);
  emit(summary);
  return exitCode(summary, args);
}

module.exports = { main, runCheck };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
