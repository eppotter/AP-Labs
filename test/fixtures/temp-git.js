'use strict';

// Throwaway git repos for the template release and check tests (Story 11.5)
// and the template update tests (Story 11.6, makeUpdateRepos below).
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
    // No background `gc --auto`: a copy of the repo leaves enough loose
    // objects to start one, and it races makeUpdateRepos' own `git gc`
    // ("could not find pack .tmp-…", seen in clean-bones on #173).
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'gc.auto',
    GIT_CONFIG_VALUE_0: '0',
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
    // Timestamps kept, so with core.checkStat=minimal (set on the update
    // repos) git need not re-read every file of a copied worktree.
    fs.cpSync(dir, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    fs.rmSync(path.join(to, 'gh-calls.txt'), { force: true });
    fs.rmSync(path.join(to, 'pr-body.md'), { force: true });
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

// ---- template updates (Story 11.6) --------------------------------------

// The stand-in example client the fork deletes on purpose. It is test data
// only: the update derives what a fork deleted, and the engine names no
// example client.
const DEMO = Object.freeze({
  'examples/demo/README.md': 'The demo client.\n',
  'examples/demo/app/hubs/demo.json': '{ "id": "demo" }\n',
  'profiles/demo/profile.yml': 'schema_version: 1\n',
});

const FORK_LEDGER_LINE = '<!-- This fork\'s own ledger. -->';

// A CHANGELOG.md entry for version.
const changelogEntry = (version, mustDo = ['- Nothing.']) => [
  `## ${version}`, '', '### What changed', '', `- The ${version} release.`, '', '### What a fork must do', '', ...mustDo, '', '',
].join('\n');

/**
 * The repos a template update needs, all in one temp dir:
 *   origin.git      the template's remote: the fork's `upstream`
 *   template/       the template: a real copy of this repo's files (as
 *                   test/fixtures/temp-fork.js's copy mode makes them), plus
 *                   the demo client above, tagged v1.0.0 and pushed
 *   fork/           cloned from origin.git at v1.0.0, `origin` renamed to
 *                   `upstream`; the demo client deleted, the Stub Co client
 *                   (test/fixtures/fork/) added, its own line on top of the
 *                   ledger, and v1.0.0 recorded (npm run template:check --
 *                   --record); pushed to fork-origin.git, its `origin`
 * Returns the handle (see handle()) with fork, forkOrigin and
 * release(version, edit, { mustDo }), which runs edit(templateRoot), adds a
 * changelog entry, commits, tags and pushes to origin.git. handle.copy()
 * gives each test its own.
 */
function makeUpdateRepos() {
  const { copyRepoFiles, addClient } = require('./temp-fork');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-temp-git-')));
  fs.mkdirSync(path.join(dir, 'home'));
  const h = handle(dir);
  try {
    h.git(dir, ['init', '-q', '--bare', '-b', 'main', h.bare]);
    fs.mkdirSync(h.work);
    copyRepoFiles(h.work);
    h.git(h.work, ['init', '-q', '-b', 'main']);
    h.git(h.work, ['remote', 'add', 'origin', '../origin.git']);
    for (const [rel, text] of Object.entries(DEMO)) h.write(h.work, rel, text);
    h.write(h.work, 'CHANGELOG.md', `# Changelog\n\n## Unreleased\n\n${changelogEntry('v1.0.0')}`);
    h.commit(h.work, 'template v1.0.0');
    h.git(h.work, ['tag', '-a', 'v1.0.0', '-m', 'v1.0.0']);
    h.git(h.work, ['push', '-q', 'origin', 'main', 'refs/tags/v1.0.0']);
    h.git(h.work, ['gc', '-q']);

    const fork = path.join(dir, 'fork');
    h.git(dir, ['clone', '-q', h.bare, fork]);
    h.git(fork, ['remote', 'rename', 'origin', 'upstream']);
    h.git(fork, ['remote', 'set-url', 'upstream', '../origin.git']);
    h.git(dir, ['init', '-q', '--bare', '-b', 'main', path.join(dir, 'fork-origin.git')]);
    h.git(fork, ['remote', 'add', 'origin', '../fork-origin.git']);
    fs.rmSync(path.join(fork, 'examples/demo'), { recursive: true });
    fs.rmSync(path.join(fork, 'profiles/demo'), { recursive: true });
    addClient(fork, 'fork');
    const ledger = path.join(fork, 'docs/ledger.md');
    fs.writeFileSync(ledger, `${FORK_LEDGER_LINE}\n${fs.readFileSync(ledger, 'utf8')}`);
    h.commit(fork, 'fork: day one');
    const rec = h.run('kit/release/check.js', ['--record', 'v1.0.0'], fork);
    if (rec.code !== 0) throw new Error(`could not record v1.0.0: ${rec.stderr}`);
    h.commit(fork, 'fork: record the template version');
    h.git(fork, ['push', '-q', '-u', 'origin', 'main']);
    // A copy has new inodes and ctimes: judge a file by its size and mtime
    // only, so each test's copy doesn't make git re-read every file.
    for (const repo of [h.work, fork]) {
      h.git(repo, ['config', 'core.checkStat', 'minimal']);
      h.git(repo, ['config', 'core.trustctime', 'false']);
      h.git(repo, ['update-index', '-q', '--refresh']);
    }
  } catch (err) {
    h.cleanup();
    throw err;
  }
  return withUpdate(h);
}

// Adds the update helpers to a handle (and to each of its copies).
function withUpdate(h) {
  const copy = h.copy;
  return Object.assign(h, {
    fork: path.join(h.dir, 'fork'),
    forkOrigin: path.join(h.dir, 'fork-origin.git'),
    release(version, edit, { mustDo } = {}) {
      if (edit) edit(h.work);
      const file = path.join(h.work, 'CHANGELOG.md');
      const text = fs.readFileSync(file, 'utf8').replace('## Unreleased\n\n', `## Unreleased\n\n${changelogEntry(version, mustDo)}`);
      fs.writeFileSync(file, text);
      h.commit(h.work, `template ${version}`);
      h.git(h.work, ['tag', '-a', version, '-m', version]);
      h.git(h.work, ['push', '-q', 'origin', 'main', `refs/tags/${version}`]);
      return h.git(h.work, ['rev-parse', 'HEAD']);
    },
    // Commits everything in the fork on its current branch and pushes it.
    forkCommit(message) {
      h.commit(h.fork, message);
      h.git(h.fork, ['push', '-q', 'origin', 'HEAD']);
    },
    copy: () => withUpdate(copy()),
  });
}

module.exports = { makeTemplate, makeUpdateRepos, PASSING_RUNS, CHANGELOG, REPO, DEMO, FORK_LEDGER_LINE };
