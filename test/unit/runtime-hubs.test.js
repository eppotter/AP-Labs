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

test('each hub file registers its slash command; one listener each handles Open and Help clicks', () => {
  const { app } = setup();
  assert.deepEqual([...app.commandListeners.keys()], ['/alpha', '/beta']);
  assert.equal(app.actionListeners.length, 2);
  assert.deepEqual([...app.eventListeners.keys()], ['team_join']);
});

test('fallback (no views client): the hub command replies privately with the hub\'s visible entries, label and description', async () => {
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
  assert.equal(echo.text.text, '*Echo*\nSays who you are &amp; where &lt;you&gt; are.');
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

test('buildMenu: entries become sections with an Open button each', () => {
  const hub = { id: 'h', name: 'H' };
  const { text, blocks } = buildMenu(hub, [{ id: 'a-b', label: 'A', description: 'd' }]);
  assert.equal(text, 'H: A');
  assert.deepEqual(blocks[1].accessory, {
    type: 'button', action_id: 'a-b:open', value: 'a-b', text: { type: 'plain_text', text: 'Open', emoji: false },
  });
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
  assert.equal(view.blocks.find((b) => b.block_id === 'entry:echo').text.text, '*Echo*\nSays who you are &amp; where &lt;you&gt; are.');
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
  // 125 blocks (header, welcome, not-set-up notice, 120 entries, divider, Help): 97 + note + 2.
  assert.equal(view.blocks.at(-3).elements[0].text, '_more… 26 more not shown here._');
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
