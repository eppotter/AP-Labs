'use strict';

// Plan template-dist, Story D.1: the distribution tree's exclusions, the
// ledger transform, the deny-list loader (fail closed), the scan, and the
// tripwire: the tracked tree minus EXCLUDED, as it would ship, has no
// reference-client names. The tripwire skips only in a distribution copy
// (no docs/reference/); docs/reference/ without the deny file fails.
//
// The synthetic deny lists below use made-up words, never the real names.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dist = require('../../kit/lib/dist');
const { ENGINE_DIRS } = require('../../kit/runtime/paths');
const { parseLedger } = require('../../kit/lib/ledger');

const REPO = path.join(__dirname, '../..');
const { EXCLUDED, DENY_FILE } = dist;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-dist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeDeny(root, text) {
  fs.mkdirSync(path.join(root, 'docs/reference'), { recursive: true });
  fs.writeFileSync(path.join(root, DENY_FILE), text);
}

// --- Exclusions ---------------------------------------------------------

test('EXCLUDED is the four internal paths, and frozen', () => {
  assert.deepEqual([...EXCLUDED], ['docs/reference', 'docs/planning', 'docs/PLAN-v1.md', 'docs/HANDOFF.md']);
  assert.ok(Object.isFrozen(EXCLUDED));
});

test('no excluded path is under kit/, profiles/_schema/ or any ENGINE_DIRS entry', () => {
  for (const e of EXCLUDED) {
    for (const d of ['kit', 'profiles/_schema', ...ENGINE_DIRS]) {
      assert.ok(!(e === d || e.startsWith(`${d}/`)), `${e} is under ${d}`);
      assert.ok(!d.startsWith(`${e}/`), `${d} is under ${e}`);
    }
  }
  assert.doesNotThrow(() => dist.assertExclusionsSafe());
});

test('assertExclusionsSafe refuses an exclusion that would drop engine files, naming each', () => {
  assert.throws(() => dist.assertExclusionsSafe(['docs/reference', 'kit/lib/x']), /"kit\/lib\/x" overlaps the engine path "kit"/);
  assert.throws(() => dist.assertExclusionsSafe(['profiles']), /"profiles" overlaps the engine path "profiles\/_schema"/);
  assert.throws(() => dist.assertExclusionsSafe(['kit']), /overlaps the engine path "kit"/);
});

test('isExcluded matches an excluded path and what is under it, nothing near it', () => {
  for (const p of ['docs/reference', 'docs/reference/dist-deny.txt', 'docs/planning/x/y.md', 'docs/PLAN-v1.md', 'docs/HANDOFF.md']) {
    assert.ok(dist.isExcluded(p), p);
  }
  for (const p of ['docs/references/x.md', 'docs/PLAN-v1.md.bak', 'docs/planning.md', 'docs/ledger.md', 'kit/lib/dist/index.js', 'README.md']) {
    assert.ok(!dist.isExcluded(p), p);
  }
});

// --- Ledger transform ---------------------------------------------------

test('transformLedger keeps the text, headings and table header rows, and drops every row', () => {
  const text = [
    '# Build ledger', '', 'Intro line.', '', '## Builds', '',
    '| PR | Date | Story | Kind | Tier | Summary | DEPs |',
    '|---|---|---|---|---|---|---|',
    '| #1 | 2026-10-23 | — | — | — | One. | — |',
    '| #2 | 2026-10-23 | — | — | — | Two. | — |',
    '', '## Deferrals (DEP)', '',
    '| DEP | Opened | Owner | Status | Blocks | What | Source |',
    '|---|---|---|---|---|---|---|',
    '| DEP-001 | 2026-10-24 | Ely | open | — | Something. | x |',
    '',
  ].join('\n');
  const out = dist.transformLedger(text);
  assert.ok(!/#1 |#2 |DEP-001/.test(out));
  for (const keep of ['# Build ledger', 'Intro line.', '## Builds', '## Deferrals (DEP)', '| PR | Date |', '| DEP | Opened |']) {
    assert.ok(out.includes(keep), keep);
  }
  assert.equal(out.split('\n').filter((l) => /^\|---/.test(l)).length, 2);
});

test('the shipped ledger parses with no errors and no rows', () => {
  const real = fs.readFileSync(path.join(REPO, dist.LEDGER_PATH), 'utf8');
  const shipped = dist.shippedContent(dist.LEDGER_PATH, Buffer.from(real)).toString('utf8');
  const parsed = parseLedger(shipped);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.builds.length, 0);
  assert.equal(parsed.deps.length, 0);
  assert.ok(shipped.startsWith('# Build ledger'));
  assert.equal(dist.shippedContent('README.md', 'same'), 'same', 'other files ship unchanged');
});

// --- Deny list ----------------------------------------------------------

test('loadDenyList refuses a missing file', (t) => {
  const root = tempDir(t);
  assert.throws(() => dist.loadDenyList(root), /deny list .* is missing/);
  assert.throws(() => dist.loadDenyList(() => null), /is missing/);
});

test('loadDenyList refuses an empty list (blank lines and comments only)', (t) => {
  const root = tempDir(t);
  writeDeny(root, '# only a comment\n\n   \n# another\n');
  assert.throws(() => dist.loadDenyList(root), /no patterns/);
  writeDeny(root, '');
  assert.throws(() => dist.loadDenyList(root), /no patterns/);
});

test('loadDenyList refuses an invalid regex, naming the line but not the pattern', (t) => {
  const root = tempDir(t);
  writeDeny(root, '# c\nzorblax\nqu(ux\n');
  assert.throws(() => dist.loadDenyList(root), (e) => /invalid regex on line 3/.test(e.message) && !e.message.includes('qu(ux'));
});

test('loadDenyList numbers patterns, records their line, and matches case-insensitively', (t) => {
  const root = tempDir(t);
  writeDeny(root, '# header\n\nzorblax\n  \\bfrimp_\\w+\\b  \n# trailing\n');
  const list = dist.loadDenyList(root);
  assert.deepEqual(list.map((p) => [p.n, p.line]), [[1, 3], [2, 4]]);
  assert.ok(list[0].re.test('ZorbLax'));
  assert.ok(list[1].re.test('a FRIMP_TABLE b'));
  // A reader function works the same (Story D.2 reads from a git tree).
  const viaReader = dist.loadDenyList((rel) => (rel === DENY_FILE ? 'zorblax\r\n' : null));
  assert.equal(viaReader.length, 1);
  assert.throws(() => dist.loadDenyList(42), /root directory or a reader function/);
});

test('referencePatterns is null without docs/reference/, and throws when the deny file is missing', (t) => {
  const bare = tempDir(t);
  assert.equal(dist.referencePatterns(bare), null);
  const noFile = tempDir(t);
  fs.mkdirSync(path.join(noFile, 'docs/reference'), { recursive: true });
  assert.throws(() => dist.referencePatterns(noFile), /is missing/);
  const withFile = tempDir(t);
  writeDeny(withFile, 'zorblax\n');
  assert.equal(dist.referencePatterns(withFile).length, 1);
});

// --- Scan ---------------------------------------------------------------

const PATTERNS = dist.loadDenyList(() => 'zorblax\n\\bfrimp\\b\n');

test('scanDist reports a content hit as file:line and the pattern number, never the text', () => {
  const { hits, binary } = scanFiles([
    { path: 'README.md', content: 'clean\nthis says Zorblax here\nclean' },
    { path: 'kit/x.js', content: Buffer.from('// a frimp comment\n') },
    { path: 'ok.md', content: 'nothing to see' },
  ]);
  assert.deepEqual(hits, [{ file: 'README.md', line: 2, pattern: 1 }, { file: 'kit/x.js', line: 1, pattern: 2 }]);
  assert.deepEqual(binary, []);
  const lines = hits.map(dist.formatHit);
  assert.deepEqual(lines, ['README.md:2: deny pattern 1', 'kit/x.js:1: deny pattern 2']);
  for (const l of lines) assert.ok(!/zorblax|frimp/i.test(l), 'the matched text is never printed');
});

test('scanDist checks every path, including a binary blob\'s', () => {
  const { hits, binary } = scanFiles([
    { path: 'docs/zorblax-notes.md', content: 'clean' },
    { path: 'assets/frimp.png', content: Buffer.from([0x89, 0x50, 0x00, 0x7a]) },
  ]);
  assert.deepEqual(hits, [{ file: 'docs/zorblax-notes.md', line: 0, pattern: 1 }, { file: 'assets/frimp.png', line: 0, pattern: 2 }]);
  assert.deepEqual(binary, ['assets/frimp.png'], 'a blob with a NUL byte is listed as binary, not skipped silently');
  assert.equal(dist.formatHit(hits[0]), 'docs/zorblax-notes.md (path): deny pattern 1');
});

test('scanDist refuses to run without a loaded deny list', () => {
  assert.throws(() => dist.scanDist([{ path: 'a', content: 'b' }], []), /needs a loaded deny list/);
  assert.throws(() => dist.scanDist([{ path: 'a', content: 'b' }]), /needs a loaded deny list/);
});

function scanFiles(files) {
  return dist.scanDist(files, PATTERNS);
}

// --- The tripwire -------------------------------------------------------

// The tracked tree minus EXCLUDED, each blob as it would ship.
function shippedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter(Boolean).filter((rel) => !dist.isExcluded(rel)).flatMap((rel) => {
    const file = path.join(root, rel);
    let st;
    try { st = fs.lstatSync(file); } catch { return []; } // deleted in the worktree
    if (st.isDirectory()) return []; // a gitlink
    const content = st.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
    return [{ path: rel, content: dist.shippedContent(rel, content) }];
  });
}

const HAS_REFERENCE = fs.existsSync(path.join(REPO, dist.REFERENCE_DIR));

test('tripwire: the shipped tree has no reference-client names', {
  skip: HAS_REFERENCE ? false : 'distribution copy: no docs/reference/',
}, () => {
  const patterns = dist.loadDenyList(REPO); // throws if the deny file is missing
  const files = shippedFiles(REPO);
  assert.ok(files.length > 100, 'the tracked tree was listed');
  const { hits } = dist.scanDist(files, patterns);
  assert.deepEqual(hits.map(dist.formatHit), [], `reference-client names would ship (see ${DENY_FILE}):\n${hits.map(dist.formatHit).join('\n')}`);
});
