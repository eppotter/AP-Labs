'use strict';

// The health check (Story 11.2, AD-13): a tiny HTTP listener, on only when
// APLABS_HEALTH_PORT is set, so a host can tell a dead Socket Mode app from a
// live one.
//
// It serves GET /healthz and nothing else (any other path or method: 404).
// The reply body is a fixed word, "ok" (200) or "down" (503): never the
// client name, a path or a token. It binds 0.0.0.0. The port must be a whole
// number from 1 to 65535; a malformed port, or one already in use
// (EADDRINUSE), refuses startup naming the variable.
//
// It fails closed. The connection state starts down at boot, and only a real
// Socket Mode `connected` event sets it up. The reply is 200 for the first
// 90 seconds after the listener starts (the boot grace, which covers the
// connect: the listener starts before Slack does). After the grace, 200 needs
// a `connected` event seen and no current outage over 60 seconds. The outage
// clock starts at boot when no `connected` event has been seen yet, and
// again at each `reconnecting` or `disconnected` event; a `connected` event
// stops it. So a short reconnect stays 200, an app that never connected gets
// 503 at 91 seconds, and one down for over 60 seconds gets 503 until it
// reconnects.
//
// The events come from the Socket Mode client Bolt builds for a socketMode
// app (app.receiver.client, an EventEmitter from @slack/socket-mode). A test
// checks that the installed client really emits each name in EVENTS. An app
// with no such client is never marked up, so its health turns 503 after the
// grace (fails closed).
//
// now (ms) is injectable: tests drive the clock.

const http = require('node:http');

const PORT_ENV = 'APLABS_HEALTH_PORT';
const HOST = '0.0.0.0';
const PATH = '/healthz';
const GRACE_MS = 90 * 1000;
const OUTAGE_MS = 60 * 1000;
// The Socket Mode client's events: up on connected, down on the others.
const EVENTS = Object.freeze({ up: Object.freeze(['connected']), down: Object.freeze(['reconnecting', 'disconnected']) });

// The port from env. Returns { port: null } when unset (health off),
// { port } when valid, or { problem } naming the variable (never its value).
function portFrom(env = process.env) {
  const raw = env[PORT_ENV];
  if (raw === undefined || raw === '') return { port: null };
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    return { problem: `${PORT_ENV} must be a port number from 1 to 65535` };
  }
  return { port: Number(raw) };
}

// The connection state and the verdict. Returns { up, down, status }.
// status() is 'ok' or 'down'.
function createHealthState({ now = Date.now } = {}) {
  const bootAt = now();
  let connectedSeen = false;
  let downSince = bootAt; // the outage clock: running from boot until connected

  return Object.freeze({
    up() {
      connectedSeen = true;
      downSince = null;
    },
    down() {
      if (downSince === null) downSince = now(); // an outage already running keeps its start
    },
    status() {
      const t = now();
      if (t - bootAt <= GRACE_MS) return 'ok';
      if (!connectedSeen) return 'down';
      if (downSince !== null && t - downSince > OUTAGE_MS) return 'down';
      return 'ok';
    },
  });
}

// The Socket Mode client of a Bolt app, or null.
function socketClientOf(app) {
  const client = app && app.receiver && app.receiver.client;
  return client && typeof client.on === 'function' ? client : null;
}

// Feeds the app's Socket Mode connection events into state. Returns true when
// it found a client to watch; false leaves the state down (fails closed).
function watchConnection(app, state) {
  const client = socketClientOf(app);
  if (!client) return false;
  for (const name of EVENTS.up) client.on(name, () => state.up());
  for (const name of EVENTS.down) client.on(name, () => state.down());
  return true;
}

// The request handler: GET /healthz only, a fixed word as the body.
function handler(state) {
  return (req, res) => {
    const pathOnly = String(req.url || '').split('?')[0];
    if (req.method !== 'GET' || pathOnly !== PATH) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const word = state.status();
    res.writeHead(word === 'ok' ? 200 : 503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(word);
  };
}

// Starts the listener. Resolves { server, port, close } once it listens;
// rejects with an error naming the variable when the port is taken or the
// listen fails. host is injectable for tests only.
function startHealthServer({ port, state, host = HOST }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler(state));
    const failed = (err) => {
      const why = err.code === 'EADDRINUSE' ? 'is already in use' : `could not be opened (${err.code || 'error'})`;
      reject(Object.assign(new Error(`${PORT_ENV}: port ${port} ${why}`), { code: err.code }));
    };
    server.once('error', failed);
    server.listen(port, host, () => {
      server.removeListener('error', failed);
      const close = () => new Promise((done) => {
        server.close(() => done());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      resolve({ server, port: server.address().port, close });
    });
  });
}

module.exports = {
  portFrom,
  createHealthState,
  socketClientOf,
  watchConnection,
  startHealthServer,
  handler,
  PORT_ENV,
  HOST,
  PATH,
  GRACE_MS,
  OUTAGE_MS,
  EVENTS,
};
