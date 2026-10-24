'use strict';

// kit/runtime/slack/manifest: `npm run slack:manifest` builds the app
// manifest's slash commands from the hub files, keeps the hand-written parts,
// sets the AD-5 scopes and events, and --check fails on any difference.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildManifest, run, render } = require('../../kit/runtime/slack/manifest');
const { BOT_SCOPES, BOT_EVENTS } = require('../../kit/runtime/slack/scopes');

const ROOT = path.join(__dirname, '../..');
const APP_DIR = path.join(__dirname, '../fixtures/runtime/app');

function tempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-manifest-'));
  fs.cpSync(APP_DIR, dir, { recursive: true });
  return dir;
}

test('slash commands come from the hub files, in file order; the rest is kept', () => {
  const base = { display_information: { name: 'X' }, features: { bot_user: { display_name: 'X' } }, settings: { org_deploy_enabled: false } };
  const m = buildManifest({ base, hubs: [
    { command: '/a', description: 'A', usage_hint: 'hint' },
    { command: '/b', description: 'B' },
  ] });
  assert.deepEqual(m.features.slash_commands, [
    { command: '/a', description: 'A', usage_hint: 'hint', should_escape: false },
    { command: '/b', description: 'B', should_escape: false },
  ]);
  assert.deepEqual(m.oauth_config.scopes.bot, [...BOT_SCOPES]);
  assert.deepEqual(m.settings.event_subscriptions.bot_events, [...BOT_EVENTS]);
  assert.equal(m.settings.socket_mode_enabled, true);
  assert.equal(m.settings.interactivity.is_enabled, true);
  assert.equal(m.settings.org_deploy_enabled, false);
  assert.equal(m.display_information.name, 'X');
  assert.equal(base.features.slash_commands, undefined, 'the base is not mutated');
});

test('extra scopes or events in the committed file are replaced by the approved set', () => {
  const base = { oauth_config: { scopes: { bot: ['admin'] } }, settings: { event_subscriptions: { bot_events: ['app_mention'] } } };
  const m = buildManifest({ base, hubs: [] });
  assert.deepEqual(m.oauth_config.scopes.bot, [...BOT_SCOPES]);
  assert.deepEqual(m.settings.event_subscriptions.bot_events, [...BOT_EVENTS]);
  assert.deepEqual(m.features.slash_commands, []);
});

test('--check fails when the committed manifest differs; a write fixes it; --check then passes', () => {
  const dir = tempApp();
  try {
    const env = { APLABS_APP_DIR: dir };
    const before = run({ argv: ['--check'], env });
    assert.equal(before.code, 1);
    assert.match(before.out, /out of date; run npm run slack:manifest/);
    const wrote = run({ env });
    assert.equal(wrote.code, 0);
    assert.match(wrote.out, /wrote slack-manifest.json \(2 hub command\(s\)\)/);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'slack-manifest.json'), 'utf8'));
    assert.deepEqual(m.features.slash_commands.map((c) => c.command), ['/alpha', '/beta']);
    assert.equal(m.display_information.name, 'Fixture Bot');
    assert.equal(run({ argv: ['--check'], env }).code, 0);
    // Adding a hub makes the committed file stale again.
    fs.writeFileSync(path.join(dir, 'hubs/gamma.json'), JSON.stringify({ id: 'gamma', command: '/gamma', name: 'G', description: 'g' }));
    assert.equal(run({ argv: ['--check'], env }).code, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid hub file, a missing manifest or a relative app dir fails without writing', () => {
  const dir = tempApp();
  try {
    fs.writeFileSync(path.join(dir, 'hubs/beta.json'), '{"id":"beta"}');
    const before = fs.readFileSync(path.join(dir, 'slack-manifest.json'), 'utf8');
    const bad = run({ env: { APLABS_APP_DIR: dir } });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /hubs\/beta.json: field "command" is required/);
    assert.equal(fs.readFileSync(path.join(dir, 'slack-manifest.json'), 'utf8'), before);
    fs.rmSync(path.join(dir, 'slack-manifest.json'));
    assert.match(run({ env: { APLABS_APP_DIR: dir } }).out, /slack-manifest.json not found/);
    assert.match(run({ env: { APLABS_APP_DIR: 'app' } }).out, /must be an absolute path/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('render is stable two-space JSON with a trailing newline', () => {
  assert.equal(render({ a: [1] }), '{\n  "a": [\n    1\n  ]\n}\n');
});

test('npm run slack:manifest is wired to the generator', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['slack:manifest'], 'node kit/runtime/slack/manifest.js');
  const dir = tempApp();
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'kit/runtime/slack/manifest.js'), '--check'], {
      env: { PATH: process.env.PATH, APLABS_APP_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /out of date/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
