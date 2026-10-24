'use strict';

// A throwaway fork for the module-template tests and the clean-bones boot
// smoke test (Story 6.5). The engine (kit/) and node_modules are symlinks to
// this repo, so the fork runs the real engine and any write to it would show in
// engineDigest(). The fork owns package.json (a copy, for the #sdk import), its
// profile (.aplabs/profile.yml, from test/fixtures/fork/) and its app dir: one
// hub, plus the module template copied in the way a builder would.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

// Makes the fork. Returns { root, appDir, cleanup }.
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
// its manifest (a field set to undefined is removed). Returns the module dir.
function addModule(appDir, { folder = FILLED.id, fields = FILLED } = {}) {
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

module.exports = { makeFork, addModule, engineDigest, FILLED, REPO, TEMPLATE };
