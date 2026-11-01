'use strict';

// Story 16.3 (plan brightside-v0, D9, D10): readiness
// (kit/runtime/knowledge/readiness) and the data-sources archetype
// (kit/runtime/archetypes/data-sources), opened through the hubs. Fixtures
// only: test/fixtures/runtime/data-sources has a full hub (sees context, data
// and rules) and a blank one (sees nothing), each with a Data sources module,
// and a profile whose client files hold signed-off and pending truths.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry, loadModules, loadHubs } = require('../../kit/runtime/registry');
const { createHubViews } = require('../../kit/runtime/slack/hub-view');
const { registerHubs, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const { readiness, createRulesReader } = require('../../kit/runtime/knowledge/readiness');
const dataSources = require('../../kit/runtime/archetypes/data-sources');
const { createStore } = require('../../kit/runtime/store');
const { PLAIN_ERROR } = require('../../kit/runtime/slack/handle');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime/data-sources');
const PROFILE_PATH = path.join(FIX, 'profile.yml');
const profile = loadProfile(PROFILE_PATH);
const { registry, problems: loadProblems } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });
const FULL = ['context', 'data', 'rules'];
const ADMIN = { id: 'UADA', name: 'ada' };
const MEMBER = { id: 'UBO', name: 'bo' };
// What must never be shown: the truths' expect values and commands, the
// files' own text, and the forbidden column names.
const NEVER = ['987654321', '987,654,321', '24680135', 'RUN_ARG_NEVER_SHOWN', 'console.log', 'DATA_PROSE_NEVER_SHOWN', 'GUARDRAILS_NEVER_SHOWN', 'people.phone', 'people.street'];

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

function fakeData({ available = true, fail = null } = {}) {
  const calls = { describe: 0, run: 0 };
  return {
    calls,
    run: async () => { calls.run += 1; return []; },
    describe: () => {
      calls.describe += 1;
      if (fail) throw fail;
      return { source: 'local fixture', label: 'tiny.duckdb', available, problem: available ? null : 'not open' };
    },
  };
}

// A rules reader that records each read.
function spyReader(inner) {
  const spy = { reads: 0 };
  spy.read = () => { spy.reads += 1; return inner.read(); };
  return spy;
}

const reader = (opts = {}) => createRulesReader({
  profile, profilePath: PROFILE_PATH, readLast: () => null, ...opts,
});
const view = (sees, data = fakeData()) => ({ id: 'h', sees, data: sees.includes('data') ? data : null, rules: sees.includes('rules') });

function tmpDir(t, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aplabs-${name}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A copy of the fixture's profile and client files, edited.
function copied(t, edit) {
  const dir = tmpDir(t, 'ds');
  fs.cpSync(path.join(FIX, 'context'), path.join(dir, 'context'), { recursive: true });
  fs.copyFileSync(PROFILE_PATH, path.join(dir, 'profile.yml'));
  edit(path.join(dir, 'context'));
  return path.join(dir, 'profile.yml');
}

const blockTexts = (blocks) => blocks.map((b) => (b.text && b.text.text) || '');
const allText = (blocks) => blockTexts(blocks).join('\n');

// --- readiness ------------------------------------------------------------------

test('the fixture app loads: data-sources is a built archetype', () => {
  assert.deepEqual(loadProblems, []);
  assert.deepEqual(registry.modules.map((m) => [m.id, m.archetype]), [['blank-sources', 'data-sources'], ['full-sources', 'data-sources']]);
});

test('readiness: a hub that sees neither data nor rules is false for both, reading nothing', () => {
  const data = fakeData();
  const rules = spyReader(reader());
  const r = readiness({ id: 'blank', sees: [], data, rules: false }, { rules });
  assert.equal(r.data, false);
  assert.equal(r.rules, false);
  assert.equal(data.calls.describe, 0);
  assert.equal(rules.reads, 0);
  assert.equal(r.detail.data.seen, false);
  assert.equal(r.detail.rules.seen, false);
  // A blank view from the hub views (the real seam) reads nothing either.
  const views = createHubViews({ hubs: registry.hubs, data });
  const b = readiness(views.forHub('blank'), { rules });
  assert.deepEqual([b.data, b.rules], [false, false]);
  assert.equal(data.calls.describe, 0);
  assert.equal(rules.reads, 0);
});

test('readiness: a full hub with connected data, both files signed and one signed-off truth is ready for both', () => {
  const r = readiness(view(FULL), { rules: reader() });
  assert.equal(r.data, true);
  assert.equal(r.rules, true);
  assert.deepEqual(r.detail.data, {
    seen: true, connected: true, source: 'local fixture', label: 'tiny.duckdb', problem: false,
  });
  assert.deepEqual(r.detail.rules.files.map((f) => [f.file, f.signed, f.owner, f.signedOff]), [
    ['data.md', true, 'Ada Owner', '2026-10-20'], ['guardrails.md', true, 'Ada Owner', '2026-10-21'],
  ]);
  assert.deepEqual(r.detail.rules.truths.map((x) => [x.id, x.owner, x.signedOff, x.valid, x.last]), [
    ['active-people', 'Ada Owner', '2026-10-20', true, null], ['open-jobs', 'Bo Owner', 'pending', true, null],
  ]);
  assert.equal(r.detail.rules.forbiddenColumns, 2);
  // detail never holds a truth's expect, its run, a file's text or a column name.
  const json = JSON.stringify(r.detail);
  for (const s of NEVER) assert.ok(!json.includes(s), s);
  for (const t of r.detail.rules.truths) assert.deepEqual(Object.keys(t).sort(), ['id', 'last', 'owner', 'signedOff', 'statement', 'valid']);
});

test('readiness: data is connected only when the hub sees data and the runner says available', () => {
  assert.equal(readiness(view(['data']), { rules: reader() }).data, true);
  assert.equal(readiness(view(['data'], fakeData({ available: false })), { rules: reader() }).data, false);
  // Sees data but no runner was handed in.
  assert.equal(readiness({ sees: ['data'], data: null, rules: false }).data, false);
  // Sees rules only: the rules are read, the runner is not.
  const data = fakeData();
  const r = readiness({ sees: ['rules'], data, rules: true }, { rules: reader() });
  assert.deepEqual([r.data, r.rules], [false, true]);
  assert.equal(data.calls.describe, 0);
});

test('readiness: a runner whose describe() throws is "not connected" with a problem flag, never an error, and no cause', () => {
  const r = readiness(view(FULL, fakeData({ fail: new Error('SECRET_CAUSE /var/lib/x') })), { rules: reader() });
  assert.equal(r.data, false);
  assert.equal(r.detail.data.problem, true);
  assert.ok(!JSON.stringify(r.detail).includes('SECRET_CAUSE'));
});

test('readiness: rules are not set up when a file is unsigned or missing, or no truth is valid and signed off', (t) => {
  const cases = {
    'guardrails pending': (dir) => {
      const f = path.join(dir, 'guardrails.md');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('signed_off: 2026-10-21', 'signed_off: pending'));
    },
    'guardrails missing': (dir) => fs.rmSync(path.join(dir, 'guardrails.md')),
    'data.md missing': (dir) => fs.rmSync(path.join(dir, 'data.md')),
    'data.md broken frontmatter': (dir) => {
      const f = path.join(dir, 'data.md');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^---\n/, ''));
    },
    'only pending truths': (dir) => {
      const f = path.join(dir, 'data.md');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/signed_off: 2026-10-20\n```/, 'signed_off: pending\n```'));
    },
    'the signed truth is malformed': (dir) => {
      const f = path.join(dir, 'data.md');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('expect: 987654321', 'expect: lots'));
    },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const profilePath = copied(t, edit);
    const r = readiness(view(FULL), { rules: createRulesReader({ profile, profilePath, readLast: () => null }) });
    assert.equal(r.rules, false, name);
    assert.equal(r.data, true, name);
    assert.equal(r.detail.rules.problem, false, `${name}: not set up is not a problem`);
  }
});

test('readiness: an unreadable client file is "not set up" with a problem flag, never an error', (t) => {
  const profilePath = copied(t, (dir) => {
    fs.rmSync(path.join(dir, 'data.md'));
    fs.mkdirSync(path.join(dir, 'data.md')); // reading it fails (EISDIR)
  });
  const r = readiness(view(FULL), { rules: createRulesReader({ profile, profilePath, readLast: () => null }) });
  assert.equal(r.rules, false);
  assert.equal(r.detail.rules.problem, true);
  assert.deepEqual(r.detail.rules.truths, []);
  assert.ok(!JSON.stringify(r.detail).includes('EISDIR'));
});

test('readiness: a reader that throws, or none at all, is "not set up" with a problem flag', () => {
  const throwing = { read: () => { throw new Error('boom'); } };
  for (const rules of [throwing, null]) {
    const r = readiness(view(FULL), { rules });
    assert.equal(r.rules, false);
    assert.equal(r.detail.rules.problem, true);
  }
});

test('readiness: each truth carries its outcome at the last verify run; a truth removed since is not listed', () => {
  const last = {
    at: '2026-10-29T08:00:00.000Z',
    results: [{ id: 'truth:active-people', outcome: 'pass' }, { id: 'truth:open-jobs', outcome: 'fail' }, { id: 'truth:gone', outcome: 'fail' }],
  };
  const r = readiness(view(FULL), { rules: reader({ readLast: () => last }) });
  assert.deepEqual(r.detail.rules.truths.map((x) => [x.id, x.last]), [['active-people', 'pass'], ['open-jobs', 'fail']]);
  assert.equal(r.detail.rules.checkedAt, '2026-10-29T08:00:00.000Z');
  // A record that can't be read counts as none.
  const broken = readiness(view(FULL), { rules: reader({ readLast: () => { throw new Error('x'); } }) });
  assert.deepEqual(broken.detail.rules.truths.map((x) => x.last), [null, null]);
});

test('readiness: outside a git repo there is no verify record (not checked on this machine), clock frozen', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T12:00:00Z') });
  const profilePath = copied(t, () => {});
  const r = readiness(view(FULL), { rules: createRulesReader({ profile, profilePath, now: () => Date.now() }) });
  assert.deepEqual(r.detail.rules.truths.map((x) => x.last), [null, null]);
  assert.equal(r.detail.rules.checkedAt, null);
});

test('readiness: no profile path is "not set up" with a problem flag', () => {
  const r = readiness(view(FULL), { rules: createRulesReader({ profile, profilePath: null }) });
  assert.equal(r.rules, false);
  assert.equal(r.detail.rules.problem, true);
});

// --- the view ---------------------------------------------------------------------

test('render: the blank (v0) hub reads "Nothing yet", saying it doesn\'t connect to data, and "None yet." for added context', () => {
  const msg = dataSources.render({ ready: readiness(view([]), { rules: reader() }) });
  assert.deepEqual(blockTexts(msg.blocks), ["Nothing yet: no added context, and this hub doesn't connect to data.", '*Added context*\nNone yet.']);
  assert.equal(msg.text, "Nothing yet: no added context, and this hub doesn't connect to data.");
});

// The wording in each state (fix/data-sources-wording).
const noRunner = (sees) => ({ id: 'h', sees, data: null, rules: sees.includes('rules') });
const NOTE = [{ title: 'Prices', added_by: 'UADA', added_at: '2026-10-30T10:00:00.000Z' }];

test('wording: a v0 hub with added context answers from it and says it doesn\'t connect to data, never truths or rules', () => {
  const msg = dataSources.render({ ready: readiness(view([]), { rules: reader() }), entries: NOTE });
  assert.equal(dataSources.CONTEXT_ONLY_NO_DATA_HUB, "Answers from the added context below. This hub doesn't connect to data, so it can't answer questions about numbers.");
  assert.deepEqual(blockTexts(msg.blocks), [dataSources.CONTEXT_ONLY_NO_DATA_HUB, '*Added context*\n• Prices by <@UADA> on 2026-10-30']);
  assert.equal(msg.text, dataSources.CONTEXT_ONLY_NO_DATA_HUB);
  assert.doesNotMatch(allText(msg.blocks), /truth|rule|No data|not connected/i);
});

test('wording: a v0 hub with nothing reads "Nothing yet", never truths or rules', () => {
  const msg = dataSources.render({ ready: readiness(view([]), { rules: reader() }) });
  assert.equal(dataSources.NOTHING_YET_NO_DATA_HUB, "Nothing yet: no added context, and this hub doesn't connect to data.");
  assert.doesNotMatch(allText(msg.blocks), /truth|rule/i);
});

test('wording: a v0 hub whose context can\'t be listed still says it doesn\'t connect to data', () => {
  const msg = dataSources.render({ ready: readiness(view([]), { rules: reader() }), contextProblem: true, admin: '<@UADA>' });
  assert.deepEqual(blockTexts(msg.blocks).slice(1), ["This hub doesn't connect to data.", '*Added context*\nNone yet.']);
});

test('wording: a hub that sees data, with added context and no data connected, answers from the context "yet"', () => {
  const msg = dataSources.render({ ready: readiness(noRunner(['data']), { rules: reader() }), entries: NOTE });
  assert.equal(dataSources.CONTEXT_ONLY, "Answers from the added context below. No data is connected, so it can't answer questions about numbers yet.");
  assert.deepEqual(blockTexts(msg.blocks), [dataSources.CONTEXT_ONLY, '*Connected data*\nNo data connected yet.', '*Added context*\n• Prices by <@UADA> on 2026-10-30']);
  assert.doesNotMatch(allText(msg.blocks), /truth|rule/i);
});

test('wording: a hub that sees data, with nothing at all, reads "Nothing yet: no added context and no data connected."', () => {
  const msg = dataSources.render({ ready: readiness(noRunner(['data']), { rules: reader() }) });
  assert.equal(dataSources.NOTHING_YET, 'Nothing yet: no added context and no data connected.');
  assert.deepEqual(blockTexts(msg.blocks), [dataSources.NOTHING_YET, '*Connected data*\nNo data connected yet.', '*Added context*\nNone yet.']);
});

test('wording: a hub that sees data and rules keeps its truths and rules lines under the lead line', (t) => {
  const withRules = dataSources.render({ ready: readiness(noRunner(FULL), { rules: reader() }), entries: NOTE });
  const text = allText(withRules.blocks);
  assert.equal(withRules.text, dataSources.CONTEXT_ONLY);
  assert.match(text, /\*Known truths and rules\*\n• data\.md: signed off/);
  assert.match(text, /The rules are set up\./);
  // Nothing set up at all: the lead line, then each section says so.
  const profilePath = copied(t, (dir) => {
    for (const f of ['data.md', 'guardrails.md']) fs.rmSync(path.join(dir, f));
  });
  const empty = dataSources.render({ ready: readiness(noRunner(FULL), { rules: createRulesReader({ profile, profilePath, readLast: () => null }) }) });
  assert.equal(empty.text, dataSources.NOTHING_YET);
  assert.match(allText(empty.blocks), /• data\.md: missing\n• guardrails\.md: missing\n.*\n\nNo known truths yet\./s);
  // Rules but no context and no data: no lead line (it would not be "nothing").
  const rulesOnly = dataSources.render({ ready: readiness(noRunner(FULL), { rules: reader() }) });
  assert.equal(rulesOnly.text, '*Connected data*\nNo data connected yet.');
});

test('wording: a hub that sees rules but not data says it doesn\'t connect to data, with its rules and no Connected data section', () => {
  const msg = dataSources.render({ ready: readiness(noRunner(['rules']), { rules: reader() }), entries: NOTE });
  const texts = blockTexts(msg.blocks);
  assert.equal(texts[0], dataSources.CONTEXT_ONLY_NO_DATA_HUB);
  assert.ok(!texts.some((x) => x.startsWith('*Connected data*')));
  assert.ok(texts.some((x) => x.startsWith('*Known truths and rules*')));
});

test('wording: a hub with a data source, available or not, keeps the current wording and has no lead line', () => {
  for (const available of [true, false]) {
    const msg = dataSources.render({ ready: readiness(view(['data'], fakeData({ available })), { rules: reader() }), entries: NOTE });
    assert.deepEqual(blockTexts(msg.blocks), [
      `*Connected data*\n• local fixture: tiny.duckdb, ${available ? 'available' : 'not available right now'}`,
      '*Added context*\n• Prices by <@UADA> on 2026-10-30',
    ]);
  }
});

test('render: a full hub shows its source, both files, the column count and each truth, never an expect value or command', () => {
  const last = { at: '2026-10-29T08:00:00.000Z', results: [{ id: 'truth:active-people', outcome: 'pass' }] };
  const msg = dataSources.render({ ready: readiness(view(FULL), { rules: reader({ readLast: () => last }) }) });
  const text = allText(msg.blocks);
  assert.match(text, /\*Connected data\*\n• local fixture: tiny\.duckdb, available/);
  assert.match(text, /• data\.md: signed off 2026-10-20 by Ada Owner/);
  assert.match(text, /• guardrails\.md: signed off 2026-10-21 by Ada Owner/);
  assert.match(text, /Columns kept out of every query: 2/);
  assert.match(text, /• \*active-people\*: There are this many active people\.\n {3}Owner: Ada Owner\. Signed off 2026-10-20\. Last check passed \(2026-10-29\)\./);
  // Escaped: a statement can't format or mention.
  assert.match(text, /• \*open-jobs\*: Open jobs at month end &lt;b&gt;&amp;&lt;\/b&gt;\.\n {3}Owner: Bo Owner\. Awaiting sign-off\. Not checked on this machine\./);
  assert.match(text, /The rules are set up\./);
  assert.match(text, /\*Added context\*\nNone yet\./);
  assert.ok(!text.includes('No data connected yet'));
  const json = JSON.stringify(msg);
  for (const s of NEVER) assert.ok(!json.includes(s), s);
});

test('render: a hub that sees data and rules with nothing set up says so section by section', (t) => {
  const profilePath = copied(t, (dir) => {
    for (const f of ['data.md', 'guardrails.md']) fs.rmSync(path.join(dir, f));
  });
  const ready = readiness(view(FULL, fakeData({ available: false })), { rules: createRulesReader({ profile, profilePath, readLast: () => null }) });
  const text = allText(dataSources.render({ ready }).blocks);
  assert.match(text, /• local fixture: tiny\.duckdb, not available right now/);
  assert.match(text, /• data\.md: missing\n• guardrails\.md: missing/);
  assert.match(text, /No known truths yet\./);
  assert.match(text, /The rules are not set up yet/);
});

test('render: a malformed truth is named, with nothing from its block but its id and statement', (t) => {
  const profilePath = copied(t, (dir) => {
    const f = path.join(dir, 'data.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('owner: Bo Owner\n', 'owner: Bo Owner\nsecret_key: 13579\n'));
  });
  const ready = readiness(view(FULL), { rules: createRulesReader({ profile, profilePath, readLast: () => null }) });
  const text = allText(dataSources.render({ ready }).blocks);
  assert.match(text, /• \*open-jobs\*: Open jobs at month end .*\n {3}Needs fixing in data\.md before it can be used\./);
  assert.ok(!text.includes('13579'));
  assert.ok(!text.includes('24680135'));
});

test('render: added context entries show title, who and when, escaped; a bad Slack id is left out', () => {
  const ready = readiness(view([]), { rules: reader() });
  const entries = [
    { title: 'Prices <b>& hours</b>', added_by: 'UADA', added_at: '2026-10-30T10:00:00.000Z' },
    { title: 'Area <!here>', added_by: '<!channel>', added_at: 'yesterday' },
  ];
  const text = allText(dataSources.render({ ready, entries }).blocks);
  assert.match(text, /\*Added context\*\n• Prices &lt;b&gt;&amp; hours&lt;\/b&gt; by <@UADA> on 2026-10-30\n• Area &lt;!here&gt;$/);
});

test('render: something unreadable gets a plain note naming the admin, above what could be read', () => {
  const ready = readiness(view(FULL, fakeData({ fail: new Error('x') })), { rules: reader() });
  const msg = dataSources.render({ ready, admin: '<@UADA>' });
  assert.equal(msg.blocks[0].text.text, "Some of this couldn't be read just now, so it may show less than is set up. Press Back and try again in a minute, or ask <@UADA>.");
  assert.match(allText(msg.blocks), /The data could not be checked just now\./);
});

// --- the manifest -------------------------------------------------------------------

test('a data-sources manifest has no handler, query, parameters, scoring or row_id', (t) => {
  const dir = tmpDir(t, 'ds-app');
  fs.cpSync(path.join(FIX, 'app'), dir, { recursive: true });
  const f = path.join(dir, 'modules/full-sources/manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({
    ...m, handler: 'h.js', query: 'q.sql', parameters: [], row_id: 'id',
  }));
  const { hubs } = loadHubs(dir);
  const { problems } = loadModules(dir, { hubs, profile });
  assert.deepEqual(problems, [
    'modules/full-sources/manifest.json: field "handler" is not used by a data-sources module (the engine shows it)',
    'modules/full-sources/manifest.json: field "query" is not used by a data-sources module (the engine shows it)',
    'modules/full-sources/manifest.json: field "parameters" is not used by a data-sources module (the engine shows it)',
    'modules/full-sources/manifest.json: field "row_id" is not used by a data-sources module (the engine shows it)',
  ]);
});

// --- through the hubs: Open and every way out ------------------------------------------

const MENU = (hub) => ({ id: 'VMENU', type: 'modal', private_metadata: hub, hash: 'hmenu' });
const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);

function setup({
  data = fakeData(), rules = reader(), views = true, knowledge = null,
} = {}) {
  const app = new FakeSlackApp({ views });
  const log = quietLog();
  const hubViews = createHubViews({ hubs: registry.hubs, data, knowledge });
  registerHubs(app, {
    registry, profile, env: 'dev', log, store: createStore(), forHub: hubViews.forHub, rules,
  });
  return { app, log, data };
}

test('the menu shows Data sources to the admin (the role confers the key), not to a member', async () => {
  const { app } = setup();
  await app.dispatchCommand('/blank', { user_id: 'UADA' });
  await app.dispatchCommand('/blank', { user_id: 'UBO' });
  const ids = (v) => v.blocks.filter((b) => b.accessory && /:open$/.test(b.accessory.action_id)).map((b) => b.accessory.action_id);
  const [admin, member] = calls(app, 'open').map((c) => c.view);
  assert.deepEqual(ids(admin), ['blank-sources:open']);
  assert.deepEqual(ids(member), []);
});

test('Open on the blank hub pushes a Back view reading "Nothing yet: ... this hub doesn\'t connect to data.", reading nothing', async () => {
  const rules = spyReader(reader());
  const { app, log, data } = setup({ rules });
  await app.dispatchAction('blank-sources:open', { user: ADMIN, view: MENU('blank') });
  assert.equal(app.acks, 1);
  assert.deepEqual(app.views.map((v) => v.method), ['push']);
  const [push] = calls(app, 'push');
  assert.equal(push.view.title.text, 'Data sources');
  assert.equal(push.view.close.text, 'Back');
  assert.equal(push.view.submit, undefined);
  assert.deepEqual(blockTexts(push.view.blocks), ["Nothing yet: no added context, and this hub doesn't connect to data.", '*Added context*\nNone yet.']);
  assert.equal(rules.reads, 0);
  assert.equal(data.calls.describe, 0);
  assert.equal(data.calls.run, 0);
  assert.ok(log.lines.some((l) => l.msg === 'module dispatched' && l.fields.module === 'blank-sources' && l.fields.hub === 'blank'));
  assert.deepEqual(app.responded, []);
});

test('Open on the full hub shows its source and its truths; no expect value reaches any Slack call', async () => {
  const { app, data } = setup();
  await app.dispatchAction('full-sources:open', { user: ADMIN, view: MENU('full') });
  const [push] = calls(app, 'push');
  const text = allText(push.view.blocks);
  assert.match(text, /local fixture: tiny\.duckdb, available/);
  assert.match(text, /\*active-people\*: There are this many active people\./);
  assert.match(text, /\*open-jobs\*/);
  assert.equal(data.calls.run, 0);
  const json = JSON.stringify({
    views: app.views, responded: app.responded, posted: app.posted, said: app.said,
  });
  for (const s of NEVER) assert.ok(!json.includes(s), s);
});

test('way out, Back: the view is pushed onto the menu (Back pops to it); it asks for no view_closed and keeps nothing', async () => {
  const { app } = setup();
  await app.dispatchAction('blank-sources:open', { user: ADMIN, view: MENU('blank') });
  const [push] = calls(app, 'push');
  assert.equal(push.trigger_id, 'T-action');
  assert.equal(push.view.close.text, 'Back');
  assert.equal(push.view.notify_on_close, undefined);
  assert.equal(push.view.private_metadata, 'blank');
  assert.deepEqual(calls(app, 'open'), []);
});

test('way out, the X: closing the stack needs nothing from the bot (no view_closed, nothing stored, nothing posted)', async () => {
  const { app } = setup();
  await app.dispatchAction('full-sources:open', { user: ADMIN, view: MENU('full') });
  const [push] = calls(app, 'push');
  assert.equal(push.view.notify_on_close, undefined);
  // No listener for this view's close: Slack sends nothing, and nothing is left behind.
  assert.equal(await app.dispatchViewClosed(push.view.callback_id, { user: ADMIN, view: { id: 'V1' }, is_cleared: true }), 0);
  assert.deepEqual(app.posted, []);
  assert.deepEqual(app.uploads, []);
});

test('way out, an error reading the runner: a plain note in the view, with Back; the person never sees the cause', async () => {
  const { app, log } = setup({ data: fakeData({ fail: new Error('SECRET_CAUSE') }) });
  await app.dispatchAction('full-sources:open', { user: ADMIN, view: MENU('full') });
  const [push] = calls(app, 'push');
  assert.equal(push.view.close.text, 'Back');
  assert.match(push.view.blocks[0].text.text, /^Some of this couldn't be read just now.*ask <@UADA>\.$/);
  assert.ok(!JSON.stringify(app.views).includes('SECRET_CAUSE'));
  assert.ok(!log.lines.some((l) => l.msg === 'handler failed'));
});

test('way out, an error reading a context file: a plain note in the view, with Back', async (t) => {
  const profilePath = copied(t, (dir) => {
    fs.rmSync(path.join(dir, 'guardrails.md'));
    fs.mkdirSync(path.join(dir, 'guardrails.md'));
  });
  const { app } = setup({ rules: createRulesReader({ profile, profilePath, readLast: () => null }) });
  await app.dispatchAction('full-sources:open', { user: ADMIN, view: MENU('full') });
  const [push] = calls(app, 'push');
  assert.equal(push.view.close.text, 'Back');
  assert.match(push.view.blocks[0].text.text, /^Some of this couldn't be read just now/);
  assert.match(allText(push.view.blocks), /The rules are not set up yet/);
});

test('way out, the view fails to build: the plain error in the view, with Back', async () => {
  const rules = { read: () => ({ files: null }) }; // a reader returning nonsense
  const { app, log } = setup({ rules });
  await app.dispatchAction('full-sources:open', { user: ADMIN, view: MENU('full') });
  const views = app.views.map((v) => v.args.view);
  assert.ok(views.length >= 1);
  const last = views.at(-1);
  assert.equal(last.close.text, 'Back');
  assert.deepEqual(blockTexts(last.blocks), [PLAIN_ERROR]);
  assert.ok(log.lines.some((l) => l.msg === 'handler failed' && l.fields.handler === 'hub:dispatch'));
});

test('way out, an expired trigger: the view goes in place on the menu, logged; nothing else is sent', async () => {
  const { app, log } = setup();
  app.issueTrigger = (id) => { app.triggers.set(id, Date.now() - 4000); return id; };
  await app.dispatchAction('blank-sources:open', { user: ADMIN, view: MENU('blank') });
  assert.deepEqual(app.views.map((v) => v.method), ['push', 'update']);
  const [update] = calls(app, 'update');
  assert.equal(update.view_id, 'VMENU');
  assert.equal(update.view.close.text, 'Back');
  assert.deepEqual(blockTexts(update.view.blocks), ["Nothing yet: no added context, and this hub doesn't connect to data.", '*Added context*\nNone yet.']);
  assert.deepEqual(log.lines.filter((l) => l.msg === 'hub modal fallback').map((l) => l.fields), [
    { where: 'open', reason: 'expired_trigger_id', hub: 'blank', via: 'views.update' },
  ]);
});

test('way out, a click from an old message menu (the ephemeral fallback): the same view as a private reply', async () => {
  const { app } = setup();
  await app.dispatchAction('blank-sources:open', { user: ADMIN });
  assert.equal(app.responded.length, 1);
  assert.equal(app.responded[0].response_type, 'ephemeral');
  assert.equal(app.responded[0].text, "Nothing yet: no added context, and this hub doesn't connect to data.");
  assert.deepEqual(blockTexts(app.responded[0].blocks), ["Nothing yet: no added context, and this hub doesn't connect to data.", '*Added context*\nNone yet.']);
});

test('way out, a person without the key: the existing refusal; nothing is read', async () => {
  const rules = spyReader(reader());
  const { app, data } = setup({ rules });
  await app.dispatchAction('full-sources:open', { user: MEMBER, view: MENU('full') });
  await app.dispatchAction('full-sources:open', { user: { id: 'UNOBODY' }, view: MENU('full') });
  const [member, stranger] = calls(app, 'push');
  assert.match(member.view.blocks[0].text.text, /access to Data sources/);
  assert.match(stranger.view.blocks[0].text.text, /^You're not set up in Tiny's bot yet/);
  assert.equal(rules.reads, 0);
  assert.equal(data.calls.describe, 0);
});

test('a data-sources module hidden in this environment is refused as not available', async () => {
  const hidden = { ...registry.module('blank-sources'), environments: ['prod'] };
  const app2 = new FakeSlackApp({ views: true });
  const reg = { ...registry, module: (id) => (id === 'blank-sources' ? hidden : registry.module(id)) };
  registerHubs(app2, {
    registry: reg, profile, env: 'dev', log: quietLog(), store: createStore(), forHub: createHubViews({ hubs: registry.hubs }).forHub, rules: reader(),
  });
  await app2.dispatchAction('blank-sources:open', { user: ADMIN, view: MENU('blank') });
  assert.deepEqual(blockTexts(calls(app2, 'push')[0].view.blocks), [NOT_AVAILABLE]);
});

test('at boot the app reads the rules beside the profile: Data sources on the full hub shows the fixture\'s truths', async (t) => {
  const { main } = require('../../kit/runtime/app');
  const lines = [];
  const varDir = tmpDir(t, 'ds-boot-var');
  const data = { ...fakeData(), open: async () => {}, close: () => {} };
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      APLABS_PROFILE: PROFILE_PATH,
      APLABS_APP_DIR: path.join(FIX, 'app'),
      APLABS_VAR_DIR: varDir,
    },
    cwd: os.tmpdir(),
    deps: { App: FakeSlackApp, write: (l) => lines.push(l), data },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  await res.app.dispatchAction('full-sources:open', { user: ADMIN });
  await res.app.dispatchAction('blank-sources:open', { user: ADMIN });
  const [full, blank] = res.app.responded.map((r) => allText(r.blocks));
  assert.match(full, /• data\.md: signed off 2026-10-20 by Ada Owner/);
  assert.match(full, /\*active-people\*: There are this many active people\./);
  assert.match(full, /The rules are set up\./);
  assert.equal(blank.split('\n')[0], "Nothing yet: no added context, and this hub doesn't connect to data.");
  for (const s of NEVER) assert.ok(!JSON.stringify(res.app.responded).includes(s), s);
  res.engineJobs.stop();
  res.jobs.stop();
});

// --- added context (the hub's knowledge store, Story 16.4) -----------------------------

const { createKnowledgeStore } = require('../../kit/runtime/knowledge/store');

test('Data sources lists the hub\'s own added context (title, who, when), never an entry\'s text or another hub\'s entries', async (t) => {
  const varDir = tmpDir(t, 'ds-var');
  const now = Date.parse('2026-10-30T09:15:00Z');
  const knowledge = createKnowledgeStore({ clientId: 'tiny', varDir, log: quietLog(), now: () => now });
  await knowledge.add({ hub: 'blank', kind: 'text', title: 'Prices & <hours>', text: 'ENTRY_TEXT_NEVER_SHOWN', addedBy: 'UADA' });
  await knowledge.add({ hub: 'full', kind: 'text', title: 'Other hub note', text: 'x', addedBy: 'UADA' });
  const { app } = setup({ knowledge });
  await app.dispatchAction('blank-sources:open', { user: ADMIN, view: MENU('blank') });
  const [push] = calls(app, 'push');
  assert.deepEqual(blockTexts(push.view.blocks), [
    "Answers from the added context below. This hub doesn't connect to data, so it can't answer questions about numbers.",
    '*Added context*\n• Prices &amp; &lt;hours&gt; by <@UADA> on 2026-10-30',
  ]);
  const json = JSON.stringify(app.views);
  assert.ok(!json.includes('ENTRY_TEXT_NEVER_SHOWN'));
  assert.ok(!json.includes('Other hub note'));
});

test('way out, the added context can\'t be listed: "None yet." with the plain note naming the admin, and Back', async () => {
  const knowledge = { forHub: () => ({ list: async () => { throw Object.assign(new Error('SECRET_CAUSE'), { code: 'EACCES' }); } }) };
  const { app, log: hubLog } = setup({ knowledge });
  await app.dispatchAction('blank-sources:open', { user: ADMIN, view: MENU('blank') });
  const [push] = calls(app, 'push');
  assert.equal(push.view.close.text, 'Back');
  assert.match(push.view.blocks[0].text.text, /^Some of this couldn't be read just now.*ask <@UADA>\.$/);
  assert.match(allText(push.view.blocks), /\*Added context\*\nNone yet\./);
  assert.ok(!JSON.stringify(app.views).includes('SECRET_CAUSE'));
  assert.deepEqual(hubLog.lines.find((l) => l.msg === 'added context not listed').fields, { hub: 'blank', reason: 'EACCES' });
});

// --- plan brightside-v1, D7, Story 19.3: the approved rule cards ------------------

const CARD = (id, status) => `\n### ${id}: A rule\n- type: access_rule\n- rule: x\n- status: ${status}\n`;
const rulesText = (msg) => allText(msg.blocks);

test('19.3: Known truths and rules counts the approved rule cards, right under the columns kept out', (t) => {
  // The fixture's guardrails.md is signed and has no cards: 0.
  const none = dataSources.render({ ready: readiness(view(FULL), { rules: reader() }) });
  assert.match(rulesText(none), /• Columns kept out of every query: 2\n• Rule cards approved: 0\n/);
  // Three approved cards and one draft: 3.
  const profilePath = copied(t, (dir) => {
    fs.appendFileSync(path.join(dir, 'guardrails.md'), CARD('GRD-001', 'approved') + CARD('GRD-002', 'approved') + CARD('GRD-003', 'draft') + CARD('GRD-004', 'approved'));
  });
  const three = dataSources.render({ ready: readiness(view(FULL), { rules: createRulesReader({ profile, profilePath, readLast: () => null }) }) });
  assert.match(rulesText(three), /• Columns kept out of every query: 2\n• Rule cards approved: 3\n/);
});

test('19.3: while guardrails.md is unsigned, its approved cards count 0', (t) => {
  const profilePath = copied(t, (dir) => {
    const f = path.join(dir, 'guardrails.md');
    const text = fs.readFileSync(f, 'utf8').replace(/^signed_off: .*$/m, 'signed_off: pending').replace(/^signed_off_by: .*$/m, 'signed_off_by: pending');
    fs.writeFileSync(f, text + CARD('GRD-001', 'approved') + CARD('GRD-002', 'approved'));
  });
  const msg = dataSources.render({ ready: readiness(view(FULL), { rules: createRulesReader({ profile, profilePath, readLast: () => null }) }) });
  const text = rulesText(msg);
  assert.match(text, /• guardrails\.md: awaiting sign-off/);
  assert.match(text, /• Rule cards approved: 0\n/);
});

test('19.3: a hub that does not see rules has no rule-card line; a count that is not a whole number shows 0', () => {
  const noRules = dataSources.render({ ready: readiness(view(['data']), { rules: reader() }) });
  assert.doesNotMatch(rulesText(noRules), /Rule cards approved/);
  const ready = readiness(view(FULL), { rules: reader() });
  for (const bad of [undefined, -1, 1.5, '8', null]) {
    const odd = { ...ready, detail: { ...ready.detail, rules: { ...ready.detail.rules, approvedRules: bad } } };
    assert.match(rulesText(dataSources.render({ ready: odd })), /• Rule cards approved: 0\n/, String(bad));
  }
});
