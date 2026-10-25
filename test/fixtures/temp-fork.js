'use strict';

// Throwaway forks, in two modes.
//
// Linked (makeFork, Story 6.5), for the module-template tests and the
// clean-bones boot smoke test: the engine (kit/) and node_modules are symlinks
// to this repo, so the fork runs the real engine and any write to it would show
// in engineDigest(). The fork owns package.json (a copy, for the #sdk import),
// its profile (.aplabs/profile.yml, from test/fixtures/fork/) and its app dir:
// one hub, plus the module template copied in the way a builder would.
//
// Copied (makeCopyFork, Story 11.3), for the two-forks acceptance test: a real
// copy of the repo's files (tracked, plus untracked files that aren't ignored,
// as scripts/clean-bones.sh copies them), without the example client
// (examples/brightside/, profiles/brightside/) or any .aplabs/, made a git
// repo. Then the client is added: .aplabs/profile.yml and .aplabs/context/
// from its fixture, and app/ with its hub and its module, filled from the
// module template. No module code is kept under test/fixtures/, where
// node --test would run its handler.test.js. Only node_modules is a link.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listEngineFiles } = require('../../kit/runtime/paths');

const REPO = path.resolve(__dirname, '../..');
const FIXTURE = path.join(__dirname, 'fork');
const TEMPLATE = path.join(REPO, 'kit/templates/module');

// What a builder fills in. Matches the stub profile and hub.
const FILLED = Object.freeze({
  id: 'weekly-report',
  hub: 'ops',
  label: 'Weekly report',
  resource: 'WEEKLY_REPORT',
  archetype: 'handler',
});

// The copied-mode clients: each fixture folder and the module filled into it.
// Neither is the template's example client.
const CLIENTS = Object.freeze({
  fork: Object.freeze({ dir: FIXTURE, module: FILLED }),
  'fork-b': Object.freeze({
    dir: path.join(__dirname, 'fork-b'),
    module: Object.freeze({ id: 'rota-planner', hub: 'desk', label: 'Rota planner', resource: 'ROTA_PLANNER', archetype: 'handler' }),
  }),
});

// Left out of a copied fork: the example client, a checkout's own profile and
// context if it has one, and node_modules (linked instead; in a clean-bones
// copy it is a symlink, which the node_modules/ ignore rule does not match).
const NOT_COPIED = Object.freeze(['examples/brightside', 'profiles/brightside', '.aplabs', 'node_modules']);

// Git with no user or system config, so the shell running the tests can't leak in.
const gitEnv = () => ({ PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const runGit = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], ...opts });

// The repo's files, listed as scripts/clean-bones.sh lists them, minus
// NOT_COPIED; a tracked file deleted in the worktree is skipped.
function repoFiles() {
  return runGit(REPO, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((rel) => rel && !NOT_COPIED.some((d) => rel === d || rel.startsWith(`${d}/`)))
    .filter((rel) => fs.existsSync(path.join(REPO, rel)));
}

// Makes a copied fork for one client (a CLIENTS key).
// Returns { root, appDir, client, cleanup }.
function makeCopyFork(name = 'fork') {
  const client = CLIENTS[name];
  if (!client) throw new Error(`no fixture client "${name}"`);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aplabs-${name}-`)));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    for (const rel of new Set(repoFiles())) {
      const dest = path.join(root, rel);
      const src = path.join(REPO, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // A tracked symlink (.claude/skills) stays a symlink, as tar keeps it.
      if (fs.lstatSync(src).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dest);
      else fs.copyFileSync(src, dest);
    }
    for (const d of NOT_COPIED) fs.rmSync(path.join(root, d), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.aplabs'));
    fs.copyFileSync(path.join(client.dir, 'profile.yml'), path.join(root, '.aplabs/profile.yml'));
    fs.cpSync(path.join(client.dir, 'context'), path.join(root, '.aplabs/context'), { recursive: true });
    const appDir = path.join(root, 'app');
    fs.cpSync(path.join(client.dir, 'hubs'), path.join(appDir, 'hubs'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'modules'));
    addModule(appDir, { fields: client.module });
    runGit(root, ['init', '-q', '-b', 'main']);
    runGit(root, ['add', '-A']);
    runGit(root, ['-c', 'user.name=two-forks', '-c', 'user.email=two-forks@example.invalid', 'commit', '-q', '--no-verify', '-m', `fork ${name}`]);
    // After the commit, so the link is never tracked.
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    return { root, appDir, client, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// Makes the linked fork. Returns { root, appDir, cleanup }.
function makeFork() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-fork-')));
  fs.symlinkSync(path.join(REPO, 'kit'), path.join(root, 'kit'), 'dir');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  fs.mkdirSync(path.join(root, '.aplabs'));
  fs.copyFileSync(path.join(FIXTURE, 'profile.yml'), path.join(root, '.aplabs/profile.yml'));
  const appDir = path.join(root, 'app');
  fs.cpSync(path.join(FIXTURE, 'hubs'), path.join(appDir, 'hubs'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'modules'));
  return { root, appDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Copies the template into <appDir>/modules/<folder>, then applies fields to
// its manifest (a field set to undefined is removed). folder defaults to the
// fields' id. Returns the module dir.
function addModule(appDir, { fields = FILLED, folder = fields.id || FILLED.id } = {}) {
  const dir = path.join(appDir, 'modules', folder);
  fs.cpSync(TEMPLATE, dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  const manifest = { ...JSON.parse(fs.readFileSync(file, 'utf8')), ...fields };
  for (const [k, v] of Object.entries(fields)) if (v === undefined) delete manifest[k];
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

// sha256 of every identical-engine file under root, keyed by repo path.
function engineDigest(root = REPO) {
  const out = {};
  for (const rel of listEngineFiles(root)) {
    out[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  }
  return out;
}

module.exports = { makeFork, makeCopyFork, addModule, engineDigest, CLIENTS, FILLED, REPO, TEMPLATE };
