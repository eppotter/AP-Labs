'use strict';

// Story 11.2: the health check (kit/runtime/app/health, AD-13). The state
// machine runs on an injected clock; the listener tests bind 127.0.0.1 on a
// free port, except the one that checks the default host. The Socket Mode
// event names are checked against the installed @slack/socket-mode client,
// offline.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const health = require('../../kit/runtime/app/health');

const {
  portFrom, createHealthState, watchConnection, startHealthServer, GRACE_MS, OUTAGE_MS, EVENTS, PORT_ENV,
} = health;

const S = 1000;

// A clock tests move by hand. at(ms) sets the time since boot.
function clock() {
  let t = 1_000_000;
  const start = t;
  return { now: () => t, at: (ms) => { t = start + ms; } };
}

function get(port, urlPath = '/healthz', method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function listening(t, state, opts = {}) {
  const h = await startHealthServer({ port: 0, state, host: '127.0.0.1', ...opts });
  t.after(() => h.close());
  return h;
}

// --- the verdict, on an injected clock ----------------------------------------

test('the boot grace: 200 for the first 90 seconds, before any connection', () => {
  const c = clock();
  const s = createHealthState({ now: c.now });
  for (const ms of [0, 30 * S, GRACE_MS]) {
    c.at(ms);
    assert.equal(s.status(), 'ok', `at ${ms}ms`);
  }
});

test('never connected: 503 at 91 seconds (the state starts down; fails closed)', () => {
  const c = clock();
  const s = createHealthState({ now: c.now });
  c.at(91 * S);
  assert.equal(s.status(), 'down');
  c.at(3600 * S);
  assert.equal(s.status(), 'down');
});

test('connected: 200 after the grace', () => {
  const c = clock();
  const s = createHealthState({ now: c.now });
  c.at(5 * S);
  s.up();
  c.at(91 * S);
  assert.equal(s.status(), 'ok');
});

test('a short reconnect stays 200', () => {
  const c = clock();
  const s = createHealthState({ now: c.now });
  s.up();
  c.at(200 * S);
  s.down();
  c.at(259 * S);
  assert.equal(s.status(), 'ok', '59 seconds down');
  c.at(260 * S);
  assert.equal(s.status(), 'ok', 'exactly 60 seconds down');
  s.up();
  c.at(400 * S);
  assert.equal(s.status(), 'ok');
});

test('an outage over 60 seconds turns 503, and recovery brings back 200', () => {
  const c = clock();
  const s = createHealthState({ now: c.now });
  s.up();
  c.at(200 * S);
  s.down();
  c.at(230 * S);
  s.down(); // a second down event keeps the outage's start
  c.at(261 * S);
  assert.equal(s.status(), 'down');
  s.up();
  assert.equal(s.status(), 'ok');
});

test('an outage that starts in the grace counts from its start, not from the grace end', () => {
  const c = clock();
  const s = createHealthState({ now: c.now });
  s.up();
  c.at(20 * S);
  s.down();
  c.at(85 * S);
  assert.equal(s.status(), 'ok', 'still in the grace');
  c.at(91 * S);
  assert.equal(s.status(), 'down', '71 seconds down, past the grace');
});

// --- the port -------------------------------------------------------------------

test('the listener is off when APLABS_HEALTH_PORT is unset or empty', () => {
  assert.deepEqual(portFrom({}), { port: null });
  assert.deepEqual(portFrom({ [PORT_ENV]: '' }), { port: null });
});

test('a malformed port is a problem naming the variable, never echoing the value', () => {
  for (const bad of ['0', '65536', '-1', '80.5', 'eighty', ' 8080', '8080 ', '1e3', '0x50', '123456']) {
    const r = portFrom({ [PORT_ENV]: bad });
    assert.ok(r.problem, bad);
    assert.match(r.problem, /APLABS_HEALTH_PORT must be a port number from 1 to 65535/);
    assert.ok(!r.problem.includes(bad), `${bad} is not echoed`);
  }
  assert.deepEqual(portFrom({ [PORT_ENV]: '1' }), { port: 1 });
  assert.deepEqual(portFrom({ [PORT_ENV]: '65535' }), { port: 65535 });
  assert.deepEqual(portFrom({ [PORT_ENV]: '8080' }), { port: 8080 });
});

// --- the listener ------------------------------------------------------------------

test('GET /healthz answers a fixed word: "ok" with 200, "down" with 503', async (t) => {
  const c = clock();
  const s = createHealthState({ now: c.now });
  const h = await listening(t, s);
  assert.deepEqual(await get(h.port), { status: 200, body: 'ok' });
  c.at(91 * S);
  assert.deepEqual(await get(h.port), { status: 503, body: 'down' });
  assert.deepEqual(await get(h.port, '/healthz?verbose=1'), { status: 503, body: 'down' });
});

test('any other path or method is 404', async (t) => {
  const s = createHealthState();
  const h = await listening(t, s);
  for (const p of ['/', '/health', '/healthz/', '/healthz/x', '/HEALTHZ', '/metrics']) {
    assert.equal((await get(h.port, p)).status, 404, p);
  }
  for (const m of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    assert.equal((await get(h.port, '/healthz', m)).status, 404, m);
  }
});

test('a port already in use (EADDRINUSE) is refused, naming the variable', async (t) => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  t.after(() => blocker.close());
  const { port } = blocker.address();
  await assert.rejects(
    startHealthServer({ port, state: createHealthState(), host: '127.0.0.1' }),
    (err) => err.code === 'EADDRINUSE' && /^APLABS_HEALTH_PORT: port \d+ is already in use$/.test(err.message),
  );
});

test('by default it binds 0.0.0.0', async (t) => {
  assert.equal(health.HOST, '0.0.0.0');
  const h = await startHealthServer({ port: 0, state: createHealthState() });
  t.after(() => h.close());
  assert.equal(h.server.address().address, '0.0.0.0');
});

// --- the connection events ---------------------------------------------------------

test('watchConnection: connected sets it up, reconnecting and disconnected start the outage clock', () => {
  const c = clock();
  const s = createHealthState({ now: c.now });
  const client = new EventEmitter();
  assert.equal(watchConnection({ receiver: { client } }, s), true);
  client.emit('connected');
  c.at(100 * S);
  client.emit('reconnecting');
  c.at(161 * S);
  assert.equal(s.status(), 'down');
  client.emit('connected');
  assert.equal(s.status(), 'ok');
  client.emit('disconnected');
  c.at(222 * S);
  assert.equal(s.status(), 'down');
});

test('an app with no Socket Mode client is never marked up (fails closed)', () => {
  const c = clock();
  const s = createHealthState({ now: c.now });
  assert.equal(watchConnection({}, s), false);
  assert.equal(watchConnection(null, s), false);
  c.at(91 * S);
  assert.equal(s.status(), 'down');
});

test('the installed @slack/socket-mode client really emits every event name the listener subscribes to', async () => {
  const { SocketModeClient } = require('@slack/socket-mode');
  assert.deepEqual([...EVENTS.up, ...EVENTS.down].sort(), ['connected', 'disconnected', 'reconnecting']);
  // A quiet logger: the client logs at debug while it works.
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel() { return 'error'; }, setName() {} };
  const client = new SocketModeClient({ appToken: 'xapp-1-A000-222-fakeappvalue', logger: quiet, clientPingTimeout: 1 });
  const seen = [];
  for (const name of [...EVENTS.up, ...EVENTS.down]) client.on(name, () => seen.push(name));

  // connected: Slack's hello message on the socket (offline; no socket opened).
  client.emit('ws_message', JSON.stringify({ type: 'hello' }), false);
  // reconnecting: the socket closed and the client retries. start() is
  // stubbed so the retry never reaches the network.
  client.start = async () => {};
  await new Promise((resolve) => {
    client.once('reconnecting', () => setImmediate(resolve));
    client.emit('close');
  });
  // disconnected: the client stops.
  await client.disconnect();

  assert.deepEqual(seen, ['connected', 'reconnecting', 'disconnected']);
});

test('a real Bolt socketMode app exposes its Socket Mode client where watchConnection looks', () => {
  const { App } = require('@slack/bolt');
  const { SocketModeClient } = require('@slack/socket-mode');
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel() { return 'error'; }, setName() {} };
  // deferInitialization and no token verification: Bolt must not call
  // auth.test, so the test stays offline.
  const app = new App({
    token: 'xoxb-000-111-faketokenvalue',
    appToken: 'xapp-1-A000-222-fakeappvalue',
    socketMode: true,
    logger: quiet,
    deferInitialization: true,
    tokenVerificationEnabled: false,
  });
  assert.ok(health.socketClientOf(app) instanceof SocketModeClient);
});

test('the reply body never carries the client name, a path or a token', async (t) => {
  const s = createHealthState();
  const h = await listening(t, s);
  const { body } = await get(h.port);
  assert.ok(['ok', 'down'].includes(body));
  const src = require('node:fs').readFileSync(require.resolve('../../kit/runtime/app/health'), 'utf8');
  assert.doesNotMatch(src, /res\.end\((?!'not found'\)|word\))/, 'the only bodies are the fixed words');
});

test('the grace and outage limits are 90 and 60 seconds', () => {
  assert.equal(GRACE_MS, 90 * S);
  assert.equal(OUTAGE_MS, 60 * S);
});
