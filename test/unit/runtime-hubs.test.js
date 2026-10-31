'use strict';

// kit/runtime/slack/hubs + registry/menu: a hub's slash command opens a modal
// menu built from the fixture entries; an Open click is acked, re-checked and
// dispatched to the module's handler, whose replies render in a pushed view.
// Without a views client, after a failed views.open, or for a click on an old
// message menu, the hub falls back to the private (ephemeral) replies: the
// tests below that use setup() without views cover that path unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry } = require('../../kit/runtime/registry');
const { buildMenu, moduleIdFromAction, hubIdFromHelpAction } = require('../../kit/runtime/registry/menu');
const { registerHubs, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const {
  modalTitle, limitBlocks, LOADING,
} = require('../../kit/runtime/slack/modal');
const { createRegistry } = require('../../kit/runtime/registry');
const { PLAIN_ERROR } = require('../../kit/runtime/slack/handle');
const { createStore } = require('../../kit/runtime/store');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime');
const profile = loadProfile(path.join(FIX, 'profile.yml'));
const { registry } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function setup({ env = 'dev', canUse, views = false, reg = registry } = {}) {
  const app = new FakeSlackApp({ views });
  const log = quietLog();
  registerHubs(app, { registry: reg, profile, env, log, store: createStore(), ...(canUse ? { canUse } : {}) });
  return { app, log };
}

// The Open buttons, in menu order (the Help button is checked on its own).
const buttons = (msg) => msg.blocks.filter((b) => b.accessory && /:open$/.test(b.accessory.action_id)).map((b) => b.accessory.action_id);

test('each hub file registers its slash command; one listener each handles Open, Help, form, "How was this made?" (and Back), push, routing-map, Add context\'s Remove, build-request, Ask and Why? clicks', () => {
  const { app } = setup();
  assert.deepEqual([...app.commandListeners.keys()], ['/alpha', '/beta']);
  assert.equal(app.actionListeners.length, 10);
  // Why? on a waiting menu row (Story 17.3), last: <module-id>:why, which
  // no other listener's pattern takes, and which takes no other click.
  const why = app.actionListeners[9].pattern;
  assert.ok(why.test('echo:why'));
  for (const id of ['echo:open', 'alpha:help', 'echo:whyx', 'Echo:why', ':why']) assert.ok(!why.test(id), id);
  for (const { pattern } of app.actionListeners.slice(0, 9)) {
    assert.ok(!(pattern instanceof RegExp ? pattern.test('echo:why') : pattern === 'echo:why'), String(pattern));
  }
  app.actionListeners.pop();
  // Ask another and Build request on an Ask answer (Story 16.7), last.
  for (const id of ['ask:again', 'ask:build-request']) assert.ok(app.actionListeners[8].pattern.test(id), id);
  assert.ok(!app.actionListeners[8].pattern.test('ask:open'));
  app.actionListeners.pop();
  // Remove on an Add context entry (Story 16.5), then Post, Edit and Cancel
  // on a build request's preview (Story 16.6), registered last.
  assert.equal(app.actionListeners[6].pattern, 'add-context:remove');
  for (const id of ['build-request:post', 'build-request:edit', 'build-request:cancel']) assert.ok(app.actionListeners[7].pattern.test(id), id);
  assert.ok(!app.actionListeners[7].pattern.test('build-request:open'));
  app.actionListeners.pop();
  // A routing map's view, day, crew and zone selects (Story 15.4).
  for (const id of ['routing-map:view', 'routing-map:day', 'routing-map:crew', 'routing-map:zone']) assert.ok(app.actionListeners[2].pattern.test(id), id);
  assert.ok(!app.actionListeners[2].pattern.test('routing-map:open'));
  app.actionListeners.splice(2, 1);
  // The form listener takes Confirm, Change and Read my request (Story 9.4).
  for (const id of ['scoped-pull:confirm', 'scoped-pull:change', 'scoped-pull:read']) assert.ok(app.actionListeners[2].pattern.test(id), id);
  // "How was this made?" and its details' "Back to the list".
  for (const id of ['provenance:show', 'provenance:back']) assert.ok(app.actionListeners[3].pattern.test(id), id);
  assert.ok(!app.actionListeners[3].pattern.test('provenance:showx'));
  // Push, Approve and Cancel on an approval-write result (Story 10.2).
  for (const id of ['approval-write:push', 'approval-write:approve', 'approval-write:cancel']) assert.ok(app.actionListeners[4].pattern.test(id), id);
  assert.ok(!app.actionListeners[4].pattern.test('approval-write:open'));
  // A map view's view_closed (Story 15.1), then four submits: the form's
  // "Check values", a follow-up question's answer (Story 9.4), Add
  // context's Add (Story 16.5) and a build request's Preview (Story 16.6).
  assert.deepEqual(app.viewListeners.map((v) => v.callbackId), [
    { callback_id: 'hub:map', type: 'view_closed' }, 'scoped-pull:form', 'scoped-pull:answer', 'add-context:submit', 'build-request:form', 'ask:form',
  ]);
  assert.deepEqual([...app.eventListeners.keys()], ['team_join']);
});

test('fallback (no views client): the hub command replies privately with the hub\'s visible entries, each its label and verb (the description is in Help, D1)', async () => {
  const { app } = setup();
  await app.dispatchCommand('/alpha', { user_id: 'U1' });
  assert.equal(app.acks, 1);
  assert.equal(app.responded.length, 1);
  const [menu] = app.responded;
  assert.equal(menu.response_type, 'ephemeral');
  assert.equal(menu.blocks[0].type, 'header');
  assert.equal(menu.blocks[0].text.text, 'Alpha tools');
  // prod-only is hidden in dev; boom belongs to beta.
  assert.deepEqual(buttons(menu), ['echo:open', 'second:open']);
  const echo = menu.blocks.find((b) => b.block_id === 'entry:echo');
  // U1 is not in the profile: the label and the verb, no status line (D4).
  assert.equal(echo.text.text, '*Echo*');
  assert.equal(echo.accessory.text.text, 'Run');
  assert.match(menu.text, /Alpha tools: Echo, Second/);
});

test('in prod the prod-only entry shows and the dev-only one does not', async () => {
  const { app } = setup({ env: 'prod' });
  await app.dispatchCommand('/alpha');
  await app.dispatchCommand('/beta');
  assert.deepEqual(buttons(app.responded[0]), ['echo:open', 'prod-only:open', 'second:open']);
  assert.deepEqual(buttons(app.responded[1]), []);
  assert.ok(app.responded[1].blocks.some((b) => b.type === 'section' && /Nothing is available/.test(b.text.text)));
});

test('a click is acked, runs the module handler, and the reply is private with the person and client names', async () => {
  const { app, log } = setup();
  app.users.U7 = { real_name: 'Real Seven', profile: { display_name: 'Sev', real_name: 'Real Seven' } };
  const ran = await app.dispatchAction('echo:open', { user: { id: 'U7', name: 'u7' } });
  assert.equal(ran, 1);
  assert.equal(app.acks, 1);
  assert.deepEqual(app.responded, [{
    response_type: 'ephemeral',
    replace_original: false,
    text: 'echo for Sev (U7) at Tiny from echo',
  }]);
  assert.ok(log.lines.some((l) => l.msg === 'module dispatched' && l.fields.module === 'echo'));
});

test('a handler may reply with blocks', async () => {
  const { app } = setup();
  await app.dispatchAction('second:open');
  assert.equal(app.responded[0].blocks[0].text.text, 'second');
  assert.equal(app.responded[0].response_type, 'ephemeral');
});

test('when users.info fails, the payload name is used; with no name, a mention', async () => {
  const { app, log } = setup();
  await app.dispatchAction('echo:open', { user: { id: 'U8', name: 'eight' } });
  await app.dispatchAction('echo:open', { user: { id: 'U9' } });
  assert.match(app.responded[0].text, /^echo for eight \(U8\)/);
  assert.match(app.responded[1].text, /^echo for <@U9> \(U9\)/);
  assert.ok(log.lines.some((l) => l.level === 'warn' && /users.info failed/.test(l.msg)));
});

test('a hidden entry\'s action is refused at dispatch, and its handler never runs', async () => {
  const { app, log } = setup({ env: 'dev' });
  await app.dispatchAction('prod-only:open');
  assert.equal(app.acks, 1);
  assert.deepEqual(app.responded.map((r) => r.text), [NOT_AVAILABLE]);
  const refused = log.lines.find((l) => l.msg === 'hub action refused');
  assert.equal(refused.fields.reason, 'hidden in this environment');
});

test('an unknown action id is acked and refused plainly', async () => {
  const { app, log } = setup();
  await app.dispatchAction('ghost:open');
  assert.equal(app.acks, 1);
  assert.deepEqual(app.responded.map((r) => r.text), [NOT_AVAILABLE]);
  assert.equal(log.lines.find((l) => l.msg === 'hub action refused').fields.reason, 'unknown module');
  // Not an Open action at all: no hub listener matches it.
  assert.equal(await app.dispatchAction('echo:delete'), 0);
  assert.equal(moduleIdFromAction('Echo:open'), null);
  assert.equal(moduleIdFromAction(undefined), null);
});

test('a handler that throws gives the person the plain error, never its text', async () => {
  const { app, log } = setup();
  await app.dispatchAction('boom:open');
  assert.equal(app.responded.length, 1);
  assert.equal(app.responded[0].text, PLAIN_ERROR);
  assert.ok(!JSON.stringify(app.responded).includes('internal detail'));
  assert.ok(log.lines.some((l) => l.msg === 'handler failed' && l.fields.handler === 'hub:dispatch'));
});

test('the access seam filters the menu and refuses at dispatch', async () => {
  const canUse = (person, mod) => !(person.id === 'U2' && mod.id === 'echo');
  const { app } = setup({ canUse });
  await app.dispatchCommand('/alpha', { user_id: 'U2' });
  assert.deepEqual(buttons(app.responded[0]), ['second:open']);
  await app.dispatchAction('echo:open', { user: { id: 'U2' } });
  // U2 is not in this profile, so the refusal says so (Story 6.3).
  assert.match(app.responded[1].text, /^You're not set up in Tiny's bot yet/);
  await app.dispatchAction('echo:open', { user: { id: 'U3', name: 'three' } });
  assert.match(app.responded[2].text, /^echo for three/);
});

test('by default access asks kit/lib/permissions, so open-access modules are allowed for anyone', async () => {
  const { app } = setup();
  await app.dispatchCommand('/alpha', { user_id: 'UNKNOWN' });
  assert.deepEqual(buttons(app.responded[0]), ['echo:open', 'second:open']);
});

test('buildMenu: rows become sections under their group, each with its verb as the button; the action id is still <id>:open (D1, D10)', () => {
  const hub = { id: 'h', name: 'H' };
  const entry = {
    id: 'a-b', label: 'A', description: 'd', archetype: 'handler',
  };
  const { text, blocks } = buildMenu(hub, [{ entry, status: { key: 'ready', detail: null }, verb: 'Run' }]);
  assert.equal(text, 'H: A');
  assert.deepEqual(blocks[1], { type: 'header', block_id: 'group:0', text: { type: 'plain_text', text: 'Tools', emoji: false } });
  assert.deepEqual(blocks[2].accessory, {
    type: 'button', action_id: 'a-b:open', value: 'a-b', text: { type: 'plain_text', text: 'Run', emoji: false },
  });
  assert.equal(blocks[2].text.text, '*A*\n✓ Ready');
  // With no verb given, the module's menu verb.
  assert.equal(buildMenu(hub, [{ entry, status: null }]).blocks[2].accessory.text.text, 'Run');
});

// --- modals ----------------------------------------------------------------

const MENU_VIEW = { id: 'VMENU', type: 'modal', private_metadata: 'alpha' };
const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const viewTexts = (view) => view.blocks.map((b) => (b.text && b.text.text) || (b.elements && b.elements[0].text));
const fallbacks = (log) => log.lines.filter((l) => l.msg === 'hub modal fallback');
const handlerModule = (id, run) => Object.freeze({
  id, hub: 'alpha', label: id, description: 'd', resource: 'R', archetype: 'handler', environments: ['dev'], run,
});

test('the hub command opens a modal with the menu: hub title, the same blocks, Close and no Submit', async () => {
  const { app, log } = setup({ views: true });
  await app.dispatchCommand('/alpha', { user_id: 'U1' });
  assert.equal(app.acks, 1);
  assert.deepEqual(app.responded, []);
  const [open] = calls(app, 'open');
  assert.equal(open.trigger_id, 'T-command');
  const { view } = open;
  assert.equal(view.type, 'modal');
  assert.deepEqual(view.title, { type: 'plain_text', text: 'Alpha tools', emoji: false });
  assert.equal(view.close.text, 'Close');
  assert.equal(view.submit, undefined);
  assert.deepEqual(buttons(view), ['echo:open', 'second:open']);
  // The same blocks as the ephemeral menu, escaping included.
  const fallback = setup();
  await fallback.app.dispatchCommand('/alpha', { user_id: 'U1' });
  assert.deepEqual(view.blocks, fallback.app.responded[0].blocks);
  assert.equal(view.blocks.find((b) => b.block_id === 'entry:echo').text.text, '*Echo*');
  assert.equal(view.blocks.at(-1).accessory.action_id, 'alpha:help');
  assert.deepEqual(fallbacks(log), []);
});

test('the modal keeps no person data: private_metadata is the hub id only', async () => {
  const { app } = setup({ views: true });
  await app.dispatchCommand('/alpha', { user_id: 'USECRET' });
  const { view } = calls(app, 'open')[0];
  assert.equal(view.private_metadata, 'alpha');
  assert.ok(!JSON.stringify(view).includes('USECRET'));
});

test('Open inside the modal pushes "Loading…", then updates that view with the module\'s reply', async () => {
  const { app, log } = setup({ views: true });
  app.users.U7 = { profile: { display_name: 'Sev' } };
  await app.dispatchAction('echo:open', { user: { id: 'U7' }, view: MENU_VIEW });
  assert.equal(app.acks, 1);
  assert.deepEqual(app.views.map((v) => v.method), ['push', 'update']);
  const [push] = calls(app, 'push');
  assert.equal(push.trigger_id, 'T-action');
  assert.equal(push.view.title.text, 'Echo');
  assert.equal(push.view.close.text, 'Back');
  assert.equal(push.view.submit, undefined);
  assert.equal(push.view.private_metadata, 'alpha');
  assert.deepEqual(viewTexts(push.view), [LOADING]);
  const [update] = calls(app, 'update');
  assert.equal(update.view_id, 'V1');
  assert.equal(update.hash, 'h1');
  assert.deepEqual(viewTexts(update.view), ['echo for Sev (U7) at Tiny from echo']);
  assert.ok(log.lines.some((l) => l.msg === 'module dispatched' && l.fields.module === 'echo'));
  assert.deepEqual(fallbacks(log), []);
});

test('a module reply with blocks renders those blocks in the view', async () => {
  const { app } = setup({ views: true });
  await app.dispatchAction('second:open', { view: MENU_VIEW });
  const [update] = calls(app, 'update');
  assert.deepEqual(update.view.blocks, [{ type: 'section', text: { type: 'mrkdwn', text: 'second' } }]);
});

test('several replies append in order, each update carrying the latest hash', async () => {
  const many = handlerModule('many', async ({ reply }) => { await reply('one'); await reply('two &amp; three'); });
  const { app } = setup({ views: true, reg: createRegistry({ hubs: registry.hubs, modules: [many] }), canUse: () => true });
  await app.dispatchAction('many:open', { view: MENU_VIEW });
  const updates = calls(app, 'update');
  assert.deepEqual(updates.map((u) => u.hash), ['h1', 'h2']);
  assert.deepEqual(viewTexts(updates[0].view), ['one']);
  assert.deepEqual(viewTexts(updates[1].view), ['one', 'two &amp; three']);
});

test('Help inside the modal pushes a Help view with the person\'s entries', async () => {
  const { app } = setup({ views: true });
  await app.dispatchAction('alpha:help', { view: MENU_VIEW });
  assert.deepEqual(app.views.map((v) => v.method), ['push']);
  const { view } = calls(app, 'push')[0];
  assert.equal(view.title.text, 'Help: Alpha tools');
  assert.equal(view.close.text, 'Back');
  assert.match(view.blocks.find((b) => b.block_id === 'help:modules').text.text, /\*Echo\*/);
  assert.deepEqual(app.responded, []);
});

test('a refusal, an unknown option and a failing handler render in the modal, never by respond', async () => {
  const canUse = (person, mod) => mod.id !== 'echo';
  const { app, log } = setup({ views: true, canUse });
  await app.dispatchAction('echo:open', { user: { id: 'U2' }, view: MENU_VIEW });
  await app.dispatchAction('prod-only:open', { view: MENU_VIEW });
  await app.dispatchAction('boom:open', { view: MENU_VIEW });
  const pushes = calls(app, 'push');
  assert.match(viewTexts(pushes[0].view)[0], /^You're not set up in Tiny's bot yet/);
  assert.deepEqual(viewTexts(pushes[1].view), [NOT_AVAILABLE]);
  assert.equal(pushes[1].view.private_metadata, '');
  assert.deepEqual(viewTexts(pushes[2].view), [LOADING]);
  const [update] = calls(app, 'update');
  assert.deepEqual(viewTexts(update.view), [PLAIN_ERROR]);
  assert.ok(!JSON.stringify(app.views).includes('internal detail'));
  assert.ok(log.lines.some((l) => l.msg === 'handler failed' && l.fields.handler === 'hub:dispatch'));
  assert.deepEqual(app.responded, []);
});

test('when views.open fails, the command falls back to the ephemeral menu and logs it once without person data', async () => {
  const { app, log } = setup({ views: true });
  app.viewsFail.open = Object.assign(new Error('An API error occurred: expired_trigger_id'), {
    code: 'slack_webapi_platform_error', data: { ok: false, error: 'expired_trigger_id' },
  });
  await app.dispatchCommand('/alpha', { user_id: 'U1' });
  assert.equal(app.responded.length, 1);
  assert.equal(app.responded[0].response_type, 'ephemeral');
  assert.deepEqual(buttons(app.responded[0]), ['echo:open', 'second:open']);
  const fb = fallbacks(log);
  assert.equal(fb.length, 1);
  assert.equal(fb[0].level, 'info');
  assert.deepEqual(fb[0].fields, { where: 'command', reason: 'expired_trigger_id', hub: 'alpha' });
});

test('a click on an old ephemeral menu message still replies ephemerally as before', async () => {
  const { app, log } = setup({ views: true });
  await app.dispatchAction('echo:open', { user: { id: 'U8', name: 'eight' } });
  await app.dispatchAction('alpha:help');
  assert.deepEqual(app.views, []);
  assert.match(app.responded[0].text, /^echo for eight \(U8\)/);
  assert.equal(app.responded[0].response_type, 'ephemeral');
  assert.match(app.responded[1].text, /^Help for Alpha tools/);
  assert.deepEqual(fallbacks(log).map((l) => l.fields), [
    { where: 'open', reason: 'not from a modal', hub: 'alpha' },
    { where: 'help', reason: 'not from a modal', hub: 'alpha' },
  ]);
});

test('if the first push fails and Slack gave a response_url, the click falls back to ephemeral', async () => {
  const { app, log } = setup({ views: true });
  app.viewsFail.push = Object.assign(new Error('x'), { data: { error: 'expired_trigger_id' } });
  const open = app.actionListeners.find(({ pattern }) => pattern.test('echo:open')).fn;
  const responded = [];
  await open({
    action: { action_id: 'echo:open' },
    body: { user: { id: 'U8', name: 'eight' }, view: MENU_VIEW, container: { type: 'view' }, trigger_id: 'T' },
    ack: async () => {},
    respond: async (m) => { responded.push(m); },
    client: app.client,
  });
  assert.equal(responded.length, 1);
  assert.match(responded[0].text, /^echo for eight/);
  assert.deepEqual(fallbacks(log).map((l) => l.fields), [{ where: 'open', reason: 'expired_trigger_id', hub: 'alpha' }]);
});

// #114: a click inside a modal has no response_url, so a failed push used to
// leave the person with nothing. The reply now replaces the view the click
// came from.
const expired = () => Object.assign(new Error('x'), { data: { error: 'expired_trigger_id' } });
const MENU_WITH_HASH = { ...MENU_VIEW, hash: 'hmenu' };

test('if the first push fails inside a modal (no response_url), the reply updates the view the click came from, and the fallback is logged', async () => {
  const { app, log } = setup({ views: true });
  app.users.U7 = { profile: { display_name: 'Sev' } };
  app.viewsFail.push = expired();
  await app.dispatchAction('echo:open', { user: { id: 'U7' }, view: MENU_WITH_HASH });
  assert.deepEqual(app.views.map((v) => v.method), ['push', 'update']);
  const [update] = calls(app, 'update');
  assert.equal(update.view_id, 'VMENU');
  assert.equal(update.hash, 'hmenu');
  assert.equal(update.view.title.text, 'Echo');
  assert.equal(update.view.private_metadata, 'alpha');
  assert.deepEqual(viewTexts(update.view), ['echo for Sev (U7) at Tiny from echo']);
  assert.deepEqual(app.responded, []);
  assert.deepEqual(fallbacks(log).map((l) => l.fields), [{ where: 'open', reason: 'expired_trigger_id', hub: 'alpha', via: 'views.update' }]);
  assert.ok(!log.lines.some((l) => l.msg === 'could not tell the person about a failure'));
});

test('after an in-place fallback, later replies append below the first, each with the latest hash', async () => {
  const many = handlerModule('many', async ({ reply }) => { await reply('one'); await reply('two'); });
  const { app } = setup({ views: true, reg: createRegistry({ hubs: registry.hubs, modules: [many] }), canUse: () => true });
  app.viewsFail.push = expired();
  await app.dispatchAction('many:open', { view: MENU_WITH_HASH });
  const updates = calls(app, 'update');
  assert.deepEqual(updates.map((u) => u.view_id), ['VMENU', 'VMENU']);
  assert.deepEqual(updates.map((u) => u.hash), ['hmenu', 'h1']);
  assert.deepEqual(viewTexts(updates[0].view), ['one']);
  assert.deepEqual(viewTexts(updates[1].view), ['one', 'two']);
});

test('a refusal, Help and a failing handler reach the person in place when the push fails inside a modal', async () => {
  const canUse = (person, mod) => mod.id !== 'echo';
  const { app, log } = setup({ views: true, canUse });
  app.viewsFail.push = expired();
  await app.dispatchAction('echo:open', { user: { id: 'U2' }, view: MENU_WITH_HASH });
  await app.dispatchAction('alpha:help', { view: MENU_WITH_HASH });
  await app.dispatchAction('boom:open', { view: MENU_WITH_HASH });
  const updates = calls(app, 'update');
  assert.equal(updates.length, 3);
  assert.match(viewTexts(updates[0].view)[0], /^You're not set up in Tiny's bot yet/);
  assert.equal(updates[1].view.title.text, 'Help: Alpha tools');
  assert.ok(updates[1].view.blocks.some((b) => b.block_id === 'help:modules'));
  // The failing handler: "Loading…" could not be pushed, so nothing shows
  // until the plain error replaces the menu.
  assert.deepEqual(viewTexts(updates[2].view), [PLAIN_ERROR]);
  assert.ok(!JSON.stringify(app.views).includes('internal detail'));
  assert.deepEqual(app.responded, []);
  assert.deepEqual(fallbacks(log).map((l) => l.fields.via), ['views.update', 'views.update', 'views.update']);
  assert.ok(!log.lines.some((l) => l.msg === 'could not tell the person about a failure'));
});

test('when the in-place update fails too, the failure is logged and nothing throws', async () => {
  const { app, log } = setup({ views: true });
  app.viewsFail.push = expired();
  app.viewsFail.update = Object.assign(new Error('y'), { data: { error: 'not_found' } });
  await app.dispatchAction('echo:open', { view: MENU_WITH_HASH });
  // #166: the failed update is logged (Slack's code only) and the handler goes on.
  const failed = log.lines.filter((l) => l.msg === 'in-place reply failed');
  assert.deepEqual(failed.map((l) => l.fields), [{ where: 'open', reason: 'not_found', hub: 'alpha' }]);
  assert.deepEqual(app.responded, []);
});

test('#166: once the in-place fallback is chosen, a failed update is logged and later replies still go in place', async () => {
  let app;
  let finished = false;
  const many = handlerModule('many', async ({ reply }) => {
    await reply('one');
    app.viewsFail.update = null; // Slack recovers
    await reply('two');
    finished = true;
  });
  const s = setup({ views: true, reg: createRegistry({ hubs: registry.hubs, modules: [many] }), canUse: () => true });
  app = s.app;
  app.viewsFail.push = expired();
  app.viewsFail.update = Object.assign(new Error('y'), { data: { error: 'not_found' } });
  await app.dispatchAction('many:open', { view: MENU_WITH_HASH });
  assert.equal(finished, true, 'the handler kept going after the failed update');
  const updates = calls(app, 'update');
  assert.equal(updates.length, 2, 'the failed update, then the one that landed');
  assert.deepEqual(viewTexts(updates[1].view), ['two']);
  assert.equal(s.log.lines.filter((l) => l.msg === 'in-place reply failed').length, 1);
  assert.ok(!s.log.lines.some((l) => l.msg === 'handler failed'));
});

test('a menu over 100 blocks keeps Help at the end with a "more…" note; long titles are cut to 24', async () => {
  const modules = Array.from({ length: 120 }, (_, i) => Object.freeze({
    id: `m${i}`, hub: 'big', label: `M${i}`, description: 'd', resource: 'R', archetype: 'handler', environments: ['dev'], run: async () => {},
  }));
  const hubs = [{ id: 'big', name: 'A hub with a really long name indeed', command: '/big' }];
  const { app } = setup({ views: true, reg: createRegistry({ hubs, modules }), canUse: () => true });
  await app.dispatchCommand('/big', { user_id: 'U1' });
  const { view } = calls(app, 'open')[0];
  assert.equal(view.blocks.length, 100);
  assert.equal(view.blocks.at(-1).accessory.action_id, 'big:help');
  assert.equal(view.blocks.at(-2).type, 'divider');
  // 126 blocks (header, not-set-up notice, welcome, the Tools header, 120
  // entries, divider, Help): 97 + note + 2. One group too big on its own is
  // left to modalView's cut (D1: the first group is never dropped whole).
  assert.equal(view.blocks.at(-3).elements[0].text, '_more… 27 more not shown here._');
  assert.equal(view.title.text, 'A hub with a really lon…');
  assert.equal(Array.from(view.title.text).length, 24);
});

test('modal helpers: titles, block limits and long text', () => {
  assert.equal(modalTitle('Short'), 'Short');
  assert.equal(modalTitle('x'.repeat(24)), 'x'.repeat(24));
  assert.equal(modalTitle('x'.repeat(25)), `${'x'.repeat(23)}…`);
  const emoji = modalTitle('😀'.repeat(30));
  assert.equal(Array.from(emoji).length, 24);
  assert.ok(emoji.endsWith('😀…'));
  assert.equal(modalTitle(''), 'Menu');
  const blocks = Array.from({ length: 150 }, (_, i) => ({ type: 'section', block_id: `b${i}` }));
  const cut = limitBlocks(blocks);
  assert.equal(cut.length, 100);
  assert.equal(cut[98].block_id, 'b98');
  assert.match(cut[99].elements[0].text, /more… 51 more/);
  assert.equal(limitBlocks(blocks.slice(0, 100)).length, 100);
});

test('a long text reply is split into sections Slack accepts, and replies beyond 100 blocks get a note', async () => {
  const chatty = handlerModule('chatty', async ({ reply }) => {
    await reply('line\n'.repeat(1000));
    await reply({ blocks: Array.from({ length: 120 }, () => ({ type: 'divider' })) });
  });
  const { app } = setup({ views: true, reg: createRegistry({ hubs: registry.hubs, modules: [chatty] }), canUse: () => true });
  await app.dispatchAction('chatty:open', { view: MENU_VIEW });
  const [first, second] = calls(app, 'update');
  assert.equal(first.view.blocks.length, 2);
  assert.ok(first.view.blocks.every((b) => b.text.text.length <= 3000));
  assert.equal(second.view.blocks.length, 100);
  assert.match(second.view.blocks.at(-1).elements[0].text, /more…/);
});

test('a long ephemeral text reply arrives whole, as sections Slack accepts, 50 blocks per message', async () => {
  const body = Array.from({ length: 12000 }, (_, i) => `line ${i} of the answer`).join('\n');
  const chatty = handlerModule('chatty', async ({ reply }) => {
    await reply('short and plain');
    await reply(body);
  });
  const { app } = setup({ reg: createRegistry({ hubs: registry.hubs, modules: [chatty] }), canUse: () => true });
  await app.dispatchAction('chatty:open');
  const [plain, ...long] = app.responded;
  assert.deepEqual(plain, { response_type: 'ephemeral', replace_original: false, text: 'short and plain' });
  assert.ok(long.length > 1);
  for (const m of long) {
    assert.equal(m.response_type, 'ephemeral');
    assert.ok(m.blocks.length <= 50);
    assert.ok(m.blocks.every((b) => b.type === 'section' && b.text.text.length <= 2900));
    assert.equal(m.text, m.blocks[0].text.text);
  }
  assert.equal(long.flatMap((m) => m.blocks.map((b) => b.text.text)).join('\n'), body);
});

// --- Story 15.1: a private image in a modal (AD-R12, AD-R15) ---------------------

const fs = require('node:fs');
const { createMapFiles } = require('../../kit/runtime/slack/image');
const { createEngineJobs } = require('../../kit/runtime/jobs');
const { MAP_NOT_SHOWN, MAP_NEEDS_WINDOW } = require('../../kit/runtime/slack/hubs');

const PNG = fs.readFileSync(path.join(__dirname, '../fixtures/routing-map/test-pattern.png'));
const ALT = 'Route map: Test pattern, no crew, 0 stops';
const MIN = 60 * 1000;
const showPattern = async ({ reply }) => reply({ text: 'Map check.', image: { png: PNG, alt: ALT } });
const mapCheck = (run = showPattern) => Object.freeze({
  id: 'map-check', hub: 'alpha', label: 'Map check', description: 'd', resource: 'R', archetype: 'handler', environments: ['dev'], run,
});
const slackError = (code) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
const imageBlocks = (view) => view.blocks.filter((b) => b.type === 'image');

// The hubs with a map-file lifecycle. ready: whether the sweep runs.
// Waits between show tries are recorded in slept, never slept (no real timer).
function mapSetup({
  modules = [mapCheck()], sweeping = () => true, store = createStore(), client, noMapFiles = false,
} = {}) {
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const mapFiles = noMapFiles ? undefined : createMapFiles({
    store, client: client === undefined ? app.client : client, log, sweeping, sleep,
  });
  registerHubs(app, {
    registry: createRegistry({ hubs: registry.hubs, modules }), profile, env: 'dev', log, store, canUse: () => true, ...(mapFiles ? { mapFiles } : {}),
  });
  return {
    app, log, store, mapFiles, slept,
  };
}

test('map-check: Open pushes a Back view asking for view_closed, uploads the PNG shared nowhere, records it, then shows the image block', async () => {
  const { app, store } = mapSetup();
  const recordedAtShow = [];
  const update = app.client.views.update;
  app.client.views.update = async (args) => {
    recordedAtShow.push(store.mapFilesOf('U1:V1').slice());
    return update(args);
  };
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  const [push] = calls(app, 'push');
  assert.equal(push.view.close.text, 'Back');
  assert.equal(push.view.notify_on_close, true);
  assert.equal(push.view.callback_id, 'hub:map');
  assert.deepEqual(viewTexts(push.view), [LOADING]);
  // The upload: no channel, the fixed filename and title.
  assert.equal(app.uploads.length, 1);
  assert.deepEqual(Object.keys(app.uploads[0]).sort(), ['file', 'filename', 'title']);
  assert.equal(app.uploads[0].filename, 'route-map.png');
  assert.equal(app.uploads[0].title, 'Route map');
  // Recorded before it was shown.
  assert.deepEqual(recordedAtShow, [['F1']]);
  const [shown] = calls(app, 'update');
  assert.equal(shown.view_id, 'V1');
  assert.equal(shown.view.notify_on_close, true);
  assert.equal(shown.view.callback_id, 'hub:map');
  assert.equal(shown.view.close.text, 'Back');
  assert.deepEqual(imageBlocks(shown.view), [{ type: 'image', slack_file: { id: 'F1' }, alt_text: ALT }]);
  assert.equal(shown.view.blocks[0].text.text, 'Map check.');
  assert.ok(!JSON.stringify(app.views).includes('image_url'));
  // Nothing anywhere else.
  assert.deepEqual(app.posted, []);
  assert.deepEqual(app.said, []);
  assert.deepEqual(app.dms, []);
  assert.deepEqual(app.deleted, []);
});

test('map-check exit, Back: returns to the hub menu (a pushed view) and view_closed deletes the file', async () => {
  const { app, store, log } = mapSetup();
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  // Back on a pushed view pops it, back to the menu: the map was pushed, never opened over the menu.
  assert.deepEqual(app.views.map((v) => v.method), ['push', 'update']);
  // A view_closed for another person's view, or another view, deletes nothing.
  await app.dispatchViewClosed('hub:map', { user: { id: 'U2' }, view: { id: 'V1' } });
  await app.dispatchViewClosed('hub:map', { user: { id: 'U1' }, view: { id: 'V9' } });
  assert.deepEqual(app.deleted, []);
  assert.equal(await app.dispatchViewClosed('hub:map', { user: { id: 'U1' }, view: { id: 'V1' } }), 1);
  assert.deepEqual(app.deleted, ['F1']);
  assert.equal(store.mapFileCount(), 0);
  assert.ok(log.lines.some((l) => l.msg === 'map view closed' && l.fields.deleted === 1 && l.fields.cleared === false));
});

test('map-check exit, Back with no view_closed: the sweep deletes the file within 20 minutes of upload (every clock frozen)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-02T15:00:00Z') });
  const store = createStore();
  let jobs;
  const { app, log } = mapSetup({ store, sweeping: () => jobs.running('sweep-map-files') });
  jobs = createEngineJobs({ names: ['sweep-map-files'], store, client: app.client, log });
  jobs.start();
  t.mock.timers.tick(2 * MIN); // uploaded at 15:02, mid-cycle
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  const uploaded = Date.now();
  let deletedAt = null;
  for (let m = 1; m <= 25 && deletedAt === null; m += 1) {
    t.mock.timers.tick(MIN);
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    if (app.deleted.includes('F1')) deletedAt = Date.now();
  }
  assert.ok(deletedAt !== null, 'the sweep deleted the file');
  assert.ok(deletedAt - uploaded <= 20 * MIN, `lived ${(deletedAt - uploaded) / MIN} minutes`);
  assert.equal(store.mapFileCount(), 0);
  jobs.stop();
});

test('map-check exit, Close (the X): view_closed with is_cleared deletes the file', async () => {
  const { app, store, log } = mapSetup();
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  await app.dispatchViewClosed('hub:map', { user: { id: 'U1' }, view: { id: 'V1' }, is_cleared: true });
  assert.deepEqual(app.deleted, ['F1']);
  assert.equal(store.mapFileCount(), 0);
  assert.ok(log.lines.some((l) => l.msg === 'map view closed' && l.fields.cleared === true));
});

test('map-check exit, upload failure: a plain message in the view with Back; nothing recorded; Slack\'s code logged, never the PNG', async () => {
  const { app, store, log } = mapSetup();
  app.filesFail = slackError('ratelimited');
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  const [shown] = calls(app, 'update');
  assert.deepEqual(viewTexts(shown.view), [MAP_NOT_SHOWN]);
  assert.equal(shown.view.close.text, 'Back');
  assert.deepEqual(imageBlocks(shown.view), []);
  assert.equal(store.mapFileCount(), 0);
  const warn = log.lines.find((l) => l.msg === 'map not shown');
  assert.deepEqual(warn.fields, { module: 'map-check', reason: 'ratelimited' });
  assert.ok(!JSON.stringify(log.lines).includes('Buffer'));
});

test('map-check exit, expired trigger: the hub\'s existing path (in place on the menu, logged); nothing is uploaded', async () => {
  const { app, log } = mapSetup();
  // The click reaches the app after its trigger expired (over 3 seconds).
  app.issueTrigger = (id) => { app.triggers.set(id, Date.now() - 4000); return id; };
  await app.dispatchAction('map-check:open', { view: { ...MENU_VIEW, hash: 'hmenu' } });
  assert.deepEqual(app.views.map((v) => v.method), ['push', 'update']);
  const [update] = calls(app, 'update');
  assert.equal(update.view_id, 'VMENU');
  assert.deepEqual(viewTexts(update.view), [MAP_NEEDS_WINDOW]);
  assert.deepEqual(app.uploads, []);
  assert.deepEqual(fallbacks(log).map((l) => l.fields), [{ where: 'open', reason: 'expired_trigger_id', hub: 'alpha', via: 'views.update' }]);
  assert.ok(log.lines.some((l) => l.msg === 'image refused' && l.fields.reason === 'no map view'));
});

test('a click on an old message menu (no modal) uploads nothing', async () => {
  const { app } = mapSetup();
  await app.dispatchAction('map-check:open');
  assert.deepEqual(app.uploads, []);
  assert.deepEqual(app.responded.map((r) => r.text), [MAP_NEEDS_WINDOW]);
});

test('a second map in the same view replaces the first, and the first file is deleted once the second shows (a view switch)', async () => {
  const twice = mapCheck(async ({ reply }) => {
    await reply({ image: { png: PNG, alt: ALT } });
    await reply({ image: { png: PNG, alt: 'Route map: Test pattern, no crew, 1 stops' } });
  });
  const { app, store } = mapSetup({ modules: [twice] });
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  const [first, second] = calls(app, 'update');
  assert.deepEqual(imageBlocks(first.view).map((b) => b.slack_file.id), ['F1']);
  assert.deepEqual(imageBlocks(second.view).map((b) => b.slack_file.id), ['F2']);
  assert.equal(second.view.blocks.length, 1);
  assert.deepEqual(app.deleted, ['F1']);
  assert.deepEqual(store.mapFilesOf('U1:V1'), ['F2']);
});

test('a map that uploads but cannot be shown is deleted at once', async () => {
  const { app, store } = mapSetup();
  const update = app.client.views.update;
  app.client.views.update = async (args) => {
    if (imageBlocks(args.view).length) throw slackError('hash_conflict');
    return update(args);
  };
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  assert.deepEqual(app.deleted, ['F1']);
  assert.equal(store.mapFileCount(), 0);
  assert.deepEqual(viewTexts(calls(app, 'update').at(-1).view), [PLAIN_ERROR]);
});

test('an image in any other module\'s reply is refused: nothing uploaded, the refusal logged, the plain error shown (F6)', async () => {
  const sneaky = handlerModule('sneaky', async ({ reply }) => reply({ text: 'look', image: { png: PNG, alt: ALT } }));
  // Not dev-only: map-check's id alone is not enough.
  const wide = Object.freeze({ ...mapCheck(), environments: ['dev', 'prod'] });
  for (const mod of [sneaky, wide]) {
    const { app, log } = mapSetup({ modules: [mod] });
    await app.dispatchAction(`${mod.id}:open`, { view: MENU_VIEW });
    assert.deepEqual(app.uploads, [], mod.id);
    assert.deepEqual(viewTexts(calls(app, 'update')[0].view), [PLAIN_ERROR], mod.id);
    assert.ok(log.lines.some((l) => l.msg === 'image refused' && l.fields.module === mod.id && l.fields.reason === 'this module may not show images'), mod.id);
    assert.ok(!JSON.stringify(log.lines).includes('Buffer'), mod.id);
    const [push] = calls(app, 'push');
    assert.ok(!('notify_on_close' in push.view), mod.id);
  }
});

test('a free-text alt is refused before upload: the view says the map could not be shown', async () => {
  const leaky = mapCheck(async ({ reply }) => reply({ image: { png: PNG, alt: '12 Elm Street, Springfield' } }));
  const { app, log } = mapSetup({ modules: [leaky] });
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  assert.deepEqual(app.uploads, []);
  assert.deepEqual(viewTexts(calls(app, 'update')[0].view), [MAP_NOT_SHOWN]);
  assert.ok(!JSON.stringify(log.lines).includes('Elm'));
});

test('fail closed: with no store, no Slack files client, no sweep or no map-file lifecycle, map-check shows "not available" and opens no map view', async () => {
  for (const opts of [{ store: null }, { client: {} }, { sweeping: () => false }, { noMapFiles: true }]) {
    let ran = false;
    const { app, log } = mapSetup({ ...opts, modules: [mapCheck(async () => { ran = true; })] });
    await app.dispatchAction('map-check:open', { view: MENU_VIEW });
    const what = JSON.stringify(Object.keys(opts));
    assert.equal(ran, false, what);
    assert.deepEqual(app.uploads, [], what);
    const [push] = calls(app, 'push');
    assert.deepEqual(viewTexts(push.view), [NOT_AVAILABLE], what);
    assert.equal(push.view.title.text, 'Not available', what);
    assert.ok(!('notify_on_close' in push.view), what);
    assert.notEqual(push.view.callback_id, 'hub:map', what);
    assert.ok(log.lines.some((l) => l.msg === 'hub action refused' && l.fields.reason === 'map files cannot be cleaned up'), what);
  }
});

test('the PNG bytes never reach a log line or any Slack call but the upload', async () => {
  const { app, log } = mapSetup();
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  await app.dispatchViewClosed('hub:map', { user: { id: 'U1' }, view: { id: 'V1' } });
  const b64 = PNG.toString('base64').slice(0, 60);
  for (const text of [JSON.stringify(log.lines), JSON.stringify(app.views), JSON.stringify(app.responded)]) {
    assert.ok(!text.includes('Buffer'));
    assert.ok(!text.includes(b64));
  }
});

// --- Story 15.1 live check: a fresh file Slack does not accept yet ----------------

const updatesWithImage = (app) => calls(app, 'update').filter((u) => imageBlocks(u.view).length);

test('file not ready: views.update is tried again with backoff and the map shows; "map image shown" logs the attempt', async () => {
  const { app, store, log, slept } = mapSetup();
  app.filesNotReadyFor = 2;
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  assert.equal(updatesWithImage(app).length, 3);
  assert.deepEqual(slept, [1000, 2000]);
  const last = calls(app, 'update').at(-1);
  assert.deepEqual(imageBlocks(last.view), [{ type: 'image', slack_file: { id: 'F1' }, alt_text: ALT }]);
  assert.deepEqual(store.mapFilesOf('U1:V1'), ['F1']);
  assert.deepEqual(app.deleted, []);
  const shown = log.lines.filter((l) => l.msg === 'map image shown');
  assert.deepEqual(shown.map((l) => l.fields), [{ module: 'map-check', attempt: 3 }]);
  assert.ok(!log.lines.some((l) => l.msg === 'handler failed'));
});

test('a map shown on the first try logs attempt 1 and never waits', async () => {
  const { app, log, slept } = mapSetup();
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  assert.deepEqual(slept, []);
  assert.deepEqual(log.lines.filter((l) => l.msg === 'map image shown').map((l) => l.fields.attempt), [1]);
});

test('file never accepted: after 5 tries the plain upload-failure view with Back, the file deleted and its record dropped, one clear log line', async () => {
  const { app, store, log, slept } = mapSetup();
  app.filesNotReadyFor = Infinity;
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  assert.equal(updatesWithImage(app).length, 5);
  assert.deepEqual(slept, [1000, 2000, 3000, 4000]);
  const last = calls(app, 'update').at(-1);
  assert.deepEqual(viewTexts(last.view), [MAP_NOT_SHOWN]);
  assert.equal(last.view.close.text, 'Back');
  assert.deepEqual(app.deleted, ['F1']);
  assert.equal(store.mapFileCount(), 0);
  const lines = log.lines.filter((l) => l.msg === 'map image not accepted by slack');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'error');
  assert.deepEqual(lines[0].fields, {
    module: 'map-check', attempts: 5, reason: 'invalid_arguments',
    messages: ['[ERROR] invalid slack file [json-pointer:view/blocks/1/slack_file.id/slack_file]'],
  });
  // Not the generic hub error.
  assert.ok(!log.lines.some((l) => l.msg === 'handler failed'));
  assert.ok(!calls(app, 'update').some((u) => viewTexts(u.view).includes(PLAIN_ERROR)));
  assert.ok(!log.lines.some((l) => l.msg === 'map image shown'));
  // Back afterwards: view_closed finds nothing left, and nothing is unrecorded in Slack.
  await app.dispatchViewClosed('hub:map', { user: { id: 'U1' }, view: { id: 'V1' } });
  assert.deepEqual(log.lines.filter((l) => l.msg === 'map view closed').map((l) => [l.fields.deleted, l.fields.kept]), [[0, 0]]);
  assert.deepEqual([...app.files].filter((id) => !app.deleted.includes(id)), []);
  const b64 = PNG.toString('base64').slice(0, 60);
  assert.ok(!JSON.stringify(log.lines).includes(b64));
});

test('another views.update error is not retried: the file goes at once and the person gets the plain error', async () => {
  const { app, store, slept, log } = mapSetup();
  const update = app.client.views.update;
  app.client.views.update = async (args) => {
    if (imageBlocks(args.view).length) {
      throw Object.assign(new Error('An API error occurred: invalid_arguments'), {
        data: { ok: false, error: 'invalid_arguments', response_metadata: { messages: ['[ERROR] must be a valid block [json-pointer:/view/blocks/0]'] } },
      });
    }
    return update(args);
  };
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  assert.deepEqual(slept, []);
  assert.equal(app.views.filter((v) => v.method === 'update').length, 1);
  assert.deepEqual(app.deleted, ['F1']);
  assert.equal(store.mapFileCount(), 0);
  assert.ok(!log.lines.some((l) => l.msg === 'map image not accepted by slack'));
});

test('the file is recorded under the view_closed key before any views.update: a show that fails and a delete that fails leave it for view_closed', async () => {
  const { app, store, log } = mapSetup();
  const recorded = [];
  const update = app.client.views.update;
  app.client.views.update = async (args) => {
    if (imageBlocks(args.view).length) {
      recorded.push(store.mapFilesOf('U1:V1').slice());
      throw slackError('hash_conflict');
    }
    return update(args);
  };
  app.deleteFail = slackError('ratelimited');
  await app.dispatchAction('map-check:open', { view: MENU_VIEW });
  assert.deepEqual(recorded, [['F1']]);
  assert.deepEqual(app.deleted, []);
  assert.deepEqual(store.mapFilesOf('U1:V1'), ['F1']);
  // Back: view_closed (same person, same view) deletes it.
  app.deleteFail = null;
  await app.dispatchViewClosed('hub:map', { user: { id: 'U1' }, view: { id: 'V1' } });
  assert.deepEqual(app.deleted, ['F1']);
  assert.equal(store.mapFileCount(), 0);
  assert.deepEqual(log.lines.filter((l) => l.msg === 'map view closed').map((l) => l.fields.deleted), [1]);
});
