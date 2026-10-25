'use strict';

// Throwaway git repos for the template release and check tests (Story 11.5).
// Nothing here reaches GitHub or the network: "origin" is a bare repo in a
// temp dir, and gh is a fake that prints the check runs a test sets.
//
//   makeTemplate()  a temp dir holding a bare origin.git and a "template"
//       clone on main with a tiny engine (kit/, profiles/_schema/), a
//       CHANGELOG.md and a README, pushed to origin. Returns a handle:
//   handle.cloneFork(name)  clones origin (with its tags) into <dir>/<name>
//       and adds a stub .aplabs/profile.yml, committed. Returns its path.
//   handle.fakeGh(runs, { exit })  sets the check runs the fake gh
//       (test/fixtures/release/fake-gh.sh, APLABS_GH_BIN) prints for `gh api .../check-runs`; every call is logged
//       to <dir>/gh-calls.txt (handle.ghCalls()).
//   handle.run(script, args, cwd)  runs a CLI with the isolated env.
//   handle.copy()  an independent copy of the whole temp dir (repos, fake gh),
//       so a test file builds its starting point once and each test gets its
//       own. Remotes are relative (../origin.git), so a copy points at its own.
//
// Git runs with no user or system config (so the shell's settings, such as
// tag signing, can't leak in) and a fixed identity.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');

const PASSING_RUNS = Object.freeze(['test', 'clean-bones', 'container'].map((name) => Object.freeze({ name, status: 'completed', conclusion: 'success' })));

const CHANGELOG = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '## v0.1.0',
  '',
  '### What changed',
  '',
  '- The first release.',
  '',
  '### What a fork must do',
  '',
  '- Nothing.',
  '',
].join('\n');

// A fixed, checked-in script: a freshly written executable can take a second
// to start on macOS (it is scanned on first run).
const FAKE_GH = path.join(__dirname, 'release/fake-gh.sh');

// A handle on the repos in dir.
function handle(dir) {
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(dir, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'temp-git',
    GIT_AUTHOR_EMAIL: 'temp-git@example.invalid',
    GIT_COMMITTER_NAME: 'temp-git',
    GIT_COMMITTER_EMAIL: 'temp-git@example.invalid',
    APLABS_GH_BIN: FAKE_GH,
    FAKE_GH_DIR: dir,
  };
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (root, rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  const commit = (root, message) => {
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '--no-verify', '-m', message]);
    return git(root, ['rev-parse', 'HEAD']);
  };
  const bare = path.join(dir, 'origin.git');
  const work = path.join(dir, 'template');

  const cloneFork = (name = 'fork') => {
    const root = path.join(dir, name);
    git(dir, ['clone', '-q', bare, root]);
    git(root, ['remote', 'set-url', 'origin', '../origin.git']);
    write(root, '.aplabs/profile.yml', 'schema_version: 1\nclient: { id: stub, name: Stub Co }\n');
    commit(root, 'fork: add the profile');
    return root;
  };

  const fakeGh = (runs = PASSING_RUNS, { exit = 0 } = {}) => {
    fs.writeFileSync(path.join(dir, 'check-runs.json'), JSON.stringify({ total_count: runs.length, check_runs: runs }));
    fs.writeFileSync(path.join(dir, 'gh-exit'), String(exit));
  };

  const run = (script, args, cwd) => {
    const r = spawnSync(process.execPath, [path.join(REPO, script), ...args], { cwd, env, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  const ghCalls = () => {
    try {
      return fs.readFileSync(path.join(dir, 'gh-calls.txt'), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  const copy = () => {
    const to = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-temp-git-')));
    fs.cpSync(dir, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(path.join(to, 'gh-calls.txt'), { force: true });
    return handle(to);
  };

  return {
    dir, bare, work, env, git, commit, write, cloneFork, fakeGh, run, ghCalls, copy,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeTemplate() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-temp-git-')));
  fs.mkdirSync(path.join(dir, 'home'));
  const h = handle(dir);
  h.git(dir, ['init', '-q', '--bare', '-b', 'main', h.bare]);
  h.git(dir, ['init', '-q', '-b', 'main', h.work]);
  h.git(h.work, ['remote', 'add', 'origin', '../origin.git']);
  h.write(h.work, 'kit/runtime/a.js', "'use strict';\nmodule.exports = 1;\n");
  h.write(h.work, 'kit/lib/b.js', "'use strict';\nmodule.exports = 2;\n");
  h.write(h.work, 'profiles/_schema/profile.schema.json', '{ "type": "object" }\n');
  h.write(h.work, 'README.md', 'A template.\n');
  h.write(h.work, 'CHANGELOG.md', CHANGELOG);
  h.commit(h.work, 'template');
  h.git(h.work, ['push', '-q', 'origin', 'main']);
  return h;
}

module.exports = { makeTemplate, PASSING_RUNS, CHANGELOG, REPO };
