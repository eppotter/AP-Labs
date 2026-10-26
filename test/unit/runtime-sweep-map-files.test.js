'use strict';

// kit/runtime/jobs/sweep-map-files (Story 15.1, AD-R15): an engine job that
// runs at start-up and every 5 minutes and deletes the file of every expired
// map-file record, so no map file outlives its upload by more than 20
// minutes. Every clock the job and the store read is frozen with node:test's
// mock.timers (Date and setTimeout): the store and the job runner read
// Date.now(), the runner arms setTimeout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../../kit/runtime/store');
const { createEngineJobs } = require('../../kit/runtime/jobs');
const sweep = require('../../kit/runtime/jobs/sweep-map-files');
const { createMapFiles } = require('../../kit/runtime/slack/image');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const PNG = fs.readFileSync(path.join(__dirname, '../fixtures/routing-map/test-pattern.png'));
const ALT = 'Route map: Test pattern, no crew, 0 stops';
const START = Date.parse('2026-11-02T15:00:00Z');
const MIN = 60 * 1000;

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}
const slackError = (code) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

// Frozen clocks: Date and setTimeout, starting at START.
function freeze(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: START });
  return {
    async tick(ms) {
      // One minute at a time, so each timer's work settles before the next.
      for (let left = ms; left > 0; left -= Math.min(left, MIN)) {
        t.mock.timers.tick(Math.min(left, MIN));
        await flush();
      }
    },
  };
}

// One process: the store (given, or new), the Slack fake, the sweep and the
// map-file lifecycle the hub uses.
function processWith({ store = createStore(), app = new FakeSlackApp({}) } = {}) {
  const log = quietLog();
  const jobs = createEngineJobs({ names: [sweep.NAME], store, client: app.client, log });
  const files = createMapFiles({ store, client: app.client, log, sweeping: () => jobs.running(sweep.NAME) });
  return { store, app, log, jobs, files };
}

test('it is the engine job sweep-map-files, every 5 minutes', () => {
  assert.equal(sweep.NAME, 'sweep-map-files');
  assert.equal(sweep.EVERY_MS, 5 * MIN);
});

test('the sweep runs at start-up and every 5 minutes, deleting only expired records\' files', async (t) => {
  const clock = freeze(t);
  const p = processWith();
  p.jobs.start();
  await flush();
  assert.equal(p.files.ready(), true);
  await p.files.upload({ owner: 'U1:V1', png: PNG, alt: ALT }); // F1 at 0:00, expires 0:15
  await clock.tick(14 * MIN);
  assert.deepEqual(p.app.deleted, []);
  await clock.tick(1 * MIN); // 0:15: the sweep runs (0:05, 0:10, 0:15) and finds F1 expired
  assert.deepEqual(p.app.deleted, ['F1']);
  assert.equal(p.store.mapFileCount(), 0);
  assert.deepEqual(p.log.lines.filter((l) => l.msg === 'map files swept').map((l) => l.fields), [{ deleted: 1, kept: 0 }]);
  p.jobs.stop();
});

test('no file outlives its upload by more than 20 minutes, whenever in the 5-minute cycle it was uploaded', async (t) => {
  const clock = freeze(t);
  const p = processWith();
  p.jobs.start();
  await flush();
  const uploadedAt = new Map();
  const deletedAt = new Map();
  const del = p.app.client.files.delete;
  p.app.client.files.delete = async (args) => {
    deletedAt.set(args.file, Date.now());
    return del(args);
  };
  for (let i = 0; i < 6; i += 1) {
    const { slack_file: { id } } = await p.files.upload({ owner: `U1:V${i}`, png: PNG, alt: ALT });
    uploadedAt.set(id, Date.now());
    await clock.tick(1 * MIN);
  }
  await clock.tick(25 * MIN);
  assert.equal(deletedAt.size, 6);
  for (const [id, at] of uploadedAt) {
    const lived = deletedAt.get(id) - at;
    assert.ok(lived >= 15 * MIN, `${id} deleted before its 15 minutes`);
    assert.ok(lived <= 20 * MIN, `${id} lived ${lived / MIN} minutes`);
  }
  p.jobs.stop();
});

test('a failed files.delete keeps the record, logs Slack\'s error code only, and the next sweep retries it', async (t) => {
  const clock = freeze(t);
  const p = processWith();
  p.jobs.start();
  await p.files.upload({ owner: 'U1:V1', png: PNG, alt: ALT });
  p.app.deleteFail = slackError('ratelimited');
  await clock.tick(15 * MIN);
  assert.deepEqual(p.app.deleted, []);
  assert.deepEqual(p.store.expiredMapFiles(), ['F1']);
  const warns = p.log.lines.filter((l) => l.level === 'warn');
  assert.deepEqual(warns.map((l) => [l.msg, l.fields]), [['map file delete failed; kept for the next sweep', { why: 'expired', reason: 'ratelimited' }]]);
  p.app.deleteFail = null;
  await clock.tick(5 * MIN);
  assert.deepEqual(p.app.deleted, ['F1']);
  assert.equal(p.store.mapFileCount(), 0);
  p.jobs.stop();
});

test('after a restart, a new process with the same store deletes the files the previous process recorded', async (t) => {
  const clock = freeze(t);
  const slack = new FakeSlackApp({}); // the same workspace across the restart
  const first = processWith({ app: slack });
  first.jobs.start();
  await first.files.upload({ owner: 'U1:V1', png: PNG, alt: ALT });
  await first.files.upload({ owner: 'U2:V2', png: PNG, alt: ALT });
  first.jobs.stop(); // the process stops before the files expire
  assert.equal(first.jobs.running(sweep.NAME), false);
  assert.equal(first.files.ready(), false);
  await clock.tick(30 * MIN);
  assert.deepEqual(slack.deleted, []);
  const second = processWith({ store: first.store, app: slack });
  second.jobs.start(); // its start-up run
  await flush();
  assert.deepEqual(slack.deleted, ['F1', 'F2']);
  assert.equal(second.store.mapFileCount(), 0);
  second.jobs.stop();
});

test('a sweep still running when the next is due skips that turn; a throwing sweep is logged and the next runs', async (t) => {
  const clock = freeze(t);
  const store = createStore();
  const log = quietLog();
  let release;
  const client = { files: { delete: () => new Promise((r) => { release = r; }) } };
  store.addMapFile('F1', 'o');
  await clock.tick(15 * MIN);
  const jobs = createEngineJobs({ names: [sweep.NAME], store, client, log });
  jobs.start();
  await clock.tick(5 * MIN);
  assert.deepEqual(log.lines.map((l) => l.msg), ['engine job skipped: still running']);
  release({ ok: true });
  await flush();
  assert.equal(store.mapFileCount(), 0);
  store.expiredMapFiles = () => { throw new Error('store broke'); };
  await clock.tick(5 * MIN);
  assert.ok(log.lines.some((l) => l.msg === 'engine job failed' && l.fields.job === 'sweep-map-files'));
  store.expiredMapFiles = () => [];
  await clock.tick(5 * MIN);
  jobs.stop();
});
