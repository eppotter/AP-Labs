'use strict';

// `npm run test:slow` (plan ci-split, Story CS.1): runs the slow test files
// with APLABS_SLOW_TESTS=1, the tests `npm test` reports as skipped. Human
// output goes to stdout and a TAP copy to a temp file, which is read for the
// counts. It fails closed: if node --test fails, if any test was skipped (the
// gate did not open, or a test skips for another reason), if a file ran no
// tests, or if no test passed.
// The name must not match node --test's default patterns (`test-*.js` would),
// or `npm test` would run it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

// Every test file that gates a test with slowSkip(), relative to the repo.
const SLOW_FILES = Object.freeze([
  'test/unit/ci-fork.test.js',
  'test/unit/template-update.test.js',
]);

// The counts from a TAP report's closing summary (`# pass 3`), or null.
function tapCounts(tap) {
  const counts = {};
  for (const m of tap.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) counts[m[1]] = Number(m[2]);
  if (counts.pass === undefined || counts.skipped === undefined) return null;
  return {
    tests: counts.tests || 0,
    pass: counts.pass,
    fail: counts.fail || 0,
    cancelled: counts.cancelled || 0,
    skipped: counts.skipped,
    todo: counts.todo || 0,
  };
}

// The files that ran no test of their own. node --test reports such a file as
// one passing top-level test named by its path, so it would count as a pass.
function emptyFiles(tap, files, cwd) {
  const names = new Set([...tap.matchAll(/^(?:not )?ok \d+ - (.*)$/gm)].map((m) => m[1]));
  return files.filter((f) => names.has(f) || names.has(path.resolve(cwd, f)));
}

// Runs the files and returns { ok, code, reasons, counts }. `files` overrides
// SLOW_FILES (used only by the tests); `out` and `err` take the human output.
function runSlow({
  files = SLOW_FILES,
  cwd = REPO,
  env = process.env,
  out = (s) => process.stdout.write(s),
  err = (s) => process.stderr.write(s),
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-slow-'));
  const tapFile = path.join(dir, 'slow.tap');
  // A parent node --test sets NODE_TEST_CONTEXT, which would make this run
  // report to the parent instead of to its own reporters.
  const childEnv = { ...env, APLABS_SLOW_TESTS: '1' };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    const r = spawnSync(process.execPath, [
      '--test',
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=tap', `--test-reporter-destination=${tapFile}`,
      ...files,
    ], { cwd, env: childEnv, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.stdout) out(r.stdout);
    if (r.stderr) err(r.stderr);
    const reasons = [];
    if (r.error) reasons.push(`node --test did not run: ${r.error.message}`);
    else if (r.status !== 0) reasons.push(`node --test exited ${r.status === null ? `on ${r.signal}` : r.status}`);
    const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, 'utf8') : '';
    const counts = tapCounts(tap);
    if (!counts) reasons.push('no test summary in the TAP report');
    else {
      if (counts.skipped > 0) reasons.push(`${counts.skipped} test(s) skipped (the slow suite must run every test)`);
      if (counts.todo > 0) reasons.push(`${counts.todo} test(s) marked todo`);
      const empty = emptyFiles(tap, files, cwd);
      for (const f of empty) reasons.push(`${f} ran no tests`);
      if (counts.pass - empty.length <= 0) reasons.push('no test passed');
    }
    return { ok: reasons.length === 0, code: reasons.length === 0 ? 0 : 1, reasons, counts };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const res = runSlow();
  if (res.ok) {
    process.stdout.write(`test:slow: ok (${res.counts.pass} passed, none skipped, ${SLOW_FILES.length} files)\n`);
  } else {
    for (const r of res.reasons) process.stderr.write(`test:slow: ${r}\n`);
    process.stderr.write('test:slow: failed\n');
  }
  process.exitCode = res.code;
}

module.exports = { SLOW_FILES, runSlow, tapCounts, emptyFiles };
