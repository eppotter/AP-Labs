'use strict';

// Generates the runtime Slack app manifest (AD-5): `npm run slack:manifest`.
//
// <app>/slack-manifest.json keeps what a person writes once (the app's name,
// description, bot user, app home). The generator overwrites the rest: one
// slash command per hub file, the bot scopes and events from scopes.js, Socket
// Mode and interactivity on. `--check` writes nothing and exits 1 when the
// committed file differs.
//
//   APLABS_APP_DIR=/abs/path/to/app npm run slack:manifest [-- --check]
//
// The app dir is APLABS_APP_DIR (absolute) or <repo>/app.

const fs = require('node:fs');
const path = require('node:path');
const { BOT_SCOPES, BOT_EVENTS } = require('./scopes');
const { loadHubs } = require('../registry');

const MANIFEST = 'slack-manifest.json';
const REPO = path.resolve(__dirname, '../../..');

function slashCommand(hub) {
  const c = { command: hub.command, description: hub.description };
  if (hub.usage_hint) c.usage_hint = hub.usage_hint;
  c.should_escape = false;
  return c;
}

// base: the parsed committed manifest; hubs: from loadHubs. Returns a new object.
function buildManifest({ base, hubs }) {
  const m = structuredClone(base);
  m.features = m.features || {};
  m.features.slash_commands = hubs.map(slashCommand);
  m.oauth_config = { ...(m.oauth_config || {}), scopes: { ...((m.oauth_config && m.oauth_config.scopes) || {}), bot: [...BOT_SCOPES] } };
  m.settings = m.settings || {};
  m.settings.event_subscriptions = { ...(m.settings.event_subscriptions || {}), bot_events: [...BOT_EVENTS] };
  m.settings.interactivity = { ...(m.settings.interactivity || {}), is_enabled: true };
  m.settings.socket_mode_enabled = true;
  return m;
}

function render(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function appDirFrom(env) {
  const dir = env.APLABS_APP_DIR;
  if (!dir) return path.join(REPO, 'app');
  if (!path.isAbsolute(dir)) throw new Error('APLABS_APP_DIR must be an absolute path');
  return dir;
}

// Returns { code, out } so tests can run it in-process.
function run({ argv = [], env = process.env } = {}) {
  const check = argv.includes('--check');
  let appDir;
  try {
    appDir = appDirFrom(env);
  } catch (e) {
    return { code: 1, out: `slack:manifest: ${e.message}` };
  }
  const file = path.join(appDir, MANIFEST);
  if (!fs.existsSync(file)) {
    return { code: 1, out: `slack:manifest: ${MANIFEST} not found in the app dir; write it with display_information and features.bot_user first` };
  }
  let base;
  try {
    base = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { code: 1, out: `slack:manifest: ${MANIFEST} is not valid JSON (${e.message})` };
  }
  const { hubs, problems } = loadHubs(appDir);
  if (problems.length) return { code: 1, out: `slack:manifest: fix the hub files first:\n  ${problems.join('\n  ')}` };
  const next = render(buildManifest({ base, hubs }));
  const current = fs.readFileSync(file, 'utf8');
  if (check) {
    return current === next
      ? { code: 0, out: `slack:manifest: ${MANIFEST} is up to date (${hubs.length} hub command(s))` }
      : { code: 1, out: `slack:manifest: ${MANIFEST} is out of date; run npm run slack:manifest` };
  }
  if (current !== next) fs.writeFileSync(file, next);
  return { code: 0, out: `slack:manifest: wrote ${MANIFEST} (${hubs.length} hub command(s))` };
}

module.exports = { buildManifest, render, run, MANIFEST };

if (require.main === module) {
  const { code, out } = run({ argv: process.argv.slice(2) });
  (code ? process.stderr : process.stdout).write(`${out}\n`);
  process.exitCode = code;
}
