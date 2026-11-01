'use strict';

// Plan hub-status-menu, Story 17.3 (D7): Why? on a waiting menu row. The
// menu's Why? button (kit/runtime/registry/menu), its listener
// (kit/runtime/slack/hubs: the module and access re-checked first, the
// status recomputed at the click) and the screen it pushes
// (kit/runtime/registry/why). Every way out: Back and the X, Request (the
// third view, whose Back returns to Why?), Request hidden, ready since the
// menu, access lost, an unknown or hidden module, an expired trigger or a
// failed push, an error, a click from an old message menu, a person not in
// the profile and the 3-second window. Then one test per row of D7's table,
// checking the exact existing words. Fixtures only: the status-menu
// fixture's profile (Ada an admin, Bo a member granted ASK and TOOL) and
// in-memory hubs built here.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const access = require('../../kit/runtime/access');
const { createRegistry } = require('../../kit/runtime/registry');
const { registerHubs, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const { buildMenu, WHY_ACTION, moduleIdFromWhy } = require('../../kit/runtime/registry/menu');
const { whyScreen, reasonFor } = require('../../kit/runtime/registry/why');
const { toolStatus } = require('../../kit/runtime/registry/status');
const statusModule = require('../../kit/runtime/registry/status');
const { WHY, VERBS } = require('../../kit/runtime/registry/vocabulary');
const {
  ASK_WORDS, BUILD_REQUEST_WORDS, WHY_WORDS,
} = require('../../kit/runtime/messages');
const { NO_STORE } = require('../../kit/runtime/archetypes/add-context');
const { PLAIN_ERROR } = require('../../kit/runtime/slack/handle');
const { MAP_CHECK } = require('../../kit/runtime/slack/image');
const { createStore } = require('../../kit/runtime/store');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime/status-menu');
const profile = loadProfile(path.join(FIX, 'profile.yml'));
const ADMIN = access.adminContact(profile);

const ADA = 'UADA'; // admin
const BO = 'UBO'; // member: ASK and TOOL
const NOBODY = 'UNOBODY'; // not in the profile

const both = ['dev', 'prod'];
const mod = (fields) => Object.freeze({ description: 'A fixture tool.', environments: both, ...fields });
const PARAMS = [{
  name: 'zone', label: 'Zone', type: 'string', enum: ['north', 'south'], required: true,
}];
// wait: a blank hub (sees nothing) with a waiting scoped pull, Ask (no AI on
// this hub), Request a tool (ready), the setup tools and the dev-only map
// check (waiting: no map files). seen: a hub that sees context, where
// Request a tool may post too (plan brightside-v1, D12). data: a hub that sees data, with no Request a
// tool, whose runner's availability a test can flip.
const HUBS = [
  { id: 'wait', command: '/wait', name: 'Wait tools', sees: [] },
  { id: 'seen', command: '/seen', name: 'Seen tools', sees: ['context'] },
  { id: 'data', command: '/data', name: 'Data tools', sees: ['data'] },
];
const MODULES = [
  mod({
    id: 'wait-pull', hub: 'wait', label: 'Visits by zone', resource: 'PULL', archetype: 'scoped-pull', parameters: PARAMS, sql: 'select 1',
  }),
  mod({
    id: 'wait-ask', hub: 'wait', label: 'Ask', resource: 'ASK', archetype: 'ask',
  }),
  mod({
    id: 'wait-request', hub: 'wait', label: 'Request a tool', resource: 'BUILD_REQUEST', archetype: 'build-request',
  }),
  mod({
    id: 'wait-tool', hub: 'wait', label: 'Say hello', resource: 'TOOL', archetype: 'handler', run: async ({ reply }) => reply('hello'),
  }),
  mod({
    id: MAP_CHECK, hub: 'wait', label: 'Map check', resource: 'TOOL', archetype: 'handler', environments: ['dev'], run: async () => {},
  }),
  mod({
    id: 'wait-add', hub: 'wait', label: 'Add context', resource: 'ADD_CONTEXT', archetype: 'add-context',
  }),
  mod({
    id: 'wait-sources', hub: 'wait', label: 'Data sources', resource: 'DATA_SOURCES', archetype: 'data-sources',
  }),
  mod({
    id: 'seen-ask', hub: 'seen', label: 'Ask', resource: 'ASK', archetype: 'ask',
  }),
  mod({
    id: 'seen-request', hub: 'seen', label: 'Request a tool', resource: 'BUILD_REQUEST', archetype: 'build-request',
  }),
  mod({
    id: 'data-pull', hub: 'data', label: 'Late visits', resource: 'PULL', archetype: 'scoped-pull', parameters: PARAMS, sql: 'select 1',
  }),
];
const registry = createRegistry({ hubs: HUBS, modules: MODULES });

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// A rules reader with nothing signed off.
const nothingSigned = () => ({
  read: () => ({
    files: [], truths: [], forbiddenColumns: 0, approvedRules: 0, checkedAt: null, problem: false,
  }),
});
const AI = Object.freeze({ ask: async () => ({}), structured: async () => ({}), readFile: async () => ({}) });

// state.data: the data hub's runner says available. llm: hub ids with an AI
// service. knowledge: false for no knowledge store. notes: a list() for
// every hub. canUse, env, prof: seams.
function setup({
  views = true, llm = ['seen-never'], knowledge = true, notes = async () => [], canUse, env = 'dev', prof = profile,
} = {}) {
  const app = new FakeSlackApp({ views });
  const log = quietLog();
  const state = { data: false };
  const runner = Object.freeze({
    run: async () => { throw new Error('Why? never runs a query'); },
    describe: () => ({ source: 'local fixture', label: 'tiny.duckdb', available: state.data }),
  });
  const forHub = (hubId) => {
    const hub = HUBS.find((h) => h.id === hubId);
    return Object.freeze({
      id: hubId,
      sees: hub.sees,
      data: hub.sees.includes('data') ? runner : null,
      llm: llm.includes(hubId) ? AI : null,
      rules: hub.sees.includes('rules'),
      knowledge: knowledge ? Object.freeze({ list: notes, add: async () => { throw new Error('not here'); }, remove: async () => {} }) : null,
    });
  };
  registerHubs(app, {
    registry, profile: prof, env, log, store: createStore(), forHub, rules: nothingSigned(), ...(canUse ? { canUse } : {}),
  });
  return { app, log, state };
}

const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const block = (view, id) => view.blocks.find((b) => b.block_id === id);
const rowOf = (view, id) => block(view, `entry:${id}`);
// A row's status line: the context block under it (subtle health), or null.
// A row's status: the mrkdwn after "*<label>* · " in the row's own section
// (inline, 2026-10-31 live check), or null for a healthy row.
const statusOf = (view, id) => {
  const b = block(view, `entry:${id}`);
  const m = b ? /^\*[^*]*\*( · (.+))?$/s.exec(b.text.text) : null;
  return m && m[2] ? m[2] : null;
};
const textOf = (view) => view.blocks.map((b) => (b.text ? b.text.text : '')).join('\n');
const buttonsOf = (view) => view.blocks.flatMap((b) => [b.accessory, ...(b.elements || [])]).filter((e) => e && e.type === 'button');
const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((r) => { setImmediate(r); }); };

// Opens the hub's menu as user and returns it (with the id the fake gave it).
async function menu(s, user, command) {
  await s.app.dispatchCommand(command, { user_id: user });
  const view = calls(s.app, 'open').at(-1).view;
  return { ...view, id: `V${s.app.viewSeq}`, hash: `h${s.app.viewSeq}` };
}

// Presses Why? on a row of the menu: returns the pushed view and its id.
async function why(s, user, menuView, moduleId) {
  const row = rowOf(menuView, moduleId);
  assert.ok(row, `${moduleId} is on the menu`);
  assert.equal(row.accessory.text.text, WHY, moduleId);
  assert.equal(await s.app.dispatchAction(row.accessory.action_id, { user: { id: user }, view: menuView }), 1);
  const pushed = calls(s.app, 'push').at(-1);
  return { view: pushed.view, id: `V${s.app.viewSeq}`, hash: `h${s.app.viewSeq}` };
}

// --- the menu's Why? button -----------------------------------------------------------------

test('a waiting row shows Why? (<id>:why) instead of its verb; every other row keeps its verb and <id>:open', async () => {
  const s = setup();
  const view = await menu(s, ADA, '/wait');
  const rows = view.blocks.filter((b) => /^entry:/.test(b.block_id || '')).map((b) => [b.block_id.slice(6), statusOf(view, b.block_id.slice(6)), b.accessory.text.text, b.accessory.action_id]);
  assert.deepEqual(rows, [
    ['wait-pull', '⚪ _needs data_', WHY, 'wait-pull:why'],
    ['wait-ask', '⚪ _needs the AI_', WHY, 'wait-ask:why'],
    ['wait-request', null, 'Request', 'wait-request:open'],
    ['wait-tool', null, 'Run', 'wait-tool:open'],
    [MAP_CHECK, '⚪ _needs map setup_', WHY, `${MAP_CHECK}:why`],
    ['wait-add', '⚪ _not started_', 'Add', 'wait-add:open'],
    ['wait-sources', '_no data on this hub_', 'View', 'wait-sources:open'],
  ]);
  // Why? is never a manifest's verb, and its pattern names the module.
  assert.ok(!VERBS.includes(WHY));
  assert.equal(moduleIdFromWhy('wait-pull:why'), 'wait-pull');
  assert.equal(moduleIdFromWhy('wait-pull:open'), null);
  assert.ok(!WHY_ACTION.test('wait-pull:open'));
});

test('buildMenu: a waiting row with no status line (a guard caught it) or still "Checking…" keeps its verb', () => {
  const hub = { id: 'h', name: 'H' };
  const rows = [{ entry: { id: 'a', label: 'A', archetype: 'scoped-pull' }, status: { key: 'waiting', detail: 'needs data' }, verb: 'Run' }];
  const checking = buildMenu(hub, rows, { strip: true, checking: true });
  assert.equal(checking.blocks.find((b) => b.block_id === 'entry:a').accessory.action_id, 'a:open');
  const unworded = buildMenu(hub, [{ ...rows[0], status: { key: 'waiting', detail: 42 } }], {});
  assert.equal(unworded.blocks.find((b) => b.block_id === 'entry:a').accessory.text.text, 'Run');
  const shown = buildMenu(hub, rows, {});
  assert.equal(shown.blocks.find((b) => b.block_id === 'entry:a').accessory.text.text, WHY);
});

// --- the screen ---------------------------------------------------------------------------

test('Why? pushes a view titled with the tool\'s label: its status line, what is missing in the existing words, and Request', async () => {
  const s = setup();
  const m = await menu(s, ADA, '/wait');
  const { view } = await why(s, ADA, m, 'wait-pull');
  assert.equal(view.title.text, 'Visits by zone');
  assert.equal(view.close.text, 'Back');
  assert.equal(block(view, 'why:status').text.text, '*Visits by zone*\n⚪ needs data');
  assert.equal(block(view, 'why:reason').text.text, ASK_WORDS.noDataNoRules());
  const request = block(view, 'why:request');
  assert.equal(request.accessory.action_id, 'wait-request:open');
  assert.equal(request.accessory.text.text, 'Request');
  assert.equal(request.accessory.style, undefined, 'the menu\'s only primary button is its next step');
  assert.equal(block(view, 'why:ask'), undefined);
  assert.ok(s.log.lines.some((l) => l.msg === 'why shown' && l.fields.module === 'wait-pull' && l.fields.waiting === true));
});

test('way out, Back and the X: the Why? view is pushed on the menu (Back returns there) and asks for no view_closed', async () => {
  const s = setup();
  const m = await menu(s, ADA, '/wait');
  const shown = await why(s, ADA, m, 'wait-pull');
  assert.equal(s.app.parentOf(shown.id), m.id, 'Back returns to the menu');
  assert.equal(s.app.depthOf(shown.id), 2);
  assert.equal(shown.view.close.text, 'Back');
  assert.equal(shown.view.notify_on_close, undefined);
  assert.equal(await s.app.dispatchViewClosed(shown.view.callback_id, { user: { id: ADA }, view: shown.view }), 0, 'the X runs nothing');
});

test('way out, Request: pushes the build-request form as the third view, whose Back returns to Why?; nothing is carried into it', async () => {
  const s = setup();
  const m = await menu(s, ADA, '/wait');
  const shown = await why(s, ADA, m, 'wait-pull');
  const button = block(shown.view, 'why:request').accessory;
  assert.equal(await s.app.dispatchAction(button.action_id, { user: { id: ADA }, view: { ...shown.view, id: shown.id, hash: shown.hash } }), 1);
  const form = calls(s.app, 'push').at(-1).view;
  const formId = `V${s.app.viewSeq}`;
  assert.equal(form.callback_id, 'build-request:form');
  assert.equal(form.title.text, 'Request a tool');
  assert.equal(form.close.text, 'Back');
  assert.equal(s.app.depthOf(formId), 3, 'the third view');
  assert.equal(s.app.parentOf(formId), shown.id, 'Back returns to Why?');
  // The form opens empty.
  const input = form.blocks.find((b) => b.type === 'input');
  assert.equal(input.element.initial_value, undefined);
});

test('the fake refuses a fourth view as Slack does (push_limit_reached), so the Request form is the last view Why? can push', async () => {
  const s = setup();
  const m = await menu(s, ADA, '/wait');
  const shown = await why(s, ADA, m, 'wait-pull');
  await s.app.dispatchAction('wait-request:open', { user: { id: ADA }, view: { ...shown.view, id: shown.id } });
  const formId = `V${s.app.viewSeq}`;
  // A push from inside the third view (a hand-made click) is refused.
  await s.app.dispatchAction('wait-tool:open', { user: { id: ADA }, view: { id: formId, type: 'modal', private_metadata: 'wait' } });
  assert.ok(s.log.lines.some((l) => l.msg === 'hub modal fallback' && l.fields.reason === 'push_limit_reached'));
});

// --- Request hidden: "Ask <admin> about it." ----------------------------------------------------

function endsAskingAdmin(view) {
  assert.equal(block(view, 'why:request'), undefined);
  assert.equal(view.blocks.at(-1).block_id, 'why:ask');
  assert.equal(view.blocks.at(-1).text.text, WHY_WORDS.askAdmin(ADMIN));
  assert.equal(WHY_WORDS.askAdmin(ADMIN), `Ask ${ADMIN} about it.`);
  assert.deepEqual(buttonsOf(view), []);
}

test('Request hidden, no Request a tool on this hub: the screen ends "Ask <admin> about it."', async () => {
  const s = setup();
  const m = await menu(s, ADA, '/data');
  const { view } = await why(s, ADA, m, 'data-pull');
  assert.equal(block(view, 'why:reason').text.text, ASK_WORDS.noDataNoRules());
  endsAskingAdmin(view);
});

test('Request hidden, the person lacks it: Bo (no BUILD_REQUEST) on Ask with no AI', async () => {
  const s = setup();
  const m = await menu(s, BO, '/wait');
  const { view } = await why(s, BO, m, 'wait-ask');
  assert.equal(block(view, 'why:reason').text.text, WHY_WORDS.noAi(ADMIN));
  endsAskingAdmin(view);
});

test('Request hidden, no channel: Request a tool itself waits, and Why? on it or on another tool ends "Ask <admin> about it."', async () => {
  const s = setup({ prof: { ...profile, slack: {} } });
  const m = await menu(s, ADA, '/wait');
  assert.equal(rowOf(m, 'wait-request').accessory.action_id, 'wait-request:why');
  const onRequest = await why(s, ADA, m, 'wait-request');
  assert.equal(block(onRequest.view, 'why:reason').text.text, BUILD_REQUEST_WORDS.notSetUp(ADMIN));
  endsAskingAdmin(onRequest.view);
  const onPull = await why(s, ADA, m, 'wait-pull');
  endsAskingAdmin(onPull.view);
});

test('D12: on a hub that sees context, Request a tool is ready (no Why?), and Why? on a waiting Ask offers it', async () => {
  const s = setup();
  const m = await menu(s, ADA, '/seen');
  assert.equal(rowOf(m, 'seen-request').accessory.action_id, 'seen-request:open');
  const onAsk = await why(s, ADA, m, 'seen-ask');
  assert.equal(block(onAsk.view, 'why:reason').text.text, WHY_WORDS.noAi(ADMIN));
  assert.equal(block(onAsk.view, 'why:request').text.text, WHY_WORDS.request('Request a tool'));
  assert.equal(block(onAsk.view, 'why:ask'), undefined, 'not "Ask <admin> about it."');
});

// --- recomputed at the click --------------------------------------------------------------

test('the tool became ready since the menu was built: "This is ready now. Press Back, then Run it from the menu."', async () => {
  const s = setup();
  const m = await menu(s, ADA, '/data');
  assert.equal(rowOf(m, 'data-pull').accessory.text.text, WHY);
  s.state.data = true;
  await s.app.dispatchAction('data-pull:why', { user: { id: ADA }, view: m });
  const view = calls(s.app, 'push').at(-1).view;
  assert.equal(block(view, 'why:status').text.text, `*Late visits*\n${WHY_WORDS.readyNow('Run')}`);
  assert.equal(WHY_WORDS.readyNow('Run'), 'This is ready now. Press Back, then Run it from the menu.');
  assert.deepEqual(buttonsOf(view), []);
});

// --- refused ------------------------------------------------------------------------------

test('the person lost access since the menu: the existing refusal, in the view; nothing else is read', async () => {
  let allowed = true;
  const s = setup({ canUse: (person, m) => (m.archetype === 'ask' ? allowed : access.decide(profile, person.user, m.resource)) });
  const m = await menu(s, BO, '/wait');
  allowed = false;
  await s.app.dispatchAction('wait-ask:why', { user: { id: BO }, view: m });
  const view = calls(s.app, 'push').at(-1).view;
  assert.equal(textOf(view), `You don't have access to Ask; ask ${ADMIN}.`);
  assert.ok(s.log.lines.some((l) => l.msg === 'hub action refused' && l.fields.action_id === 'wait-ask:why' && l.fields.reason === 'AccessDenied'));
  assert.ok(!s.log.lines.some((l) => l.msg === 'why shown'));
});

test('an unknown module, or one hidden in this environment: the existing "isn\'t available here any more"', async () => {
  const s = setup({ env: 'prod' });
  const m = { id: 'VMENU', type: 'modal', private_metadata: 'wait' };
  for (const id of ['nope:why', `${MAP_CHECK}:why`]) {
    await s.app.dispatchAction(id, { user: { id: ADA }, view: m });
    const view = calls(s.app, 'push').at(-1).view;
    assert.equal(textOf(view), NOT_AVAILABLE, id);
    assert.equal(view.title.text, 'Not available', id);
  }
  assert.deepEqual(s.log.lines.filter((l) => l.msg === 'hub action refused').map((l) => l.fields.reason), ['unknown module', 'hidden in this environment']);
});

test('never more than the person could see: a person not in the profile gets the not-set-up notice only, and a member clicking a Setup tool gets "not available"', async () => {
  const s = setup({ canUse: () => 'allowed' });
  const m = { id: 'VMENU', type: 'modal', private_metadata: 'wait' };
  await s.app.dispatchAction('wait-pull:why', { user: { id: NOBODY }, view: m });
  const stranger = calls(s.app, 'push').at(-1).view;
  assert.match(textOf(stranger), /^You're not set up in Tiny's bot yet/);
  assert.doesNotMatch(textOf(stranger), /Waiting|data|rules/i);
  // Bo granted Add context by name never sees the Setup group, so not its Why? either.
  await s.app.dispatchAction('wait-add:why', { user: { id: BO }, view: m });
  assert.equal(textOf(calls(s.app, 'push').at(-1).view), NOT_AVAILABLE);
  assert.ok(!s.log.lines.some((l) => l.msg === 'why shown'));
});

test('never more than the person could see: Why? shows the status line their row showed and the yes-or-no words, never a note, truth or rule', async () => {
  const NOTE = 'NOTE_TEXT_NEVER_SHOWN';
  const s = setup({ notes: async () => [{ id: '0'.repeat(32), kind: 'text', title: NOTE, text: NOTE, addedBy: ADA, addedAt: 0 }] });
  const m = await menu(s, ADA, '/wait');
  const { view } = await why(s, ADA, m, 'wait-pull');
  // The same label and status as the row (the row has them inline, the
  // screen on two lines, the words not in italics).
  assert.equal(rowOf(m, 'wait-pull').text.text, '*Visits by zone* · ⚪ _needs data_');
  assert.equal(block(view, 'why:status').text.text, '*Visits by zone*\n⚪ needs data');
  assert.ok(!JSON.stringify(view).includes(NOTE));
  // Pure: nothing in readiness's detail reaches the screen.
  const ready = { data: false, rules: false, detail: { rules: { truths: [{ name: 'RULE_TEXT_NEVER_SHOWN' }] } } };
  const screen = whyScreen({
    mod: MODULES[0], status: { key: 'waiting', detail: 'needs data' }, ready, admin: ADMIN,
  });
  assert.ok(!JSON.stringify(screen).includes('RULE_TEXT_NEVER_SHOWN'));
});

// --- errors and fallbacks -----------------------------------------------------------------

test('way out, an error: the status throwing at the click gives the plain error in the view, logged', async (t) => {
  const s = setup();
  const m = await menu(s, ADA, '/wait');
  t.mock.method(statusModule, 'toolStatus', () => { throw new Error('boom'); });
  await s.app.dispatchAction('wait-pull:why', { user: { id: ADA }, view: m });
  assert.equal(textOf(calls(s.app, 'push').at(-1).view), PLAIN_ERROR);
  assert.ok(s.log.lines.some((l) => l.msg === 'handler failed' && l.fields.handler === 'hub:why'));
});

test('way out, an expired trigger or a failed push: the existing in-place fallback on the menu, logged with Slack\'s code', async () => {
  const s = setup();
  const m = await menu(s, ADA, '/wait');
  s.app.viewsFail.push = Object.assign(new Error('An API error occurred: expired_trigger_id'), { data: { ok: false, error: 'expired_trigger_id' } });
  await s.app.dispatchAction('wait-pull:why', { user: { id: ADA }, view: m });
  const update = calls(s.app, 'update').at(-1);
  assert.equal(update.view_id, m.id);
  assert.equal(block(update.view, 'why:reason').text.text, ASK_WORDS.noDataNoRules());
  assert.ok(s.log.lines.some((l) => l.msg === 'hub modal fallback' && l.fields.where === 'why' && l.fields.reason === 'expired_trigger_id' && l.fields.via === 'views.update'));
});

test('way out, a click from an old message menu: the words as a private reply, with no buttons', async () => {
  const s = setup({ views: false });
  await s.app.dispatchCommand('/wait', { user_id: ADA });
  const [old] = s.app.responded;
  assert.equal(rowOf(old, 'wait-pull').accessory.action_id, 'wait-pull:why');
  await s.app.dispatchAction('wait-pull:why', { user: { id: ADA } });
  const reply = s.app.responded.at(-1);
  assert.equal(reply.response_type, 'ephemeral');
  assert.equal(reply.blocks, undefined);
  assert.equal(reply.text, [
    'Visits by zone: ⚪ needs data', ASK_WORDS.noDataNoRules(), WHY_WORDS.requestInWindow('Request a tool'),
  ].join('\n'));
  assert.ok(!/button/.test(JSON.stringify(reply)));
});

test('the 3-second window: the click is acked first, and with slow notes Why? is pushed after the menu\'s budget, not after the notes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const gate = { release: null };
  const slow = () => new Promise((r) => { gate.release = () => r([]); });
  const s = setup({ notes: async () => [] });
  const m = await menu(s, ADA, '/wait');
  const s2 = setup({ notes: slow });
  const pushes = () => calls(s2.app, 'push').length;
  const done = s2.app.dispatchAction('wait-pull:why', { user: { id: ADA }, view: m });
  await settle();
  assert.equal(s2.app.acks, 1, 'acked before anything is read');
  assert.equal(pushes(), 0);
  t.mock.timers.tick(1000);
  await done;
  assert.equal(pushes(), 1, 'pushed at the budget, inside the trigger\'s 3 seconds');
  assert.equal(block(calls(s2.app, 'push')[0].view, 'why:reason').text.text, ASK_WORDS.noDataNoRules());
  gate.release();
});

// --- D7's table, one test per row: the exact existing words ---------------------------------

const ready = (data, rules) => ({ data, rules, detail: {} });
const summaryOf = (steps) => ({ counts: { notes: 1 }, steps, problem: false });
const reasonOf = (screen) => (screen.blocks.find((b) => b.block_id === 'why:reason') || { text: {} }).text.text;

test('D7: waiting for data and rules (a scoped pull, approval write or routing map on a hub with no data): the Ask readiness words, by readiness', () => {
  for (const archetype of ['scoped-pull', 'approval-write', 'routing-map']) {
    const m = { id: 'x', label: 'X', archetype };
    for (const [r, words] of [[ready(false, false), ASK_WORDS.noDataNoRules()], [ready(false, true), ASK_WORDS.rulesNoData()]]) {
      const status = toolStatus(m, { ready: r, summary: summaryOf([]) });
      assert.deepEqual(status, { key: 'waiting', detail: 'needs data' }, archetype);
      assert.equal(reasonOf(whyScreen({ mod: m, status, ready: r, admin: ADMIN })), words, archetype);
    }
  }
  // Data and no rules has its own words too (D10's table), should a tool wait on data then.
  assert.equal(reasonFor('needs data', { ready: ready(true, false), admin: ADMIN }), ASK_WORDS.dataNoRules());
});

test('D7: waiting for a build-request channel: BUILD_REQUEST_WORDS.notSetUp(admin)', () => {
  const m = { id: 'r', label: 'Request a tool', archetype: 'build-request' };
  const status = toolStatus(m, { ready: ready(false, false), requests: { available: false, reason: 'channel' } });
  assert.equal(reasonOf(whyScreen({ mod: m, status, ready: ready(false, false), admin: ADMIN })), BUILD_REQUEST_WORDS.notSetUp(ADMIN));
});

test('D7: waiting for a hub that may post: BUILD_REQUEST_WORDS.notOnThisHub', () => {
  const m = { id: 'r', label: 'Request a tool', archetype: 'build-request' };
  const status = toolStatus(m, { ready: ready(false, false), requests: { available: false, reason: 'hub' } });
  assert.equal(reasonOf(whyScreen({ mod: m, status, ready: ready(false, false), admin: ADMIN })), BUILD_REQUEST_WORDS.notOnThisHub());
});

test('D7: waiting for the map setup (a routing map with data, or the map check): "The map isn\'t set up on this bot yet. Ask <admin>."', () => {
  const routing = { id: 'map', label: 'Map', archetype: 'routing-map' };
  const check = {
    id: MAP_CHECK, label: 'Map check', archetype: 'handler', environments: ['dev'],
  };
  for (const [m, facts] of [[routing, { mapReady: false }], [routing, { mapReady: true, unready: true }], [check, { mapReady: false }]]) {
    const status = toolStatus(m, { ready: ready(true, true), ...facts });
    assert.deepEqual(status, { key: 'waiting', detail: 'needs map setup' }, m.id);
    assert.equal(reasonOf(whyScreen({ mod: m, status, ready: ready(true, true), admin: ADMIN })), WHY_WORDS.noMap(ADMIN), m.id);
  }
  assert.equal(WHY_WORDS.noMap('<@U1>'), "The map isn't set up on this bot yet. Ask <@U1>.");
});

test('D7: waiting for the AI service: "The AI helper isn\'t set up on this bot yet. Ask <admin>."', () => {
  const m = { id: 'a', label: 'Ask', archetype: 'ask' };
  const status = toolStatus(m, { ready: ready(false, false), llm: false, summary: summaryOf([]) });
  assert.deepEqual(status, { key: 'waiting', detail: 'needs the AI' });
  assert.equal(reasonOf(whyScreen({ mod: m, status, ready: ready(false, false), admin: ADMIN })), WHY_WORDS.noAi(ADMIN));
  assert.equal(WHY_WORDS.noAi('<@U1>'), "The AI helper isn't set up on this bot yet. Ask <@U1>.");
});

test('D7: waiting for the knowledge store: add-context\'s NO_STORE(admin)', async () => {
  const m = { id: 'c', label: 'Add context', archetype: 'add-context' };
  const status = toolStatus(m, { ready: ready(false, false), knowledge: false });
  assert.equal(reasonOf(whyScreen({ mod: m, status, ready: ready(false, false), admin: ADMIN })), NO_STORE(ADMIN));
  // Through the listener too: an admin's Add context on a bot with no store.
  const s = setup({ knowledge: false });
  const menuView = await menu(s, ADA, '/wait');
  const { view } = await why(s, ADA, menuView, 'wait-add');
  assert.equal(block(view, 'why:reason').text.text, NO_STORE(ADMIN));
});

test('D7: a waiting detail with no words (a status added later) shows its status line and the last line, never a guess', () => {
  const m = { id: 'x', label: 'X', archetype: 'handler' };
  const screen = whyScreen({
    mod: m, status: { key: 'waiting', detail: 'needs something new' }, ready: ready(false, false), admin: ADMIN,
  });
  assert.deepEqual(screen.blocks.map((b) => b.block_id), ['why:status', 'why:ask']);
  assert.throws(() => whyScreen({}), TypeError);
});
