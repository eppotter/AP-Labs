'use strict';

// scripts/check-conflict-markers.js: the pure parser, and the script end to
// end against a throwaway git repo. Markers are built with repeat() so this
// file never holds one itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { findMarkers } = require('../../scripts/check-conflict-markers');

const cli = path.join(__dirname, '../../scripts/check-conflict-markers.js');
const OPEN = `${'<'.repeat(7)} HEAD`;
const MID = '='.repeat(7);
const CLOSE = `${'>'.repeat(7)} origin/main`;
const tmps = [];
test.after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// A git repo with `files` tracked (and `untracked` left out of the index).
function repo(files, untracked = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-markers-')));
  tmps.push(dir);
  const write = (map) => {
    for (const [name, body] of Object.entries(map)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), body);
    }
  };
  write(files);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  write(untracked);
  return dir;
}

const run = (cwd) => spawnSync(process.execPath, [cli], { cwd, encoding: 'utf8' });

const conflicted = `{\n${OPEN}\n  "a": 1\n${MID}\n  "b": 2\n${CLOSE}\n}\n`;

test('findMarkers: flags open, middle and close lines of a conflict block', () => {
  const out = ['package.json\x002\x00' + OPEN, 'package.json\x004\x00' + MID, 'package.json\x006\x00' + CLOSE, ''].join('\n');
  assert.deepEqual(findMarkers(out).map((f) => f.line), [2, 4, 6]);
});

test('findMarkers: a bare ======= outside a block is a setext heading, not a marker', () => {
  const out = ['README.md\x002\x00' + MID, `README.md\x009\x00${MID}\r`].join('\n');
  assert.deepEqual(findMarkers(out), []);
});

test('findMarkers: a line merely starting with ======= but longer is not a marker', () => {
  const out = ['a.md\x001\x00' + OPEN, `a.md\x002\x00${MID}=`, 'a.md\x003\x00' + CLOSE].join('\n');
  assert.deepEqual(findMarkers(out).map((f) => f.line), [1, 3]);
});

test('script: fails on a planted conflict marker and names the file and line', () => {
  const r = run(repo({ 'package.json': conflicted, 'ok.js': 'module.exports = 1;\n' }));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /package\.json:2: conflict marker/);
  assert.match(r.stderr, /package\.json:4: conflict marker/);
  assert.match(r.stderr, /package\.json:6: conflict marker/);
});

test('script: passes on clean files, including markdown setext headings', () => {
  const r = run(repo({ 'README.md': `Title\n${MID}\n\nBody.\n`, 'ok.js': 'module.exports = 1;\n' }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no conflict markers/);
});

test('script: ignores vendored skills and untracked files', () => {
  const dir = repo({ '.agents/skills/x/SKILL.md': conflicted, 'ok.js': '1;\n' }, { 'node_modules/pkg/index.js': conflicted, 'scratch.txt': conflicted });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
});

test('script: outside a git repo is an error, never a pass', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-markers-nogit-')));
  tmps.push(dir);
  const r = spawnSync(process.execPath, [cli], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});
