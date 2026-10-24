'use strict';

// The build ledger (Story 5.1): the pure rules in kit/lib/ledger, and
// scripts/ledger-check.js end to end against a throwaway git repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseLedger, checkPr, cells } = require('../../kit/lib/ledger');

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

test('parseLedger: the repo ledger is well formed', () => {
  const text = fs.readFileSync(path.join(__dirname, '../../docs/ledger.md'), 'utf8');
  assert.deepEqual(parseLedger(text).errors, []);
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

test('checkPr: a touched ledger passes; an untouched one fails and names the file', () => {
  assert.equal(checkPr({ changes: [ch('kit/a.js'), ch('docs/ledger.md')] }).ok, true);
  const miss = checkPr({ changes: [ch('kit/a.js')] });
  assert.equal(miss.ok, false);
  assert.match(miss.message, /docs\/ledger\.md/);
});

test('checkPr: exemptions come from the review rules, limited to docs-only and verified reverts', () => {
  assert.deepEqual(checkPr({ changes: [ch('docs/a.md'), ch('README.md')] }).reason, 'docs only');
  assert.equal(checkPr({ changes: [ch('AGENTS.md')] }).ok, false, 'protected docs are never exempt');
  assert.equal(checkPr({ changes: [ch('kit/a.json', 1, 1)] }).ok, false, 'small config skips review but not the ledger');
  assert.equal(checkPr({ changes: [ch('kit/a.js')], commits: [{ verifiedRevert: true }] }).reason, 'revert');
  assert.equal(checkPr({ changes: [ch('kit/a.js')], commits: [{ verifiedRevert: false }] }).ok, false);
  assert.equal(checkPr({ changes: [] }).ok, false, 'nothing to classify is not exempt');
});

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-ledger-'));
  tmps.push(dir);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (files, msg = 'change') => {
    for (const [file, text] of Object.entries(files)) write(file, text);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  commit({ 'docs/ledger.md': ledger(), 'kit/a.js': '1\n' }, 'base');
  git('checkout', '-q', '-b', 'feat');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: 'utf8' });
  return { commit, run, git };
}

test('ledger-check CLI: diffs against --base and fails a code PR with no ledger row', () => {
  const r = repo();
  r.commit({ 'kit/a.js': '2\n' });
  const out = r.run('--base', 'main');
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /Add a row for it to the Builds table in docs\/ledger\.md/);

  r.commit({ 'docs/ledger.md': ledger({ builds: '| #1 | d | — | — | — | s | DEP-001 |\n| pending | d | — | — | — | t | — |\n' }) });
  const ok = r.run('--base', 'main');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /docs\/ledger\.md is updated/);
});

test('ledger-check CLI: docs-only passes; a revert is not exempt in CI', () => {
  const docs = repo();
  docs.commit({ 'docs/guide.md': 'hi\n' });
  assert.equal(docs.run('--base', 'main').status, 0);

  const rev = repo();
  rev.commit({ 'kit/a.js': '2\n' }, 'change');
  rev.git('revert', '--no-edit', 'HEAD');
  const out = rev.run('--base', 'main');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /reverts are not exempt in CI/);
});

test('ledger-check CLI: a malformed ledger fails even when touched', () => {
  const r = repo();
  r.commit({ 'docs/ledger.md': ledger({ deps: '| DEP-001 | d | O | wip | — | A | x |\n' }) });
  const out = r.run('--base', 'main');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /status "wip"/);
});

test('ledger-check CLI: usage and a bad base exit 2', () => {
  const r = repo();
  assert.equal(r.run().status, 2);
  assert.equal(r.run('--base', 'no-such-ref').status, 2);
  assert.equal(r.run('--help').status, 0);
});
