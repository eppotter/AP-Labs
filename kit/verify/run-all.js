'use strict';

// Runs the client's checks the same way every time (Story 3.1):
//
//   npm run verify [-- --strict]
//
// Reads verify.checks from .aplabs/profile.yml (or APLABS_PROFILE), then the
// known truths in context/data.md beside it, .aplabs/context/data.md in a fork
// (Story 4.2, run as checks `truth:<id>` and judged on
// the number they print), and spawns each argv in order,
// without a shell, from the repo root (cwd), stdin ignored. A check sees only
// the fixed env allowlist plus verify.env_allow, and the profile's path as
// APLABS_GOVERNING_PROFILE (kit/lib/verify checkEnv), and its whole process group
// is SIGKILLed after its timeout_seconds (kit/lib/verify/runner). One line per check, then a JSON summary as the last stdout
// line. Output tails of failed and timed-out checks go to stderr. Each run's
// outcomes are recorded in <git-dir>/aplabs/verify/last.json for the session
// banner (kit/lib/verify/last).
//
// After the profile's checks and truths, the engine's built-in checks
// (kit/verify/builtins.js) run in process, whatever the profile says (a
// profile can neither drop nor replace them): engine:write-path (kit/verify/write-path.js, DEP-012), which fails
// app code that writes live outside the approval-write archetype, scanning
// from the repo root (cwd) with APLABS_APP_DIR from this process's env. They
// report like any check. A profile with no checks of its own still prints
// SKIPPED (0 checks) and is never ok, even when the built-ins pass.
//
// No profile is a SKIP (exit 0, 1 under --strict) so an ungoverned repo's CI
// stays green. Exit codes: 0 no check failed, 1 a check failed, 2 usage or
// profile error.

const { findProfilePath, loadProfile, PROFILE_REL } = require('../lib/profile');
const { USAGE, parseArgs, checkEnv, tail, checkLine, summarize, exitCode } = require('../lib/verify');
const { runChecks, installSignalCleanup } = require('../lib/verify/runner');
const { truthChecksFor } = require('../lib/truths');
const { writeLastResult } = require('../lib/verify/last');
const { runBuiltins } = require('./builtins');

const emit = (summary) => console.log(JSON.stringify(summary));

async function main(argv, env = process.env, cwd = process.cwd()) {
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
  let profileFile;
  try {
    const file = findProfilePath(cwd);
    if (!file) {
      console.log(`verify: SKIPPED (no ${PROFILE_REL})`);
      const summary = summarize([]);
      emit(summary);
      return exitCode(summary, args);
    }
    profile = loadProfile(file);
    profileFile = file;
  } catch (err) {
    if (err.code !== 'PROFILE_INVALID') throw err;
    console.error(err.message);
    emit({ check: 'run-all', ok: false, error: 'profile' });
    return 2;
  }

  // The profile's checks, then the known truths in context/data.md beside it.
  const checks = [...profile.verify.checks, ...truthChecksFor(profileFile)];
  const envAllow = profile.verify.env_allow;
  if (!checks.length) console.log('verify: SKIPPED (0 checks)');
  installSignalCleanup();
  const onResult = (result) => {
    console.log(checkLine(result));
    if (result.outcome === 'fail' || result.outcome === 'timeout') {
      for (const [name, text] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
        const t = tail(text);
        if (t) console.error(`--- ${result.id} ${name} (last lines) ---\n${t}`);
      }
    }
  };
  const { results } = await runChecks(checks, checkEnv(env, envAllow, profileFile), cwd, { onResult });
  for (const result of runBuiltins(cwd, env)) {
    onResult(result);
    results.push(result);
  }

  // For the session banner (issue #45): best effort, never fails the run.
  writeLastResult(cwd, results, 'verify');
  const summary = summarize(results);
  // Zero checks of the profile's own is never a pass (the built-ins alone are not verification).
  if (!checks.length) summary.ok = false;
  emit(summary);
  return exitCode(summary, args);
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
