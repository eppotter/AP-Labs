'use strict';

// The runtime's entry point (Story 6.1): `npm start`, or `node kit/runtime/app`.
//
// Boot order: read the Slack tokens through kit/lib/secrets and register them
// with the logger, load the profile (AD-2), and refuse to start listing every
// problem at once (a missing variable by name, never a value; each profile
// error). Then connect to Slack in Socket Mode (AD-5: a bot token and an
// app-level token, no signing secret) and log one startup line naming the
// client, the profile path and "single instance" (AD-8).
//
// Profile: APLABS_PROFILE (absolute path) in template dev and the container,
// else .aplabs/profile.yml found walking up from the working directory (a fork).
//
// main() takes env, cwd and deps so tests inject a fake Slack App class and
// capture output; no test touches the network or the real Keychain.

const { readSecret } = require('../../lib/secrets');
const { loadProfile, findProfilePath, ProfileError, PROFILE_REL } = require('../../lib/profile');
const { createLog, slackLogger } = require('../log');
const { registerGreeting } = require('../slack/greeting');

// Secret env var names live here, never in the profile (AD-12).
const SECRETS = Object.freeze([
  { env: 'SLACK_BOT_TOKEN', keychain: 'aplabs-slack-bot-token', prefix: 'xoxb-', what: 'the bot token' },
  { env: 'SLACK_APP_TOKEN', keychain: 'aplabs-slack-app-token', prefix: 'xapp-', what: 'the app-level token' },
]);

// Collects every boot problem. Returns { problems, tokens, profile, profilePath }.
// Problems name variables and profile errors, never a secret's value.
function checkConfig({ env, cwd, deps = {} }) {
  const problems = [];
  const tokens = {};
  for (const s of SECRETS) {
    const value = readSecret(s.env, s.keychain, { env, platform: deps.platform, readKeychain: deps.readKeychain });
    if (!value) {
      problems.push(`${s.env} is not set (${s.what}; set it in env or the macOS Keychain item "${s.keychain}")`);
    } else if (!value.startsWith(s.prefix)) {
      tokens[s.env] = value;
      problems.push(`${s.env} does not look like ${s.what} (expected it to start with ${s.prefix})`);
    } else {
      tokens[s.env] = value;
    }
  }

  let profilePath = null;
  let profile = null;
  try {
    profilePath = findProfilePath(cwd, env);
    if (!profilePath) problems.push(`APLABS_PROFILE is not set and no ${PROFILE_REL} was found`);
  } catch (e) {
    if (!(e instanceof ProfileError)) throw e;
    problems.push(e.message);
  }
  if (profilePath) {
    try {
      profile = loadProfile(profilePath);
    } catch (e) {
      problems.push(e.message);
    }
  }
  return { problems, tokens, profile, profilePath };
}

// Builds the Bolt app in Socket Mode with the redacting logger. App is
// injectable so tests use a fake Slack client.
function createApp({ tokens, profile, log, App }) {
  const AppClass = App || require('@slack/bolt').App;
  const app = new AppClass({
    token: tokens.SLACK_BOT_TOKEN,
    appToken: tokens.SLACK_APP_TOKEN,
    socketMode: true,
    logger: slackLogger(log),
    logLevel: 'info',
  });
  app.error(async (err) => {
    log.error('slack app error', { err });
  });
  registerGreeting(app, { profile, log });
  return app;
}

// Returns { code, app }. code 0 = connected, 1 = refused or failed to start.
async function main({ env = process.env, cwd = process.cwd(), deps = {} } = {}) {
  const log = deps.log || createLog({ write: deps.write });
  const cfg = checkConfig({ env, cwd, deps });
  for (const value of Object.values(cfg.tokens)) log.registerSecret(value);
  if (cfg.problems.length) {
    log.error('refusing to start', { problems: cfg.problems });
    return { code: 1 };
  }

  // createApp inside the try: a throw while building the app (it may carry a
  // token) still goes through the redacting logger.
  let app;
  try {
    app = createApp({ tokens: cfg.tokens, profile: cfg.profile, log, App: deps.App });
    await app.start();
  } catch (err) {
    log.error('could not connect to Slack', { err });
    return { code: 1, app };
  }
  const client = cfg.profile.client.name;
  log.info(`${client} bot started (single instance: run exactly one process)`, {
    client,
    profile: cfg.profilePath,
    instance: 'single instance',
  });
  return { code: 0, app, log };
}

// Anything that escapes main() is logged through the same redacting logger
// (tokens already registered), then the process exits 1. proc is injectable
// for tests.
function installCrashHandlers(log, proc = process) {
  const crash = (what) => (err) => {
    log.error(what, { err });
    proc.exit(1);
  };
  proc.on('uncaughtException', crash('uncaught exception'));
  proc.on('unhandledRejection', crash('unhandled rejection'));
  return crash('boot failed');
}

module.exports = { main, checkConfig, createApp, installCrashHandlers, SECRETS };

if (require.main === module) {
  const log = createLog();
  const bootFailed = installCrashHandlers(log);
  main({ deps: { log } }).then(({ code, app }) => {
    if (code !== 0) {
      process.exitCode = code;
      // Bolt may hold the process open after a failed start.
      setImmediate(() => process.exit(code));
      return;
    }
    const stop = (signal) => {
      log.info('stopping', { signal });
      Promise.resolve(app.stop()).finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(bootFailed);
}
