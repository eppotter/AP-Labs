'use strict';

// kit/runtime/log: every registered secret is redacted from every line, and
// Bolt and the Slack SDK log only through it at INFO and above. No network:
// the Bolt app is constructed but never started.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLog, slackLogger } = require('../../kit/runtime/log');

// Fake values, shaped like the real ones; nothing here is a credential.
const BOT = 'xoxb-000-111-faketokenvalue';
const APP = 'xapp-1-A000-222-fakeappvalue';
const WSS = 'wss://wss-primary.slack.com/link/?ticket=fake-ticket-0123&app_id=A000';

function capture(opts = {}) {
  const lines = [];
  const log = createLog({ write: (line) => lines.push(line), now: () => new Date('2026-10-24T00:00:00Z'), ...opts });
  return { log, lines, text: () => lines.join('\n') };
}

test('a loaded secret is redacted from the message, fields, nested values and errors', () => {
  const { log, lines, text } = capture();
  const secret = log.registerSecret('plain-secret-value-9876');
  log.info(`token is ${secret}`, { nested: { list: [secret, 'ok'] }, [secret]: 1, err: new Error(`bad ${secret}`) });
  assert.equal(lines.length, 1);
  assert.ok(!text().includes(secret));
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.msg, 'token is [redacted]');
  assert.deepEqual(entry.nested.list, ['[redacted]', 'ok']);
  assert.equal(entry.err.message, 'bad [redacted]');
  assert.ok(!entry.err.stack.includes(secret));
  assert.equal(entry.level, 'info');
  assert.equal(entry.ts, '2026-10-24T00:00:00.000Z');
});

test('a secret with JSON-special characters still yields a valid line', () => {
  const { log, lines } = capture();
  log.registerSecret('a"b\\c');
  log.warn('x a"b\\c y');
  assert.equal(JSON.parse(lines[0]).msg, 'x [redacted] y');
});

test('Slack token and Socket Mode URL shapes are masked even when not registered', () => {
  const { log, text } = capture();
  log.error(`tokens ${BOT} ${APP} url ${WSS}`);
  for (const s of [BOT, APP, 'fake-ticket-0123', 'wss-primary.slack.com']) assert.ok(!text().includes(s), s);
});

test('levels below the floor are dropped; an unknown level is refused', () => {
  const { log, lines } = capture();
  log.debug('hidden');
  log.info('shown');
  assert.equal(lines.length, 1);
  assert.throws(() => createLog({ level: 'loud' }), /unknown log level/);
});

test('circular fields do not throw', () => {
  const { log, lines } = capture();
  const a = { name: 'a' };
  a.self = a;
  log.info('loop', { a });
  assert.equal(JSON.parse(lines[0]).a.self, '[circular]');
});

test('#56: two secret-shaped keys keep both fields under unique redacted keys', () => {
  const { log, lines, text } = capture();
  const secret = log.registerSecret('plain-secret-value-9876');
  log.info('keys', { [BOT]: 'first', [APP]: 'second', nested: { [secret]: 1, [`${secret}-2`]: 2, '[redacted]': 3 } });
  assert.ok(!text().includes(BOT) && !text().includes(APP) && !text().includes(secret));
  const entry = JSON.parse(lines[0]);
  assert.equal(entry['[redacted]'], 'first');
  assert.equal(entry['[redacted]#2'], 'second');
  assert.deepEqual(entry.nested, { '[redacted]': 1, '[redacted]-2': 2, '[redacted]#2': 3 });
});

test('slackLogger drops debug even when the library asks for it', () => {
  const { log, lines } = capture();
  const sl = slackLogger(log, 'bolt');
  sl.setLevel('debug');
  assert.equal(sl.getLevel(), 'debug');
  sl.debug(`connecting to ${WSS}`);
  assert.equal(lines.length, 0);
  sl.info('connected %s', 'ok');
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.msg, 'connected ok');
  assert.equal(entry.source, 'bolt');
});

test('Bolt at debug level: its and the Socket Mode client\'s output goes through the log, URL never reaches output', () => {
  const { App, LogLevel } = require('@slack/bolt');
  const { log, text } = capture();
  log.registerSecret(BOT);
  log.registerSecret(APP);
  const logger = slackLogger(log);
  // deferInitialization and no token verification: Bolt must not call
  // auth.test, so the test stays offline.
  const app = new App({
    token: BOT,
    appToken: APP,
    socketMode: true,
    logger,
    logLevel: LogLevel.DEBUG,
    deferInitialization: true,
    tokenVerificationEnabled: false,
  });

  // Bolt and the Socket Mode client both hold our logger, not a console one.
  assert.equal(app.logger, logger);
  const socketClient = app.receiver.client;
  assert.equal(socketClient.logger, logger);
  assert.equal(logger.getLevel(), LogLevel.DEBUG);

  // What the SDK prints at debug when it opens the socket, then a stray INFO
  // and ERROR line that echo the URL and a token.
  socketClient.logger.debug(`Initiating new WebSocket connection to ${WSS}`);
  app.logger.debug(`apps.connections.open returned ${WSS}`);
  socketClient.logger.info(`Now connected to ${WSS}`);
  app.logger.error(`failed with ${APP} and ${BOT}`);

  const out = text();
  assert.ok(out.length > 0, 'INFO and above reach the log');
  for (const s of [WSS, 'fake-ticket-0123', 'wss-primary.slack.com', BOT, APP]) assert.ok(!out.includes(s), s);
  assert.ok(!out.includes('Initiating new WebSocket'), 'debug lines are dropped');
});
