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
  buildMenu, KNOWS_CHECKING, KNOWS_UNCHECKED, KNOWS_NOTHING, MORE_TOOLS, NOTHING_HERE,
} = require('../../kit/runtime/registry/menu');
const {
  CHECKING, SETUP_GROUP, setupProgress, statusText, VERBS,
} = require('../../kit/runtime/registry/vocabulary');
const { TEACH_LABEL } = require('../../kit/runtime/registry/next-step');
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
// A row's status line: the context block under it (subtle health), or null.
const statusOf = (view, id) => { const b = block(view, `status:${id}`); return b ? b.elements[0].text : null; };
const rowsOf = (view) => view.blocks.filter((b) => /^entry:/.test(b.block_id || '')).map((b) => ({
  id: b.block_id.slice(6), text: b.text.text, status: statusOf(view, b.block_id.slice(6)), verb: b.accessory.text.text, action: b.accessory.action_id,
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

test('blank, admin: the strip, then Tools (Ask partly, Request a tool healthy), then the Setup group (Add context not started, Data sources a fact)', async () => {
  const { view, app } = await menuFor(ADA, '/blank');
  assert.equal(knowsOf(view), 'Knows: nothing yet');
  assert.equal(knowsOf(view), KNOWS_NOTHING);
  assert.equal(progressOf(view), 'Setup 0 of 1 · 1 of 2 tools working');
  assert.deepEqual(groupsOf(view), ['Tools', 'Setup · admins only']);
  assert.deepEqual(rowsOf(view), [
    {
      id: 'blank-ask', text: '*Ask*', status: '🟡 nothing taught yet', verb: 'Ask', action: 'blank-ask:open',
    },
    {
      id: 'blank-request', text: '*Request a tool*', status: null, verb: 'Request', action: 'blank-request:open',
    },
    {
      id: 'blank-add', text: '*Add context*', status: '⚪ not started', verb: 'Add', action: 'blank-add:open',
    },
    {
      id: 'blank-sources', text: '*Data sources*', status: 'no data on this hub', verb: 'View', action: 'blank-sources:open',
    },
  ]);
  // Each status line is a context block (Slack's small grey text) right
  // under its row; a healthy row has none.
  const ids = view.blocks.map((b) => b.block_id || b.type);
  assert.equal(block(view, 'status:blank-ask').type, 'context');
  assert.equal(ids[ids.indexOf('entry:blank-ask') + 1], 'status:blank-ask');
  assert.equal(ids[ids.indexOf('entry:blank-request') + 1], 'group:1', 'a healthy row has no status line');
  assert.equal(block(view, 'status:blank-request'), undefined);
  // Top to bottom (D1): header, strip, welcome, groups, divider, Help.
  // The next step (Story 17.4) follows the welcome: nothing is taught yet.
  assert.deepEqual(ids.slice(0, 6), ['header', 'strip:knows', 'strip:progress', 'welcome', 'next', 'group:0']);
  assert.deepEqual(ids.slice(-2), ['divider', 'help']);
  // In time: one views.open with the whole menu, no late update.
  assert.equal(calls(app, 'open').length, 1);
  assert.equal(calls(app, 'update').length, 0);
});

test('blank, member with Ask: "Your admin is setting this up. You can still ask questions." and no Setup group; a member with other rows but not Ask: the first sentence only', async () => {
  const bo = await menuFor(BO, '/blank');
  assert.equal(knowsOf(bo.view), 'Knows: nothing yet');
  assert.equal(progressOf(bo.view), 'Your admin is setting this up. You can still ask questions.');
  assert.deepEqual(groupsOf(bo.view), ['Tools']);
  assert.deepEqual(rowsOf(bo.view).map((r) => r.id), ['blank-ask']);
  // Bo granted Request a tool instead of Ask (a seam): no Ask row.
  const canUse = (person, mod) => (person.user && person.user.id === 'bo' ? mod.id === 'blank-request' : true);
  const other = await menuFor(BO, '/blank', { canUse });
  assert.deepEqual(rowsOf(other.view).map((r) => r.id), ['blank-request']);
  assert.equal(progressOf(other.view), 'Your admin is setting this up.');
});

test('onboarded: the blank hub with two notes is set up (1 of 2 tools working · 1 limited, Add context "2 notes"); a hub that sees all three with one note is Setup 1 of 4', async () => {
  const { view } = await menuFor(ADA, '/blank', { notes: { blank: 2 } });
  assert.equal(knowsOf(view), 'Knows: 2 notes');
  assert.equal(progressOf(view), '1 of 2 tools working · 1 limited');
  assert.equal(statusOf(view, 'blank-add'), '2 notes');
  assert.equal(statusOf(view, 'blank-sources'), 'notes only · no data on this hub');
  assert.equal(statusOf(view, 'blank-ask'), '🟡 no data yet');
  // The full hub before anything is signed off and with no data: only
  // "taught" is done (it sees context).
  const full = await menuFor(ADA, '/full', { notes: { full: 1 }, data: false, rules: nothingSigned() });
  assert.equal(knowsOf(full.view), 'Knows: 1 note');
  assert.match(progressOf(full.view), /^Setup 1 of 4 · \d+ of 10 tools working$/);
});

test('first tool: a scoped pull on a hub with data is healthy (no status line) with Run, and the strip counts 1 source', async () => {
  const { view } = await menuFor(ADA, '/first-tool');
  assert.equal(knowsOf(view), 'Knows: 1 source');
  assert.equal(progressOf(view), 'Setup 1 of 2 · 1 of 1 tool working');
  assert.deepEqual(rowOf(view, 'first-pull').accessory.text.text, 'Run');
  assert.equal(rowOf(view, 'first-pull').text.text, '*Visits by zone*');
  assert.equal(statusOf(view, 'first-pull'), null);
  assert.equal(rowOf(view, 'first-sources').text.text, '*Data sources*');
  assert.equal(statusOf(view, 'first-sources'), null);
});

test('full: every group in order (manifest groups by first module, then Tools, then Setup), "All N tools working" once every counted step is done, under 30 blocks', async () => {
  const { view } = await menuFor(ADA, '/full', { notes: { full: 3 } });
  assert.equal(knowsOf(view), 'Knows: 3 notes · 1 source · 1 truth · 2 rules');
  assert.equal(progressOf(view), 'All 10 tools working');
  assert.deepEqual(groupsOf(view), ['Lists', 'Reports', 'Tools', 'Setup · admins only']);
  // Every tool is healthy: the only status line is Add context's fact.
  assert.deepEqual(rowsOf(view).filter((r) => r.status).map((r) => `${r.id}:${r.status}`), ['full-add:3 notes']);
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
        // The next-step button (Story 17.4) may also say "Add context" (D6).
        const words = b.style === 'primary' ? [...VERBS, TEACH_LABEL] : [...VERBS, 'Help'];
        assert.ok(words.includes(b.text.text), `${command} ${user}: ${b.text.text}`);
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
  assert.deepEqual(rowsOf(view).map((r) => [r.text, r.status]), [['*Ask*', null], ['*Request a tool*', null]]);
});

test('a member with no rows sees "Nothing is available to you here yet." and Help: no strip, no next step', async () => {
  const { view } = await menuFor(BO, '/first-tool');
  assert.ok(view.blocks.some((b) => b.text && b.text.text === NOTHING_HERE));
  assert.equal(block(view, 'strip:knows'), undefined);
  assert.equal(block(view, 'strip:progress'), undefined);
  assert.equal(block(view, 'next'), undefined);
  assert.deepEqual(view.blocks.slice(-2).map((b) => b.block_id || b.type), ['divider', 'help']);
});

test('a member with rows sees the counts (numbers only) and how many tools work, never setup progress', async () => {
  const { view } = await menuFor(BO, '/full', { notes: { full: 3 }, rules: nothingSigned() });
  assert.equal(knowsOf(view), 'Knows: 3 notes · 1 source');
  assert.match(progressOf(view), /^\d+ of 7 tools working · 1 limited$/);
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
  assert.match(JSON.stringify(calls(s.app, 'push').at(-1).view), /Nothing yet: no added context, and this hub doesn't connect to data\./);
});

// --- the guards (D1, architect P2-5) ----------------------------------------------------------

test('summarize throws: no strip, every row keeps its verb with no status line, logged with the function name only; the menu opens', async (t) => {
  t.mock.method(summaryModule, 'summarize', () => { throw new Error('SECRET_DETAIL'); });
  const { view, log } = await menuFor(ADA, '/blank');
  assert.equal(block(view, 'strip:knows'), undefined);
  assert.equal(block(view, 'strip:progress'), undefined);
  assert.deepEqual(rowsOf(view).map((r) => `${r.text}|${r.status}|${r.verb}`), ['*Ask*|null|Ask', '*Request a tool*|null|Request', '*Add context*|null|Add', '*Data sources*|null|View']);
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
  assert.equal(statusOf(view, 'blank-request'), null);
  assert.equal(rowOf(view, 'blank-request').accessory.text.text, 'Request');
  assert.equal(statusOf(view, 'blank-ask'), '🟡 nothing taught yet');
  assert.ok(knowsOf(view));
  assert.deepEqual(log.lines.filter((l) => l.msg === 'menu fact skipped').map((l) => l.fields), [{ module: 'blank-request', fn: 'toolStatus' }]);
});

test('statusText gets an unknown key for one row: that row keeps its verb with no status line, logged with the module id and function name only', async (t) => {
  const real = statusModule.toolStatus;
  t.mock.method(statusModule, 'toolStatus', (mod, facts) => (mod.id === 'blank-ask' ? { key: 'requested', detail: null } : real(mod, facts)));
  const { view, log } = await menuFor(ADA, '/blank');
  assert.equal(rowOf(view, 'blank-ask').text.text, '*Ask*');
  assert.equal(statusOf(view, 'blank-ask'), null);
  assert.equal(rowOf(view, 'blank-ask').accessory.text.text, 'Ask');
  assert.equal(statusOf(view, 'blank-add'), '⚪ not started');
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
    assert.equal(knowsOf(seen['/blank']), 'Knows: 1 note', order.join());
    assert.equal(knowsOf(seen['/full']), 'Knows: 3 notes · 1 source · 1 truth · 2 rules', order.join());
    assert.equal(statusOf(seen['/blank'], 'blank-add'), '1 note');
    assert.equal(statusOf(seen['/full'], 'full-add'), '3 notes');
    assert.equal(statusOf(seen['/blank'], 'blank-sources'), 'notes only · no data on this hub');
    assert.equal(statusOf(seen['/full'], 'full-sources'), null);
    assert.equal(progressOf(seen['/blank']), '1 of 2 tools working · 1 limited');
    assert.equal(progressOf(seen['/full']), 'All 10 tools working');
    // Story 17.4: each hub's next step from its own summary. Blank is taught
    // and has only the template tools; full has its own tools.
    assert.equal(block(seen['/blank'], 'next').text.text, '*Next:* request your first tool', order.join());
    assert.equal(block(seen['/full'], 'next'), undefined, order.join());
  }
  // The "New" record per hub is tested in hub-status-next.test.js.
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
  // Header, two strip lines, welcome, next step (5) + divider and Help (2)
  // + the more line (1) + Setup (5: its header, two rows and a status line
  // under each) leave 87: five groups of 1 + 15 (the tools are healthy, so
  // they have no status line).
  assert.deepEqual(groups, ['Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5', 'Setup · admins only']);
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
  for (const r of rowsOf(open.view)) assert.equal(r.status, CHECKING, r.id);
  assert.equal(calls(s.app, 'update').length, 0);
  slow.release();
  await done;
  const [update] = calls(s.app, 'update');
  assert.equal(update.view_id, 'V1');
  assert.equal(update.hash, 'h1');
  assert.equal(knowsOf(update.view), 'Knows: 2 notes');
  assert.equal(progressOf(update.view), '1 of 2 tools working · 1 limited');
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
  assert.deepEqual(rowsOf(update.view).map((r) => [r.text, r.status]), [['*Ask*', null], ['*Request a tool*', null], ['*Add context*', null], ['*Data sources*', null]]);
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
  assert.equal(knowsOf(menu), 'Knows: 2 notes');
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
  assert.match(menu.text, /\nKnows: nothing yet\nSetup 0 of 1 · 1 of 2 tools working/);
  assert.equal(knowsOf(menu), 'Knows: nothing yet');
  assert.ok(s.log.lines.some((l) => l.msg === 'hub modal fallback' && l.fields.reason === 'expired_trigger_id'));
});

test('way out, a click on an old message menu: dispatch is unchanged (a private reply, no view)', async () => {
  const s = setup();
  assert.equal(await s.app.dispatchAction('blank-sources:open', { user: { id: ADA } }), 1);
  assert.equal(calls(s.app, 'push').length, 0);
  assert.match(JSON.stringify(s.app.responded.at(-1)), /Nothing yet: no added context, and this hub doesn't connect to data\./);
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

test('setupProgress is "Setup N of M" then "X of Y tools working", with no bar; CHECKING is a word with no dot and is not a status', () => {
  assert.equal(setupProgress(0, 1, 1, 2), 'Setup 0 of 1 · 1 of 2 tools working');
  assert.equal(setupProgress(2, 4, 0, 0), 'Setup 2 of 4');
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
  assert.deepEqual(member.blocks.filter((b) => /^entry:/.test(b.block_id || '')).map((b) => b.text.text), ['*A*']);
  assert.equal(statusOf(member, 'a'), CHECKING);
  assert.equal(member.blocks.find((b) => b.block_id === 'strip:knows').text.text, KNOWS_CHECKING);
  const admin = buildMenu(hub, rows, { admin: true });
  assert.deepEqual(admin.blocks.filter((b) => /^group:/.test(b.block_id || '')).map((b) => b.text.text), ['Tools', SETUP_GROUP]);
});

// --- subtle health (2026-10-31) -----------------------------------------------------------------

const pureSummary = (done, of, counts = {}) => ({
  counts: {
    notes: 0, sources: 0, truths: 0, rules: 0, ...counts,
  },
  problem: false,
  done,
  of,
  steps: [{ step: 'taught', counted: true, done: done > 0 }],
});

test('buildMenu, subtle health: a healthy row has no status line; each attention state is a small grey dot line; a setup fact has no dot', () => {
  const hub = { id: 'h', name: 'H' };
  const e = (id, archetype) => ({ id, label: id.toUpperCase(), archetype });
  const rows = [
    { entry: e('ok', 'handler'), status: { key: 'ready', detail: null } },
    { entry: e('part', 'ask'), status: { key: 'partly', detail: 'no data yet' } },
    { entry: e('wait', 'scoped-pull'), status: { key: 'waiting', detail: 'needs data' } },
    { entry: e('add', 'add-context'), status: { key: 'not-started', detail: 'no notes yet' } },
    { entry: e('src', 'data-sources'), status: { key: 'context-only', detail: 'no data on this hub' } },
  ];
  const { blocks } = buildMenu(hub, rows, { admin: true, strip: true, summary: pureSummary(1, 1, { notes: 2 }) });
  const view = { blocks };
  assert.equal(statusOf(view, 'ok'), null);
  assert.equal(statusOf(view, 'part'), '🟡 no data yet');
  assert.equal(statusOf(view, 'wait'), '⚪ needs data');
  assert.equal(statusOf(view, 'add'), '⚪ not started');
  assert.equal(statusOf(view, 'src'), 'notes only · no data on this hub');
  for (const id of ['part', 'wait', 'add', 'src']) {
    const b = block(view, `status:${id}`);
    assert.equal(b.type, 'context', id);
    assert.equal(b.elements.length, 1, id);
    assert.equal(b.elements[0].type, 'mrkdwn', id);
  }
  // A waiting row's button is still Why?; the others keep their verbs.
  assert.equal(rowOf(view, 'wait').accessory.text.text, 'Why?');
  assert.equal(rowOf(view, 'part').accessory.text.text, 'Ask');
  // The strip has no dots, and no old mark is anywhere in the menu.
  for (const id of ['strip:knows', 'strip:progress']) assert.doesNotMatch(JSON.stringify(block(view, id)), /🟢|🟡|⚪|🔴/);
  assert.doesNotMatch(JSON.stringify(blocks), /[✓◐◌○▰▱]|🔒/);
});

test('buildMenu, the strip: zero counts are left off, "Knows: nothing yet" when all are zero, and both forms of line 2', () => {
  const hub = { id: 'h', name: 'H' };
  const tool = (id, key) => ({ entry: { id, label: id, archetype: 'handler' }, status: key ? { key, detail: null } : null });
  const strip = (rows, summary, admin = true) => {
    const { blocks } = buildMenu(hub, rows, { admin, strip: true, summary });
    return [knowsOf({ blocks }), progressOf({ blocks })];
  };
  const ok = [tool('a', 'ready'), tool('b', 'ready')];
  assert.deepEqual(strip(ok, pureSummary(1, 1)), ['Knows: nothing yet', 'All 2 tools working']);
  assert.deepEqual(strip(ok, pureSummary(1, 1, { notes: 2 })), ['Knows: 2 notes', 'All 2 tools working']);
  assert.deepEqual(strip(ok, pureSummary(1, 1, { sources: 1, truths: 7 })), ['Knows: 1 source · 7 truths', 'All 2 tools working']);
  assert.equal(strip(ok, pureSummary(1, 1, {
    notes: 1, sources: 1, truths: 1, rules: 3,
  }))[0], 'Knows: 1 note · 1 source · 1 truth · 3 rules');
  // Line 2 while setup is incomplete: "Setup N of M · X of Y tools working".
  assert.equal(strip(ok, pureSummary(1, 4))[1], 'Setup 1 of 4 · 2 of 2 tools working');
  // Line 2 once complete, with tools that are not working: honest counts.
  const mixed = [tool('a', 'ready'), tool('b', 'partly'), tool('c', 'waiting'), tool('d', 'waiting'), tool('e', null)];
  assert.equal(strip(mixed, pureSummary(1, 1))[1], '1 of 5 tools working · 1 limited · 2 need setup');
  assert.equal(strip(mixed.slice(0, 3), pureSummary(1, 1))[1], '1 of 3 tools working · 1 limited · 1 needs setup');
  // A member sees the same tools line, never setup progress.
  assert.equal(strip(mixed.slice(0, 3), pureSummary(1, 4), false)[1], '1 of 3 tools working · 1 limited · 1 needs setup');
  // A count that couldn't be read is never hidden as "nothing yet".
  assert.equal(strip(ok, { ...pureSummary(1, 1), problem: true })[0], KNOWS_UNCHECKED);
});

test('buildMenu, the block budget counts each status line: 60 waiting tools in eight groups cut whole groups to stay under 100', () => {
  const hub = { id: 'h', name: 'H' };
  const rows = Array.from({ length: 60 }, (_, i) => ({
    entry: {
      id: `w${i}`, label: `W ${i}`, archetype: 'scoped-pull', group: `G${Math.floor(i / 7.5) + 1}`,
    },
    status: { key: 'waiting', detail: 'needs data' },
  }));
  const { blocks } = buildMenu(hub, rows, { admin: true, strip: true, summary: pureSummary(1, 1) });
  assert.ok(blocks.length <= 100, `${blocks.length}`);
  assert.ok(blocks.some((b) => b.block_id === 'more'));
  // Every kept row has its status line right under it: no half rows.
  const ids = blocks.map((b) => b.block_id || b.type);
  for (const id of ids.filter((x) => /^entry:/.test(x))) assert.equal(ids[ids.indexOf(id) + 1], `status:${id.slice(6)}`, id);
});
