'use strict';

// kit/runtime/slack/image (Story 15.1, AD-R12, AD-R15): the map image is
// uploaded shared nowhere, with a fixed filename and title, shown by an image
// block with slack_file { id } and alt text from one fixed template, recorded
// in the store before it is shown, and deleted later. Also the Slack fake's
// rules for these calls (F10): it rejects what Slack rejects for every field
// the code sets, and accepts an upload with no channel, as Slack does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const image = require('../../kit/runtime/slack/image');
const { createStore } = require('../../kit/runtime/store');
const { FakeSlackApp, invalidImageBlocks, TRIGGER_MS } = require('../fixtures/fake-slack');

const PNG = fs.readFileSync(path.join(__dirname, '../fixtures/routing-map/test-pattern.png'));
const ALT = 'Route map: Test pattern, no crew, 0 stops';

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}
const slackError = (code) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });

test('the alt text comes from one fixed template, asserted as the exact string (F15)', () => {
  assert.equal(image.altText({ view: 'Change', crew: 'Crew 2', stops: 7 }), 'Route map: Change, Crew 2, 7 stops');
  assert.equal(image.altText({ view: 'Test pattern', crew: 'no crew', stops: 0 }), ALT);
  for (const bad of [
    { view: 'Change, 12 Elm St', crew: 'Crew 2', stops: 7 },
    { view: 'Change', crew: 'Crew\n2', stops: 7 },
    { view: '', crew: 'Crew 2', stops: 7 },
    { view: 'Change', crew: 'x'.repeat(61), stops: 7 },
    { view: 'Change', crew: 'Crew 2', stops: -1 },
    { view: 'Change', crew: 'Crew 2', stops: 1.5 },
    { view: 'Change', crew: 'Crew 2', stops: 10000 },
  ]) assert.throws(() => image.altText(bad), image.ImageError, JSON.stringify(bad));
  assert.equal(image.isAltText(ALT), true);
  for (const bad of ['Route map: a, b, c, 3 stops', 'Route map: a, b, 3 stop', 'Map: a, b, 3 stops', '45.123, -71.2', `${ALT} `, '', null]) {
    assert.equal(image.isAltText(bad), false, String(bad));
  }
});

test('uploadPng calls files.uploadV2 with no channel, filename route-map.png and title Route map, and returns the file id', async () => {
  const app = new FakeSlackApp({});
  const id = await image.uploadPng({ client: app.client, png: PNG });
  assert.equal(id, 'F1');
  assert.equal(app.uploads.length, 1);
  assert.deepEqual(Object.keys(app.uploads[0]).sort(), ['file', 'filename', 'title']);
  assert.equal(app.uploads[0].file, PNG);
  assert.equal(app.uploads[0].filename, 'route-map.png');
  assert.equal(app.uploads[0].title, 'Route map');
  for (const k of ['channel_id', 'channel', 'channels', 'initial_comment', 'thread_ts']) assert.ok(!(k in app.uploads[0]), k);
});

test('uploadPng refuses what is not a PNG under 1 MB before calling Slack, and an answer with no file id', async () => {
  const app = new FakeSlackApp({});
  const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(image.MAX_PNG_BYTES)]);
  for (const png of [Buffer.from('not a png at all'), big, 'string', null, PNG.subarray(0, 8)]) {
    await assert.rejects(image.uploadPng({ client: app.client, png }), image.ImageError);
  }
  assert.deepEqual(app.uploads, []);
  const client = { files: { uploadV2: async () => ({ ok: true, files: [{ files: [{ id: 'not-an-id' }] }] }) } };
  await assert.rejects(image.uploadPng({ client, png: PNG }), /no file id/);
  assert.equal(image.fileIdOf({ files: [{ files: [{ id: 'F9' }] }] }), 'F9');
  assert.equal(image.fileIdOf({ files: [{ id: 'F8' }] }), 'F8');
  assert.equal(image.fileIdOf(null), null);
});

test('the image block uses slack_file { id } and the alt text, never image_url', () => {
  const block = image.imageBlock({ id: 'F1', alt: ALT });
  assert.deepEqual(block, { type: 'image', slack_file: { id: 'F1' }, alt_text: ALT });
  assert.ok(!('image_url' in block));
  assert.throws(() => image.imageBlock({ id: 'https://x', alt: ALT }), /bad file id/);
  assert.throws(() => image.imageBlock({ id: 'F1', alt: 'free text' }), /fixed template/);
  assert.equal(invalidImageBlocks({ blocks: [block] }), null);
});

test('only the routing-map archetype and the dev-only map-check module may show an image (F6)', () => {
  const mod = (over) => ({ id: 'map-check', archetype: 'handler', environments: ['dev'], ...over });
  assert.equal(image.uploadsMapImages(mod()), true);
  assert.equal(image.uploadsMapImages({ id: 'routing', archetype: 'routing-map', environments: ['dev', 'prod'] }), true);
  assert.equal(image.uploadsMapImages(mod({ environments: ['dev', 'prod'] })), false);
  assert.equal(image.uploadsMapImages(mod({ environments: ['prod'] })), false);
  assert.equal(image.uploadsMapImages(mod({ id: 'echo' })), false);
  assert.equal(image.uploadsMapImages(mod({ archetype: 'scoped-pull' })), false);
  assert.equal(image.uploadsMapImages(null), false);
});

// --- the lifecycle -------------------------------------------------------------

function lifecycle({ sweeping = () => true } = {}) {
  const app = new FakeSlackApp({});
  const store = createStore();
  const log = quietLog();
  const files = image.createMapFiles({ store, client: app.client, log, sweeping });
  return { app, store, log, files };
}

test('upload records the file id in the store (15 minutes) before it returns the block to show', async () => {
  const { app, store, files } = lifecycle();
  const recordedAtUpload = [];
  const upload = app.client.files.uploadV2;
  app.client.files.uploadV2 = async (args) => {
    recordedAtUpload.push(store.mapFileCount());
    return upload(args);
  };
  const block = await files.upload({ owner: 'U1:V1', png: PNG, alt: ALT });
  assert.deepEqual(recordedAtUpload, [0]);
  assert.deepEqual(block, { type: 'image', slack_file: { id: 'F1' }, alt_text: ALT });
  assert.deepEqual(store.mapFilesOf('U1:V1'), ['F1']);
});

test('a free-text alt or a bad PNG is refused before anything is uploaded', async () => {
  const { app, files } = lifecycle();
  await assert.rejects(files.upload({ owner: 'o', png: PNG, alt: '12 Elm Street' }), /fixed template/);
  await assert.rejects(files.upload({ owner: 'o', png: Buffer.from('x'), alt: ALT }), /not a PNG/);
  assert.deepEqual(app.uploads, []);
});

test('a file that cannot be recorded is deleted at once and the upload fails', async () => {
  const { app, store, log, files } = lifecycle();
  store.addMapFile = () => { throw new Error('full'); };
  await assert.rejects(files.upload({ owner: 'o', png: PNG, alt: ALT }), /could not be recorded/);
  assert.deepEqual(app.deleted, ['F1']);
  assert.ok(log.lines.some((l) => l.msg === 'map file not recorded; deleting it now'));
});

test('ready() fails closed: no store, no Slack client that can upload and delete, or the sweep not running', () => {
  const app = new FakeSlackApp({});
  const store = createStore();
  const log = quietLog();
  assert.equal(image.createMapFiles({ store, client: app.client, log, sweeping: () => true }).ready(), true);
  assert.equal(image.createMapFiles({ store: null, client: app.client, log, sweeping: () => true }).ready(), false);
  assert.equal(image.createMapFiles({ store, client: null, log, sweeping: () => true }).ready(), false);
  assert.equal(image.createMapFiles({ store, client: { files: { uploadV2: async () => ({}) } }, log, sweeping: () => true }).ready(), false);
  assert.equal(image.createMapFiles({ store, client: app.client, log, sweeping: () => false }).ready(), false);
  assert.equal(image.createMapFiles({ store, client: app.client, log }).ready(), false);
  assert.equal(image.createMapFiles({ store: {}, client: app.client, log, sweeping: () => true }).ready(), false);
});

test('upload refuses when not ready, uploading nothing', async () => {
  const { app, files } = lifecycle({ sweeping: () => false });
  await assert.rejects(files.upload({ owner: 'o', png: PNG, alt: ALT }), /cannot be cleaned up/);
  assert.deepEqual(app.uploads, []);
});

test('release deletes the owner\'s files (all, all but keep, or only one); a failed delete keeps the record and logs Slack\'s code only', async () => {
  const { app, store, log, files } = lifecycle();
  await files.upload({ owner: 'A', png: PNG, alt: ALT });
  await files.upload({ owner: 'A', png: PNG, alt: ALT });
  await files.upload({ owner: 'A', png: PNG, alt: ALT });
  await files.upload({ owner: 'B', png: PNG, alt: ALT });
  assert.deepEqual(await files.release('A', { keep: 'F3' }), { deleted: 2, kept: 0 });
  assert.deepEqual(app.deleted, ['F1', 'F2']);
  assert.deepEqual(store.mapFilesOf('A'), ['F3']);
  app.deleteFail = slackError('ratelimited');
  assert.deepEqual(await files.release('A'), { deleted: 0, kept: 1 });
  assert.deepEqual(store.mapFilesOf('A'), ['F3']);
  const warn = log.lines.find((l) => l.msg === 'map file delete failed; kept for the next sweep');
  assert.deepEqual(warn.fields, { why: 'released', reason: 'ratelimited' });
  app.deleteFail = null;
  assert.deepEqual(await files.release('B', { only: 'F9' }), { deleted: 0, kept: 0 });
  assert.deepEqual(await files.release('B', { only: 'F4' }), { deleted: 1, kept: 0 });
  assert.deepEqual(await files.release('nobody'), { deleted: 0, kept: 0 });
});

test('a file Slack no longer has (file_not_found, file_deleted) loses its record', async () => {
  const { app, store, log } = lifecycle();
  store.addMapFile('F77', 'o');
  const res = await image.deleteMapFiles({ store, client: app.client, log, ids: ['F77'], why: 'expired' });
  assert.deepEqual(res, { deleted: 1, kept: 0 });
  assert.equal(store.mapFileCount(), 0);
  assert.deepEqual(log.lines.map((l) => [l.msg, l.fields.reason]), [['map file already gone', 'file_not_found']]);
});

test('nothing in the lifecycle logs the PNG, the alt text or a Slack payload', async () => {
  const { app, store, log, files } = lifecycle();
  await files.upload({ owner: 'o', png: PNG, alt: ALT });
  app.deleteFail = Object.assign(new Error('boom with details'), { data: { ok: false, error: 'internal_error', detail: ALT } });
  await files.release('o');
  store.addMapFile = () => { throw new Error('full'); };
  await assert.rejects(files.upload({ owner: 'o', png: PNG, alt: ALT }));
  const text = JSON.stringify(log.lines);
  assert.ok(!text.includes('Buffer'));
  assert.ok(!text.includes(PNG.toString('base64').slice(0, 40)));
  assert.ok(!text.includes('Route map'));
  assert.ok(!text.includes('boom with details'));
});

// --- the Slack fake rejects what Slack rejects (F10) -----------------------------

test('the fake: files.uploadV2 without content or filename is rejected; with no channel it is accepted', async () => {
  const app = new FakeSlackApp({});
  await assert.rejects(app.client.files.uploadV2({ filename: 'route-map.png' }), (e) => e.data.error === 'invalid_arguments');
  await assert.rejects(app.client.files.uploadV2({ file: PNG }), (e) => e.data.error === 'invalid_arguments');
  await assert.rejects(app.client.files.uploadV2({ file: Buffer.alloc(0), filename: 'a.png' }), (e) => e.data.error === 'invalid_arguments');
  const res = await app.client.files.uploadV2({ file: PNG, filename: 'route-map.png', title: 'Route map' });
  assert.equal(res.files[0].files[0].id, 'F1');
});

test('the fake: files.delete rejects an unknown id (file_not_found) and a second delete (file_deleted)', async () => {
  const app = new FakeSlackApp({});
  await app.client.files.uploadV2({ file: PNG, filename: 'route-map.png' });
  await assert.rejects(app.client.files.delete({ file: 'F99' }), (e) => e.data.error === 'file_not_found');
  await assert.rejects(app.client.files.delete({}), (e) => e.data.error === 'invalid_arguments');
  assert.deepEqual(await app.client.files.delete({ file: 'F1' }), { ok: true });
  await assert.rejects(app.client.files.delete({ file: 'F1' }), (e) => e.data.error === 'file_deleted');
  assert.deepEqual(app.deleted, ['F1']);
});

test('the fake: an image block with both image_url and slack_file, neither, no alt text or alt text over 2000 characters is rejected', async () => {
  const app = new FakeSlackApp({ views: true });
  const view = (block) => ({ type: 'modal', title: { type: 'plain_text', text: 'M' }, blocks: [block] });
  const good = { type: 'image', slack_file: { id: 'F1' }, alt_text: ALT };
  // Like Slack (Story 15.4, F10), the fake refuses a slack_file it never had.
  await assert.rejects(app.client.views.update({ view_id: 'V1', view: view(good) }), (e) => e.data.error === 'invalid_arguments');
  await app.client.files.uploadV2({ file: PNG, filename: 'route-map.png' });
  await app.client.views.update({ view_id: 'V1', view: view(good) });
  await app.client.views.update({ view_id: 'V1', view: view({ type: 'image', image_url: 'https://example.test/a.png', alt_text: 'a' }) });
  await app.client.views.update({ view_id: 'V1', view: view({ ...good, alt_text: 'x'.repeat(2000) }) });
  for (const bad of [
    { ...good, image_url: 'https://example.test/a.png' },
    { type: 'image', alt_text: ALT },
    { type: 'image', slack_file: {}, alt_text: ALT },
    { type: 'image', slack_file: { id: 'F1' } },
    { ...good, alt_text: '' },
    { ...good, alt_text: 'x'.repeat(2001) },
  ]) {
    await assert.rejects(app.client.views.update({ view_id: 'V1', view: view(bad) }), (e) => e.data.error === 'invalid_blocks', JSON.stringify(bad).slice(0, 80));
  }
});

test('the fake: views.open and views.push with a trigger over 3 seconds old answer expired_trigger_id', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T15:00:00Z') });
  const app = new FakeSlackApp({ views: true });
  const view = { type: 'modal', title: { type: 'plain_text', text: 'M' }, blocks: [] };
  const trigger = app.issueTrigger('T-1');
  t.mock.timers.tick(TRIGGER_MS);
  await app.client.views.push({ trigger_id: trigger, view });
  t.mock.timers.tick(1);
  for (const method of ['open', 'push']) {
    await assert.rejects(app.client.views[method]({ trigger_id: trigger, view }), (e) => e.data.error === 'expired_trigger_id', method);
  }
  // views.update takes a view id, not a trigger, so it is unaffected.
  await app.client.views.update({ view_id: 'V1', view });
  app.issueTrigger('T-2');
  app.expireTriggers();
  await assert.rejects(app.client.views.open({ trigger_id: 'T-2', view }), (e) => e.data.error === 'expired_trigger_id');
});

// --- Live check 2026-10-26: Slack does not accept a fresh file yet -----------------

const { notReadyError } = require('../fixtures/fake-slack');

test('fileNotReady matches exactly the real answer: invalid_arguments with an "invalid slack file" message on slack_file', () => {
  assert.equal(image.fileNotReady(notReadyError(1)), true);
  const other = (error, messages) => Object.assign(new Error('x'), { data: { ok: false, error, response_metadata: { messages } } });
  assert.equal(image.fileNotReady(other('invalid_blocks', ['[ERROR] invalid slack file [json-pointer:view/blocks/1/slack_file]'])), false);
  assert.equal(image.fileNotReady(other('invalid_arguments', ['[ERROR] must be a valid block [json-pointer:/view/blocks/0]'])), false);
  assert.equal(image.fileNotReady(other('invalid_arguments', [])), false);
  assert.equal(image.fileNotReady(Object.assign(new Error('x'), { data: { ok: false, error: 'invalid_arguments' } })), false);
  assert.equal(image.fileNotReady(new Error('invalid slack file slack_file')), false);
  assert.equal(image.fileNotReady(null), false);
});

test('slackMessages keeps at most 3 messages, 200 printable characters each', () => {
  const err = { data: { response_metadata: { messages: ['a\u0000b', 'x'.repeat(500), 'c', 'd', 7] } } };
  assert.deepEqual(image.slackMessages(err), ['ab', 'x'.repeat(200), 'c']);
  assert.deepEqual(image.slackMessages({}), []);
});

test('the fake answers a file not ready yet the way the real API did, for the first N views calls only', async () => {
  const app = new FakeSlackApp({ views: true });
  app.filesNotReadyFor = 1;
  const png = fs.readFileSync(path.join(__dirname, '../fixtures/routing-map/test-pattern.png'));
  await app.client.files.uploadV2({ file: png, filename: 'route-map.png', title: 'Route map' });
  const view = {
    type: 'modal', title: { type: 'plain_text', text: 'x' }, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'a' } }, { type: 'image', slack_file: { id: 'F1' }, alt_text: 'a' }],
  };
  await assert.rejects(app.client.views.update({ view_id: 'V1', view }), (e) => e.code === 'slack_webapi_platform_error'
    && e.data.error === 'invalid_arguments'
    && e.data.response_metadata.messages[0] === '[ERROR] invalid slack file [json-pointer:view/blocks/1/slack_file.id/slack_file]');
  await app.client.views.update({ view_id: 'V1', view });
});

test('showing: retries only a file not ready, waits 1, 2, 3, 4 s, then throws NotAccepted with the attempts', async () => {
  assert.deepEqual([...image.SHOW_DELAYS], [1000, 2000, 3000, 4000]);
  const store = createStore();
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const files = image.createMapFiles({ store, client: {}, log: {}, sleep });
  let n = 0;
  assert.equal(await files.showing(async () => { n += 1; if (n < 3) throw notReadyError(0); }), 3);
  assert.deepEqual(slept, [1000, 2000]);
  slept.length = 0;
  await assert.rejects(files.showing(async () => { throw notReadyError(0); }), (err) => err instanceof image.NotAccepted
    && err.attempts === 5 && err.reason === 'invalid_arguments' && err.messages.length === 1);
  assert.deepEqual(slept, [1000, 2000, 3000, 4000]);
  slept.length = 0;
  const boom = new Error('boom');
  await assert.rejects(files.showing(async () => { throw boom; }), (err) => err === boom);
  assert.deepEqual(slept, []);
  const custom = image.createMapFiles({ store, client: {}, log: {}, showDelays: [5], sleep });
  await assert.rejects(custom.showing(async () => { throw notReadyError(0); }), (err) => err.attempts === 2);
  assert.deepEqual(slept, [5]);
});
