'use strict';

// The build ledger (Story 5.1; plan ledger-rows): the pure rules in
// kit/lib/ledger, and scripts/ledger-check.js end to end against throwaway
// git repos. The rows and branch names are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  parseLedger, parseLedgerSet, parseBuildFile, buildFileName, buildFilePath, checkPr, cells, BUILDS_DIR,
} = require('../../kit/lib/ledger');
const { readLedgerSet, parseNameStatus } = require('../../scripts/ledger-check');

const cli = path.join(__dirname, '../../scripts/ledger-check.js');
const tmps = [];
test.after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const BUILDS = '| PR | Date | Story | Kind | Tier | Summary | DEPs |\n|---|---|---|---|---|---|---|\n';
const DEPS = '| DEP | Opened | Owner | Status | Blocks | What | Source |\n|---|---|---|---|---|---|---|\n';
const ledger = ({ builds = '| #1 | 2026-01-01 | 1.1 | infra | T1 | Adds a thing. | DEP-001 |\n', deps = '| DEP-001 | 2026-01-01 | Orchestrator | open | — | Later. | #2 |\n' } = {}) =>
  `# Build ledger\n\n## Builds\n\n${BUILDS}${builds}\n## Deferrals (DEP)\n\n${DEPS}${deps}`;
const ch = (file, added = 1, deleted = 0) => ({ file, added, deleted });

test('parseLedger: a well-formed ledger parses with no errors', () => {
  const r = parseLedger(ledger({ builds: '| #1 | 2026-01-01 | 1.1 | infra | — | A \\| B. | DEP-001 |\n| pending | 2026-01-02 | — | — | — | Next. | — |\n' }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.builds.length, 2);
  assert.equal(r.builds[0].summary, 'A \\| B.');
  assert.deepEqual(r.builds[0].deps, ['DEP-001']);
  assert.equal(r.deps[0].status, 'open');
});

// Plan ledger-rows, design 5: npm test on main re-checks the whole set, so two
// PRs that each passed alone but clash together (the same DEP, the same PR
// number) show up on the next run.
test('parseLedgerSet: the repo ledger, with every build file, is well formed', () => {
  const set = readLedgerSet(path.join(__dirname, '../..'));
  assert.ok(set.ledger, 'docs/ledger.md is read');
  assert.deepEqual(parseLedgerSet(set).errors, []);
});

test('parseLedger: malformed ledgers fail with a named problem', () => {
  const dupDep = parseLedger(ledger({ deps: '| DEP-001 | 2026-01-01 | O | open | — | A | x |\n| DEP-001 | 2026-01-01 | O | closed | — | B | x |\n' }));
  assert.match(dupDep.errors.join('\n'), /DEP-001 is used twice/);

  const badStatus = parseLedger(ledger({ deps: '| DEP-001 | 2026-01-01 | O | done | — | A | x |\n' }));
  assert.match(badStatus.errors.join('\n'), /status "done"/);

  const badId = parseLedger(ledger({ builds: '', deps: '| DEP-1 | 2026-01-01 | O | open | — | A | x |\n' }));
  assert.match(badId.errors.join('\n'), /"DEP-1" is not a DEP id/);

  const noDeps = parseLedger(`# Build ledger\n\n${BUILDS}| #1 | d | — | — | — | s | — |\n`);
  assert.match(noDeps.errors.join('\n'), /missing the Deferrals table/);
  const noBuilds = parseLedger(`# Build ledger\n\n${DEPS}`);
  assert.match(noBuilds.errors.join('\n'), /missing the Builds table/);

  const dupPr = parseLedger(ledger({ builds: '| #1 | d | — | — | — | s | — |\n| #1 | d | — | — | — | t | — |\n' }));
  assert.match(dupPr.errors.join('\n'), /PR #1 has two rows/);

  const danglingDep = parseLedger(ledger({ builds: '| #1 | d | — | — | — | s | DEP-009 |\n' }));
  assert.match(danglingDep.errors.join('\n'), /DEP-009, which has no DEP row/);

  const shortRow = parseLedger(ledger({ builds: '| #1 | d | s |\n' }));
  assert.match(shortRow.errors.join('\n'), /needs 7 cells, found 3/);
});

test('parseLedger: a second Builds or Deferrals table fails validation (#34)', () => {
  const extraBuilds = parseLedger(`${ledger()}\n## More builds\n\n${BUILDS}| #1 | d | — | — | — | dup | DEP-404 |\n`);
  assert.match(extraBuilds.errors.join('\n'), /line 17: a second Builds table; keep one Builds table \(the first is at line 5\)/);
  const extraDeps = parseLedger(`${ledger()}\n${DEPS}| DEP-001 | d | O | done | — | A | x |\n\n${DEPS}`);
  const msg = extraDeps.errors.join('\n');
  assert.match(msg, /line 15, 19: a second Deferrals table; keep one Deferrals table \(the first is at line 11\)/);
  assert.doesNotMatch(msg, /Builds table/);
  assert.deepEqual(parseLedger(ledger()).errors, []);
});

test('cells: escaped pipes stay inside a cell', () => {
  assert.deepEqual(cells('| a | b \\| c | d |'), ['a', 'b \\| c', 'd']);
});

test('checkPr: a touched ledger passes; an untouched one fails and names where the row goes', () => {
  assert.equal(checkPr({ changes: [ch('kit/a.js'), ch('docs/ledger.md')] }).ok, true);
  const miss = checkPr({ changes: [ch('kit/a.js')] });
  assert.equal(miss.ok, false);
  assert.match(miss.message, /docs\/ledger\/builds\/<branch>\.md/);
  assert.match(miss.message, /a DEP row in docs\/ledger\.md/);
});

test('checkPr: exemptions come from the review rules, limited to docs-only and verified reverts', () => {
  assert.deepEqual(checkPr({ changes: [ch('docs/a.md'), ch('README.md')] }).reason, 'docs only');
  assert.equal(checkPr({ changes: [ch('AGENTS.md')] }).ok, false, 'protected docs are never exempt');
  assert.equal(checkPr({ changes: [ch('kit/a.json', 1, 1)] }).ok, false, 'small config skips review but not the ledger');
  assert.equal(checkPr({ changes: [ch('kit/a.js')], commits: [{ verifiedRevert: true }] }).reason, 'revert');
  assert.equal(checkPr({ changes: [ch('kit/a.js')], commits: [{ verifiedRevert: false }] }).ok, false);
  assert.equal(checkPr({ changes: [] }).ok, false, 'nothing to classify is not exempt');
});

// --- plan ledger-rows: one build file per row ------------------------------

const row = (pr = 'pending', deps = '—', summary = 'A build.') => `| ${pr} | 2026-01-03 | 9.9 | infra | T1 | ${summary} | ${deps} |\n`;
const buildFile = (...rows) => `${BUILDS}${rows.join('')}`;
const set = (builds, opts) => ({ ledger: ledger(opts), builds: Object.entries(builds).map(([name, text]) => ({ name, text })) });
const errorsOf = (s) => parseLedgerSet(s).errors;

test('buildFileName: the branch lowercased with / as -', () => {
  assert.equal(buildFileName('infra/ledger-no-conflicts'), 'infra-ledger-no-conflicts.md');
  assert.equal(buildFileName('Feat/Routing-15.3/Map'), 'feat-routing-15.3-map.md');
  assert.equal(buildFilePath('feat/x'), `${BUILDS_DIR}/feat-x.md`);
  assert.equal(BUILDS_DIR, 'docs/ledger/builds');
});

test('parseLedgerSet: the ledger and well-formed build files parse together, with each row\'s file and line', () => {
  const r = parseLedgerSet(set({ 'feat-a.md': buildFile(row('#7', 'DEP-001')), 'feat-b.md': `\n${buildFile(row())}\n` }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.builds.map((b) => [b.file, b.line, b.pr]), [
    ['docs/ledger.md', 7, '#1'], [`${BUILDS_DIR}/feat-a.md`, 3, '#7'], [`${BUILDS_DIR}/feat-b.md`, 4, 'pending'],
  ]);
  assert.deepEqual(r.builds[1].deps, ['DEP-001']);
  assert.equal(r.deps.length, 1);
});

test('parseLedgerSet: no builds/ folder counts as empty, and a missing ledger is an error', () => {
  assert.deepEqual(parseLedgerSet({ ledger: ledger() }).errors, []);
  assert.deepEqual(parseLedgerSet({ ledger: ledger(), builds: [] }).errors, []);
  assert.deepEqual(parseLedgerSet({ ledger: null }).errors, ['docs/ledger.md: missing']);
});

test('parseLedgerSet: a PR with two rows anywhere fails as file:line (AC1, AC2)', () => {
  // In docs/ledger.md and a build file.
  assert.deepEqual(errorsOf(set({ 'feat-a.md': buildFile(row('#1')) })), [
    `${BUILDS_DIR}/feat-a.md:3: PR #1 has two rows (the other is at docs/ledger.md:7)`,
  ]);
  // In two build files.
  assert.deepEqual(errorsOf(set({ 'feat-b.md': buildFile(row('#8')), 'feat-a.md': buildFile(row('#8')) })), [
    `${BUILDS_DIR}/feat-b.md:3: PR #8 has two rows (the other is at ${BUILDS_DIR}/feat-a.md:3)`,
  ]);
  // Pending rows have no number yet, so two of them never clash here
  // (ledger-check stops one branch adding two).
  assert.deepEqual(errorsOf(set({ 'feat-a.md': buildFile(row()), 'feat-b.md': buildFile(row()) })), []);
  // parseLedger's own errors come out as file:line too.
  assert.deepEqual(errorsOf(set({}, { builds: `${row('#1')}${row('#1')}` })), ['docs/ledger.md:8: PR #1 has two rows']);
});

test('parseLedgerSet: a build file holds one Builds row and nothing else (AC2)', () => {
  const f = `${BUILDS_DIR}/feat-a.md`;
  assert.deepEqual(errorsOf(set({ 'feat-a.md': BUILDS })), [`${f}:1: no row; a build file holds exactly one Builds row`]);
  assert.deepEqual(errorsOf(set({ 'feat-a.md': buildFile(row('#7'), row('#8')) })), [
    `${f}:4: a second row; a build file holds exactly one Builds row (one file per PR)`,
  ]);
  assert.deepEqual(errorsOf(set({ 'feat-a.md': `${buildFile(row('#7'))}\n${DEPS}| DEP-002 | d | O | open | — | A | x |\n` })), [
    `${f}:5: a DEP table; DEP rows go in docs/ledger.md, never in a build file`,
  ]);
  assert.deepEqual(errorsOf(set({ 'feat-a.md': `# Heading\n\n${buildFile(row('#7'))}` })), [
    `${f}:1: text outside the table; a build file holds only the Builds header and one row`,
  ]);
  assert.deepEqual(errorsOf(set({ 'feat-a.md': `${buildFile(row('#7'))}\n| a | b |\n|---|---|\n` })), [
    `${f}:5: another table; a build file holds only the Builds table`,
  ]);
  assert.deepEqual(errorsOf(set({ 'feat-a.md': '' })), [`${f}:1: missing the Builds table (header: | PR | Date | Story | Kind | Tier | Summary | DEPs |)`]);
  assert.deepEqual(errorsOf(set({ 'feat-a.md': `| PR | Date | Story | Kind | Tier | Summary | DEPs |\n${row('#7')}` })), [
    `${f}:2: the Builds header needs its separator row (|---|---|...)`,
  ]);
  assert.deepEqual(errorsOf(set({ 'feat-a.md': buildFile('| #7 | d | s |\n') })), [`${f}:3: a Builds row needs 7 cells, found 3`]);
  assert.deepEqual(errorsOf(set({ 'feat-a.md': buildFile(row('7')) })), [`${f}:3: PR "7" must be #<number> or pending`]);
});

test('parseLedgerSet: a bad build file name fails (AC2)', () => {
  for (const name of ['Feat-a.md', 'feat_a.md', '-feat.md', '.feat.md', 'feat-a.txt', 'README.md', 'sub/', 'feat a.md']) {
    assert.deepEqual(errorsOf(set({ [name]: buildFile(row('#7')) })).filter((e) => /bad file name/.test(e)), [
      `${BUILDS_DIR}/${name}: a bad file name; use the branch name lowercased with / as - (/^[a-z0-9][a-z0-9.-]*\\.md$/)`,
    ], name);
  }
  for (const name of ['feat-a.md', '15.3-map.md', '0.md']) assert.deepEqual(errorsOf(set({ [name]: buildFile(row('#7')) })), [], name);
});

test('parseLedgerSet: a DEP named in a build file needs a DEP row in docs/ledger.md (AC2)', () => {
  assert.deepEqual(errorsOf(set({ 'feat-a.md': buildFile(row('#7', 'DEP-001, DEP-009')) })), [
    `${BUILDS_DIR}/feat-a.md:3: PR #7 names DEP-009, which has no DEP row in docs/ledger.md`,
  ]);
});

test('parseBuildFile: the row and its line, or null with the errors', () => {
  const ok = parseBuildFile(buildFile(row('#7')));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.row.pr, '#7');
  assert.equal(ok.row.line, 3);
  assert.equal(parseBuildFile(buildFile(row('#7'), row('#8'))).row, null);
});

const st = (status, file) => ({ status, file });
const own = `${BUILDS_DIR}/feat-x.md`;

test('checkPr: a PR that adds only its own build file passes (AC3)', () => {
  const r = checkPr({ changes: [ch('kit/a.js'), ch(own)], files: [st('M', 'kit/a.js'), st('A', own)], branch: 'feat/x' });
  assert.deepEqual([r.ok, r.reason], [true, 'build file added']);
});

test('checkPr: a code PR with no row fails and names its own build file (AC3)', () => {
  const r = checkPr({ changes: [ch('kit/a.js')], files: [st('M', 'kit/a.js')], branch: 'feat/x' });
  assert.equal(r.ok, false);
  assert.equal(r.message, `This PR adds no ledger row. Add its one Builds row in its own build file, ${own} (see docs/ledger/README.md), and a DEP row in docs/ledger.md for anything it defers.`);
});

test('checkPr: deleting or editing another PR\'s build file fails, even in a docs-only PR (AC3)', () => {
  const other = `${BUILDS_DIR}/feat-y.md`;
  const del = checkPr({ changes: [ch(other)], files: [st('D', other)], branch: 'feat/x' });
  assert.deepEqual([del.ok, del.reason], [false, 'deletes a build file']);
  assert.match(del.message, /deletes docs\/ledger\/builds\/feat-y\.md/);
  const delOwnAlongside = checkPr({ changes: [ch(own), ch(other)], files: [st('A', own), st('D', other)], branch: 'feat/x' });
  assert.equal(delOwnAlongside.reason, 'deletes a build file');
  const edit = checkPr({ changes: [ch(other)], files: [st('M', other)], branch: 'feat/x' });
  assert.deepEqual([edit.ok, edit.reason], [false, 'another build file']);
  assert.match(edit.message, new RegExp(`Add or edit only ${own}`));
  const addOther = checkPr({ changes: [ch(other)], files: [st('A', other)], branch: 'feat/x' });
  assert.equal(addOther.reason, 'another build file');
  const unknown = checkPr({ changes: [ch(other)], files: [st('A', other)] });
  assert.deepEqual([unknown.ok, unknown.reason], [false, 'unknown branch']);
});

test('checkPr: a reused branch name (its build file already on the base) fails (AC3)', () => {
  const r = checkPr({ changes: [ch(own)], files: [st('M', own)], branch: 'feat/x' });
  assert.deepEqual([r.ok, r.reason], [false, 'branch name reused']);
  assert.match(r.message, /already exists at the base: branch name reused; add a suffix \(for example feat\/x-2\)/);
});

test('checkPr: a row in both docs/ledger.md and a build file fails, and so do two pending rows (AC1)', () => {
  const before = parseLedger(ledger()).builds;
  const plusOne = parseLedger(ledger({ builds: `${row('#1', 'DEP-001')}${row()}` })).builds;
  const plusTwo = parseLedger(ledger({ builds: `${row('#1', 'DEP-001')}${row()}${row()}` })).builds;
  const both = checkPr({
    changes: [ch('docs/ledger.md'), ch(own)], files: [st('M', 'docs/ledger.md'), st('A', own)], branch: 'feat/x', ledgerRows: { before, after: plusOne },
  });
  assert.deepEqual([both.ok, both.reason], [false, 'row in both places']);
  const two = checkPr({ changes: [ch('docs/ledger.md')], files: [st('M', 'docs/ledger.md')], branch: 'feat/x', ledgerRows: { before, after: plusTwo } });
  assert.deepEqual([two.ok, two.reason], [false, 'two pending rows']);
  // One pending row in docs/ledger.md (the old way, as a fork without
  // docs/ledger/ does) still passes.
  const old = checkPr({ changes: [ch('docs/ledger.md')], files: [st('M', 'docs/ledger.md')], branch: 'feat/x', ledgerRows: { before, after: plusOne } });
  assert.deepEqual([old.ok, old.reason], [true, 'ledger updated']);
  // Its own build file plus a DEP row in docs/ledger.md passes.
  const withDep = checkPr({
    changes: [ch('docs/ledger.md'), ch(own)], files: [st('M', 'docs/ledger.md'), st('A', own)], branch: 'feat/x', ledgerRows: { before, after: before },
  });
  assert.equal(withDep.ok, true);
});

test('parseNameStatus: -z name-status output -> { status, file }', () => {
  assert.deepEqual(parseNameStatus('A\0docs/a b.md\0M\0kit/x.js\0D\0old.md\0'), [st('A', 'docs/a b.md'), st('M', 'kit/x.js'), st('D', 'old.md')]);
  assert.deepEqual(parseNameStatus(''), []);
});

function repo({ branch = 'feat', base = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-ledger-'));
  tmps.push(dir);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (files, msg = 'change') => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) fs.rmSync(path.join(dir, file));
      else write(file, text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', msg);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  commit({ 'docs/ledger.md': ledger(), 'kit/a.js': '1\n', ...base }, 'base');
  git('checkout', '-q', '-b', branch);
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  return { dir, commit, run, git };
}

test('ledger-check CLI: diffs against --base and fails a code PR with no ledger row', () => {
  const r = repo();
  r.commit({ 'kit/a.js': '2\n' });
  const out = r.run(['--base', 'main']);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /This PR adds no ledger row\. Add its one Builds row in its own build file, docs\/ledger\/builds\/feat\.md/);

  r.commit({ 'docs/ledger.md': ledger({ builds: '| #1 | d | — | — | — | s | DEP-001 |\n| pending | d | — | — | — | t | — |\n' }) });
  const ok = r.run(['--base', 'main']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /docs\/ledger\.md is updated/);
});

test('ledger-check CLI: a PR that adds only its own build file passes; the branch comes from --head, GITHUB_HEAD_REF or HEAD (AC3)', () => {
  const r = repo({ branch: 'feat/Map-View' });
  r.commit({ 'kit/a.js': '2\n', 'docs/ledger/builds/feat-map-view.md': buildFile(row()) });
  const out = r.run(['--base', 'main']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /docs\/ledger\/builds\/feat-map-view\.md is added/);
  assert.equal(r.run(['--base', 'main'], { GITHUB_HEAD_REF: 'feat/map-view' }).status, 0);
  const wrong = r.run(['--base', 'main'], { GITHUB_HEAD_REF: 'feat/other' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /not this branch's build file\. Add or edit only docs\/ledger\/builds\/feat-other\.md/);
  assert.equal(r.run(['--base', 'main', '--head', 'feat/map-view'], { GITHUB_HEAD_REF: 'feat/other' }).status, 0, '--head wins');
});

test('ledger-check CLI: fails a PR that edits or deletes another PR\'s build file (AC3)', () => {
  const other = { 'docs/ledger/builds/feat-old.md': buildFile(row('#5')) };
  const edit = repo({ base: other });
  edit.commit({ 'kit/a.js': '2\n', 'docs/ledger/builds/feat.md': buildFile(row()), 'docs/ledger/builds/feat-old.md': buildFile(row('#5', '—', 'Changed.')) });
  const e = edit.run(['--base', 'main']);
  assert.equal(e.status, 1);
  assert.match(e.stderr, /adds or edits docs\/ledger\/builds\/feat-old\.md, which is not this branch's build file/);

  const del = repo({ base: other });
  del.commit({ 'docs/ledger/builds/feat-old.md': null });
  const d = del.run(['--base', 'main']);
  assert.equal(d.status, 1, 'a docs-only delete still fails');
  assert.match(d.stderr, /This PR deletes docs\/ledger\/builds\/feat-old\.md/);
});

test('ledger-check CLI: fails a reused branch name (AC3)', () => {
  const r = repo({ base: { 'docs/ledger/builds/feat.md': buildFile(row('#5')) } });
  r.commit({ 'kit/a.js': '2\n', 'docs/ledger/builds/feat.md': buildFile(row()) });
  const out = r.run(['--base', 'main']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /docs\/ledger\/builds\/feat\.md already exists at the base: branch name reused; add a suffix/);
});

test('ledger-check CLI: a row in both places, or two pending rows, fails (AC1)', () => {
  const both = repo();
  both.commit({ 'kit/a.js': '2\n', 'docs/ledger/builds/feat.md': buildFile(row()), 'docs/ledger.md': ledger({ builds: `${row('#1', 'DEP-001')}${row()}` }) });
  const b = both.run(['--base', 'main']);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /adds a row to docs\/ledger\.md and its own build file docs\/ledger\/builds\/feat\.md/);

  const two = repo();
  two.commit({ 'kit/a.js': '2\n', 'docs/ledger.md': ledger({ builds: `${row('#1', 'DEP-001')}${row()}${row()}` }) });
  const t = two.run(['--base', 'main']);
  assert.equal(t.status, 1);
  assert.match(t.stderr, /adds 2 pending rows to docs\/ledger\.md/);
});

test('ledger-check CLI: a malformed build file fails as file:line', () => {
  const r = repo();
  r.commit({ 'kit/a.js': '2\n', 'docs/ledger/builds/feat.md': buildFile(row('pending', 'DEP-404')) });
  const out = r.run(['--base', 'main']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /docs\/ledger\/builds\/feat\.md:3: PR pending names DEP-404, which has no DEP row/);
});

// AC1: the point of the plan. Two branches from the same main, each adding
// its own build file, merge one after the other with no conflict, and the
// check passes on each merged tree (as CI runs it, on the PR's merge commit).
test('ledger-check CLI: two PRs from one main each add a build file and merge with no conflict (AC1)', () => {
  const r = repo({ branch: 'feat/a' });
  r.commit({ 'kit/a.js': '2\n', 'docs/ledger/builds/feat-a.md': buildFile(row('#10')) }, 'a');
  r.git('checkout', '-q', 'main');
  r.git('checkout', '-q', '-b', 'feat/b');
  r.commit({ 'kit/b.js': '1\n', 'docs/ledger/builds/feat-b.md': buildFile(row('#11')) }, 'b');

  // PR a lands first.
  r.git('checkout', '-q', 'main');
  r.git('merge', '-q', '--no-ff', '--no-edit', 'feat/a');
  const mainAfterA = r.git('rev-parse', 'HEAD');

  // PR b, never updated from main: CI checks its merge commit with main.
  r.git('checkout', '-q', '--detach', mainAfterA);
  r.git('merge', '-q', '--no-ff', '--no-edit', 'feat/b'); // throws on a conflict
  assert.equal(r.git('status', '--porcelain'), '');
  const out = r.run(['--base', mainAfterA], { GITHUB_HEAD_REF: 'feat/b' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /docs\/ledger\/builds\/feat-b\.md is added/);
  const merged = readLedgerSet(r.dir);
  assert.deepEqual(merged.builds.map((b) => b.name).sort(), ['feat-a.md', 'feat-b.md']);
  assert.deepEqual(parseLedgerSet(merged).errors, []);

  // The switchover: rows in docs/ledger.md and build files side by side.
  const parsed = parseLedgerSet(merged);
  assert.deepEqual(parsed.builds.map((b) => b.pr), ['#1', '#10', '#11']);
});

test('ledger-check CLI: two PRs that each pass alone but share a PR number fail on the merged tree', () => {
  const r = repo({ branch: 'feat/a' });
  r.commit({ 'docs/ledger/builds/feat-a.md': buildFile(row('#10')) }, 'a');
  r.git('checkout', '-q', 'main');
  r.git('checkout', '-q', '-b', 'feat/b');
  r.commit({ 'docs/ledger/builds/feat-b.md': buildFile(row('#10')) }, 'b');
  r.git('checkout', '-q', 'main');
  r.git('merge', '-q', '--no-ff', '--no-edit', 'feat/a');
  r.git('merge', '-q', '--no-ff', '--no-edit', 'feat/b');
  assert.deepEqual(parseLedgerSet(readLedgerSet(r.dir)).errors, [
    `${BUILDS_DIR}/feat-b.md:3: PR #10 has two rows (the other is at ${BUILDS_DIR}/feat-a.md:3)`,
  ]);
});

test('ledger-check CLI: docs-only passes; a revert is not exempt in CI', () => {
  const docs = repo();
  docs.commit({ 'docs/guide.md': 'hi\n' });
  assert.equal(docs.run(['--base', 'main']).status, 0);

  const rev = repo();
  rev.commit({ 'kit/a.js': '2\n' }, 'change');
  rev.git('revert', '--no-edit', 'HEAD');
  const out = rev.run(['--base', 'main']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /reverts are not exempt in CI/);
});

test('ledger-check CLI: a malformed ledger fails even when touched', () => {
  const r = repo();
  r.commit({ 'docs/ledger.md': ledger({ deps: '| DEP-001 | d | O | wip | — | A | x |\n' }) });
  const out = r.run(['--base', 'main']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /docs\/ledger\.md:13: DEP-001 has status "wip"/);
});

test('ledger-check CLI: usage and a bad base exit 2', () => {
  const r = repo();
  assert.equal(r.run([]).status, 2);
  assert.equal(r.run(['--base', 'no-such-ref']).status, 2);
  assert.equal(r.run(['--base', 'main', '--head']).status, 2);
  assert.equal(r.run(['--help']).status, 0);
});
