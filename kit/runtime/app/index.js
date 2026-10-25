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
// Story 6.2: boot also scans the app dir for hubs and modules (AD-3) and
// refuses on any invalid one, naming the file and field; then registers each
// hub's slash command and the dispatcher. One store (AD-7) holds all
// short-lived state, starting with event de-duplication (AD-6).
//
// App dir: APLABS_APP_DIR (absolute), else <repo>/app (AD-2). Environment:
// APLABS_ENV (default "dev"); module entries show only where they say.
//
// Story 7.5: boot opens the data file (kit/runtime/data: APLABS_DATA_PATH,
// else the built fixture) read-only and locked. A missing or unreadable file
// is logged and the app starts anyway; a module that needs the data tells the
// person it is unavailable.
//
// Plan motherduck-read: with data.source: motherduck in the profile, boot
// reads the read key (MOTHERDUCK_READ_TOKEN, else the Keychain item
// aplabs-motherduck-read-token) and registers it with the logger first; a
// missing one refuses to start, naming the setting. If the publish key
// (MOTHERDUCK_TOKEN, else aplabs-motherduck-token) is present it is
// registered too and compared: equal keys refuse to start. It is never kept.
// Absent, the check is logged as skipped. Connecting to MotherDuck never
// blocks Slack: the app starts and the data stays unavailable until a connect
// succeeds. A local profile never reads either MotherDuck key.
//
// Story 9.1: boot reads the AI key once (ANTHROPIC_API_KEY, else the Keychain
// item aplabs-anthropic-key) and registers it with the logger. A missing key,
// or APLABS_LLM_OFF, leaves the AI off and the app starts anyway; the startup
// line says which. A profile naming an unpriced model refuses to start. The AI
// service (kit/runtime/llm) is built once here and is engine-internal: it is
// handed to the hubs only for the scoped-pull reader (Story 9.4).
//
// Story 11.1: boot reads <app dir>/jobs.json (kit/runtime/jobs) and refuses
// on any broken entry, even with jobs off, naming the job and field. Jobs run
// only with the profile's jobs.enabled, the entry's enabled, and no
// APLABS_JOBS_OFF; with jobs off no job file is loaded. The startup line says
// "jobs: on (n scheduled)", "off (profile)" or "off (APLABS_JOBS_OFF)". The
// scheduler starts after Slack connects and stops first on SIGTERM or SIGINT.
//
// Story 11.2: with APLABS_HEALTH_PORT set, boot starts the health listener
// (./health, AD-13) before the data and Slack, so its 90-second grace covers
// the connect. A malformed port or one in use refuses to start, naming the
// variable. The Socket Mode client's connection events feed it: it fails
// closed (never connected, or down over 60 seconds, after the grace: 503).
// The startup line says "health: on (port n)" or "off"; shutdown closes it.
//
// Profile: APLABS_PROFILE (absolute path) in template dev and the container,
// else .aplabs/profile.yml found walking up from the working directory (a fork).
//
// main() takes env, cwd and deps so tests inject a fake Slack App class and
// capture output; no test touches the network or the real Keychain.

const path = require('node:path');
const { readSecret } = require('../../lib/secrets');
const { loadProfile, findProfilePath, ProfileError, PROFILE_REL } = require('../../lib/profile');
const { createLog, slackLogger } = require('../log');
const { registerGreeting } = require('../slack/greeting');
const { registerHubs } = require('../slack/hubs');
const { loadRegistry, ENV_PATTERN } = require('../registry');
const { createStore } = require('../store');
const { createData, dataPathFor, sourceOf } = require('../data');
const md = require('../data/motherduck');
const llm = require('../llm');
const jobs = require('../jobs');
const health = require('./health');

const REPO = path.resolve(__dirname, '../../..');
// The startup line's word for why the AI is off.
const AI_OFF_WORDS = Object.freeze({ off: `switched off by ${llm.OFF_ENV}`, no_key: `${llm.KEY_ENV} not set`, config: 'configuration fault' });
const DEFAULT_ENV = 'dev';

// Secret env var names live here, never in the profile (AD-12).
const SECRETS = Object.freeze([
  { env: 'SLACK_BOT_TOKEN', keychain: 'aplabs-slack-bot-token', prefix: 'xoxb-', what: 'the bot token' },
  { env: 'SLACK_APP_TOKEN', keychain: 'aplabs-slack-app-token', prefix: 'xapp-', what: 'the app-level token' },
]);

// The MotherDuck keys, for a motherduck profile. register(value) is called
// on each key as soon as it is read (the logger's registerSecret). Returns
// { token, notes } and pushes onto problems; the publish key is only compared,
// never returned.
function checkMotherDuckKeys({ env, deps, problems, register }) {
  const notes = [];
  const read = (name, item) => readSecret(name, item, { env, platform: deps.platform, readKeychain: deps.readKeychain });
  const token = read(md.READ_TOKEN_ENV, md.READ_TOKEN_KEYCHAIN);
  register(token);
  if (!token) {
    problems.push(`${md.READ_TOKEN_ENV} is not set (the MotherDuck read key, needed by data.source: motherduck; set it in env or the macOS Keychain item "${md.READ_TOKEN_KEYCHAIN}")`);
    return { token: null, notes };
  }
  let publish = read(md.PUBLISH_TOKEN_ENV, md.PUBLISH_TOKEN_KEYCHAIN);
  if (publish) {
    register(publish);
    if (publish === token) problems.push(`${md.READ_TOKEN_ENV} is the publish key (${md.PUBLISH_TOKEN_ENV}); the bot needs its own read-only key`);
  } else {
    notes.push(`${md.PUBLISH_TOKEN_ENV} is not set, so the check that ${md.READ_TOKEN_ENV} is not the publish key was skipped`);
  }
  publish = null;
  return { token, notes };
}

// The clock as a Date. deps.now (ms, like the store's) is injected by tests.
const clockOf = (deps) => () => new Date(deps.now ? deps.now() : Date.now());

// Collects every boot problem. Returns { problems, notes, tokens, profile,
// profilePath, registry, jobs, jobsState, dataFile, env, healthPort }. register(value) is
// called on each MotherDuck key as soon as it is read.
// Problems name variables and profile errors, never a secret's value.
function checkConfig({ env, cwd, deps = {}, register = () => {} }) {
  const problems = [];
  const notes = [];
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

  const runEnv = env.APLABS_ENV || DEFAULT_ENV;
  if (!ENV_PATTERN.test(runEnv)) problems.push('APLABS_ENV must be a lower-case name such as dev or prod');
  const hp = health.portFrom(env);
  if (hp.problem) problems.push(hp.problem);

  // The app dir is checked only with a valid profile: modules are checked
  // against its resources. Paths are not echoed (they may come from env).
  let registry = null;
  let jobList = [];
  let jobsState = jobs.jobsSwitch({ profile, env });
  const appDir = env.APLABS_APP_DIR || path.join(REPO, 'app');
  if (!path.isAbsolute(appDir)) {
    problems.push('APLABS_APP_DIR must be an absolute path');
  } else if (profile) {
    const loaded = loadRegistry({ appDir, profile });
    problems.push(...loaded.problems.map((p) => `app: ${p}`));
    registry = loaded.registry;
    const j = jobs.loadJobs({ appDir, profile, env, now: clockOf(deps)() });
    problems.push(...j.problems.map((p) => `app: ${p}`));
    jobList = j.jobs;
    jobsState = j.state;
  }
  if (profile) problems.push(...llm.modelProblems(profile));
  // Read once, here; a missing key is not a problem (the AI stays off).
  const aiKey = llm.readKey({ env, deps, register });
  if (aiKey) tokens[llm.KEY_ENV] = aiKey;

  let dataFile = null;
  if (profile && sourceOf(profile) === 'motherduck') {
    const keys = checkMotherDuckKeys({ env, deps, problems, register });
    if (keys.token) tokens[md.READ_TOKEN_ENV] = keys.token;
    notes.push(...keys.notes);
  } else if (profile) {
    const d = dataPathFor(profile, env);
    if (d.problem) problems.push(d.problem);
    dataFile = d.path || null;
  }
  return { problems, notes, tokens, profile, profilePath, registry, jobs: jobList, jobsState, dataFile, env: runEnv, healthPort: hp.port || null };
}

// Builds the Bolt app in Socket Mode with the redacting logger. App is
// injectable so tests use a fake Slack client.
function createApp({ tokens, profile, registry, env, store, data, log, App, llm = null }) {
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
  registerGreeting(app, { profile, log, store });
  registerHubs(app, { registry, profile, env, log, store, data, llm });
  return app;
}

// The startup line's word for the data: a MotherDuck connect still running
// (no problem recorded yet) is 'connecting'.
function dataState(data, remote) {
  const d = data.describe();
  if (d.available) return 'available';
  return remote && !d.problem ? 'connecting' : 'unavailable';
}

// Returns { code, app }. code 0 = connected, 1 = refused or failed to start.
async function main({ env = process.env, cwd = process.cwd(), deps = {} } = {}) {
  const log = deps.log || createLog({ write: deps.write });
  const cfg = checkConfig({ env, cwd, deps, register: (v) => log.registerSecret(v) });
  for (const value of Object.values(cfg.tokens)) log.registerSecret(value);
  for (const note of cfg.notes) log.info(note);
  if (cfg.problems.length) {
    log.error('refusing to start', { problems: cfg.problems });
    return { code: 1 };
  }

  // The health listener, first: its grace covers the data and the connect.
  let healthCheck = null;
  let healthState = null;
  if (cfg.healthPort) {
    healthState = health.createHealthState({ now: deps.now || Date.now });
    try {
      healthCheck = await health.startHealthServer({ port: cfg.healthPort, state: healthState, ...(deps.healthHost ? { host: deps.healthHost } : {}) });
    } catch (err) {
      log.error('refusing to start', { problems: [err.message] });
      return { code: 1 };
    }
  }

  // createApp inside the try: a throw while building the app (it may carry a
  // token) still goes through the redacting logger.
  // The data never blocks boot: a failed open is logged, and retried on use.
  // A local file is opened before Slack starts; MotherDuck connects alongside
  // it (up to its 10s limit) and is reported when the attempt settles.
  const remote = sourceOf(cfg.profile) === 'motherduck';
  const data = deps.data || createData({
    file: cfg.dataFile,
    profile: cfg.profile,
    ...(remote ? { token: cfg.tokens[md.READ_TOKEN_ENV], ...(deps.connect ? { connect: deps.connect } : {}), ...deps.dataLimits } : {}),
  });
  const unavailable = (err) => {
    if (err.code !== 'DATA_UNAVAILABLE') throw err;
    const { source, label } = data.describe();
    log.warn('data unavailable; starting anyway', { source, label, reason: err.reason });
  };
  let connecting = null;
  if (remote) {
    connecting = data.open().then(() => {
      const { source, label } = data.describe();
      log.info('data available', { source, label });
    }, unavailable).catch((err) => log.error('data open failed', { err }));
  } else {
    try {
      await data.open();
    } catch (err) {
      unavailable(err);
    }
  }

  const store = deps.store || createStore({ now: deps.now });
  const ai = llm.createLlm({
    apiKey: cfg.tokens[llm.KEY_ENV] || null,
    profile: cfg.profile,
    profilePath: cfg.profilePath,
    store,
    log,
    env,
    ...(deps.now ? { now: deps.now } : {}),
    deps: deps.llm || {},
  });
  const aiStatus = ai.status();
  if (aiStatus.reason === 'config') log.error('AI helper off: configuration fault', { problem: aiStatus.problem });

  let app;
  try {
    app = createApp({ ...cfg, store, data, log, App: deps.App, llm: ai });
    // Before start(): Bolt's start() resolves on the first connected event.
    if (healthState && !health.watchConnection(app, healthState)) {
      log.warn('health: no Socket Mode client to watch, so /healthz reports down after the grace period');
    }
    await app.start();
  } catch (err) {
    log.error('could not connect to Slack', { err });
    if (healthCheck) await healthCheck.close();
    return { code: 1, app };
  }
  const client = cfg.profile.client.name;
  log.info(`${client} bot started (single instance: run exactly one process)`, {
    client,
    profile: cfg.profilePath,
    env: cfg.env,
    hubs: cfg.registry.hubs.map((h) => h.command),
    modules: cfg.registry.modules.length,
    data: dataState(data, remote),
    ai: aiStatus.on ? 'on' : `off (${AI_OFF_WORDS[aiStatus.reason]})`,
    jobs: jobs.jobsWords(cfg.jobsState, cfg.jobs),
    health: healthCheck ? `on (port ${healthCheck.port})` : 'off',
    instance: 'single instance',
  });
  // Read-only jobs (Q3): the logger, the query runner and the clock; nothing else.
  const scheduler = jobs.createScheduler({
    jobs: cfg.jobsState.on ? cfg.jobs : [], log, data, now: clockOf(deps), ...(deps.timers ? { timers: deps.timers } : {}),
  });
  scheduler.start();
  return { code: 0, app, log, data, connecting, llm: ai, jobs: scheduler, health: healthCheck };
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

// SIGTERM or SIGINT: the scheduler stops scheduling first (a run in progress
// is not awaited), then Slack stops, the health listener and the data close
// and the process exits.
function shutdown({ app, data, jobs: scheduler, health: healthCheck, log, exit = (code) => process.exit(code) }, signal) {
  log.info('stopping', { signal });
  if (scheduler) scheduler.stop();
  return Promise.resolve()
    .then(() => app.stop())
    .catch((err) => log.error('could not stop Slack cleanly', { err }))
    .then(() => (healthCheck ? healthCheck.close() : null))
    .catch((err) => log.error('could not close the health listener', { err }))
    .finally(() => {
      data.close();
      exit(0);
    });
}

module.exports = { main, checkConfig, checkMotherDuckKeys, createApp, installCrashHandlers, shutdown, SECRETS };

if (require.main === module) {
  const log = createLog();
  const bootFailed = installCrashHandlers(log);
  main({ deps: { log } }).then(({ code, app, data, jobs: scheduler, health: healthCheck }) => {
    if (code !== 0) {
      process.exitCode = code;
      // Bolt may hold the process open after a failed start.
      setImmediate(() => process.exit(code));
      return;
    }
    const stop = (signal) => shutdown({ app, data, jobs: scheduler, health: healthCheck, log }, signal);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(bootFailed);
}
