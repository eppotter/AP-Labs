'use strict';

// Brightside v1, the hub (plan brightside-v1, D5, D6, D8, D9, Story 19.2):
// /brightside-v1 sees context, data and rules, shares v0's notes, and lists
// five route skills (Optimize a route, Customer cancellation, Crew out,
// Route map, and Add a stop since Story 19.5), Ask, Request a tool, and Add
// context and Data sources in Setup. Every route skill is dev-only (gate item
// 5: copies never inherit production).
//
// Through the engine with the fake Slack client, on a temporary build of the
// fixture: the menu for a person with the routing key (Routing, Tools, Setup)
// and for an admin without it (no Routing); the /brightside and
// /brightside-v0 menus are the same block snapshots as before the v1 hub
// existed; and every way out of the v1 menu: Help then Back, the X, an
// expired trigger, a person not in the profile, a click from someone without
// the key, a route row clicked from an old menu once it is hidden in prod, a
// waiting row's Why?, and Request a tool, which opens its form on v1 since
// Story 19.3 (D12; v1-ask.test.js covers posting from it). Then each route
// skill opens its own screen on v1 for a dispatcher and refuses a person with
// no routing key.
//
// An example test (architecture carve-out): it reads Brightside's app dir and
// fixture, and its profiles come from test fixtures (fixtures/demo-profile.yml,
// fixtures/routing-profile.yml), never profiles/brightside/. Deleted with the
// example in a fork.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { createData } = require('../../../kit/runtime/data');
const { loadRegistry, createRegistry } = require('../../../kit/runtime/registry');
const { registerHubs, NOT_AVAILABLE } = require('../../../kit/runtime/slack/hubs');
const { bootProblems } = require('../../../kit/runtime/slack/hub-view');
const { createStore } = require('../../../kit/runtime/store');
const { createMapFiles } = require('../../../kit/runtime/slack/image');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const { createAdapter } = require('../app/routing/adapter');

const ROOT = path.join(__dirname, '../../..');
const APP = path.join(ROOT, 'examples/brightside/app');
const DEMO_PROFILE = path.join(__dirname, 'fixtures/demo-profile.yml');
const profile = loadProfile(DEMO_PROFILE);
const { registry, problems } = loadRegistry({ appDir: APP, profile });
const slackOf = (p, id) => p.users.find((u) => u.id === id).identities.slack;
const ELY = slackOf(profile, 'ely');
const STEVEN = slackOf(profile, 'steven');
// An admin with no routing key: added to a copy of the demo profile below.
const ANN = 'U0FIXTUREANN';
const V1 = 'brightside-v1';
const ROUTES = ['v1-route-add-stop', 'v1-route-cancellation', 'v1-route-crew-out', 'v1-route-map', 'v1-route-optimize'];
const BUILD_REQUEST_FORM = 'build-request:form';

let tmp;
let FIXTURE;
let NO_ROUTING_PROFILE;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-v1-hub-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
  // The demo profile plus Ann, an admin with no grants: she gets Ask, Add
  // context and Data sources from her role, and no routing key
  // (ROUTING_ALL_CREWS is not admin-grantable).
  const text = fs.readFileSync(DEMO_PROFILE, 'utf8');
  const STEVEN_LINE = /^ {2}- \{ id: steven, .*$/m;
  assert.match(text, STEVEN_LINE);
  NO_ROUTING_PROFILE = path.join(tmp, 'no-routing-admin.yml');
  fs.writeFileSync(NO_ROUTING_PROFILE, text.replace(STEVEN_LINE, (line) => `${line}\n  - { id: ann, name: Ann Admin, role: admin, identities: { slack: ${ANN} } }`));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

class ViewsSlackApp extends FakeSlackApp {
  constructor(options) { super({ ...options, views: true }); }
}

let seq = 0;
// Boots the app as the live bot runs it, on its own var dir (no notes).
async function boot(t, { env = 'dev', profilePath = DEMO_PROFILE } = {}) {
  seq += 1;
  const varDir = path.join(tmp, `var-${seq}`);
  const lines = [];
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      APLABS_PROFILE: profilePath,
      APLABS_APP_DIR: APP,
      APLABS_DATA_PATH: FIXTURE,
      APLABS_VAR_DIR: varDir,
      APLABS_ENV: env,
    },
    cwd: os.tmpdir(),
    deps: { App: ViewsSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => {
    res.engineJobs.stop();
    res.jobs.stop();
    res.data.close();
  });
  return { app: res.app, lines };
}

const lastView = (app) => app.views.at(-1).args.view;
// A block, in short: its type, id, text and button.
const shape = (blocks) => blocks.map((b) => [
  b.type,
  b.block_id || null,
  (b.text && b.text.text) || (b.elements ? b.elements.map((e) => e.text).join(' | ') : null),
  (b.accessory && b.accessory.action_id) || null,
]);
const headers = (blocks) => blocks.filter((b) => b.type === 'header').map((b) => b.text.text);
const rowIds = (blocks) => blocks.filter((b) => /^entry:/.test(b.block_id || '')).map((b) => b.block_id.slice('entry:'.length));
async function menu(app, command, user) {
  await app.dispatchCommand(command, { user_id: user });
  return lastView(app);
}
const MENU_VIEW = Object.freeze({ id: 'VMENU', type: 'modal', private_metadata: V1 });

// --- the hub and its folders ---------------------------------------------------------

test('the v1 hub file is D5\'s: /brightside-v1 sees context, data and rules and shares brightside-v0\'s notes', () => {
  assert.deepEqual(problems, []);
  const hub = registry.hubs.find((h) => h.id === V1);
  assert.deepEqual({ ...hub, file: undefined }, { ...JSON.parse(fs.readFileSync(path.join(APP, 'hubs/brightside-v1.json'), 'utf8')), file: undefined });
  assert.equal(hub.command, '/brightside-v1');
  assert.equal(hub.description, 'Open the Brightside v1 menu');
  assert.deepEqual(hub.sees, ['context', 'data', 'rules']);
  assert.equal(hub.notes, 'brightside-v0');
  assert.equal(hub.usage_hint, undefined);
  for (const env of ['dev', 'prod']) assert.deepEqual(bootProblems({ hubs: registry.hubs, modules: registry.modules, env }), [], env);
});

test('the v1 folders are D5\'s: five route skills (dev only, ROUTING_ALL_CREWS, Routing), Ask, Request a tool, Add context and Data sources', () => {
  const got = Object.fromEntries(registry.entries(V1).map((m) => [m.id, {
    label: m.label, archetype: m.archetype, resource: m.resource, group: m.group || null, screen: m.screen || null, verb: m.verb || null, environments: m.environments,
  }]));
  const route = (label, screen, verb) => ({
    label, archetype: 'routing-map', resource: 'ROUTING_ALL_CREWS', group: 'Routing', screen, verb, environments: ['dev'],
  });
  const tool = (label, archetype, resource) => ({
    label, archetype, resource, group: null, screen: null, verb: null, environments: ['dev', 'prod'],
  });
  assert.deepEqual(got, {
    'v1-add-context': tool('Add context', 'add-context', 'ADD_CONTEXT'),
    'v1-ask': tool('Ask', 'ask', 'ASK'),
    'v1-build-request': tool('Request a tool', 'build-request', 'BUILD_REQUEST'),
    'v1-data-sources': tool('Data sources', 'data-sources', 'DATA_SOURCES'),
    'v1-route-add-stop': route('Add a stop', 'add-stop', 'Run'),
    'v1-route-cancellation': route('Customer cancellation', 'cancellation', 'Run'),
    'v1-route-crew-out': route('Crew out', 'crew-out', 'Run'),
    'v1-route-map': route('Route map', null, null),
    'v1-route-optimize': route('Optimize a route', 'route-editor', 'Run'),
  });
});

test('gate item 5: no v1 route skill runs in production, and the /brightside route modules are untouched', () => {
  for (const id of ROUTES) assert.deepEqual(registry.module(id).environments, ['dev'], id);
  assert.deepEqual(registry.entries('brightside').map((m) => m.id), [
    'dataset', 'hello-world', 'labour-cost', 'outbox', 'route-planner', 'routing', 'unpaid-invoices', 'win-back',
  ]);
  assert.deepEqual(registry.entries('brightside-v0').map((m) => m.id), ['v0-add-context', 'v0-ask', 'v0-build-request', 'v0-data-sources']);
});

test('each v1 route skill\'s adapter is Brightside\'s routing adapter, re-exported', () => {
  for (const id of ROUTES) {
    assert.equal(registry.module(id).adapter, 'adapter.js', id);
    assert.equal(require(path.join(APP, 'modules', id, 'adapter.js')).createAdapter, createAdapter, id);
  }
});

test('D6: v1\'s Ask, Add context and Data sources use v0\'s keys, so the same people read, write and list the shared notes', () => {
  for (const tool of ['ask', 'add-context', 'data-sources', 'build-request']) {
    assert.equal(registry.module(`v1-${tool}`).resource, registry.module(`v0-${tool}`).resource, tool);
  }
});

test('D6 on the real hubs: a note Ely adds on v1 is stored in v0\'s folder, and both Data sources list it as shared', async (t) => {
  const { app } = await boot(t);
  const ely = { id: ELY, name: 'ely' };
  await app.dispatchAction('v1-add-context:open', { user: ely, view: { ...MENU_VIEW, hash: 'h0' } });
  const form = lastView(app);
  assert.equal(form.submit.text, 'Add');
  await app.dispatchView('add-context:submit', {
    user: ely,
    view: {
      ...form,
      id: 'VFORM',
      state: { values: { 'ac-title': { value: { value: 'Saturdays' } }, 'ac-text': { value: { value: 'We clean on Saturdays too.' } } } },
    },
  });
  assert.equal(lastView(app).blocks[0].text.text, 'Added. Ask can use it now.');
  const listed = async (id, hubId) => {
    await app.dispatchAction(`${id}:open`, { user: ely, view: { ...MENU_VIEW, private_metadata: hubId } });
    return lastView(app).blocks.map((b) => b.text && b.text.text).join('\n');
  };
  assert.match(await listed('v0-data-sources', 'brightside-v0'), /\*Added context \(shared with Brightside v1\)\*\n• Saturdays by <@U0FIXTUREELY>/);
  assert.match(await listed('v1-data-sources', V1), /\*Added context \(shared with Brightside v0\)\*\n• Saturdays by <@U0FIXTUREELY>/);
});

// --- the menu ------------------------------------------------------------------------

test('/brightside-v1 for Ely, who holds the routing key: Routing, Tools, then Setup, with the welcome; Steven sees the same', async (t) => {
  const { app } = await boot(t);
  const view = await menu(app, '/brightside-v1', ELY);
  assert.equal(view.title.text, 'Brightside v1');
  assert.deepEqual(headers(view.blocks), ['Routing', 'Tools', 'Setup · admins only']);
  assert.deepEqual(rowIds(view.blocks), [...ROUTES, 'v1-ask', 'v1-build-request', 'v1-add-context', 'v1-data-sources']);
  assert.equal(view.blocks.find((b) => b.block_id === 'welcome').text.text, 'Brightside on your real data: it knows the company, follows its rules, and plans routes.');
  // The strip reads the hub's data source (it sees data).
  assert.equal(view.blocks.find((b) => b.block_id === 'strip:knows').text.text, 'Knows: 1 source');
  // No menu button says "Open".
  assert.ok(!view.blocks.some((b) => b.accessory && b.accessory.text && b.accessory.text.text === 'Open'));
  const { app: again } = await boot(t);
  assert.deepEqual(shape((await menu(again, '/brightside-v1', STEVEN)).blocks), shape(view.blocks));
});

test('/brightside-v1 for an admin without the routing key: no Routing group and no route row; Tools and Setup as for Ely', async (t) => {
  const { app } = await boot(t, { profilePath: NO_ROUTING_PROFILE });
  const view = await menu(app, '/brightside-v1', ANN);
  assert.deepEqual(headers(view.blocks), ['Tools', 'Setup · admins only']);
  assert.deepEqual(rowIds(view.blocks), ['v1-ask', 'v1-build-request', 'v1-add-context', 'v1-data-sources']);
});

test('/brightside-v1 in production: the route skills are hidden (gate item 5); Ask, Request a tool and Setup stay', async (t) => {
  const { app } = await boot(t, { env: 'prod' });
  const view = await menu(app, '/brightside-v1', ELY);
  assert.deepEqual(headers(view.blocks), ['Tools', 'Setup · admins only']);
  assert.deepEqual(rowIds(view.blocks), ['v1-ask', 'v1-build-request', 'v1-add-context', 'v1-data-sources']);
});

// The menus as they were before the v1 hub existed (captured with the v1 hub
// file and folders taken out, on main at 57a5e62): the v1 hub changes neither.
const BRIGHTSIDE_MENU = [
  ['section', 'strip:knows', 'Knows: 1 source', null],
  ['context', 'strip:progress', 'Setup 2 of 4 · 7 of 8 tools working', null],
  ['section', 'welcome', 'Welcome to the Brightside bot: your day-to-day tools, and only the ones you\'re set up for.', null],
  ['header', 'group:0', 'Lists', null],
  ['section', 'entry:labour-cost', '*Labour cost*', 'labour-cost:open'],
  ['section', 'entry:unpaid-invoices', '*Unpaid invoices*', 'unpaid-invoices:open'],
  ['section', 'entry:win-back', '*Win-back list*', 'win-back:open'],
  ['header', 'group:1', 'Routing', null],
  ['section', 'entry:route-planner', '*Plan a route* · ⚪ _needs map setup_', 'route-planner:why'],
  ['section', 'entry:routing', '*Route map*', 'routing:open'],
  ['header', 'group:2', 'Tools', null],
  ['section', 'entry:dataset', '*Dataset*', 'dataset:open'],
  ['section', 'entry:hello-world', '*Say hello*', 'hello-world:open'],
  ['section', 'entry:outbox', '*Outbox*', 'outbox:open'],
  ['divider', null, null, null],
  ['section', 'help', '*Help*\nWhat you can use here, and how to give feedback.', 'brightside:help'],
];
const V0_MENU = [
  ['section', 'strip:knows', 'Knows: nothing yet', null],
  ['context', 'strip:progress', 'Setup 0 of 1 · 1 of 2 tools working', null],
  ['section', 'welcome', 'A blank Brightside bot: it knows nothing about the business until an admin teaches it.', null],
  ['section', 'next', '*Next:* teach it the business', 'v0-add-context:open'],
  ['header', 'group:0', 'Tools', null],
  ['section', 'entry:v0-ask', '*Ask* · 🟡 _nothing taught yet_', 'v0-ask:open'],
  ['section', 'entry:v0-build-request', '*Request a tool*', 'v0-build-request:open'],
  ['header', 'group:1', 'Setup · admins only', null],
  ['section', 'entry:v0-add-context', '*Add context* · ⚪ _not started_', 'v0-add-context:open'],
  ['section', 'entry:v0-data-sources', '*Data sources* · _no data on this hub_', 'v0-data-sources:open'],
  ['divider', null, null, null],
  ['section', 'help', '*Help*\nWhat you can use here, and how to give feedback.', 'brightside-v0:help'],
];

test('/brightside and /brightside-v0 are unchanged by the v1 hub: the same blocks as before it existed', async (t) => {
  const { app } = await boot(t);
  assert.deepEqual(shape((await menu(app, '/brightside', ELY)).blocks), BRIGHTSIDE_MENU);
  assert.deepEqual(shape((await menu(app, '/brightside-v0', ELY)).blocks), V0_MENU);
});

// --- ways out of the v1 menu ---------------------------------------------------------

test('way out, Help then Back: Help pushes a view whose close is Back, naming the v1 tools', async (t) => {
  const { app } = await boot(t);
  await app.dispatchAction('brightside-v1:help', { user: { id: ELY }, view: MENU_VIEW });
  const last = app.views.at(-1);
  assert.equal(last.method, 'push');
  const { view } = last.args;
  assert.equal(view.title.text, 'Help: Brightside v1');
  assert.equal(view.close.text, 'Back');
  assert.equal(view.submit, undefined);
  assert.equal(view.notify_on_close, undefined);
  const listed = view.blocks.find((b) => b.block_id === 'help:modules').text.text;
  for (const label of ['Optimize a route', 'Customer cancellation', 'Crew out', 'Add a stop', 'Route map', 'Ask', 'Request a tool']) assert.ok(listed.includes(label), label);
});

test('way out, the X: the v1 menu has Close and no Submit, and asks Slack for no view_closed, so nothing runs', async (t) => {
  const { app } = await boot(t);
  const view = await menu(app, '/brightside-v1', ELY);
  assert.equal(view.close.text, 'Close');
  assert.equal(view.submit, undefined);
  assert.equal(view.notify_on_close, undefined);
  assert.equal(await app.dispatchViewClosed(view.callback_id, { user: { id: ELY }, view: { ...MENU_VIEW, callback_id: view.callback_id } }), 0);
});

test('way out, an expired trigger: the v1 menu comes as a private reply instead, with the same rows', async (t) => {
  const { app } = await boot(t);
  const open = app.client.views.open;
  app.client.views.open = async (args) => { app.expireTriggers(); return open(args); };
  await app.dispatchCommand('/brightside-v1', { user_id: ELY });
  assert.equal(app.responded.length, 1);
  const [reply] = app.responded;
  assert.equal(reply.response_type, 'ephemeral');
  assert.deepEqual(rowIds(reply.blocks), [...ROUTES, 'v1-ask', 'v1-build-request', 'v1-add-context', 'v1-data-sources']);
});

test('way out, a person not in the profile: the "not set up" notice and no rows', async (t) => {
  const { app } = await boot(t);
  const view = await menu(app, '/brightside-v1', 'UNOBODY');
  assert.deepEqual(rowIds(view.blocks), []);
  assert.match(view.blocks.find((b) => b.type === 'context').elements[0].text, /^You're not set up in Brightside Home Cleaning's bot yet/);
});

test('way out, a route row clicked by someone without the routing key: refused, nothing opens', async (t) => {
  const { app, lines } = await boot(t, { profilePath: NO_ROUTING_PROFILE });
  for (const id of ROUTES) {
    const before = app.views.length;
    await app.dispatchAction(`${id}:open`, { user: { id: ANN }, view: MENU_VIEW });
    const text = JSON.stringify(app.views.slice(before).map((v) => v.args.view.blocks));
    assert.ok(app.views.length > before, `${id}: a reply`);
    assert.doesNotMatch(text, /routing-map:/, `${id} opened a map control`);
    // Refused and logged (the demo fixture has no Office, so the two editor
    // screens stop there first; the routing-profile test below has one, and
    // checks the access refusal for all four).
    assert.ok(lines.some((l) => l.includes('"hub action refused"') && l.includes(`"${id}:open"`)), `${id}: refused`);
  }
});

test('way out, a route row clicked from an old menu once production hides it: "isn\'t available here any more"', async (t) => {
  const { app } = await boot(t, { env: 'prod' });
  for (const id of ROUTES) {
    await app.dispatchAction(`${id}:open`, { user: { id: ELY }, view: MENU_VIEW });
    assert.equal(lastView(app).blocks[0].text.text, NOT_AVAILABLE, id);
  }
});

test('way out, a waiting row: Optimize a route without the Office says why (Why?); Request a tool is ready on v1 and opens its form (Story 19.3, D12)', async (t) => {
  // The demo profile fixture has no Office (routing.depot), so the editor
  // screens wait; the routing-profile fixture below has one.
  const { app } = await boot(t);
  const view = await menu(app, '/brightside-v1', ELY);
  const row = (id) => view.blocks.find((b) => b.block_id === `entry:${id}`);
  assert.equal(row('v1-route-optimize').accessory.action_id, 'v1-route-optimize:why');
  assert.equal(row('v1-build-request').accessory.action_id, 'v1-build-request:open');
  assert.equal(row('v1-build-request').accessory.text.text, 'Request');
  await app.dispatchAction('v1-build-request:open', { user: { id: ELY }, view: MENU_VIEW });
  assert.equal(lastView(app).callback_id, BUILD_REQUEST_FORM);
  await app.dispatchAction('v1-route-optimize:why', { user: { id: ELY }, view: MENU_VIEW });
  assert.equal(app.views.at(-1).method, 'push');
});

// --- the route skills open on v1 -----------------------------------------------------

const routingProfile = loadProfile(path.join(__dirname, 'fixtures/routing-profile.yml'));
const DISPATCH = { id: slackOf(routingProfile, 'dee'), name: 'dee' };
const MEMBER = { id: slackOf(routingProfile, 'mo'), name: 'mo' };

function v1Hub(data) {
  const app = new FakeSlackApp({ views: true });
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  const log = {
    lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'),
  };
  const store = createStore();
  const mapFiles = createMapFiles({
    store, client: app.client, log, sweeping: () => true, sleep: async () => {},
  });
  const hubs = registry.hubs.filter((h) => h.id === V1 || h.id === 'brightside-v0');
  registerHubs(app, {
    registry: createRegistry({ hubs, modules: ROUTES.map((id) => registry.module(id)) }), profile: routingProfile, env: 'dev', log, store, data, mapFiles,
  });
  return { app, log };
}

test('each v1 route skill opens its own screen on /brightside-v1 for a dispatcher, and refuses a person with no routing key', async (t) => {
  const data = createData({ file: FIXTURE, profile: routingProfile });
  t.after(() => data.close());
  const { app, log } = v1Hub(data);
  const opened = {};
  for (const id of ROUTES) {
    await app.dispatchAction(`${id}:open`, { user: DISPATCH, view: MENU_VIEW });
    const view = lastView(app);
    assert.equal(view.title.text, registry.module(id).label.slice(0, 24), id);
    assert.notEqual(view.blocks[0].text && view.blocks[0].text.text, NOT_AVAILABLE, id);
    opened[id] = view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));
  }
  // Each screen asks for what its skill needs first: a crew or a day.
  for (const id of ROUTES) assert.ok(opened[id].some((a) => /^routing-map:(crew|day)$/.test(a)), `${id}: ${opened[id]}`);
  for (const id of ROUTES) {
    const before = app.views.length;
    await app.dispatchAction(`${id}:open`, { user: MEMBER, view: MENU_VIEW });
    const text = JSON.stringify(app.views.slice(before).map((v) => v.args.view.blocks));
    assert.doesNotMatch(text, /routing-map:/, `${id} opened a map control for a member with no key`);
    assert.ok(log.lines.some((l) => l.msg === 'hub action refused' && l.fields.action_id === `${id}:open` && l.fields.reason === 'AccessDenied'), `${id}: refused`);
  }
});
