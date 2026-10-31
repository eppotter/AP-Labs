'use strict';

// Story 6.4: a first-visit welcome above each hub's menu (once per person per
// hub, store namespace `welcome`), a Help entry at the end of every menu that
// lists only what the person can use plus how to give feedback, and a private
// welcome for a person joining the workspace naming the hubs they can use.
// Profiles: test/fixtures/runtime/access.yml (people and grants) and
// test/fixtures/runtime/profile.yml with the fixture app (hub file wording).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { createRegistry, loadRegistry, loadHubs } = require('../../kit/runtime/registry');
const { buildHelp, hubIdFromHelpAction, helpActionId } = require('../../kit/runtime/registry/menu');
const { registerHubs, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const { createStore, NAMESPACES } = require('../../kit/runtime/store');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime');
const accessProfile = loadProfile(path.join(FIX, 'access.yml'));
const ADMIN = '<@UADA> or Dee &lt;D&gt;';

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function mod(id, hub, resource, environments = ['dev']) {
  return Object.freeze({
    id, hub, label: `${id[0].toUpperCase()}${id.slice(1)}`, description: `${id} entry`,
    resource, archetype: 'handler', environments, run: async () => {},
  });
}

// Two hubs with no welcome or feedback of their own (defaults): "main" has an
// open, a granted and a denied entry plus one hidden in dev; "pay" has only
// the payroll entry nobody in access.yml can use.
function accessSetup({ now } = {}) {
  const modules = [
    mod('open', 'main', 'OPEN_THING'),
    mod('reports', 'main', 'REPORTS'),
    mod('payroll', 'main', 'PAYROLL'),
    mod('later', 'main', 'OPEN_THING', ['prod']),
    mod('salary', 'pay', 'PAYROLL'),
  ];
  const hubs = [
    { id: 'main', name: 'Main', command: '/main' },
    { id: 'pay', name: 'Pay', command: '/pay' },
  ];
  const app = new FakeSlackApp({});
  const log = quietLog();
  registerHubs(app, { registry: createRegistry({ hubs, modules }), profile: accessProfile, env: 'dev', log, store: createStore({ now }) });
  return { app, log };
}

function fixtureSetup() {
  const profile = loadProfile(path.join(FIX, 'profile.yml'));
  const { registry } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });
  const app = new FakeSlackApp({});
  registerHubs(app, { registry, profile, env: 'dev', log: quietLog(), store: createStore() });
  return { app };
}

const welcomeOf = (msg) => msg.blocks.find((b) => b.block_id === 'welcome');
const helpModules = (msg) => msg.blocks.find((b) => b.block_id === 'help:modules').text.text;
const helpFeedback = (msg) => msg.blocks.find((b) => b.block_id === 'help:feedback').text.text;

// --- first visit and repeat visit ------------------------------------------

test('first visit: the hub file\'s welcome sits above the entries, escaped', async () => {
  const { app } = fixtureSetup();
  await app.dispatchCommand('/alpha', { user_id: 'U1' });
  const [menu] = app.responded;
  const blocks = menu.blocks;
  const w = welcomeOf(menu);
  assert.equal(w.text.text, 'Hi &amp; welcome to &lt;Alpha&gt;.');
  const at = blocks.indexOf(w);
  // The private reply leads with the hub's name (no modal title there).
  assert.equal(blocks[0].type, 'header');
  assert.ok(at > 0 && at < blocks.findIndex((b) => b.block_id === 'entry:echo'), 'welcome comes before the first entry');
  assert.match(menu.text, /^Hi &amp; welcome to &lt;Alpha&gt;\.\nAlpha tools: Echo, Second/);
});

test('repeat visit: no welcome the second time, for the same person and hub', async () => {
  const { app } = fixtureSetup();
  await app.dispatchCommand('/alpha', { user_id: 'U1' });
  await app.dispatchCommand('/alpha', { user_id: 'U1' });
  assert.ok(welcomeOf(app.responded[0]));
  assert.equal(welcomeOf(app.responded[1]), undefined);
  assert.match(app.responded[1].text, /^Alpha tools: Echo, Second/);
});

test('the welcome is once per person per hub: another hub or another person still gets one', async () => {
  const { app } = fixtureSetup();
  await app.dispatchCommand('/alpha', { user_id: 'U1' });
  await app.dispatchCommand('/beta', { user_id: 'U1' });
  await app.dispatchCommand('/alpha', { user_id: 'U2' });
  await app.dispatchCommand('/beta', { user_id: 'U1' });
  const welcomes = app.responded.map((m) => welcomeOf(m) && welcomeOf(m).text.text);
  assert.equal(welcomes[0], 'Hi &amp; welcome to &lt;Alpha&gt;.');
  // beta sees nothing (sees: []), so its welcome is a blank hub's and shows
  // only while a summary says it is blank; this setup reads none, so it is
  // left out. The default welcome on a blank hub is in hub-status-menu.
  assert.equal(welcomes[1], undefined);
  assert.equal(welcomes[2], 'Hi &amp; welcome to &lt;Alpha&gt;.');
  assert.equal(welcomes[3], undefined);
});

test('the first-visit flag lives in the store\'s welcome namespace and expires with its 7-day TTL', async () => {
  let t = 1_000;
  const { app } = accessSetup({ now: () => t });
  await app.dispatchCommand('/main', { user_id: 'UBO' });
  t += NAMESPACES.welcome - 1;
  await app.dispatchCommand('/main', { user_id: 'UBO' });
  t += 1;
  await app.dispatchCommand('/main', { user_id: 'UBO' });
  assert.deepEqual(app.responded.map((m) => Boolean(welcomeOf(m))), [true, false, true]);
});

test('a person not set up still gets the welcome, with the not-set-up notice', async () => {
  const { app } = accessSetup();
  await app.dispatchCommand('/main', { user_id: 'UNEW' });
  const [menu] = app.responded;
  assert.match(welcomeOf(menu).text.text, /^Welcome to Main\./);
  assert.match(menu.blocks.find((b) => b.type === 'context').elements[0].text, /^You're not set up in Tiny &amp; Co's bot yet/);
});

// --- the Help entry ---------------------------------------------------------

test('every menu ends with a Help entry whose button names the hub, even when nothing else shows', async () => {
  const { app } = accessSetup();
  await app.dispatchCommand('/main', { user_id: 'UBO' });
  await app.dispatchCommand('/pay', { user_id: 'UBO' });
  for (const [menu, hubId] of [[app.responded[0], 'main'], [app.responded[1], 'pay']]) {
    const last = menu.blocks.at(-1);
    assert.equal(last.block_id, 'help');
    assert.match(last.text.text, /^\*Help\*/);
    assert.equal(last.accessory.action_id, `${hubId}:help`);
    assert.equal(last.accessory.text.text, 'Help');
  }
});

test('help lists only the modules the person can use, by the same decision as the menu', async () => {
  const { app } = accessSetup();
  // Bo: open + granted reports; payroll is denied (deny wins); "later" is prod-only.
  await app.dispatchAction('main:help', { user: { id: 'UBO' } });
  // Cy: open access is denied to them, nothing granted.
  await app.dispatchAction('main:help', { user: { id: 'UCY' } });
  // Ada (admin): admin-grantable reports, but not payroll (admin_grantable: false).
  await app.dispatchAction('main:help', { user: { id: 'UADA' } });
  const [bo, cy, ada] = app.responded;
  assert.equal(app.acks, 3);
  assert.equal(bo.response_type, 'ephemeral');
  assert.equal(bo.blocks[0].text.text, 'Help: Main');
  assert.equal(helpModules(bo), '*What you can use here*\n• *Open*: open entry\n• *Reports*: reports entry');
  assert.equal(helpModules(cy), '*What you can use here*\nNothing is available to you here yet.');
  assert.equal(helpModules(ada), '*What you can use here*\n• *Open*: open entry\n• *Reports*: reports entry');
  for (const h of [bo, cy, ada]) assert.doesNotMatch(JSON.stringify(h), /Payroll|Later/);
  assert.match(bo.text, /^Help for Main: you can use Open, Reports\./);
});

test('help matches the menu exactly for every person', async () => {
  for (const id of ['UADA', 'UBO', 'UCY', 'UNEW']) {
    const { app } = accessSetup();
    await app.dispatchCommand('/main', { user_id: id });
    await app.dispatchAction('main:help', { user: { id } });
    const [menu, help] = app.responded;
    const menuLabels = menu.blocks.filter((b) => /^entry:/.test(b.block_id || '')).map((b) => b.text.text.split('\n')[0]);
    const helpLabels = [...helpModules(help).matchAll(/• (\*[^*]+\*)/g)].map((m) => m[1]);
    assert.deepEqual(helpLabels, menuLabels, id);
  }
});

test('help says how to give feedback: the hub file\'s line, else the profile\'s admins', async () => {
  const fx = fixtureSetup();
  await fx.app.dispatchAction('alpha:help');
  await fx.app.dispatchAction('beta:help');
  assert.equal(helpFeedback(fx.app.responded[0]), '*Feedback*\nPost in the alpha feedback thread.');
  assert.equal(helpFeedback(fx.app.responded[1]), '*Feedback*\nTo give feedback or ask for something new, tell Solo.');
  const ac = accessSetup();
  await ac.app.dispatchAction('main:help', { user: { id: 'UBO' } });
  assert.equal(helpFeedback(ac.app.responded[0]), `*Feedback*\nTo give feedback or ask for something new, tell ${ADMIN}.`);
});

test('help for a person not set up carries the notice and lists only open-access modules', async () => {
  const { app } = accessSetup();
  await app.dispatchAction('main:help', { user: { id: 'UNEW' } });
  const [help] = app.responded;
  assert.match(help.blocks.find((b) => b.type === 'context').elements[0].text, /^You're not set up/);
  assert.equal(helpModules(help), '*What you can use here*\n• *Open*: open entry');
});

test('a Help click for an unknown hub is acked and refused plainly', async () => {
  const { app, log } = accessSetup();
  assert.equal(await app.dispatchAction('ghost:help'), 1);
  assert.equal(app.acks, 1);
  assert.deepEqual(app.responded.map((r) => r.text), [NOT_AVAILABLE]);
  assert.equal(log.lines.find((l) => l.msg === 'hub action refused').fields.reason, 'unknown hub');
  assert.equal(hubIdFromHelpAction('Main:help'), null);
  assert.equal(hubIdFromHelpAction(undefined), null);
  assert.equal(helpActionId('main'), 'main:help');
});

test('buildHelp escapes labels and descriptions', () => {
  const { blocks } = buildHelp({ id: 'h', name: 'H' }, [{ id: 'x', label: 'A & B', description: '<d>' }], { feedback: 'f' });
  assert.equal(blocks.find((b) => b.block_id === 'help:modules').text.text, '*What you can use here*\n• *A &amp; B*: &lt;d&gt;');
});

// --- the join welcome -------------------------------------------------------

test('a person joining gets a private DM naming the hubs they can use', async () => {
  const { app, log } = accessSetup();
  // UBO already has a profile user: main has entries for them, pay has none.
  assert.equal(await app.dispatchEvent('team_join', { user: { id: 'UBO', name: 'bo' } }, { body: { event_id: 'Ev1' } }), 1);
  assert.equal(app.posted.length, 1);
  const [dm] = app.posted;
  assert.equal(dm.channel, 'UBO');
  assert.match(dm.text, /^Welcome to Tiny &amp; Co! I'm the Tiny &amp; Co bot\./);
  assert.match(dm.text, /You can use `\/main` \(Main\)\./);
  assert.doesNotMatch(dm.text, /\/pay|not set up/);
  assert.deepEqual(log.lines.find((l) => l.msg === 'join welcome sent').fields, { hubs: ['/main'], set_up: true });
});

test('a joiner not in the profile is told what is open to everyone and who to ask', async () => {
  const { app } = accessSetup();
  await app.dispatchEvent('team_join', { user: { id: 'UNEW' } });
  const [dm] = app.posted;
  assert.equal(dm.channel, 'UNEW');
  assert.match(dm.text, /You can use `\/main` \(Main\)\./);
  assert.match(dm.text, new RegExp(`You're not set up in Tiny &amp; Co's bot yet.*Ask ${ADMIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} to add you\\.$`));
});

test('a joiner with nothing to use is told so, with who to ask', async () => {
  const { app } = accessSetup();
  await app.dispatchEvent('team_join', { user: { id: 'UCY' } });
  assert.match(app.posted[0].text, new RegExp(`There's nothing here for you to use yet; ask .*UADA.* if you need something\\.$`));
  assert.doesNotMatch(app.posted[0].text, /You can use/);
});

test('bots, deleted users and malformed joins get no welcome; a retried event is sent once', async () => {
  const { app } = accessSetup();
  await app.dispatchEvent('team_join', { user: { id: 'UBOT', is_bot: true } });
  await app.dispatchEvent('team_join', { user: { id: 'UDEL', deleted: true } });
  await app.dispatchEvent('team_join', {});
  await app.dispatchEvent('team_join', { user: { id: '' } });
  assert.equal(app.posted.length, 0);
  await app.dispatchEvent('team_join', { user: 'UBO' }, { body: { event_id: 'Ev9' } });
  await app.dispatchEvent('team_join', { user: 'UBO' }, { body: { event_id: 'Ev9', retry_attempt: 1 } });
  assert.deepEqual(app.posted.map((p) => p.channel), ['UBO']);
});

// --- the hub schema ---------------------------------------------------------

test('hub files may set welcome and feedback; a multi-line welcome or an unknown key is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-welcome-'));
  try {
    fs.mkdirSync(path.join(dir, 'hubs'));
    const write = (id, extra) => fs.writeFileSync(path.join(dir, 'hubs', `${id}.json`),
      JSON.stringify({ id, command: `/${id}`, name: id, description: id, sees: [], ...extra }));
    write('ok', { welcome: 'One paragraph.', feedback: 'Tell us.' });
    write('multi', { welcome: 'Two\nparagraphs.' });
    write('blank', { feedback: '  ' });
    write('extra', { greeting: 'hi' });
    const { hubs, problems } = loadHubs(dir);
    assert.deepEqual(hubs.map((h) => h.id), ['ok']);
    assert.equal(problems.length, 3);
    assert.ok(problems.some((p) => /hubs\/multi\.json: field "welcome"/.test(p)));
    assert.ok(problems.some((p) => /hubs\/blank\.json: field "feedback"/.test(p)));
    assert.ok(problems.some((p) => /hubs\/extra\.json: unknown field "greeting"/.test(p)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
