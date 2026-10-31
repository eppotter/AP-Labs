'use strict';

// Plan hub-status-menu, Story 17.2 (D1, D4, D5, D8, D9, D10, D11): the new
// hub menu through the slash command (kit/runtime/slack/hubs) and buildMenu
// (kit/runtime/registry/menu). The four stages, who sees the strip, the
// Setup group, groups and verbs, the guards, the 100-block cut, two hubs in
// one process, unreadable notes, the late summary and every way out of the
// menu. Fixtures only: test/fixtures/runtime/status-menu (Ada is an admin,
// Bo a member granted ASK and TOOL).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry, createRegistry } = require('../../kit/runtime/registry');
const { createRulesReader } = require('../../kit/runtime/knowledge/readiness');
const { registerHubs, FORM_NEEDS_WINDOW, MAP_NEEDS_WINDOW } = require('../../kit/runtime/slack/hubs');
const {
  buildMenu, KNOWS_CHECKING, KNOWS_UNCHECKED, MORE_TOOLS, NOTHING_HERE,
} = require('../../kit/runtime/registry/menu');
const {
  CHECKING, SETUP_GROUP, setupProgress, statusText,
} = require('../../kit/runtime/registry/vocabulary');
const statusModule = require('../../kit/runtime/registry/status');
const summaryModule = require('../../kit/runtime/knowledge/summary');
const {
  BUILD_REQUEST_WORDS, ASK_WORDS, welcomeText, REQUEST_A_TOOL,
} = require('../../kit/runtime/messages');
const { createStore } = require('../../kit/runtime/store');
const { FakeSlackApp, invalidElements } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime/status-menu');
const PROFILE_PATH = path.join(FIX, 'profile.yml');
const profile = loadProfile(PROFILE_PATH);
const { registry } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });
const hubOf = (id) => registry.hubs.find((h) => h.id === id);

const ADA = 'UADA'; // admin
const BO = 'UBO'; // member: ASK and TOOL
const NOBODY = 'UNOBODY'; // not in the profile

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

const fixtureRules = () => createRulesReader({ profile, profilePath: PROFILE_PATH, readLast: () => null });
// A rules reader for a hub whose client files are there but nothing is
// signed off yet.
const nothingSigned = () => ({
  read: () => ({
    files: [], truths: [], forbiddenColumns: 0, approvedRules: 0, checkedAt: null, problem: false,
  }),
});
const note = (i) => ({
  id: `${String(i).padStart(32, '0')}`, kind: 'text', title: `Note ${i}`, text: 'NOTE_TEXT_NEVER_SHOWN', addedBy: ADA, addedAt: 0,
});
const notesOf = (n) => Array.from({ length: n }, (_, i) => note(i));
const AI = Object.freeze({ ask: async () => ({}), structured: async () => ({}), readFile: async () => ({}) });

// notes: hub id -> a count, an array, or a list() function. data: the
// runner says available. reg, canUse: seams for in-memory hubs.
function setup({
  notes = {}, data = true, llm = true, rules = fixtureRules(), views = true, canUse, reg = registry, sees = null,
} = {}) {
  const app = new FakeSlackApp({ views });
  const log = quietLog();
  const runner = Object.freeze({
    run: async () => { throw new Error('the menu never runs a query'); },
    describe: () => ({ source: 'local fixture', label: 'tiny.duckdb', available: data }),
  });
  const forHub = (hubId) => {
    const hub = reg.hubs.find((h) => h.id === hubId);
    const hubSees = sees || hub.sees || [];
    const n = notes[hubId];
    let list;
    if (typeof n === 'function') list = n;
    else if (Array.isArray(n)) list = async () => n;
    else list = async () => notesOf(n || 0);
    return Object.freeze({
      id: hubId,
      sees: hubSees,
      data: hubSees.includes('data') ? runner : null,
      llm: llm ? AI : null,
      rules: hubSees.includes('rules'),
      knowledge: Object.freeze({ list, add: async () => { throw new Error('not here'); }, remove: async () => {} }),
    });
  };
  registerHubs(app, {
    registry: reg, profile, env: 'dev', log, store: createStore(), forHub, rules, ...(canUse ? { canUse } : {}),
  });
  return { app, log };
}

const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const openedMenu = (app) => calls(app, 'open').at(-1).view;
const block = (view, id) => view.blocks.find((b) => b.block_id === id);
const knowsOf = (view) => (block(view, 'strip:knows') || { text: {} }).text.text;
const progressOf = (view) => { const b = block(view, 'strip:progress'); return b ? b.elements[0].text : undefined; };
const groupsOf = (view) => view.blocks.filter((b) => /^group:/.test(b.block_id || '')).map((b) => b.text.text);
const rowOf = (view, id) => block(view, `entry:${id}`);
const rowsOf = (view) => view.blocks.filter((b) => /^entry:/.test(b.block_id || '')).map((b) => ({
  id: b.block_id.slice(6), text: b.text.text, verb: b.accessory.text.text, action: b.accessory.action_id,
}));
const allButtons = (view) => view.blocks.flatMap((b) => [b.accessory, ...(b.elements || [])]).filter((e) => e && e.type === 'button');
const MENU_VIEW = (hub) => ({ id: 'VMENU', type: 'modal', private_metadata: hub, hash: 'hmenu' });
const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((r) => { setImmediate(r); }); };

async function menuFor(user, hubCommand, opts) {
  const s = setup(opts);
  await s.app.dispatchCommand(hubCommand, { user_id: user });
  return { ...s, view: openedMenu(s.app) };
}

// --- the four stages ---------------------------------------------------------------------

test('blank, admin: the strip, then Tools (Ask partly, Request a tool ready), then the Setup group (Add context not started, Data sources done)', async () => {
  const { view, app } = await menuFor(ADA, '/blank');
  assert.equal(knowsOf(view), 'Knows: 0 notes · 0 sources · 0 truths · 0 rules');
  assert.equal(progressOf(view), '▱ Setup 0 of 1 · 1 of 2 tools ready');
  assert.deepEqual(groupsOf(view), ['Tools', '🔒 Setup · admins']);
  assert.deepEqual(rowsOf(view), [
    {
      id: 'blank-ask', text: '*Ask*\n◐ Partly ready · nothing taught yet', verb: 'Ask', action: 'blank-ask:open',
    },
    {
      id: 'blank-request', text: '*Request a tool*\n✓ Ready', verb: 'Request', action: 'blank-request:open',
    },
    {
      id: 'blank-add', text: '*Add context*\n○ Not started · no notes yet', verb: 'Add', action: 'blank-add:open',
    },
    {
      id: 'blank-sources', text: '*Data sources*\n✓ Done · no data on this hub', verb: 'View', action: 'blank-sources:open',
    },
  ]);
  // Top to bottom (D1): header, strip, welcome, groups, divider, Help.
  const ids = view.blocks.map((b) => b.block_id || b.type);
  assert.deepEqual(ids.slice(0, 5), ['header', 'strip:knows', 'strip:progress', 'welcome', 'group:0']);
  assert.deepEqual(ids.slice(-2), ['divider', 'help']);
  // In time: one views.open with the whole menu, no late update.
  assert.equal(calls(app, 'open').length, 1);
  assert.equal(calls(app, 'update').length, 0);
});

test('blank, member with Ask: "Your admin is setting this up. You can still ask questions." and no Setup group; a member with other rows but not Ask: the first sentence only', async () => {
  const bo = await menuFor(BO, '/blank');
  assert.equal(knowsOf(bo.view), 'Knows: 0 notes · 0 sources · 0 truths · 0 rules');
  assert.equal(progressOf(bo.view), 'Your admin is setting this up. You can still ask questions.');
  assert.deepEqual(groupsOf(bo.view), ['Tools']);
  assert.deepEqual(rowsOf(bo.view).map((r) => r.id), ['blank-ask']);
  // Bo granted Request a tool instead of Ask (a seam): no Ask row.
  const canUse = (person, mod) => (person.user && person.user.id === 'bo' ? mod.id === 'blank-request' : true);
  const other = await menuFor(BO, '/blank', { canUse });
  assert.deepEqual(rowsOf(other.view).map((r) => r.id), ['blank-request']);
  assert.equal(progressOf(other.view), 'Your admin is setting this up.');
});

test('onboarded: the blank hub with two notes is set up (✓ 1 of 2 tools ready, Add context done · 2 notes); a hub that sees all three with one note is ▰▱▱▱ Setup 1 of 4', async () => {
  const { view } = await menuFor(ADA, '/blank', { notes: { blank: 2 } });
  assert.equal(knowsOf(view), 'Knows: 2 notes · 0 sources · 0 truths · 0 rules');
  assert.equal(progressOf(view), '✓ 1 of 2 tools ready');
  assert.equal(rowOf(view, 'blank-add').text.text, '*Add context*\n✓ Done · 2 notes');
  assert.equal(rowOf(view, 'blank-ask').text.text, '*Ask*\n◐ Partly ready · no data yet');
  // The full hub before anything is signed off and with no data: only
  // "taught" is done (it sees context).
  const full = await menuFor(ADA, '/full', { notes: { full: 1 }, data: false, rules: nothingSigned() });
  assert.equal(knowsOf(full.view), 'Knows: 1 note · 0 sources · 0 truths · 0 rules');
  assert.match(progressOf(full.view), /^▰▱▱▱ Setup 1 of 4 · \d+ of 10 tools ready$/);
});

test('first tool: a scoped pull on a hub with data is ✓ Ready with Run, and the strip counts 1 source', async () => {
  const { view } = await menuFor(ADA, '/first-tool');
  assert.equal(knowsOf(view), 'Knows: 0 notes · 1 source · 0 truths · 0 rules');
  assert.equal(progressOf(view), '▰▱ Setup 1 of 2 · 1 of 1 tools ready');
  assert.deepEqual(rowOf(view, 'first-pull').accessory.text.text, 'Run');
  assert.equal(rowOf(view, 'first-pull').text.text, '*Visits by zone*\n✓ Ready');
  assert.equal(rowOf(view, 'first-sources').text.text, '*Data sources*\n✓ Done');
});

test('full: every group in order (manifest groups by first module, then Tools, then Setup), ✓ N of M once every counted step is done, under 30 blocks', async () => {
  const { view } = await menuFor(ADA, '/full', { notes: { full: 3 } });
  assert.equal(knowsOf(view), 'Knows: 3 notes · 1 source · 1 truth · 2 rules');
  assert.equal(progressOf(view), '✓ 10 of 10 tools ready');
  assert.deepEqual(groupsOf(view), ['Lists', 'Reports', 'Tools', '🔒 Setup · admins']);
  // Each archetype's verb, or the manifest's own (D10).
  assert.deepEqual(rowsOf(view).map((r) => `${r.id}:${r.verb}`), [
    'full-list-a:Run', 'full-list-b:Review', 'full-list-c:Run',
    'full-report-a:View', 'full-report-b:View', 'full-report-c:Run',
    'full-ask:Ask', 'full-tool-a:Run', 'full-tool-b:View', 'full-tool-c:Run',
    'full-add:Add', 'full-sources:View',
  ]);
  assert.ok(view.blocks.length < 30, `${view.blocks.length} blocks`);
  // No count gives away what it counts: no note, truth or rule text.
  const all = JSON.stringify(view);
  assert.ok(!/NOTE_TEXT_NEVER_SHOWN|RULE_TEXT_NEVER_SHOWN|active people/i.test(all));
});

test('the word "Open" is on no menu button, and every button is a verb or Help, in every stage and for every person', async () => {
  const stages = [['/blank', {}], ['/blank', { notes: { blank: 2 } }], ['/first-tool', {}], ['/full', { notes: { full: 3 } }], ['/onboarded', {}]];
  for (const [command, opts] of stages) {
    for (const user of [ADA, BO, NOBODY]) {
      const { view } = await menuFor(user, command, opts);
      for (const b of allButtons(view)) {
        assert.notEqual(b.text.text, 'Open', `${command} ${user}`);
        assert.ok(['Ask', 'Run', 'View', 'Add', 'Review', 'Request', 'Help'].includes(b.text.text), `${command} ${user}: ${b.text.text}`);
      }
      assert.ok(!/press Open/i.test(JSON.stringify(view)), `${command} ${user}`);
    }
  }
});

// --- who sees the strip (D4, architect P1-1) --------------------------------------------------

test('a person not in the profile sees the not-set-up notice only: no Knows block, no progress block, no Setup group', async () => {
  // Everyone may open everything (a seam), so the stranger has rows.
  const { view } = await menuFor(NOBODY, '/blank', { canUse: () => true });
  assert.match(view.blocks.find((b) => b.type === 'context').elements[0].text, /^You're not set up in Tiny's bot yet/);
  assert.equal(block(view, 'strip:knows'), undefined);
  assert.equal(block(view, 'strip:progress'), undefined);
  assert.ok(!groupsOf(view).includes(SETUP_GROUP));
  // Rows with their verb and no status line.
  assert.deepEqual(rowsOf(view).map((r) => r.text), ['*Ask*', '*Request a tool*']);
});

test('a member with no rows sees "Nothing is available to you here yet." and Help: no strip, no next step', async () => {
  const { view } = await menuFor(BO, '/first-tool');
  assert.ok(view.blocks.some((b) => b.text && b.text.text === NOTHING_HERE));
  assert.equal(block(view, 'strip:knows'), undefined);
  assert.equal(block(view, 'strip:progress'), undefined);
  assert.equal(block(view, 'next'), undefined);
  assert.deepEqual(view.blocks.slice(-2).map((b) => b.block_id || b.type), ['divider', 'help']);
});

test('a member with rows sees the counts (numbers only) and "✓ N of M tools ready", never setup progress', async () => {
  const { view } = await menuFor(BO, '/full', { notes: { full: 3 }, rules: nothingSigned() });
  assert.equal(knowsOf(view), 'Knows: 3 notes · 1 source · 0 truths · 0 rules');
  assert.match(progressOf(view), /^✓ \d+ of 7 tools ready$/);
  assert.ok(!/Setup/.test(progressOf(view)));
});

test('a member granted the setup tools by name still sees no Setup group, in the menu or in Help (fail closed); the dispatcher still decides a click', async () => {
  const s = setup({ canUse: () => true });
  await s.app.dispatchCommand('/blank', { user_id: BO });
  const view = openedMenu(s.app);
  assert.deepEqual(rowsOf(view).map((r) => r.id), ['blank-ask', 'blank-request']);
  assert.ok(!groupsOf(view).includes(SETUP_GROUP));
  await s.app.dispatchAction('blank:help', { user: { id: BO }, view: MENU_VIEW('blank') });
  const help = calls(s.app, 'push').at(-1).view;
  assert.doesNotMatch(JSON.stringify(help), /Add context|Data sources/);
  // Access is unchanged: the grant still opens Data sources at the click.
  await s.app.dispatchAction('blank-sources:open', { user: { id: BO }, view: MENU_VIEW('blank') });
  assert.match(JSON.stringify(calls(s.app, 'push').at(-1).view), /No data connected yet/);
});

// --- the guards (D1, architect P2-5) ----------------------------------------------------------

test('summarize throws: no strip, every row keeps its verb with no status line, logged with the function name only; the menu opens', async (t) => {
  t.mock.method(summaryModule, 'summarize', () => { throw new Error('SECRET_DETAIL'); });
  const { view, log } = await menuFor(ADA, '/blank');
  assert.equal(block(view, 'strip:knows'), undefined);
  assert.equal(block(view, 'strip:progress'), undefined);
  assert.deepEqual(rowsOf(view).map((r) => `${r.text}|${r.verb}`), ['*Ask*|Ask', '*Request a tool*|Request', '*Add context*|Add', '*Data sources*|View']);
  const line = log.lines.find((l) => l.msg === 'menu fact skipped');
  assert.deepEqual(line.fields, { hub: 'blank', fn: 'summarize' });
  assert.ok(!JSON.stringify(log.lines).includes('SECRET_DETAIL'));
});

test('toolStatus throws for one module: that row keeps its verb with no status line, the others are unaffected, logged with the module id and function name only', async (t) => {
  const real = statusModule.toolStatus;
  t.mock.method(statusModule, 'toolStatus', (mod, facts) => {
    if (mod.id === 'blank-request') throw new Error('SECRET_DETAIL');
    return real(mod, facts);
  });
  const { view, log } = await menuFor(ADA, '/blank');
  assert.equal(rowOf(view, 'blank-request').text.text, '*Request a tool*');
  assert.equal(rowOf(view, 'blank-request').accessory.text.text, 'Request');
  assert.equal(rowOf(view, 'blank-ask').text.text, '*Ask*\n◐ Partly ready · nothing taught yet');
  assert.ok(knowsOf(view));
  assert.deepEqual(log.lines.filter((l) => l.msg === 'menu fact skipped').map((l) => l.fields), [{ module: 'blank-request', fn: 'toolStatus' }]);
});

test('statusText gets an unknown key for one row: that row keeps its verb with no status line, logged with the module id and function name only', async (t) => {
  const real = statusModule.toolStatus;
  t.mock.method(statusModule, 'toolStatus', (mod, facts) => (mod.id === 'blank-ask' ? { key: 'requested', detail: null } : real(mod, facts)));
  const { view, log } = await menuFor(ADA, '/blank');
  assert.equal(rowOf(view, 'blank-ask').text.text, '*Ask*');
  assert.equal(rowOf(view, 'blank-ask').accessory.text.text, 'Ask');
  assert.equal(rowOf(view, 'blank-request').text.text, '*Request a tool*\n✓ Ready');
  assert.deepEqual(log.lines.filter((l) => l.msg === 'menu fact skipped').map((l) => l.fields), [{ module: 'blank-ask', fn: 'statusText' }]);
});

// --- unreadable notes (D3, architect P2-4) ----------------------------------------------------

test('a knowledge store whose list() rejects gives "Knows: couldn\'t check just now", never "0 notes", and no progress line', async () => {
  const { view } = await menuFor(ADA, '/blank', { notes: { blank: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } } });
  assert.equal(knowsOf(view), KNOWS_UNCHECKED);
  assert.equal(knowsOf(view), "Knows: couldn't check just now");
  assert.ok(!JSON.stringify(view).includes('0 notes'));
  assert.equal(progressOf(view), undefined);
});

// --- two hubs, isolated (architect P2-7) --------------------------------------------------------

test('two hubs in one process: each menu\'s counts and statuses come from its own hub only, in either order', async () => {
  for (const order of [['/blank', '/full'], ['/full', '/blank']]) {
    const s = setup({ notes: { blank: 1, full: 3 } });
    const seen = {};
    for (const command of order) {
      await s.app.dispatchCommand(command, { user_id: ADA });
      seen[command] = openedMenu(s.app);
    }
    assert.equal(knowsOf(seen['/blank']), 'Knows: 1 note · 0 sources · 0 truths · 0 rules', order.join());
    assert.equal(knowsOf(seen['/full']), 'Knows: 3 notes · 1 source · 1 truth · 2 rules', order.join());
    assert.equal(rowOf(seen['/blank'], 'blank-add').text.text, '*Add context*\n✓ Done · 1 note');
    assert.equal(rowOf(seen['/full'], 'full-add').text.text, '*Add context*\n✓ Done · 3 notes');
    assert.equal(rowOf(seen['/blank'], 'blank-sources').text.text, '*Data sources*\n✓ Done · no data on this hub');
    assert.equal(rowOf(seen['/full'], 'full-sources').text.text, '*Data sources*\n✓ Done');
    assert.equal(progressOf(seen['/blank']), '✓ 1 of 2 tools ready');
    assert.equal(progressOf(seen['/full']), '✓ 10 of 10 tools ready');
  }
});

// --- over 100 blocks (D1, architect P3-10) ------------------------------------------------------

function bigHub(count, groups) {
  const modules = Array.from({ length: count }, (_, i) => Object.freeze({
    id: `m${String(i).padStart(3, '0')}`, hub: 'big', label: `Tool ${i}`, description: 'd', resource: 'TOOL', archetype: 'handler', environments: ['dev'],
    group: `Group ${Math.floor(i / (count / groups)) + 1}`, run: async () => {},
  }));
  const setupMods = [
    Object.freeze({
      id: 'big-add', hub: 'big', label: 'Add context', description: 'd', resource: 'ADD_CONTEXT', archetype: 'add-context', environments: ['dev'],
    }),
    Object.freeze({
      id: 'big-sources', hub: 'big', label: 'Data sources', description: 'd', resource: 'DATA_SOURCES', archetype: 'data-sources', environments: ['dev'],
    }),
  ];
  return createRegistry({ hubs: [{ id: 'big', name: 'Big', command: '/big', sees: [] }], modules: [...modules, ...setupMods] });
}

test('over 100 blocks: 120 tools in eight groups cut whole groups only, keep the strip, the Setup group, the "more tools" line, the divider and Help', async () => {
  const { view } = await menuFor(ADA, '/big', { reg: bigHub(120, 8), canUse: () => true });
  assert.ok(view.blocks.length <= 100, `${view.blocks.length}`);
  assert.ok(block(view, 'strip:knows') && block(view, 'strip:progress'));
  const groups = groupsOf(view);
  // Header, two strip lines, welcome (4) + divider and Help (2) + the more
  // line (1) + Setup (3) leave 90: five groups of 1 + 15.
  assert.deepEqual(groups, ['Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5', '🔒 Setup · admins']);
  const rows = rowsOf(view).map((r) => r.id);
  assert.equal(rows.length, 5 * 15 + 2, 'every kept group is whole');
  assert.ok(!rows.includes('m075'), 'group 6 is dropped whole');
  assert.equal(block(view, 'more').elements[0].text, MORE_TOOLS);
  const ids = view.blocks.map((b) => b.block_id || b.type);
  assert.ok(ids.indexOf('more') < ids.indexOf('group:5'), 'the more line comes before the Setup group');
  assert.deepEqual(ids.slice(-2), ['divider', 'help']);
  assert.ok(!JSON.stringify(view).includes('_more…'), 'modalView\'s generic cut never acts on the menu');
});

test('60 tools in eight groups fit in 100 blocks whole: nothing is cut', async () => {
  const { view } = await menuFor(ADA, '/big', { reg: bigHub(60, 8), canUse: () => true });
  assert.equal(groupsOf(view).length, 9);
  assert.equal(rowsOf(view).length, 62);
  assert.equal(block(view, 'more'), undefined);
});

// --- the late summary (D8) ----------------------------------------------------------------------

function slowNotes() {
  let release;
  const gate = new Promise((r) => { release = r; });
  return { list: async () => { await gate; return notesOf(2); }, release };
}

test('a slow knowledge store: the ack and the menu ("Knows: checking…", every row "Checking…", no progress) come first; the whole menu follows by views.update with the opened view\'s id and hash', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const slow = slowNotes();
  const s = setup({ notes: { blank: slow.list } });
  const done = s.app.dispatchCommand('/blank', { user_id: ADA });
  await settle();
  assert.equal(s.app.acks, 1, 'acked before anything is read');
  assert.equal(calls(s.app, 'open').length, 0, 'within the budget, the menu waits');
  t.mock.timers.tick(1000);
  await settle();
  const [open] = calls(s.app, 'open');
  assert.ok(open, 'the menu opened before the summary');
  assert.equal(knowsOf(open.view), KNOWS_CHECKING);
  assert.equal(progressOf(open.view), undefined);
  assert.equal(block(open.view, 'next'), undefined);
  for (const r of rowsOf(open.view)) assert.equal(r.text.split('\n')[1], CHECKING, r.id);
  assert.equal(calls(s.app, 'update').length, 0);
  slow.release();
  await done;
  const [update] = calls(s.app, 'update');
  assert.equal(update.view_id, 'V1');
  assert.equal(update.hash, 'h1');
  assert.equal(knowsOf(update.view), 'Knows: 2 notes · 0 sources · 0 truths · 0 rules');
  assert.equal(progressOf(update.view), '✓ 1 of 2 tools ready');
  assert.equal(update.view.callback_id, 'hub:menu');
  assert.ok(block(update.view, 'welcome'), 'the first visit\'s welcome is kept');
});

test('the late update\'s errors (hash_conflict, not_found, anything else) are dropped and logged at info with the hub and Slack\'s code only; never shown', async (t) => {
  for (const code of ['hash_conflict', 'not_found', 'internal_error']) {
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const slow = slowNotes();
    const s = setup({ notes: { blank: slow.list } });
    s.app.viewsFail.update = Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
    const done = s.app.dispatchCommand('/blank', { user_id: ADA });
    await settle();
    t.mock.timers.tick(1000);
    await settle();
    slow.release();
    await done;
    const line = s.log.lines.find((l) => l.msg === 'menu update dropped');
    assert.deepEqual(line, { level: 'info', msg: 'menu update dropped', fields: { hub: 'blank', reason: code } }, code);
    assert.deepEqual(s.app.responded, [], code);
    assert.ok(!s.log.lines.some((l) => l.msg === 'handler failed'), code);
  }
});

test('a late summary that fails leaves the menu saying "couldn\'t check just now", with each row\'s verb', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(summaryModule, 'summarize', () => { throw new Error('boom'); });
  const slow = slowNotes();
  const s = setup({ notes: { blank: slow.list } });
  const done = s.app.dispatchCommand('/blank', { user_id: ADA });
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  slow.release();
  await done;
  const [update] = calls(s.app, 'update');
  assert.equal(knowsOf(update.view), KNOWS_UNCHECKED);
  assert.equal(progressOf(update.view), undefined);
  assert.deepEqual(rowsOf(update.view).map((r) => r.text), ['*Ask*', '*Request a tool*', '*Add context*', '*Data sources*']);
});

test('no views client and slow notes: the private reply waits for them (it has no 3-second limit) and carries the whole menu', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const slow = slowNotes();
  const s = setup({ views: false, notes: { blank: slow.list } });
  const done = s.app.dispatchCommand('/blank', { user_id: ADA });
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(s.app.responded, []);
  slow.release();
  await done;
  const [menu] = s.app.responded;
  assert.equal(knowsOf(menu), 'Knows: 2 notes · 0 sources · 0 truths · 0 rules');
});

// --- ways out of the menu ---------------------------------------------------------------------

test('way out, the X: the menu asks for no view_closed, so closing it runs nothing', async () => {
  const { view, app } = await menuFor(ADA, '/blank');
  assert.equal(view.callback_id, 'hub:menu');
  assert.equal(view.notify_on_close, undefined);
  assert.equal(view.close.text, 'Close');
  assert.equal(await app.dispatchViewClosed('hub:menu', { user: { id: ADA }, view }), 0);
});

test('way out, each verb button pushes its tool\'s view, whose Back returns to the menu', async () => {
  const s = setup();
  await s.app.dispatchCommand('/blank', { user_id: ADA });
  const rows = rowsOf(openedMenu(s.app));
  for (const r of rows) {
    const before = calls(s.app, 'push').length;
    assert.equal(await s.app.dispatchAction(r.action, { user: { id: ADA }, view: MENU_VIEW('blank') }), 1, r.id);
    const pushed = calls(s.app, 'push');
    assert.equal(pushed.length, before + 1, r.id);
    assert.equal(pushed.at(-1).view.close.text, 'Back', r.id);
  }
});

test('way out, Help then Back: Help pushes its view, whose close is Back', async () => {
  const s = setup();
  assert.equal(await s.app.dispatchAction('blank:help', { user: { id: ADA }, view: MENU_VIEW('blank') }), 1);
  const [push] = calls(s.app, 'push');
  assert.equal(push.view.close.text, 'Back');
  assert.match(JSON.stringify(push.view), /Help: Blank tools/);
});

test('way out, an expired trigger: the private fallback, its text carrying the strip\'s two lines', async () => {
  const s = setup();
  s.app.viewsFail.open = Object.assign(new Error('An API error occurred: expired_trigger_id'), { data: { ok: false, error: 'expired_trigger_id' } });
  await s.app.dispatchCommand('/blank', { user_id: ADA });
  const [menu] = s.app.responded;
  assert.equal(menu.response_type, 'ephemeral');
  assert.match(menu.text, /\nKnows: 0 notes · 0 sources · 0 truths · 0 rules\n▱ Setup 0 of 1 · 1 of 2 tools ready/);
  assert.equal(knowsOf(menu), 'Knows: 0 notes · 0 sources · 0 truths · 0 rules');
  assert.ok(s.log.lines.some((l) => l.msg === 'hub modal fallback' && l.fields.reason === 'expired_trigger_id'));
});

test('way out, a click on an old message menu: dispatch is unchanged (a private reply, no view)', async () => {
  const s = setup();
  assert.equal(await s.app.dispatchAction('blank-sources:open', { user: { id: ADA } }), 1);
  assert.equal(calls(s.app, 'push').length, 0);
  assert.match(JSON.stringify(s.app.responded.at(-1)), /No data connected yet/);
  // A form tool from a message is told to use the hub window, without "Open".
  await s.app.dispatchAction('blank-ask:open', { user: { id: ADA } });
  assert.equal(s.app.responded.at(-1).text, FORM_NEEDS_WINDOW);
});

// --- the welcome (D9) ---------------------------------------------------------------------------

test('the first-visit welcome sits below the strip, once per person per hub', async () => {
  const s = setup();
  await s.app.dispatchCommand('/blank', { user_id: ADA });
  await s.app.dispatchCommand('/blank', { user_id: ADA });
  const [first, second] = calls(s.app, 'open').map((o) => o.view);
  const ids = first.blocks.map((b) => b.block_id);
  assert.ok(ids.indexOf('welcome') > ids.indexOf('strip:progress'));
  assert.match(block(first, 'welcome').text.text, /^Welcome to Blank tools\. Press Help/);
  assert.equal(block(second, 'welcome'), undefined);
  assert.doesNotMatch(welcomeText({ name: 'X' }), /opens one tool/);
});

// --- words (D10) --------------------------------------------------------------------------------

test('no bot text says "Build request" or "press Open"', () => {
  const said = [
    ...Object.values(BUILD_REQUEST_WORDS).map((f) => f('<@UADA>', 5)),
    ...Object.values(ASK_WORDS).map((f) => f('Tool', 'Run')),
    FORM_NEEDS_WINDOW, MAP_NEEDS_WINDOW, welcomeText({ name: 'Hub' }), REQUEST_A_TOOL,
  ];
  for (const s of said) {
    assert.doesNotMatch(s, /Build request/, s);
    assert.doesNotMatch(s, /press Open/i, s);
  }
  assert.equal(ASK_WORDS.tool('Dataset', 'View'), '*Dataset* can help with that. Press View to use it.');
  assert.match(FORM_NEEDS_WINDOW, /press its button there/);
  assert.match(MAP_NEEDS_WINDOW, /press its button there/);
});

// --- the Slack fake: context blocks (Story 17.2's additions) ------------------------------------

test('the fake refuses a context block as Slack does: no elements, more than 10, or an element\'s text over 3,000', () => {
  const ctx = (elements) => ({ blocks: [{ type: 'context', elements }] });
  const el = (text) => ({ type: 'mrkdwn', text });
  assert.match(invalidElements(ctx([])), /context block holds 1 to 10/);
  assert.match(invalidElements(ctx(Array.from({ length: 11 }, () => el('x')))), /context block holds 1 to 10/);
  assert.match(invalidElements(ctx([el('x'.repeat(3001))])), /3000/);
  assert.equal(invalidElements(ctx(Array.from({ length: 10 }, () => el('x'.repeat(3000))))), null);
});

// --- the vocabulary's additions (Story 17.2) ----------------------------------------------------

test('setupProgress is the bar then "N of M tools ready" with no tick; CHECKING is a word with no glyph and is not a status', () => {
  assert.equal(setupProgress(0, 1, 1, 2), '▱ Setup 0 of 1 · 1 of 2 tools ready');
  assert.equal(setupProgress(2, 4, 0, 0), '▰▰▱▱ Setup 2 of 4 · 0 of 0 tools ready');
  assert.throws(() => setupProgress(0, 1, 3, 2), RangeError);
  assert.throws(() => setupProgress(2, 1, 0, 0), RangeError);
  assert.equal(CHECKING, 'Checking…');
  assert.throws(() => statusText({ key: 'checking' }), TypeError);
});

// --- buildMenu, pure ----------------------------------------------------------------------------

test('buildMenu: a member never gets setup rows even when handed them; checking rows say "Checking…"', () => {
  const hub = { id: 'h', name: 'H' };
  const rows = [
    { entry: { id: 'a', label: 'A', archetype: 'ask' }, status: { key: 'ready' }, verb: 'Ask' },
    { entry: { id: 'b', label: 'B', archetype: 'add-context' }, status: { key: 'done', detail: '1 note' }, verb: 'Add' },
  ];
  const member = buildMenu(hub, rows, { strip: true, checking: true });
  assert.deepEqual(member.blocks.filter((b) => /^entry:/.test(b.block_id || '')).map((b) => b.text.text), [`*A*\n${CHECKING}`]);
  assert.equal(member.blocks.find((b) => b.block_id === 'strip:knows').text.text, KNOWS_CHECKING);
  const admin = buildMenu(hub, rows, { admin: true });
  assert.deepEqual(admin.blocks.filter((b) => /^group:/.test(b.block_id || '')).map((b) => b.text.text), ['Tools', SETUP_GROUP]);
});
