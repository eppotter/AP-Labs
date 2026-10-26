'use strict';

// PR #222 review (Story 15.1, fail closed): an image is honoured only on the
// map lifecycle, a map module's reply from Open (runtime-hubs.test.js covers
// that path). Every other way a message reaches the person refuses a message
// carrying an image: the plain error is shown, the refusal is logged without
// the PNG, nothing is uploaded and no Slack call carries the bytes. Each path
// gets a test here: a form click, "How was this made?" and its Back, an
// approval click, a form and an answer submit, a form's open from the menu,
// the ephemeral reply path, and the renderers' own backstop.
//
// The archetypes here are stand-ins that answer every step with an image, so
// the hub's own screening is what is tested. They are swapped in before the
// hub module loads (node:test runs each file in its own process).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scopedPull = require('../../kit/runtime/archetypes/scoped-pull');
const approvalWrite = require('../../kit/runtime/archetypes/approval-write');

const PNG = fs.readFileSync(path.join(__dirname, '../fixtures/routing-map/test-pattern.png'));
const ALT = 'Route map: Test pattern, no crew, 0 stops';
const withImage = () => ({ text: 'look', image: { png: PNG, alt: ALT } });

const HUBS = require.resolve('../../kit/runtime/slack/hubs');
assert.ok(!require.cache[HUBS], 'the hub module loads after the stand-ins');
scopedPull.createScopedPull = () => ({
  open: () => withImage(),
  submit: () => ({ message: withImage() }),
  answer: () => ({ message: withImage() }),
  click: async ({ show }) => { await show(withImage()); },
  details: async ({ show }) => { await show(withImage()); },
  back: async ({ show }) => { await show(withImage()); },
});
approvalWrite.createApprovalWrite = () => ({ click: async ({ show }) => { await show(withImage()); } });

const { registerHubs } = require('../../kit/runtime/slack/hubs');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry, createRegistry } = require('../../kit/runtime/registry');
const { PLAIN_ERROR } = require('../../kit/runtime/slack/handle');
const { createStore } = require('../../kit/runtime/store');
const { createMapFiles, ImageError } = require('../../kit/runtime/slack/image');
const { messageBlocks, pushedView, updatedView } = require('../../kit/runtime/slack/modal');
const { messageParts } = require('../../kit/runtime/slack/format');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime');
const profile = loadProfile(path.join(FIX, 'profile.yml'));
const { registry } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

const pull = Object.freeze({
  id: 'pull', hub: 'alpha', label: 'Pull', description: 'd', resource: 'R', archetype: 'scoped-pull', environments: ['dev'],
});
const sneaky = Object.freeze({
  id: 'sneaky', hub: 'alpha', label: 'Sneaky', description: 'd', resource: 'R', archetype: 'handler', environments: ['dev'],
  run: async ({ reply }) => reply(withImage()),
});

// The hubs with a working map-file lifecycle, so a refusal is not just a
// missing lifecycle.
function setup({ views = true } = {}) {
  const app = new FakeSlackApp({ views });
  const log = quietLog();
  const store = createStore();
  const mapFiles = createMapFiles({ store, client: app.client, log, sweeping: () => true });
  registerHubs(app, {
    registry: createRegistry({ hubs: registry.hubs, modules: [pull, sneaky] }), profile, env: 'dev', log, store, canUse: () => true, mapFiles,
  });
  return { app, log, store };
}

const MODULE_VIEW = Object.freeze({
  id: 'VMOD', type: 'modal', hash: 'h1', title: { type: 'plain_text', text: 'Pull' }, private_metadata: 'alpha',
});
const MENU_VIEW = Object.freeze({ id: 'VMENU', type: 'modal', private_metadata: 'alpha' });
const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const viewTexts = (view) => view.blocks.map((b) => (b.text && b.text.text) || (b.elements && b.elements[0].text));

// Nothing uploaded, nothing recorded, no image or bytes in any Slack call or
// log line, and the refusal logged where it happened.
function assertRefused({ app, log, store }, where) {
  assert.deepEqual(app.uploads, [], where);
  assert.equal(store.mapFileCount(), 0, where);
  const b64 = PNG.toString('base64').slice(0, 60);
  for (const text of [JSON.stringify(app.views), JSON.stringify(app.responded), JSON.stringify(app.viewAcks), JSON.stringify(log.lines)]) {
    assert.ok(!text.includes('Buffer'), where);
    assert.ok(!text.includes(b64), where);
    assert.ok(!text.includes('"image"'), where);
  }
  assert.deepEqual(app.posted, [], where);
  assert.deepEqual(app.dms, [], where);
  const refused = log.lines.filter((l) => l.msg === 'image refused');
  assert.deepEqual(refused.map((l) => l.fields), [{ where, reason: 'not on the map view path' }], where);
}

test('a form click (Confirm, Change, Read my request) whose result carries an image: the plain error in the view, nothing uploaded', async () => {
  for (const verb of ['confirm', 'change', 'read']) {
    const ctx = setup();
    await ctx.app.dispatchAction(`scoped-pull:${verb}`, { view: MODULE_VIEW, value: 's1' });
    const updates = calls(ctx.app, 'update');
    assert.equal(updates.length, 1, verb);
    assert.equal(updates[0].view_id, 'VMOD', verb);
    assert.deepEqual(viewTexts(updates[0].view), [PLAIN_ERROR], verb);
    assertRefused(ctx, 'form');
  }
});

test('"How was this made?" and its Back, carrying an image: the plain error in the view, nothing uploaded', async () => {
  for (const id of ['provenance:show', 'provenance:back']) {
    const ctx = setup();
    await ctx.app.dispatchAction(id, { view: MODULE_VIEW, value: 'r1' });
    const updates = calls(ctx.app, 'update');
    assert.equal(updates.length, 1, id);
    assert.deepEqual(viewTexts(updates[0].view), [PLAIN_ERROR], id);
    assertRefused(ctx, 'provenance');
  }
});

test('an approval click (Push, Approve, Cancel, Retry) carrying an image: the plain error in the view, nothing uploaded', async () => {
  for (const verb of ['push', 'approve', 'cancel', 'retry']) {
    const ctx = setup();
    await ctx.app.dispatchAction(`approval-write:${verb}`, { view: MODULE_VIEW, value: 'p1' });
    const updates = calls(ctx.app, 'update');
    assert.equal(updates.length, 1, verb);
    assert.deepEqual(viewTexts(updates[0].view), [PLAIN_ERROR], verb);
    assertRefused(ctx, 'approval');
  }
});

test('a form submit and a follow-up answer carrying an image: the ack shows the plain error, nothing uploaded', async () => {
  for (const [callback, step] of [['scoped-pull:form', 'submit'], ['scoped-pull:answer', 'answer']]) {
    const ctx = setup();
    await ctx.app.dispatchView(callback, { view: { ...MODULE_VIEW, private_metadata: 'alpha:s1' } });
    const [ack] = ctx.app.viewAcks;
    assert.equal(ack.response_action, 'update', callback);
    assert.deepEqual(viewTexts(ack.view), [PLAIN_ERROR], callback);
    assertRefused(ctx, `form-${step}`);
  }
});

test('a form opened from the menu (Open on a scoped pull) carrying an image: the plain error in the pushed view, nothing uploaded', async () => {
  const ctx = setup();
  await ctx.app.dispatchAction('pull:open', { view: MENU_VIEW });
  const [push] = calls(ctx.app, 'push');
  assert.deepEqual(viewTexts(push.view), [PLAIN_ERROR]);
  assert.ok(!('notify_on_close' in push.view));
  assertRefused(ctx, 'open');
});

test('the ephemeral path (a click on an old message menu): an image from a module that may not show one is refused, never sent', async () => {
  const ctx = setup({ views: false });
  await ctx.app.dispatchAction('sneaky:open');
  assert.deepEqual(ctx.app.responded.map((r) => r.text), [PLAIN_ERROR]);
  assert.deepEqual(ctx.app.uploads, []);
  assert.ok(!JSON.stringify(ctx.app.responded).includes('"image"'));
  assert.ok(ctx.log.lines.some((l) => l.msg === 'image refused' && l.fields.module === 'sneaky'));
});

test('backstop: the renderers throw a fixed-text ImageError on an image and make no Slack call', async () => {
  const msg = withImage();
  assert.throws(() => messageBlocks(msg), ImageError);
  assert.throws(() => messageParts(msg), ImageError);
  assert.throws(() => messageParts({ text: 'x', ephemeralFallback: msg }), ImageError);
  try {
    messageParts(msg);
  } catch (err) {
    assert.equal(err.message, 'map image refused: not on the map view path');
  }
  const app = new FakeSlackApp({ views: true });
  const pushed = pushedView({ client: app.client, triggerId: app.issueTrigger('T1'), title: 'X', hubId: 'alpha' });
  await assert.rejects(pushed.show(msg), ImageError);
  const updated = updatedView({ client: app.client, view: MODULE_VIEW, title: 'X', hubId: 'alpha' });
  await assert.rejects(updated.show(msg), ImageError);
  assert.deepEqual(app.views, []);
  assert.deepEqual(app.uploads, []);
  // A message without an image still renders.
  assert.equal(messageBlocks({ text: 'fine' })[0].text.text, 'fine');
  assert.deepEqual(messageParts({ text: 'fine' }), [{ text: 'fine' }]);
});
