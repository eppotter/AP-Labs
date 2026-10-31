'use strict';

// Plan hub-status-menu, Story 17.4 (D6): the next-step line and the "New"
// record. The rule (kit/runtime/registry/next-step, pure: one test per row
// of D6's table, first match wins, a waiting tool never chosen), its block in
// the menu (kit/runtime/registry/menu: the only primary button) and the seen
// record the slash command keeps (kit/runtime/slack/hubs: seen:<slack
// id>:<hub id> in the store's welcome namespace, read before it is written).
// Every way out of the next-step button, the guard, two hubs and the 7-day
// expiry. Fixtures only: test/fixtures/runtime/status-menu (Ada an admin, Bo
// a member granted ASK and TOOL) and in-memory hubs built here.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const access = require('../../kit/runtime/access');
const { loadRegistry, createRegistry } = require('../../kit/runtime/registry');
const { createRulesReader } = require('../../kit/runtime/knowledge/readiness');
const { registerHubs, newSinceLastMenu, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const { buildMenu } = require('../../kit/runtime/registry/menu');
const nextStepModule = require('../../kit/runtime/registry/next-step');
const {
  nextStep, TEACH, TEACH_LABEL, FIRST_TOOL, FIRST_TOOL_LABEL,
} = nextStepModule;
const { VERBS } = require('../../kit/runtime/registry/vocabulary');
const { createStore } = require('../../kit/runtime/store');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime/status-menu');
const PROFILE_PATH = path.join(FIX, 'profile.yml');
const profile = loadProfile(PROFILE_PATH);
const { registry } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });
const ADMIN = access.adminContact(profile);

const ADA = 'UADA'; // admin
const BO = 'UBO'; // member: ASK and TOOL
const NOBODY = 'UNOBODY'; // not in the profile
const DAY = 24 * 60 * 60 * 1000;

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

const fixtureRules = () => createRulesReader({ profile, profilePath: PROFILE_PATH, readLast: () => null });
const note = (i) => ({
  id: `${String(i).padStart(32, '0')}`, kind: 'text', title: `Note ${i}`, text: 'NOTE_TEXT_NEVER_SHOWN', addedBy: ADA, addedAt: 0,
});
const notesOf = (n) => Array.from({ length: n }, (_, i) => note(i));
const AI = Object.freeze({ ask: async () => ({}), structured: async () => ({}), readFile: async () => ({}) });

// A store that records every get and set on a seen: key, in order.
function recordingStore(store = createStore()) {
  const log = [];
  return {
    log,
    store: {
      ...store,
      get: (ns, key) => {
        if (String(key).startsWith('seen:')) log.push(`get ${key}`);
        return store.get(ns, key);
      },
      set: (ns, key, ...rest) => {
        if (String(key).startsWith('seen:')) log.push(`set ${key}`);
        return store.set(ns, key, ...rest);
      },
    },
  };
}

// notes: hub id -> a count or a list() function. hidden: module ids no one
// may open just now (a Set the test changes between opens). reg, env, store:
// seams.
function setup({
  notes = {}, hidden = new Set(), reg = registry, env = 'dev', store = createStore(), views = true,
} = {}) {
  const app = new FakeSlackApp({ views });
  const log = quietLog();
  const runner = Object.freeze({
    run: async () => { throw new Error('the menu never runs a query'); },
    describe: () => ({ source: 'local fixture', label: 'tiny.duckdb', available: true }),
  });
  const forHub = (hubId) => {
    const hub = reg.hubs.find((h) => h.id === hubId);
    const sees = hub.sees || [];
    const n = notes[hubId];
    const list = typeof n === 'function' ? n : async () => notesOf(n || 0);
    return Object.freeze({
      id: hubId,
      sees,
      data: sees.includes('data') ? runner : null,
      llm: AI,
      rules: sees.includes('rules'),
      knowledge: Object.freeze({ list, add: async () => { throw new Error('not here'); }, remove: async () => {} }),
    });
  };
  const canUse = (person, mod) => !hidden.has(mod.id) && access.decide(profile, person.user, mod.resource);
  registerHubs(app, {
    registry: reg, profile, env, log, store, forHub, rules: fixtureRules(), canUse,
  });
  return { app, log };
}

const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const block = (view, id) => view.blocks.find((b) => b.block_id === id);
const nextOf = (view) => {
  const b = block(view, 'next');
  return b ? {
    text: b.text.text, label: b.accessory.text.text, action: b.accessory.action_id, style: b.accessory.style,
  } : null;
};
const buttons = (view) => view.blocks.flatMap((b) => [b.accessory, ...(b.elements || [])]).filter((e) => e && e.type === 'button');
const textOf = (view) => view.blocks.map((b) => (b.text ? b.text.text : '')).join('\n');
const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((r) => { setImmediate(r); }); };

async function open(s, user, command) {
  await s.app.dispatchCommand(command, { user_id: user });
  const view = calls(s.app, 'open').at(-1).view;
  return { ...view, id: `V${s.app.viewSeq}`, hash: `h${s.app.viewSeq}` };
}

// --- the rule, pure (D6) ------------------------------------------------------------------------

const entry = (id, archetype, label = id) => Object.freeze({ id, archetype, label });
const row = (e, key, verb = 'Run') => ({ entry: e, status: key ? { key, detail: null } : null, verb });
const ASK = entry('h-ask', 'ask', 'Ask');
const ADD = entry('h-add', 'add-context', 'Add context');
const SOURCES = entry('h-sources', 'data-sources', 'Data sources');
const REQUEST = entry('h-request', 'build-request', 'Request a tool');
const PULL = entry('h-pull', 'scoped-pull', 'Visits <by> zone & more');
const summary = (taught, problem = false) => ({
  counts: {
    notes: taught ? 1 : 0, sources: 0, truths: 0, rules: 0,
  },
  steps: [{ step: 'taught', counted: true, done: taught }],
  done: taught ? 1 : 0,
  of: 1,
  problem,
});
const TEMPLATE = [ASK, ADD, SOURCES, REQUEST];
const templateRows = (add = 'not-started', request = 'ready') => [
  row(ASK, 'partly', 'Ask'), row(REQUEST, request, 'Request'), row(ADD, add, 'Add'), row(SOURCES, 'done', 'View'),
];

test('rule 1: an admin, nothing taught yet, an Add context row: "Next: teach it the business" with Add context, sending the row\'s own :open', () => {
  const got = nextStep({
    summary: summary(false), admin: true, rows: templateRows(), newIds: [], hubTools: TEMPLATE,
  });
  assert.deepEqual(got, {
    text: TEACH, label: TEACH_LABEL, moduleId: 'h-add', actionId: 'h-add:open',
  });
  assert.equal(TEACH, '*Next:* teach it the business');
  assert.equal(TEACH_LABEL, 'Add context');
  // A member never sees a setup step, even handed an Add context row.
  assert.equal(nextStep({ summary: summary(false), admin: false, rows: templateRows() }), null);
  // No Add context row in the menu: nothing to point at.
  assert.equal(nextStep({ summary: summary(false), admin: true, rows: templateRows().filter((r) => r.entry !== ADD) }), null);
});

test('rule 2: anyone, a tool new to them that is ready or partly: "New: <label>" (escaped) with its verb', () => {
  const rows = [row(ASK, 'partly', 'Ask'), row(PULL, 'ready', 'Run')];
  for (const admin of [true, false]) {
    assert.deepEqual(nextStep({
      summary: summary(true), admin, rows, newIds: ['h-pull'], hubTools: [ASK, PULL],
    }), {
      text: '*New:* Visits &lt;by&gt; zone &amp; more', label: 'Run', moduleId: 'h-pull', actionId: 'h-pull:open',
    });
  }
  // Partly ready counts too.
  assert.equal(nextStep({ summary: summary(true), rows, newIds: ['h-ask'] }).label, 'Ask');
  // The first new row in menu order.
  assert.equal(nextStep({ summary: summary(true), rows, newIds: ['h-pull', 'h-ask'] }).moduleId, 'h-ask');
  // A new id not in this menu is never chosen.
  assert.equal(nextStep({ summary: summary(true), rows, newIds: ['h-elsewhere'] }), null);
});

test('rule 3: an admin, taught, only the template tools on the hub, a ready Request a tool row: "Next: request your first tool" with Request', () => {
  assert.deepEqual(nextStep({
    summary: summary(true), admin: true, rows: templateRows('done'), newIds: [], hubTools: TEMPLATE,
  }), {
    text: FIRST_TOOL, label: FIRST_TOOL_LABEL, moduleId: 'h-request', actionId: 'h-request:open',
  });
  assert.equal(FIRST_TOOL, '*Next:* request your first tool');
  assert.ok(VERBS.includes(FIRST_TOOL_LABEL));
  // Any other tool on the hub, even one this admin can't see: no line.
  assert.equal(nextStep({
    summary: summary(true), admin: true, rows: templateRows('done'), hubTools: [...TEMPLATE, PULL],
  }), null);
  // A member: never.
  assert.equal(nextStep({
    summary: summary(true), admin: false, rows: templateRows('done'), hubTools: TEMPLATE,
  }), null);
});

test('no line when nothing sensible applies', () => {
  assert.equal(nextStep({
    summary: summary(true), admin: true, rows: [row(ASK, 'ready', 'Ask'), row(PULL, 'ready')], hubTools: [ASK, PULL],
  }), null);
  assert.equal(nextStep({ summary: summary(true), admin: false, rows: [] }), null);
  assert.equal(nextStep(), null);
  // A summary that couldn't be read gives no setup step (rules 1 and 3).
  assert.equal(nextStep({ summary: summary(false, true), admin: true, rows: templateRows() }), null);
  assert.equal(nextStep({ summary: null, admin: true, rows: templateRows() }), null);
  assert.throws(() => nextStep({ rows: 'nope' }), TypeError);
});

test('the first match wins: teach before New, New before request your first tool', () => {
  const rows = templateRows();
  assert.equal(nextStep({
    summary: summary(false), admin: true, rows, newIds: ['h-ask', 'h-request'], hubTools: TEMPLATE,
  }).text, TEACH);
  assert.equal(nextStep({
    summary: summary(true), admin: true, rows: templateRows('done'), newIds: ['h-ask'], hubTools: TEMPLATE,
  }).text, '*New:* Ask');
});

test('a waiting tool (or one with no status) is never chosen, by any rule', () => {
  // Rule 1: Add context waiting (no store).
  assert.equal(nextStep({
    summary: summary(false), admin: true, rows: templateRows('waiting'), hubTools: TEMPLATE,
  }), null);
  // Rule 2: the new tool waits, or has no status line.
  for (const key of ['waiting', null, 'not-started', 'done']) {
    assert.equal(nextStep({
      summary: summary(true), rows: [row(PULL, key)], newIds: ['h-pull'], hubTools: [PULL],
    }), null, String(key));
  }
  // Rule 3: Request a tool waiting (no channel).
  assert.equal(nextStep({
    summary: summary(true), admin: true, rows: templateRows('done', 'waiting'), hubTools: TEMPLATE,
  }), null);
});

// --- the block (menu.js) ------------------------------------------------------------------------

test('buildMenu renders the next step as block "next", after the welcome, with the only primary button; never while checking, never without the strip, never for a row not in the menu', () => {
  const hub = { id: 'h', name: 'H' };
  const rows = templateRows();
  const next = nextStep({
    summary: summary(false), admin: true, rows, hubTools: TEMPLATE,
  });
  const menu = buildMenu(hub, rows, {
    admin: true, strip: true, summary: summary(false), welcome: 'Hi.', next,
  });
  const ids = menu.blocks.map((b) => b.block_id || b.type);
  assert.equal(ids.indexOf('next'), ids.indexOf('welcome') + 1);
  assert.deepEqual(buttons(menu).filter((b) => b.style === 'primary').map((b) => b.action_id), ['h-add:open']);
  assert.ok(menu.text.includes(TEACH), 'the plain-text fallback says it too');
  assert.equal(block(buildMenu(hub, rows, { admin: true, strip: true, checking: true, next }), 'next'), undefined);
  assert.equal(block(buildMenu(hub, rows, { admin: true, strip: false, next }), 'next'), undefined);
  // A member's menu leaves the setup rows out, so their next step can't show.
  assert.equal(block(buildMenu(hub, rows, { admin: false, strip: true, summary: summary(false), next }), 'next'), undefined);
  // An action id that isn't the row's own :open is refused.
  assert.equal(block(buildMenu(hub, rows, { admin: true, strip: true, next: { ...next, actionId: 'h-add:why' } }), 'next'), undefined);
});

// --- the menu, through the slash command ----------------------------------------------------------

test('at most one primary button, and it is the next step\'s, in every stage, for every person, before and after a tool appears', async () => {
  const stages = [['/blank', {}], ['/blank', { notes: { blank: 2 } }], ['/first-tool', {}], ['/full', { notes: { full: 3 } }], ['/onboarded', {}]];
  for (const [command, opts] of stages) {
    for (const user of [ADA, BO, NOBODY]) {
      const hidden = new Set(['blank-request', 'full-tool-a', 'first-pull', 'onboarded-ask']);
      const s = setup({ ...opts, hidden });
      const views = [await open(s, user, command)];
      hidden.clear();
      views.push(await open(s, user, command));
      for (const view of views) {
        const primary = buttons(view).filter((b) => b.style === 'primary');
        assert.ok(primary.length <= 1, `${command} ${user}`);
        if (primary.length) assert.equal(block(view, 'next').accessory, primary[0], `${command} ${user}`);
      }
    }
  }
});

test('the blank hub for an admin: "Next: teach it the business"; once taught, with only the template tools: "Next: request your first tool"; a member sees neither', async () => {
  const blank = setup();
  assert.deepEqual(nextOf(await open(blank, ADA, '/blank')), {
    text: TEACH, label: 'Add context', action: 'blank-add:open', style: 'primary',
  });
  assert.equal(nextOf(await open(blank, BO, '/blank')), null);
  const taught = setup({ notes: { blank: 1 } });
  assert.deepEqual(nextOf(await open(taught, ADA, '/blank')), {
    text: FIRST_TOOL, label: 'Request', action: 'blank-request:open', style: 'primary',
  });
  assert.equal(nextOf(await open(taught, BO, '/blank')), null);
  // The full hub has its own tools: no "first tool" line.
  assert.equal(nextOf(await open(setup({ notes: { full: 3 } }), ADA, '/full')), null);
});

test('a first visit has no "New" line, even though every tool is new to the person', async () => {
  const s = setup();
  const view = await open(s, BO, '/full');
  assert.equal(block(view, 'next'), undefined);
  assert.ok(block(view, 'welcome'), 'a first visit');
});

test('a tool added between two opens is "New" on the second (its verb, its own :open), and not on the third', async () => {
  const full = new Set(['full-tool-a']);
  const s = setup({ hidden: full, notes: { full: 3 } });
  const first = await open(s, BO, '/full');
  assert.equal(block(first, 'entry:full-tool-a'), undefined);
  assert.equal(nextOf(first), null);
  full.clear();
  const second = await open(s, BO, '/full');
  assert.deepEqual(nextOf(second), {
    text: '*New:* Say hello', label: 'Run', action: 'full-tool-a:open', style: 'primary',
  });
  assert.equal(block(second, 'entry:full-tool-a').accessory.text.text, 'Run');
  const third = await open(s, BO, '/full');
  assert.equal(nextOf(third), null);
});

test('the new ids are computed from the old record before the new one is written, with nothing awaited in between', async () => {
  const rec = recordingStore();
  const hidden = new Set(['full-tool-a']);
  const s = setup({ hidden, notes: { full: 3 }, store: rec.store });
  await open(s, BO, '/full');
  hidden.clear();
  const view = await open(s, BO, '/full');
  assert.equal(nextOf(view).text, '*New:* Say hello');
  assert.deepEqual(rec.log, ['get seen:UBO:full', 'set seen:UBO:full', 'get seen:UBO:full', 'set seen:UBO:full']);
  // The function itself, on a store that records the order.
  const r2 = recordingStore();
  assert.deepEqual(newSinceLastMenu(r2.store, 'UX', 'h', ['a']), []);
  assert.deepEqual(newSinceLastMenu(r2.store, 'UX', 'h', ['a', 'b']), ['b']);
  assert.deepEqual(newSinceLastMenu(r2.store, 'UX', 'h', ['b']), []);
  assert.deepEqual(newSinceLastMenu(r2.store, 'UX', 'h', ['a', 'b']), ['a']);
  assert.deepEqual(r2.log, Array.from({ length: 4 }, () => ['get seen:UX:h', 'set seen:UX:h']).flat());
  // Synchronous: it returns the ids, not a promise.
  assert.ok(Array.isArray(newSinceLastMenu(createStore(), 'UX', 'h', [])));
  assert.deepEqual(newSinceLastMenu(null, 'UX', 'h', ['a']), []);
});

test('the next-step rule throwing gives no next-step line, is logged with the hub and the function\'s name only, and the menu opens with its strip', async (t) => {
  t.mock.method(nextStepModule, 'nextStep', () => { throw new Error('SECRET_DETAIL'); });
  const s = setup();
  const view = await open(s, ADA, '/blank');
  assert.equal(block(view, 'next'), undefined);
  assert.ok(block(view, 'strip:knows'));
  assert.ok(block(view, 'entry:blank-add'));
  assert.deepEqual(s.log.lines.filter((l) => l.msg === 'menu fact skipped').map((l) => l.fields), [{ hub: 'blank', fn: 'nextStep' }]);
  assert.ok(!JSON.stringify(s.log.lines).includes('SECRET_DETAIL'));
});

test('two hubs, isolated: a tool new on one hub is not "New" on the other, each hub\'s next step comes from its own summary, and opening one hub never writes the other\'s record', async () => {
  for (const order of [['/blank', '/full'], ['/full', '/blank']]) {
    const rec = recordingStore();
    const hidden = new Set(['blank-request', 'full-tool-a']);
    const s = setup({ hidden, notes: { blank: 1, full: 3 }, store: rec.store });
    const before = {};
    for (const command of order) before[command] = await open(s, ADA, command);
    // Each from its own summary: blank is taught but has no Request a tool
    // row yet, full has its own tools; neither has a line.
    assert.equal(nextOf(before['/blank']), null, order.join());
    assert.equal(nextOf(before['/full']), null, order.join());
    assert.deepEqual(rec.log, order.flatMap((c) => [`get seen:UADA:${c.slice(1)}`, `set seen:UADA:${c.slice(1)}`]), order.join());
    // A tool appears on blank only.
    hidden.delete('blank-request');
    rec.log.length = 0;
    const after = {};
    for (const command of order) after[command] = await open(s, ADA, command);
    assert.equal(nextOf(after['/blank']).text, '*New:* Request a tool', order.join());
    assert.equal(nextOf(after['/full']), null, order.join());
    // Then one on full only: New there, nothing on blank.
    hidden.delete('full-tool-a');
    const blankAgain = await open(s, ADA, '/blank');
    const fullAgain = await open(s, ADA, '/full');
    assert.equal(nextOf(fullAgain).text, '*New:* Say hello', order.join());
    // Blank: nothing new, so its own summary's next step (taught, template only).
    assert.equal(nextOf(blankAgain).text, FIRST_TOOL, order.join());
  }
  // A hub opened first after another has no record of its own: nothing new.
  const s = setup({ notes: { blank: 1, full: 3 } });
  await open(s, BO, '/full');
  assert.equal(nextOf(await open(s, BO, '/blank')), null);
});

test('after 7 days (frozen clock), nothing is new; a day short of it, the tool still is', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  for (const [wait, isNew] of [[7 * DAY, false], [7 * DAY - 1, true]]) {
    t.mock.timers.setTime(0);
    const hidden = new Set(['full-tool-a']);
    const s = setup({ hidden, notes: { full: 3 } });
    await open(s, BO, '/full');
    hidden.clear();
    t.mock.timers.setTime(wait);
    const view = await open(s, BO, '/full');
    assert.equal(Boolean(nextOf(view)), isNew, String(wait));
    // The welcome's own record keeps its 7-day expiry: back after 7 days.
    assert.equal(Boolean(block(view, 'welcome')), !isNew, String(wait));
  }
});

test('the first-visit welcome still shows once per person per hub, beside the seen record', async () => {
  const store = createStore();
  const s = setup({ store });
  const one = await open(s, BO, '/full');
  const two = await open(s, BO, '/full');
  const other = await open(s, BO, '/blank');
  assert.ok(block(one, 'welcome'));
  assert.equal(block(two, 'welcome'), undefined);
  assert.ok(block(other, 'welcome'));
  assert.equal(store.get('welcome', 'UBO:full'), true);
  assert.ok(Array.isArray(store.get('welcome', 'seen:UBO:full')));
});

// --- ways out of the next-step button -------------------------------------------------------------

test('way out, the next-step button: it pushes the tool\'s view, whose Back returns to the menu', async () => {
  const s = setup();
  const view = await open(s, ADA, '/blank');
  const { action } = nextOf(view);
  assert.equal(await s.app.dispatchAction(action, { user: { id: ADA }, view }), 1);
  const pushed = calls(s.app, 'push').at(-1).view;
  assert.equal(pushed.close.text, 'Back');
});

test('way out, access refused since the menu: the next-step click gets the existing refusal, in the view', async () => {
  const hidden = new Set(['full-tool-a']);
  const s = setup({ hidden, notes: { full: 3 } });
  await open(s, BO, '/full');
  hidden.clear();
  const view = await open(s, BO, '/full');
  const { action } = nextOf(view);
  hidden.add('full-tool-a');
  await s.app.dispatchAction(action, { user: { id: BO }, view });
  assert.match(textOf(calls(s.app, 'push').at(-1).view), new RegExp(`^You don't have access to .+; ask ${ADMIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.$`));
  assert.ok(s.log.lines.some((l) => l.msg === 'hub action refused' && l.fields.action_id === action && l.fields.reason === 'AccessDenied'));
});

test('way out, a tool hidden since the menu (gone from this environment): the existing "isn\'t available here any more"', async () => {
  const mods = (envs) => [
    { id: 'nx-ask', label: 'Ask', resource: 'ASK', archetype: 'ask' },
    { id: 'nx-tool', label: 'Say hello', resource: 'TOOL', archetype: 'handler', environments: envs, run: async ({ reply }) => reply('hello') },
  ].map((m) => Object.freeze({ hub: 'nx', description: 'A fixture tool.', environments: ['dev', 'prod'], ...m }));
  const reg = (envs) => createRegistry({ hubs: [{ id: 'nx', command: '/nx', name: 'Nx tools', sees: [] }], modules: mods(envs) });
  const hidden = new Set(['nx-tool']);
  const store = createStore();
  const dev = setup({ reg: reg(['dev', 'prod']), hidden, store });
  await open(dev, BO, '/nx');
  hidden.clear();
  const view = await open(dev, BO, '/nx');
  const { action } = nextOf(view);
  assert.equal(action, 'nx-tool:open');
  // The same click reaches a bot whose manifest now leaves it out of dev.
  const later = setup({ reg: reg(['prod']), store });
  await later.app.dispatchAction(action, { user: { id: BO }, view });
  assert.equal(textOf(calls(later.app, 'push').at(-1).view), NOT_AVAILABLE);
  assert.ok(later.log.lines.some((l) => l.msg === 'hub action refused' && l.fields.reason === 'hidden in this environment'));
});

test('way out, the late menu (D8): no next step while "checking…", then the update carries it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = setup({ notes: { blank: async () => { await gate; return []; } } });
  const done = s.app.dispatchCommand('/blank', { user_id: ADA });
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  const [opened] = calls(s.app, 'open');
  assert.equal(block(opened.view, 'next'), undefined);
  release();
  await done;
  const [update] = calls(s.app, 'update');
  assert.equal(nextOf(update.view).text, TEACH);
});

test('way out, an expired trigger: the private fallback carries the next step and its button', async () => {
  const s = setup();
  s.app.viewsFail.open = Object.assign(new Error('An API error occurred: expired_trigger_id'), { data: { ok: false, error: 'expired_trigger_id' } });
  await s.app.dispatchCommand('/blank', { user_id: ADA });
  const [menu] = s.app.responded;
  assert.equal(nextOf(menu).text, TEACH);
  assert.ok(menu.text.includes(TEACH));
  // Its click from that message is the ordinary :open dispatch.
  assert.equal(await s.app.dispatchAction(nextOf(menu).action, { user: { id: ADA } }), 1);
});
