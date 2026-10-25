'use strict';

// Plan ci-split, Story CS.1: the slow tests skip in `npm test` and run in
// `npm run test:slow` (CI's "Slow tests" step and clean-bones). This guard
// keeps the pieces in step, so a gated test can't drop out of every suite,
// the ci-fork test can't run itself, and the runner can't pass on skips.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');
const { slowSkip, ENV, REASON } = require('../fixtures/slow');
const { SLOW_FILES, runSlow, tapCounts, emptyFiles } =require('../../scripts/run-slow-tests');

const REPO = path.resolve(__dirname, '../..');
const STEP = 'Slow tests (fork copy, template update)';
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const tracked = () => execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);

// node --test's default patterns, other than *.test.js and test/**: a file
// matching one of these anywhere would run in `npm test`.
const DEFAULT_PATTERNS = [/^test-.*\.[cm]?js$/, /^test\.[cm]?js$/, /-test\.[cm]?js$/, /_test\.[cm]?js$/];

test('slowSkip opens only when APLABS_SLOW_TESTS is exactly 1', () => {
  assert.equal(ENV, 'APLABS_SLOW_TESTS');
  assert.equal(REASON, "slow: runs in CI's 'Slow tests' step (npm run test:slow)");
  assert.equal(slowSkip({ APLABS_SLOW_TESTS: '1' }), false);
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', '01']) {
    assert.equal(slowSkip(v === undefined ? {} : { APLABS_SLOW_TESTS: v }), REASON, `value ${JSON.stringify(v)}`);
  }
});

test('the tracked test files that call slowSkip are exactly SLOW_FILES', () => {
  const own = new Set(['test/fixtures/slow.js', 'test/unit/slow-tests.test.js']);
  const callers = tracked()
    .filter((f) => /\.[cm]?js$/.test(f) && !own.has(f) && !f.startsWith('scripts/'))
    .filter((f) => fs.existsSync(path.join(REPO, f)) && /\bslowSkip\(/.test(read(f)))
    .sort();
  assert.deepEqual(callers, [...SLOW_FILES].sort());
  for (const f of SLOW_FILES) assert.match(read(f), /require\('\.\.\/fixtures\/slow'\)/, `${f} uses the shared gate`);
});

test('package.json: test:slow is the runner and test is still plain node --test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:slow'], 'node scripts/run-slow-tests.js');
  assert.equal(pkg.scripts.test, 'node --test');
});

test('ci.yml: the slow step follows the tests in the test job, runs test:slow and has no condition', () => {
  const doc = YAML.parse(read('.github/workflows/ci.yml'));
  const steps = doc.jobs.test.steps;
  const i = steps.findIndex((s) => s.name === STEP);
  assert.ok(i > 0, `the test job has the step "${STEP}"`);
  assert.equal(steps[i - 1].name, 'Tests (unit, hook, acceptance)', 'right after the fast tests');
  assert.equal(steps[i].run, 'npm run test:slow');
  assert.equal(steps[i].if, undefined, 'no if: (the template and every fork run it)');
  assert.ok(!steps[i].run.includes('examples/brightside'), 'no fork guard');
  for (const [job, def] of Object.entries(doc.jobs)) {
    if (job === 'test') continue;
    assert.ok(!(def.steps || []).some((s) => s.name === STEP), `only in the test job, not ${job}`);
  }
});

test('the ci-fork test does not run the slow step (it would run itself)', () => {
  const src = read('test/unit/ci-fork.test.js');
  const notRun = src.match(/const NOT_RUN = Object\.freeze\(\{([^]*?)\n\}\);/);
  assert.ok(notRun, 'ci-fork.test.js has NOT_RUN');
  assert.ok(notRun[1].includes(`'test/${STEP}': `), 'NOT_RUN lists the slow step');
});

test('clean-bones.sh runs npm run test:slow after npm test', () => {
  const lines = read('scripts/clean-bones.sh').split('\n').map((l) => l.trim());
  const t = lines.indexOf('npm test');
  const s = lines.indexOf('npm run test:slow');
  assert.ok(t >= 0, 'runs npm test');
  assert.ok(s > t, 'runs npm run test:slow after it');
});

test('no tracked file outside test/ matches node --test\'s default patterns', () => {
  assert.ok(!DEFAULT_PATTERNS.some((re) => re.test('run-slow-tests.js')), 'the runner\'s name is safe');
  assert.ok(DEFAULT_PATTERNS.some((re) => re.test('test-slow.js')), 'the patterns catch the unsafe name');
  const hits = tracked().filter((f) => !f.startsWith('test/') && DEFAULT_PATTERNS.some((re) => re.test(path.basename(f))));
  assert.deepEqual(hits, []);
});

// The runner, on throwaway files outside the repo (so npm test never runs them).
function files(t, specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-slow-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return Object.entries(specs).map(([name, body]) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `'use strict';\nconst test = require('node:test');\n${body}\n`);
    return f;
  });
}
const quiet = (list, env = process.env) => runSlow({ files: list, env, out: () => {}, err: () => {} });

test('the runner passes when every test passes, and opens the gate', (t) => {
  const list = files(t, {
    'gated.js': `test('gated', { skip: process.env.APLABS_SLOW_TESTS === '1' ? false : 'gate shut' }, () => {});`,
    'plain.js': `test('plain', () => {});`,
  });
  const env = { ...process.env };
  delete env.APLABS_SLOW_TESTS;
  const res = quiet(list, env);
  assert.deepEqual(res.reasons, []);
  assert.equal(res.code, 0);
  assert.equal(res.counts.pass, 2);
  assert.equal(res.counts.skipped, 0);
});

test('the runner fails on a skipped test', (t) => {
  const list = files(t, { 'skipped.js': `test('runs', () => {});\ntest('skipped', { skip: 'no' }, () => {});` });
  const res = quiet(list);
  assert.equal(res.code, 1);
  assert.equal(res.counts.skipped, 1);
  assert.ok(res.reasons.some((r) => /1 test\(s\) skipped/.test(r)), res.reasons.join('; '));
});

test('the runner fails on a file with zero tests', (t) => {
  // node --test counts a file with no tests as one passing test (the file).
  const list = files(t, { 'empty.js': '// no tests here' });
  const res = quiet(list);
  assert.equal(res.code, 1);
  assert.ok(res.reasons.includes('no test passed'), res.reasons.join('; '));
  assert.ok(res.reasons.includes(`${list[0]} ran no tests`), res.reasons.join('; '));
});

test('the runner fails when one file of several has zero tests', (t) => {
  const list = files(t, { 'empty.js': '// no tests here', 'plain.js': `test('plain', () => {});` });
  const res = quiet(list);
  assert.equal(res.code, 1);
  assert.deepEqual(res.reasons, [`${list[0]} ran no tests`]);
});

test('the runner fails when a test fails', (t) => {
  const list = files(t, { 'failing.js': `test('fails', () => { throw new Error('boom'); });\ntest('passes', () => {});` });
  const res = quiet(list);
  assert.equal(res.code, 1);
  assert.ok(res.reasons.some((r) => /node --test exited 1/.test(r)), res.reasons.join('; '));
});

test('tapCounts reads the closing summary and refuses a report without one', () => {
  const tap = 'TAP version 13\n# Subtest: a\n    # pass 9\nok 1 - a\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 5\n';
  assert.deepEqual(tapCounts(tap), { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(tapCounts(''), null);
  assert.equal(tapCounts('# pass 1\n'), null, 'no skipped count: not a full summary');
  assert.deepEqual(emptyFiles('ok 1 - test/a.js\nok 2 - real test\n', ['test/a.js', 'test/b.js'], REPO), ['test/a.js']);
  assert.deepEqual(emptyFiles(`ok 1 - ${path.join(REPO, 'test/b.js')}\n`, ['test/a.js', 'test/b.js'], REPO), ['test/b.js']);
});
