'use strict';

// kit/runtime/app: boot checks, the startup line, the DM greeting, the app
// dir scan and event de-duplication. Uses the
// fake Slack App (no network) and a fixture profile; the Keychain is off
// (APLABS_NO_KEYCHAIN=1) and never read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { main, installCrashHandlers, shutdown } = require('../../kit/runtime/app');
const { createLog } = require('../../kit/runtime/log');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const ROOT = path.join(__dirname, '../..');
const PROFILE = path.join(__dirname, '../fixtures/runtime/profile.yml');
const APP_DIR = path.join(__dirname, '../fixtures/runtime/app');
// Fake values, shaped like the real ones; nothing here is a credential.
const BOT = 'xoxb-000-111-faketokenvalue';
const APP = 'xapp-1-A000-222-fakeappvalue';

function env(extra = {}) {
  return { APLABS_NO_KEYCHAIN: '1', SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP, APLABS_PROFILE: PROFILE, APLABS_APP_DIR: APP_DIR, ...extra };
}

// A data source that is always available, so boot tests don't depend on a
// built fixture. Tests of the real runner live in runtime-data.test.js.
const fakeData = () => ({
  open: async () => {},
  run: async () => [],
  describe: () => ({ source: 'local fixture', label: 'fake.duckdb', available: true, problem: null }),
  close: () => {},
});

async function boot(e, deps = {}) {
  const lines = [];
  const noKeychain = () => assert.fail('the Keychain must not be read');
  const res = await main({
    env: e,
    cwd: os.tmpdir(),
    deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: noKeychain, data: fakeData(), ...deps },
  });
  const entries = lines.map((l) => JSON.parse(l));
  return { ...res, lines, entries, text: lines.join('\n') };
}

test('starts in Socket Mode with both tokens, no signing secret, and the redacting logger', async () => {
  const { code, app } = await boot(env());
  assert.equal(code, 0);
  assert.equal(app.started, true);
  assert.equal(app.options.socketMode, true);
  assert.equal(app.options.token, BOT);
  assert.equal(app.options.appToken, APP);
  assert.equal(app.options.signingSecret, undefined);
  assert.equal(typeof app.options.logger.info, 'function');
});

test('logs one startup line naming the client, the profile path and "single instance"', async () => {
  const { entries, text } = await boot(env());
  assert.equal(entries.length, 1);
  const [line] = entries;
  assert.equal(line.level, 'info');
  assert.equal(line.client, 'Tiny');
  assert.equal(line.profile, PROFILE);
  assert.match(line.msg, /single instance/);
  assert.ok(!text.includes(BOT) && !text.includes(APP));
});

test('a direct message gets a short greeting in the same DM', async () => {
  const { app } = await boot(env());
  await app.dispatchMessage({ channel_type: 'im', channel: 'D123', user: 'U123', text: 'hi' });
  assert.equal(app.said.length, 1);
  assert.equal(app.said[0].channel, 'D123');
  assert.match(app.said[0].text, /Tiny bot/);
  assert.match(app.said[0].text, /<@U123>/);
});

test('the greeting escapes the client name from the profile', () => {
  const { greetingText } = require('../../kit/runtime/slack/greeting');
  assert.equal(greetingText({ client: { name: 'A & <!channel>' } }, 'U1'), "Hi <@U1>, I'm the A &amp; &lt;!channel&gt; bot. I'm up and running.");
});

test('channel messages, edits and bot messages get no greeting', async () => {
  const { app } = await boot(env());
  await app.dispatchMessage({ channel_type: 'channel', channel: 'C1', user: 'U1', text: 'hi' });
  await app.dispatchMessage({ channel_type: 'im', channel: 'D1', user: 'U1', subtype: 'message_changed' });
  await app.dispatchMessage({ channel_type: 'im', channel: 'D1', bot_id: 'B1', text: 'hi' });
  assert.deepEqual(app.said, []);
});

test('a greeting that fails sends the person the plain error message', async () => {
  const { app, lines } = await boot(env());
  // say throws once (the greeting), then succeeds (the error reply).
  let first = true;
  const said = [];
  const say = async (arg) => {
    if (first) { first = false; throw new Error('chat.postMessage failed'); }
    said.push(arg.text);
  };
  const message = { channel_type: 'im', channel: 'D9', user: 'U9', text: 'hi' };
  for (const fn of app.messageListeners) await fn({ message, say, client: app.client });
  assert.equal(said.length, 1);
  assert.match(said[0], /something went wrong/);
  assert.match(lines.at(-1), /handler failed/);
});

test('missing tokens and profile: refuses, lists each variable by name', async () => {
  const { code, app, entries } = await boot({ APLABS_NO_KEYCHAIN: '1' });
  assert.equal(code, 1);
  assert.equal(app, undefined);
  const refusal = entries.find((e) => e.msg === 'refusing to start');
  const problems = refusal.problems.join('\n');
  assert.match(problems, /SLACK_BOT_TOKEN is not set/);
  assert.match(problems, /SLACK_APP_TOKEN is not set/);
  assert.match(problems, /APLABS_PROFILE is not set/);
});

test('a token with the wrong shape is refused by name, and its value never appears', async () => {
  const wrong = 'not-a-real-token-value-5555';
  const { code, text } = await boot(env({ SLACK_APP_TOKEN: wrong }));
  assert.equal(code, 1);
  assert.match(text, /SLACK_APP_TOKEN does not look like the app-level token/);
  assert.ok(!text.includes(wrong));
  assert.ok(!text.includes(BOT));
});

test('a relative APLABS_PROFILE is refused by name, without echoing its value', async () => {
  const { code, text } = await boot(env({ APLABS_PROFILE: 'profiles/x.yml' }));
  assert.equal(code, 1);
  assert.match(text, /APLABS_PROFILE must be an absolute path/);
  assert.ok(!text.includes('profiles/x.yml'));
});

test('a throw while building the app is logged redacted and exits 1', async () => {
  class ThrowingApp {
    constructor(opts) { throw new Error(`bad options: ${opts.token}`); }
  }
  const { code, text } = await boot(env(), { App: ThrowingApp });
  assert.equal(code, 1);
  assert.match(text, /bad options/);
  assert.ok(!text.includes(BOT));
});

test('crash handlers log uncaught errors through the redacting logger and exit 1', () => {
  const lines = [];
  const log = createLog({ write: (line) => lines.push(line) });
  log.registerSecret(BOT);
  const proc = new EventEmitter();
  const exits = [];
  proc.exit = (code) => exits.push(code);
  const bootFailed = installCrashHandlers(log, proc);
  proc.emit('uncaughtException', new Error(`boom ${BOT}`));
  proc.emit('unhandledRejection', new Error(`later ${BOT}`));
  bootFailed(new Error(`main threw ${BOT}`));
  assert.deepEqual(exits, [1, 1, 1]);
  const text = lines.join('\n');
  assert.match(text, /uncaught exception/);
  assert.match(text, /unhandled rejection/);
  assert.match(text, /boot failed/);
  assert.ok(!text.includes(BOT));
});

test('an invalid profile refuses to start and lists its validation errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-app-'));
  const bad = path.join(dir, 'profile.yml');
  fs.writeFileSync(bad, 'schema_version: 1\nclient: { id: tiny }\nusers: []\nsurprise: true\n');
  try {
    const { code, text } = await boot(env({ APLABS_PROFILE: bad }));
    assert.equal(code, 1);
    assert.match(text, /refusing to start/);
    assert.match(text, /unknown key \\"surprise\\"/);
    assert.match(text, /name/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed Slack connection exits 1 and the error is redacted', async () => {
  class FailingApp extends FakeSlackApp {
    async start() { throw new Error(`invalid_auth for ${BOT}`); }
  }
  const { code, text } = await boot(env(), { App: FailingApp });
  assert.equal(code, 1);
  assert.match(text, /could not connect to Slack/);
  assert.ok(!text.includes(BOT));
});

test('the real entry point exits non-zero naming the missing variables, with no output to stdout', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'kit/runtime/app')], {
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, APLABS_NO_KEYCHAIN: '1', SLACK_APP_TOKEN: APP },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SLACK_BOT_TOKEN is not set/);
  assert.match(r.stderr, /APLABS_PROFILE is not set/);
  assert.ok(!r.stderr.includes(APP) && !r.stdout.includes(APP));
  assert.equal(r.stdout, '');
});

test('the startup line names the environment and the hub commands it registered', async () => {
  const { entries, app } = await boot(env());
  assert.equal(entries[0].env, 'dev');
  assert.deepEqual(entries[0].hubs, ['/alpha', '/beta']);
  assert.equal(entries[0].modules, 4);
  assert.deepEqual([...app.commandListeners.keys()], ['/alpha', '/beta']);
});

test('a missing data file is logged and the app starts anyway, its startup line saying the data is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-app-data-'));
  try {
    const file = path.join(dir, 'missing.duckdb');
    const { code, app, entries, data } = await boot(env({ APLABS_DATA_PATH: file }), { data: undefined });
    assert.equal(code, 0);
    assert.equal(app.started, true);
    assert.deepEqual(entries.map((e) => e.level), ['warn', 'info']);
    assert.equal(entries[0].msg, 'data unavailable; starting anyway');
    assert.equal(entries[0].reason, 'the data file does not exist');
    assert.ok(!JSON.stringify(entries[0]).includes(dir), 'the path is not logged');
    assert.equal(entries[1].data, 'unavailable');
    data.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the startup line says the data is available when it opened', async () => {
  const { entries } = await boot(env());
  assert.equal(entries[0].data, 'available');
});

test('refuses to start when APLABS_DATA_PATH is not absolute', async () => {
  const { code, entries } = await boot(env({ APLABS_DATA_PATH: 'var/x.duckdb' }));
  assert.equal(code, 1);
  assert.ok(entries[0].problems.includes('APLABS_DATA_PATH must be an absolute path'));
});

// --- Plan motherduck-read: a motherduck profile, with a fake connection ------

const MD_PROFILE = path.join(__dirname, '../fixtures/runtime/profile-motherduck.yml');
// Fake keys: shaped like nothing real, findable in output.
const READ_KEY = 'fake-md-read-key-1111-not-a-credential';
const PUBLISH_KEY = 'fake-md-publish-key-2222-not-a-credential';
const mdEnv = (extra = {}) => env({ APLABS_PROFILE: MD_PROFILE, MOTHERDUCK_READ_TOKEN: READ_KEY, ...extra });

test('a motherduck profile with no read key refuses to start, naming the setting', async () => {
  const { code, entries, text } = await boot(mdEnv({ MOTHERDUCK_READ_TOKEN: '' }), { data: undefined, connect: () => assert.fail('never connects') });
  assert.equal(code, 1);
  assert.ok(entries[0].problems.some((p) => /^MOTHERDUCK_READ_TOKEN is not set \(the MotherDuck read key.*Keychain item "aplabs-motherduck-read-token"\)$/.test(p)), text);
});

test('a read key equal to the publish key refuses to start, and neither value is printed', async () => {
  const { code, entries, text } = await boot(mdEnv({ MOTHERDUCK_TOKEN: READ_KEY }), { data: undefined, connect: () => assert.fail('never connects') });
  assert.equal(code, 1);
  assert.ok(entries[0].problems.includes('MOTHERDUCK_READ_TOKEN is the publish key (MOTHERDUCK_TOKEN); the bot needs its own read-only key'), text);
  assert.ok(!text.includes(READ_KEY));
});

test('with no publish key the comparison is logged as skipped; a different publish key is registered with the scrubber, never kept', async (t) => {
  const { createFakeMotherDuck } = require('../fixtures/fake-motherduck');
  const skipped = await boot(mdEnv(), { data: undefined, connect: createFakeMotherDuck({ database: 'tiny_fixture' }).create });
  t.after(() => skipped.data.close());
  assert.equal(skipped.code, 0);
  assert.ok(skipped.entries.some((e) => e.level === 'info' && /MOTHERDUCK_TOKEN is not set, so the check that MOTHERDUCK_READ_TOKEN is not the publish key was skipped/.test(e.msg)));

  const res = await boot(mdEnv({ MOTHERDUCK_TOKEN: PUBLISH_KEY }), { data: undefined, connect: createFakeMotherDuck({ database: 'tiny_fixture' }).create });
  t.after(() => res.data.close());
  assert.equal(res.code, 0);
  assert.ok(!res.entries.some((e) => /skipped/.test(e.msg)));
  await res.connecting;
  res.log.info(`both ${READ_KEY} and ${PUBLISH_KEY}`);
  assert.equal(JSON.parse(res.lines.at(-1)).msg, 'both [redacted] and [redacted]', 'both keys are masked');
  assert.ok(!JSON.stringify(res.data.describe()).includes(PUBLISH_KEY));
});

test('a slow MotherDuck connect does not hold up Slack: the app starts, then the data comes up', async (t) => {
  const { createFakeMotherDuck } = require('../fixtures/fake-motherduck');
  const fake = createFakeMotherDuck({ database: 'tiny_fixture', createDelayMs: 60 });
  const lines = [];
  const res = await main({
    env: mdEnv(),
    cwd: os.tmpdir(),
    deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain'), connect: fake.create },
  });
  t.after(() => res.data.close());
  assert.equal(res.code, 0);
  assert.equal(res.app.started, true, 'Slack started while MotherDuck was still connecting');
  const startup = JSON.parse(lines.at(-1));
  assert.match(startup.msg, /single instance/);
  assert.equal(startup.data, 'connecting');
  assert.equal(res.data.describe().available, false);
  await res.connecting;
  const after = lines.map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([after.level, after.msg, after.source, after.label], ['info', 'data available', 'MotherDuck', 'tiny_fixture']);
  assert.equal(res.data.describe().available, true);
});

test('a MotherDuck connect that fails is logged with the read key masked, and the app keeps running', async (t) => {
  const { createFakeMotherDuck } = require('../fixtures/fake-motherduck');
  const fake = createFakeMotherDuck({
    database: 'tiny_fixture',
    // A raw error that echoes the key: the data module and the logger both mask it.
    failOn: (sql) => (sql.startsWith('ATTACH') ? new Error(`IO Error: auth failed for ${READ_KEY}`) : null),
  });
  const lines = [];
  const res = await main({
    env: mdEnv(),
    cwd: os.tmpdir(),
    deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain'), connect: fake.create },
  });
  t.after(() => res.data.close());
  assert.equal(res.code, 0);
  await res.connecting;
  const warn = lines.map((l) => JSON.parse(l)).find((e) => e.level === 'warn');
  assert.equal(warn.msg, 'data unavailable; starting anyway');
  assert.equal(warn.source, 'MotherDuck');
  assert.match(warn.reason, /auth failed for \[redacted\]/);
  assert.ok(!lines.join('\n').includes(READ_KEY));
});

test('a local profile never reads a MotherDuck key, from env or the Keychain', async () => {
  const read = [];
  const base = env({ MOTHERDUCK_READ_TOKEN: READ_KEY, MOTHERDUCK_TOKEN: PUBLISH_KEY });
  delete base.APLABS_NO_KEYCHAIN; // let the Keychain be asked, so a read would show
  const watched = new Proxy(base, {
    get(target, key) {
      if (typeof key === 'string') read.push(key);
      return target[key];
    },
  });
  const services = [];
  const res = await main({
    env: watched,
    cwd: os.tmpdir(),
    deps: {
      App: FakeSlackApp, write: () => {}, data: fakeData(), platform: 'darwin',
      readKeychain: (service) => { services.push(service); return null; },
      connect: () => assert.fail('a local profile never connects to MotherDuck'),
    },
  });
  assert.equal(res.code, 0);
  assert.ok(read.length > 0, 'the env was read');
  assert.deepEqual(read.filter((k) => /MOTHERDUCK/i.test(k)), []);
  assert.deepEqual(services.filter((s) => /motherduck/i.test(s)), []);
});

test('a retried event with an event_id already seen is processed once', async () => {
  const { app, lines } = await boot(env());
  const message = { channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi' };
  await app.dispatchMessage(message, { body: { event_id: 'Ev1' } });
  await app.dispatchMessage(message, { body: { event_id: 'Ev1', retry_attempt: 1 }, context: { retryNum: 1 } });
  await app.dispatchMessage(message, { body: { event_id: 'Ev2' } });
  assert.equal(app.said.length, 2);
  const skipped = lines.map((l) => JSON.parse(l)).filter((e) => e.msg === 'duplicate event skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].event_id, 'Ev1');
  assert.equal(skipped[0].retry, 1);
});

test('an event_id is forgotten after 10 minutes (store expiry, injected clock)', async () => {
  let t = 0;
  const { app } = await boot(env(), { now: () => t });
  const message = { channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi' };
  await app.dispatchMessage(message, { body: { event_id: 'Ev1' } });
  t = 10 * 60 * 1000 - 1;
  await app.dispatchMessage(message, { body: { event_id: 'Ev1' } });
  assert.equal(app.said.length, 1);
  t = 10 * 60 * 1000;
  await app.dispatchMessage(message, { body: { event_id: 'Ev1' } });
  assert.equal(app.said.length, 2);
});

test('an invalid module manifest refuses to start, naming the file and the field', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-appdir-'));
  try {
    fs.cpSync(APP_DIR, dir, { recursive: true });
    const file = path.join(dir, 'modules/echo/manifest.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete m.label;
    fs.writeFileSync(file, JSON.stringify(m));
    const { code, text } = await boot(env({ APLABS_APP_DIR: dir }));
    assert.equal(code, 1);
    assert.match(text, /refusing to start/);
    assert.match(text, /modules\/echo\/manifest.json: field \\"label\\" is required/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing app dir, a relative one and a bad APLABS_ENV are refused by name', async () => {
  const missing = await boot(env({ APLABS_APP_DIR: path.join(os.tmpdir(), 'aplabs-no-such-app-dir') }));
  assert.equal(missing.code, 1);
  assert.match(missing.text, /app dir does not exist/);
  const relative = await boot(env({ APLABS_APP_DIR: 'app', APLABS_ENV: 'Prod!' }));
  assert.equal(relative.code, 1);
  assert.match(relative.text, /APLABS_APP_DIR must be an absolute path/);
  assert.match(relative.text, /APLABS_ENV must be a lower-case name/);
});

// Story 9.1: the AI key and the AI service at boot. A stand-in client; no
// request is ever sent.
const AI_KEY = 'sk-ant-api00-fake-boot-key-value';
const fakeAiClient = () => ({ messages: { create: async () => assert.fail('no AI call at boot') } });

test('no AI key: the app still boots, and the startup line says the AI is off', async () => {
  const { code, entries, llm } = await boot(env());
  assert.equal(code, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ai, 'off (ANTHROPIC_API_KEY not set)');
  assert.deepEqual([llm.status().on, llm.status().reason], [false, 'no_key']);
});

test('the AI key is read once at startup, registered with the redactor, and turns the AI on', async () => {
  const built = [];
  const res = await boot(env({ ANTHROPIC_API_KEY: AI_KEY }), { llm: { createClient: (o) => { built.push(o); return fakeAiClient(); } } });
  assert.equal(res.code, 0);
  assert.equal(res.entries[0].ai, 'on');
  assert.equal(built.length, 1);
  assert.equal(built[0].apiKey, AI_KEY);
  assert.equal(res.log.redact(`key=${AI_KEY}`), 'key=[redacted]');
  assert.ok(!res.text.includes(AI_KEY));
});

test('APLABS_LLM_OFF keeps the AI off even with a key, and builds no client', async () => {
  const res = await boot(env({ ANTHROPIC_API_KEY: AI_KEY, APLABS_LLM_OFF: '1' }), { llm: { createClient: () => assert.fail('no client when off') } });
  assert.equal(res.code, 0);
  assert.equal(res.entries[0].ai, 'off (switched off by APLABS_LLM_OFF)');
  assert.equal(res.log.redact(AI_KEY), '[redacted]', 'the key is still registered');
});

test('a profile naming an unpriced model refuses to start, naming the setting', async () => {
  const { code, text } = await boot(env({ APLABS_PROFILE: path.join(__dirname, '../fixtures/runtime/profile-unpriced-model.yml') }));
  assert.equal(code, 1);
  assert.match(text, /refusing to start/);
  assert.match(text, /llm\.model \\"claude-unpriced-9\\" has no price/);
});

// Scheduled jobs (Story 11.1).
const JOBS_PROFILE = path.join(__dirname, '../fixtures/runtime/profile-jobs.yml');
const JOBS_APP = path.join(__dirname, '../fixtures/runtime/jobs/app');
const OFF_APP = path.join(__dirname, '../fixtures/runtime/jobs/off-app');

// Fake timers for the scheduler: { set, clear } plus fire() for every pending one.
function fakeTimers() {
  const pending = new Set();
  return {
    pending,
    set(fn, ms) { const h = { fn, ms }; pending.add(h); return h; },
    clear(h) { pending.delete(h); },
    fire() { const now = [...pending]; pending.clear(); for (const h of now) h.fn(); },
  };
}

test('jobs: the startup line says "off (profile)" by default and loads no job file', async () => {
  const res = await boot(env());
  assert.equal(res.code, 0);
  assert.equal(res.entries[0].jobs, 'off (profile)');
  assert.deepEqual(res.jobs.scheduled(), []);
});

test('jobs: on with the profile, the startup line counts the enabled jobs and the scheduler runs them', async () => {
  let t = Date.parse('2026-03-10T08:04:00Z');
  const timers = fakeTimers();
  const res = await boot(env({ APLABS_PROFILE: JOBS_PROFILE, APLABS_APP_DIR: JOBS_APP }), { now: () => t, timers });
  assert.equal(res.code, 0);
  assert.equal(res.entries.length, 1, 'starting the scheduler logs nothing');
  assert.equal(res.entries[0].jobs, 'on (1 scheduled)');
  assert.deepEqual(res.jobs.scheduled().map((j) => [j.name, j.next.toISOString()]), [['heartbeat', '2026-03-10T08:05:00.000Z']]);
  t = Date.parse('2026-03-10T08:05:00Z');
  timers.fire();
  await new Promise((r) => setImmediate(r));
  const after = res.lines.slice(1).map((l) => JSON.parse(l));
  assert.deepEqual(after.map((e) => [e.msg, e.job]), [['job started', 'heartbeat'], ['heartbeat ran', 'heartbeat'], ['job finished', 'heartbeat']]);
  res.jobs.stop();
});

test('jobs: APLABS_JOBS_OFF (even "0") wins over the profile; a job file that throws on load is never evaluated', async () => {
  const before = globalThis.__aplabsJobFixtureLoads || 0;
  for (const value of ['1', '0']) {
    const res = await boot(env({ APLABS_PROFILE: JOBS_PROFILE, APLABS_APP_DIR: OFF_APP, APLABS_JOBS_OFF: value }), { timers: fakeTimers() });
    assert.equal(res.code, 0, value);
    assert.equal(res.entries[0].jobs, 'off (APLABS_JOBS_OFF)');
    assert.deepEqual(res.jobs.scheduled(), []);
  }
  assert.equal(globalThis.__aplabsJobFixtureLoads || 0, before);
});

test('jobs: a broken jobs.json refuses to start even with jobs off, naming the job and field', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-app-jobs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify([{ name: 'nightly', schedule: '* * * * *', run: '../x.js', enabled: true }]));
  const { code, text } = await boot(env({ APLABS_APP_DIR: dir }));
  assert.equal(code, 1);
  assert.match(text, /refusing to start/);
  assert.match(text, /app: jobs\.json: job \\"nightly\\": field \\"schedule\\" it can run more often than every 5 minutes/);
  assert.match(text, /app: jobs\.json: job \\"nightly\\": field \\"run\\" must stay inside jobs\//);
});

test('jobs: shutdown stops the scheduler before Slack, and does not wait for a running job', async () => {
  const order = [];
  const lines = [];
  const log = createLog({ write: (l) => lines.push(JSON.parse(l)) });
  let exited = null;
  await shutdown({
    app: { stop: async () => { order.push('slack'); } },
    data: { close: () => order.push('data') },
    jobs: { stop: () => order.push('jobs') },
    log,
    exit: (code) => { exited = code; order.push('exit'); },
  }, 'SIGTERM');
  assert.deepEqual(order, ['jobs', 'slack', 'data', 'exit']);
  assert.equal(exited, 0);
  assert.deepEqual([lines[0].msg, lines[0].signal], ['stopping', 'SIGTERM']);
});

// --- Story 11.2: the health listener (kit/runtime/app/health) ------------------

const net = require('node:net');
const http = require('node:http');

// A free local port, found by listening on 0 and closing.
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function getHealth(port, urlPath = '/healthz') {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('health: off when APLABS_HEALTH_PORT is unset; the startup line says so', async () => {
  const { code, health, entries } = await boot(env());
  assert.equal(code, 0);
  assert.equal(health, null);
  assert.equal(entries.find((e) => /bot started/.test(e.msg)).health, 'off');
});

test('health: on with APLABS_HEALTH_PORT, started before Slack, fed by the connection events', async (t) => {
  const port = await freePort();
  let now = 5_000_000;
  let sawHealthBeforeStart = null;
  class Watching extends FakeSlackApp {
    async start() {
      sawHealthBeforeStart = (await getHealth(port)).status;
      return super.start();
    }
  }
  const res = await boot(env({ APLABS_HEALTH_PORT: String(port) }), { App: Watching, now: () => now, healthHost: '127.0.0.1' });
  t.after(() => res.health && res.health.close());
  assert.equal(res.code, 0);
  assert.equal(sawHealthBeforeStart, 200, 'the listener answers before Slack connects');
  assert.equal(res.entries.find((e) => /bot started/.test(e.msg)).health, `on (port ${port})`);
  now += 91_000;
  assert.deepEqual(await getHealth(port), { status: 200, body: 'ok' });
  res.app.disconnect();
  now += 61_000;
  assert.deepEqual(await getHealth(port), { status: 503, body: 'down' });
  res.app.connect();
  assert.deepEqual(await getHealth(port), { status: 200, body: 'ok' });
  assert.equal((await getHealth(port, '/')).status, 404);
});

test('health: an app that never connects gets 503 at 91 seconds', async (t) => {
  const port = await freePort();
  let now = 5_000_000;
  class NeverConnects extends FakeSlackApp {
    constructor(o) { super(o); this.connectOnStart = false; }
  }
  const res = await boot(env({ APLABS_HEALTH_PORT: String(port) }), { App: NeverConnects, now: () => now, healthHost: '127.0.0.1' });
  t.after(() => res.health && res.health.close());
  assert.equal(res.code, 0);
  assert.deepEqual(await getHealth(port), { status: 200, body: 'ok' });
  now += 91_000;
  assert.deepEqual(await getHealth(port), { status: 503, body: 'down' });
});

test('health: a malformed APLABS_HEALTH_PORT refuses to start, naming the variable', async () => {
  for (const bad of ['0', '70000', 'http']) {
    const { code, app, entries } = await boot(env({ APLABS_HEALTH_PORT: bad }));
    assert.equal(code, 1, bad);
    assert.equal(app, undefined);
    const refusal = entries.find((e) => e.msg === 'refusing to start');
    assert.match(refusal.problems.join('\n'), /APLABS_HEALTH_PORT must be a port number from 1 to 65535/);
  }
});

test('health: a port already in use (EADDRINUSE) refuses to start, naming the variable, before Slack', async (t) => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  t.after(() => blocker.close());
  const { port } = blocker.address();
  const { code, app, entries } = await boot(env({ APLABS_HEALTH_PORT: String(port) }), { healthHost: '127.0.0.1' });
  assert.equal(code, 1);
  assert.equal(app, undefined, 'Slack never started');
  const refusal = entries.find((e) => e.msg === 'refusing to start');
  assert.match(refusal.problems.join('\n'), /APLABS_HEALTH_PORT: port \d+ is already in use/);
});

test('health: a failed Slack connection closes the listener', async () => {
  const port = await freePort();
  class FailingApp extends FakeSlackApp {
    async start() { throw new Error('invalid_auth'); }
  }
  const { code } = await boot(env({ APLABS_HEALTH_PORT: String(port) }), { App: FailingApp, healthHost: '127.0.0.1' });
  assert.equal(code, 1);
  await assert.rejects(getHealth(port), (err) => err.code === 'ECONNREFUSED');
});

test('health: shutdown closes the listener after Slack stops', async () => {
  const order = [];
  const log = createLog({ write: () => {} });
  await shutdown({
    app: { stop: async () => { order.push('slack'); } },
    data: { close: () => order.push('data') },
    jobs: { stop: () => order.push('jobs') },
    health: { close: async () => { order.push('health'); } },
    log,
    exit: () => order.push('exit'),
  }, 'SIGTERM');
  assert.deepEqual(order, ['jobs', 'slack', 'health', 'data', 'exit']);
});
