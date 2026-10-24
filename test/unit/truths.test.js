'use strict';

// Known truths (Story 4.2): parsing and validation in kit/lib/truths, then
// `npm run verify`, the Stop hook and the session banner against throwaway
// repos whose truths run tiny node one-liners as the "client query".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const {
  parseTruths, loadTruths, parseTolerance, readNumber, judge, truthChecks, bannerLine,
} = require('../../kit/lib/truths');
const { TEMPLATES_DIR, initContext } = require('../../kit/lib/onboard');
const { sessionStart } = require('../../kit/lib/session');
const { isIsoDate } = require('../../kit/lib/dates');
const { lastFile, readLastResult, writeLastResult, MAX_AGE_MS } = require('../../kit/lib/verify/last');

const ROOT = path.resolve(__dirname, '../..');
const VERIFY = path.join(ROOT, 'kit/verify/run-all.js');
const STOP = path.join(ROOT, 'kit/hooks/stop-verify.sh');
const node = process.execPath;

// The in-process session banner tests find the profile the way a session does,
// and APLABS_PROFILE wins over the temp repo. Run from a shell or a verify run
// that sets it (Brightside's profile has truths), they would read that profile
// instead. node --test runs each file in its own process, so this stays here.
delete process.env.APLABS_PROFILE;

const tmps = [];
test.after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-truths-'));
  tmps.push(d);
  return d;
}

// One truth block. `fields` override a valid, signed-off truth whose command
// prints `prints`; a field set to undefined is left out.
function block(fields = {}, prints = '412,300') {
  const t = {
    id: 'revenue-2026-09',
    statement: 'Total paid revenue for September 2026 is $412,300.',
    run: [node, '-e', `console.log(${JSON.stringify(prints)})`],
    expect: 412300,
    tolerance: '0.5%',
    owner: 'Dana Reyes',
    signed_off: '2026-10-20',
    ...fields,
  };
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
  return `\`\`\`truth\n${YAML.stringify(t)}\`\`\`\n`;
}

const doc = (...blocks) => `---\nowner: x\n---\n\n# Data canon\n\n## Terminology\n\nwords\n\n## Known truths\n\n${blocks.join('\n')}`;

const parse1 = (fields, prints) => parseTruths(doc(block(fields, prints)))[0];

// --- parsing and validation ---

test('parses a valid truth block', () => {
  const [e] = parseTruths(doc(block()));
  assert.deepEqual(e.problems, []);
  assert.equal(e.id, 'revenue-2026-09');
  assert.equal(e.truth.statement, 'Total paid revenue for September 2026 is $412,300.');
  assert.deepEqual(e.truth.tolerance, { kind: 'pct', value: 0.5 });
  assert.equal(e.truth.owner, 'Dana Reyes');
  assert.equal(e.truth.signedOff, '2026-10-20');
  assert.equal(e.truth.timeoutSeconds, 300);
});

test('the format in the brief parses as written (unquoted percent, comments)', () => {
  const text = [
    '## Known truths', '', '```truth',
    'id: revenue-2026-09          # slug, unique in the file',
    'statement: Total paid revenue for September 2026 is $412,300.',
    'run: [node, scripts/truths/revenue.js, "2026-09"]',
    '# a whole-line YAML comment does not end the section',
    'expect: 412300', 'tolerance: 0.5%', 'owner: Dana Reyes', 'signed_off: 2026-10-20', '```', '',
  ].join('\n');
  const [e] = parseTruths(text);
  assert.deepEqual(e.problems, []);
  assert.deepEqual(e.truth.run, ['node', 'scripts/truths/revenue.js', '2026-09']);
});

test('each missing required field is a problem', () => {
  for (const k of ['id', 'statement', 'run', 'expect', 'owner']) {
    const e = parse1({ [k]: undefined });
    assert.ok(e.problems.includes(`missing ${k}`), `${k}: ${e.problems}`);
  }
  assert.match(parse1({ signed_off: undefined }).problems.join(), /missing signed_off/);
  assert.match(parse1({ owner: '   ' }).problems.join(), /owner must name/);
});

test('bad values are problems: id, run, expect, tolerance, timeout, unknown keys', () => {
  const has = (fields, re) => assert.match(parse1(fields).problems.join('; '), re, JSON.stringify(fields));
  has({ id: 'Revenue 2026' }, /id must be a slug/);
  has({ run: 'node -e 1' }, /run must be a non-empty argv list/);
  has({ run: [] }, /run must be a non-empty argv list/);
  has({ run: ['node', ''] }, /run must be a non-empty argv list/);
  has({ run: ['node', 3] }, /run must be a non-empty argv list/);
  has({ expect: '412,300' }, /expect must be a number/);
  has({ tolerance: '-1%' }, /tolerance must be/);
  has({ tolerance: -5 }, /tolerance must be/);
  has({ tolerance: 'a bit' }, /tolerance must be/);
  has({ timeout_seconds: 0 }, /timeout_seconds/);
  has({ timeout_seconds: 1.5 }, /timeout_seconds/);
  has({ query: 'select 1' }, /unknown key "query"/);
});

test('impossible or malformed sign-off dates are problems; pending is not', () => {
  for (const bad of ['2026-02-30', '2026-13-01', '2026-04-31', '2026-9-01', 'soon']) {
    assert.match(parse1({ signed_off: bad }).problems.join(), /signed_off must be pending or a real ISO date/, bad);
  }
  assert.deepEqual(parse1({ signed_off: 'pending' }).problems, []);
  assert.deepEqual(parse1({ signed_off: '2028-02-29' }).problems, []);
});

test('one strict date validator: real calendar days only', () => {
  for (const ok of ['2026-10-20', '2028-02-29', '2000-02-29']) assert.equal(isIsoDate(ok), true, ok);
  for (const bad of ['2026-02-30', '2025-02-29', '1900-02-29', '2026-00-10', '2026-12-32', '2026-10-2', '2026/10/20', 20261020, null]) {
    assert.equal(isIsoDate(bad), false, String(bad));
  }
});

test('a duplicate id is a problem on the second block, which gets a block id', () => {
  const entries = parseTruths(doc(block(), block()));
  assert.deepEqual(entries[0].problems, []);
  assert.equal(entries[0].id, 'revenue-2026-09');
  assert.match(entries[1].problems.join(), /duplicate id "revenue-2026-09"/);
  assert.equal(entries[1].id, 'block-2');
});

test('broken blocks are problems: bad YAML, not a mapping, not closed', () => {
  const [yamlBad] = parseTruths('## Known truths\n\n```truth\nid: [unclosed\n```\n');
  assert.match(yamlBad.problems.join(), /not valid YAML/);
  assert.equal(yamlBad.id, 'block-1');
  assert.match(parseTruths('## Known truths\n\n```truth\n- a\n```\n')[0].problems.join(), /not a YAML mapping/);
  assert.match(parseTruths('## Known truths\n\n```truth\nid: x\n')[0].problems.join(), /not closed/);
});

test('only truth blocks under Known truths count; comments and other fences are ignored', () => {
  const text = [
    '## Terminology', '', block({ id: 'outside' }),
    '## Known truths', '',
    '<!--', block({ id: 'commented' }), '-->',
    '<!-- one-line comment -->',
    '```yaml', 'id: not-a-truth', '```',
    '### Revenue', '', block({ id: 'kept' }),
    '## Deprecated sources', '', block({ id: 'after' }),
  ].join('\n');
  assert.deepEqual(parseTruths(text).map((e) => e.id), ['kept']);
});

test('the template has zero runnable truths, before and after onboard --init', () => {
  const text = fs.readFileSync(path.join(TEMPLATES_DIR, 'data.md'), 'utf8');
  assert.match(text, /```truth/, 'the template shows an example');
  assert.deepEqual(parseTruths(text), []);
  const d = tmpDir();
  initContext(d);
  assert.deepEqual(loadTruths(d), []);
  assert.equal(bannerLine(loadTruths(d)), null);
});

test('no data.md or no Known truths section means no truths', () => {
  assert.deepEqual(loadTruths(tmpDir()), []);
  assert.deepEqual(parseTruths('# Data canon\n\n## Terminology\n\n```truth\nid: x\n```\n'), []);
});

// --- judging the number ---

test('tolerance: absolute number or percent; default 0', () => {
  assert.deepEqual(parseTolerance(undefined), { kind: 'abs', value: 0 });
  assert.deepEqual(parseTolerance(25), { kind: 'abs', value: 25 });
  assert.deepEqual(parseTolerance('0.5%'), { kind: 'pct', value: 0.5 });
  assert.equal(parseTolerance('5'), null);
});

test('readNumber: last non-empty line, commas allowed', () => {
  assert.deepEqual(readNumber('rows: 3\n412,300\n\n'), { value: 412300 });
  assert.deepEqual(readNumber('1,234,567.89'), { value: 1234567.89 });
  assert.deepEqual(readNumber('-12,345'), { value: -12345 });
  assert.deepEqual(readNumber('-1.5e3'), { value: -1500 });
  assert.match(readNumber('412300 dollars').error, /not a number: "412300 dollars"/);
  assert.match(readNumber('\n \n').error, /printed nothing/);
});

test('readNumber: commas that are not standard thousands grouping are rejected (#45)', () => {
  for (const bad of ['1,2', '12,34,5', '1234,567', ',123', '123,', '1,,234', '1,234.5,6', '1.234,56', '0.1,234', '1,234e3']) {
    assert.match(readNumber(bad).error, /commas that are not standard thousands grouping/, bad);
  }
  // A judged truth fails rather than reading 1,2 as 12.
  const t = { expect: 12, tolerance: { kind: 'abs', value: 0 } };
  assert.equal(judge(t, '1,2').outcome, 'fail');
});

test('judge: pass within tolerance, fail outside with expected vs actual', () => {
  const t = (tolerance) => ({ expect: 412300, tolerance });
  const pct = { kind: 'pct', value: 0.5 }; // ± 2061.5
  assert.deepEqual(judge(t(pct), '414361.5'), { outcome: 'pass' });
  assert.deepEqual(judge(t(pct), '410,238.5'), { outcome: 'pass' });
  const off = judge(t(pct), '400000');
  assert.equal(off.outcome, 'fail');
  assert.equal(off.reason, 'expected 412300 ± 0.5%, actual 400000 (off by 12300)');
  const abs = { kind: 'abs', value: 100 };
  assert.deepEqual(judge(t(abs), '412400'), { outcome: 'pass' });
  assert.match(judge(t(abs), '412401').reason, /expected 412300 ± 100, actual 412401/);
  assert.deepEqual(judge(t({ kind: 'abs', value: 0 }), '412300'), { outcome: 'pass' });
  assert.deepEqual(judge({ expect: 0.3, tolerance: { kind: 'abs', value: 0 } }, String(0.1 + 0.2)), { outcome: 'pass' });
  assert.match(judge(t(abs), 'n/a').reason, /expected 412300 ± 100, output is not a number: "n\/a"/);
});

test('truthChecks: ids are truth:<id>; malformed blocks carry their problem', () => {
  const checks = truthChecks(parseTruths(doc(block(), block({ id: 'bad', expect: 'x' }))));
  assert.deepEqual(checks.map((c) => c.id), ['truth:revenue-2026-09', 'truth:bad']);
  assert.equal(checks[0].timeout_seconds, 300);
  assert.equal(typeof checks[0].judge, 'function');
  assert.match(checks[1].problem, /^line \d+: expect must be a number$/);
  assert.equal(checks[1].run, undefined);
});

// --- npm run verify ---

// A governed repo with an optional data.md. `checks` become verify.checks.
function repo({ checks, data } = {}) {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, '.aplabs'));
  // A governed repo has an app dir, or the built-in write-path check fails.
  fs.mkdirSync(path.join(d, 'app'));
  const profile = { schema_version: 1, client: { id: 'tiny', name: 'Tiny' }, users: [{ id: 'solo', name: 'Solo', role: 'admin' }] };
  if (checks) profile.verify = { checks };
  fs.writeFileSync(path.join(d, '.aplabs/profile.yml'), YAML.stringify(profile));
  if (data !== undefined) {
    fs.mkdirSync(path.join(d, '.aplabs/context'));
    fs.writeFileSync(path.join(d, '.aplabs/context/data.md'), data);
  }
  return d;
}

function verify(dir, args = []) {
  const r = spawnSync(node, [VERIFY, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  const lines = r.stdout.trim().split('\n');
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, summary: JSON.parse(lines[lines.length - 1]) };
}

const PASS_CHECK = { id: 'ok', run: [node, '-e', 'process.exit(0)'] };
// The engine's built-in check, run last in every verify (DEP-012).
const BUILTIN = ['engine:write-path', 'pass'];

test('verify: truths run after the profile checks and appear in the JSON summary', () => {
  const d = repo({ checks: [PASS_CHECK], data: doc(block(), block({ id: 'abs', expect: 10, tolerance: 1 }, '10.9')) });
  const r = verify(d);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.summary.results.map((x) => [x.id, x.outcome]), [['ok', 'pass'], ['truth:revenue-2026-09', 'pass'], ['truth:abs', 'pass'], BUILTIN]);
  assert.equal(r.summary.ok, true);
  assert.match(r.stdout, /^PASS truth:revenue-2026-09 /m);
});

test('verify: a truth outside tolerance, non-numeric output or a malformed block fails with exit 1', () => {
  const d = repo({
    data: doc(
      block({ id: 'off' }, '400,000'),
      block({ id: 'words' }, 'no rows'),
      block({ id: 'broken', signed_off: '2026-02-30' }),
      block({ id: 'exits' }).replace(/console\.log\([^)]*\)/, 'process.exit(4)'),
    ),
  });
  const r = verify(d);
  assert.equal(r.code, 1);
  const by = Object.fromEntries(r.summary.results.map((x) => [x.id, x]));
  assert.equal(by['truth:off'].outcome, 'fail');
  assert.equal(by['truth:off'].reason, 'expected 412300 ± 0.5%, actual 400000 (off by 12300)');
  assert.equal(by['truth:words'].outcome, 'fail');
  assert.match(by['truth:words'].reason, /output is not a number: "no rows"/);
  assert.equal(by['truth:broken'].outcome, 'fail');
  assert.match(by['truth:broken'].reason, /signed_off must be pending or a real ISO date/);
  assert.deepEqual([by['truth:exits'].outcome, by['truth:exits'].reason], ['fail', 'exit 4']);
  assert.equal(r.summary.failed, 4);
  assert.match(r.stdout, /^FAIL truth:off \d+\.\d\ds \(expected 412300 ± 0\.5%, actual 400000/m);
});

test('verify: a missing command skips and a slow one times out; --strict exits 1', () => {
  const d = repo({
    data: doc(
      block({ id: 'gone', run: ['/nonexistent/aplabs-no-such-binary'] }),
      block({ id: 'slow', run: [node, '-e', 'setTimeout(() => {}, 10000)'], timeout_seconds: 1 }),
    ),
  });
  const r = verify(d);
  assert.equal(r.code, 0);
  assert.deepEqual(r.summary.results.map((x) => [x.id, x.outcome]), [['truth:gone', 'skip'], ['truth:slow', 'timeout'], BUILTIN]);
  assert.deepEqual([r.summary.skipped, r.summary.timed_out, r.summary.ok], [1, 1, false]);
  assert.equal(verify(d, ['--strict']).code, 1);
});

test('verify: no data.md, or no truths in it, runs nothing extra', () => {
  for (const data of [undefined, '# Data canon\n\n## Known truths\n\n<!-- none yet -->\n']) {
    const r = verify(repo({ checks: [PASS_CHECK], data }));
    assert.equal(r.code, 0);
    assert.deepEqual(r.summary.results.map((x) => x.id), ['ok', BUILTIN[0]]);
  }
});

// --- Stop hook ---

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1' };

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, ...GIT_ENV } });
  assert.equal(r.status, 0, r.stderr);
}

function stopHook(dir) {
  const r = spawnSync('/bin/bash', [STOP], {
    cwd: dir,
    input: JSON.stringify({ session_id: 'sess-1', cwd: dir, hook_event_name: 'Stop' }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PROJECT_DIR: dir, ...GIT_ENV },
  });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

test('Stop hook: a failing truth blocks the turn end, even with no profile checks', () => {
  const d = repo({ data: doc(block({ id: 'off' }, '400000')) });
  git(d, 'init', '-q');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(d, 'work.txt'), 'changed\n');
  const r = stopHook(d);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /^Verify failed: truth:off\./);
  assert.match(r.out.reason, /expected 412300 ± 0\.5%, actual 400000/);
  assert.match(r.out.systemMessage, /FAILED truth:off/);
});

test('Stop hook: passing truths are one pass line', () => {
  const d = repo({ data: doc(block()) });
  git(d, 'init', '-q');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(d, 'work.txt'), 'changed\n');
  const r = stopHook(d);
  assert.match(r.out.systemMessage, /^AP Labs verify: all 2 checks passed/);
});

// --- last verify result (#45) ---

const gitRepo = (opts) => {
  const d = repo(opts);
  git(d, 'init', '-q');
  return d;
};
const readLast = (d) => JSON.parse(fs.readFileSync(lastFile(path.join(d, '.git')), 'utf8'));

test('verify records each run in <git-dir>/aplabs/verify/last.json; outside git it writes nothing', () => {
  const d = gitRepo({ checks: [PASS_CHECK], data: doc(block({ id: 'off' }, '400,000')) });
  assert.equal(verify(d).code, 1);
  const rec = readLast(d);
  assert.equal(rec.source, 'verify');
  assert.equal(rec.head, null);
  assert.ok(Math.abs(Date.parse(rec.at) - Date.now()) < 60000);
  assert.deepEqual(rec.results, [{ id: 'ok', outcome: 'pass' }, { id: 'truth:off', outcome: 'fail' }, { id: BUILTIN[0], outcome: 'pass' }]);
  const plain = repo({ checks: [PASS_CHECK] });
  assert.equal(verify(plain).code, 0);
  assert.equal(fs.existsSync(path.join(plain, '.git')), false);
});

test('Stop hook records its run in last.json too', () => {
  const d = gitRepo({ data: doc(block({ id: 'off' }, '400000')) });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(d, 'work.txt'), 'changed\n');
  stopHook(d);
  const rec = readLast(d);
  assert.equal(rec.source, 'stop-hook');
  assert.match(rec.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(rec.results, [{ id: 'truth:off', outcome: 'fail' }, { id: BUILTIN[0], outcome: 'pass' }]);
});

test('readLastResult: missing, malformed, future or old records read as null', () => {
  const g = path.join(tmpDir(), '.git');
  assert.equal(readLastResult(g), null);
  assert.equal(readLastResult(null), null);
  const file = lastFile(g);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const text of ['not json', '[]', '{"at":"2026-10-24T00:00:00Z"}', '{"at":"soon","results":[]}']) {
    fs.writeFileSync(file, text);
    assert.equal(readLastResult(g), null, text);
  }
  const now = Date.parse('2026-10-24T12:00:00Z');
  const rec = (at) => JSON.stringify({ at: new Date(at).toISOString(), head: null, source: 'verify', results: [{ id: 'a', outcome: 'fail' }, { id: 1, outcome: 'fail' }, { id: 'b', outcome: 'odd' }] });
  fs.writeFileSync(file, rec(now - MAX_AGE_MS - 1000));
  assert.equal(readLastResult(g, now), null);
  fs.writeFileSync(file, rec(now + 5 * 60 * 1000));
  assert.equal(readLastResult(g, now), null);
  fs.writeFileSync(file, rec(now - 1000));
  assert.deepEqual(readLastResult(g, now).results, [{ id: 'a', outcome: 'fail' }]);
});

test('writeLastResult never throws and writes nothing outside a git repo', () => {
  assert.equal(writeLastResult(tmpDir(), [{ id: 'a', outcome: 'pass' }], 'verify'), null);
});

// --- session banner ---

const bannerLines = (d) => sessionStart(d).systemMessage.split('\n').filter((l) => l.startsWith('Known truths'));

test('banner: one line for pending, ownerless or invalid truths; never runs them', () => {
  const marker = path.join(tmpDir(), 'ran');
  const touches = [node, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`];
  const d = repo({
    data: doc(
      block({ id: 'signed', run: touches }),
      block({ id: 'waiting', signed_off: 'pending', run: touches }),
      block({ id: 'nobody', owner: undefined, run: touches }),
      block({ id: 'broken', tolerance: 'lots', run: touches }),
      block({ id: 'fine', run: touches }),
    ),
  });
  assert.deepEqual(bannerLines(d), ['Known truths: 3 of 5 need a check or sign-off']);
  const context = sessionStart(d).hookSpecificOutput.additionalContext;
  assert.match(context, /^Known truths: 3 of 5 need a check or sign-off \(the truth blocks in \.aplabs\/context\/data\.md/m);
  assert.equal(fs.existsSync(marker), false, 'session start must not run truth commands');
});

test('banner: flags truths that failed or timed out at the last verify run, without running them (#45)', () => {
  const marker = path.join(tmpDir(), 'ran');
  const touches = [node, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`];
  const d = gitRepo({ data: doc(block({ id: 'a', run: touches }), block({ id: 'b', run: touches }), block({ id: 'c', run: touches }), block({ id: 'w', signed_off: 'pending', run: touches })) });
  // No record yet: only the sign-off line.
  assert.deepEqual(bannerLines(d), ['Known truths: 1 of 4 need a check or sign-off']);
  const at = new Date(Date.now() - 60000).toISOString();
  const write = (results, when = at) => {
    fs.mkdirSync(path.dirname(lastFile(path.join(d, '.git'))), { recursive: true });
    fs.writeFileSync(lastFile(path.join(d, '.git')), JSON.stringify({ at: when, head: null, source: 'verify', results }));
  };
  // A removed truth (gone) and a non-truth check (ok) are not counted.
  write([{ id: 'ok', outcome: 'fail' }, { id: 'truth:a', outcome: 'fail' }, { id: 'truth:b', outcome: 'timeout' },
    { id: 'truth:c', outcome: 'pass' }, { id: 'truth:gone', outcome: 'fail' }]);
  assert.deepEqual(bannerLines(d), [`Known truths: 1 of 4 need a check or sign-off; 2 failed at last verify (${at})`]);
  assert.match(sessionStart(d).hookSpecificOutput.additionalContext, /2 failed at last verify .*SQLsmith must not rely/);
  // All signed off and only a failure: one line for the failure.
  const d2 = gitRepo({ data: doc(block({ id: 'a', run: touches })) });
  fs.mkdirSync(path.dirname(lastFile(path.join(d2, '.git'))), { recursive: true });
  fs.writeFileSync(lastFile(path.join(d2, '.git')), JSON.stringify({ at, results: [{ id: 'truth:a', outcome: 'fail' }] }));
  assert.deepEqual(bannerLines(d2), [`Known truths: 1 failed at last verify (${at})`]);
  // An old record is ignored.
  write([{ id: 'truth:a', outcome: 'fail' }], new Date(Date.now() - MAX_AGE_MS - 60000).toISOString());
  assert.deepEqual(bannerLines(d), ['Known truths: 1 of 4 need a check or sign-off']);
  assert.equal(fs.existsSync(marker), false, 'session start must not run truth commands');
});

test('banner: a real failing verify run shows up at the next session start', () => {
  const d = gitRepo({ data: doc(block({ id: 'off' }, '400,000')) });
  assert.deepEqual(bannerLines(d), []);
  assert.equal(verify(d).code, 1);
  assert.match(bannerLines(d)[0], /^Known truths: 1 failed at last verify \(\d{4}-\d\d-\d\dT/);
});

test('banner: silent when every truth is valid and signed off, or there are none', () => {
  assert.deepEqual(bannerLines(repo({ data: doc(block(), block({ id: 'two' })) })), []);
  assert.deepEqual(bannerLines(repo({ data: '# Data canon\n' })), []);
  assert.deepEqual(bannerLines(repo()), []);
});
