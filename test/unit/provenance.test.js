'use strict';

// Story 9.6: "How was this made?". Every scoped-pull result that reached the
// data carries a button; the run record (AD-15 shape) sits in the store's
// `provenance` namespace for 24 hours, and a click by the person who ran it
// shows the confirmed values, the exact SQL, the data source and version and
// the time, in the view the button is in. Through the hub wiring with the fake
// Slack client and a stand-in query runner; the real runner on the minimal
// fixture checks the version query. The module is a fixture, never a client's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { createRegistry, loadRegistry } = require('../../kit/runtime/registry');
const { registerHubs } = require('../../kit/runtime/slack/hubs');
const { ACTIONS, FORM_CALLBACK, PROVENANCE_ACTION } = require('../../kit/runtime/archetypes/scoped-pull');
const { INPUT_BLOCK, VALUE_ACTION } = require('../../kit/runtime/archetypes/scoped-pull/form');
const provenance = require('../../kit/runtime/slack/provenance');
const { ProvenanceGone, ProvenanceNotYours, QueryFailed } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');
const { createStore, NAMESPACES } = require('../../kit/runtime/store');
const { createData } = require('../../kit/runtime/data');
const { build } = require('../../kit/fixture/build');
const sqlGuard = require('../../kit/runtime/sql');
const access = require('../../kit/runtime/access');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const FIX = path.join(__dirname, '../fixtures/runtime');
const MINI = path.join(__dirname, '../fixtures/fixture-build/mini');
const profile = loadProfile(path.join(FIX, 'profile.yml'));
const { registry: base } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });

const PULL = Object.freeze({
  id: 'lapsed',
  hub: 'alpha',
  label: 'Lapsed list',
  description: 'People who left.',
  resource: 'R',
  archetype: 'scoped-pull',
  environments: ['dev'],
  parameters: [
    { name: 'zone', label: 'Zone', type: 'string', enum: ['north', 'south'], required: true },
    { name: 'days', label: 'Days', type: 'integer', min: 1, max: 365, default: 90, required: true },
    { name: 'code', label: 'Code', type: 'string', pattern: '[A-Z]{2}', max_length: 2 },
  ],
  query: 'lapsed.sql',
  sql: 'SELECT name, zone\nFROM people\nWHERE zone = $zone AND days <= $days AND ($code IS NULL OR code = $code)',
});

const TWO = [{ name: 'Ann', zone: 'north' }, { name: 'Bo', zone: 'north' }];
const META = [{ key: 'as_of', value: '2026-09-30' }, { key: 'generator_version', value: '3' }];
const GONE = messageFor(new ProvenanceGone());
const NOT_YOURS = messageFor(new ProvenanceNotYours());
const T0 = Date.parse('2026-10-25T14:03:00.000Z');
const HOUR = 60 * 60 * 1000;

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// A stand-in runner: the version query gets META, anything else answer().
function fakeData(answer = () => TWO, describe = () => ({ source: 'MotherDuck', label: 'tinydb', available: true, problem: null })) {
  const runs = [];
  return {
    runs,
    run: async (sql, params, opts) => {
      runs.push({ sql, params, opts });
      return sql === provenance.VERSION_SQL ? META : answer(sql, params, opts);
    },
    describe,
  };
}

function setup({ data = fakeData(), mod = PULL, canUse = () => true } = {}) {
  const clock = { t: T0 };
  const store = createStore({ now: () => clock.t });
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  const registry = createRegistry({ hubs: base.hubs, modules: [...base.modules, mod] });
  const allowed = { fn: canUse };
  registerHubs(app, { registry, profile, env: 'dev', log, store, data, canUse: (...a) => allowed.fn(...a) });
  return { app, log, store, data, clock, allowed, mod };
}

const MENU_VIEW = { id: 'VMENU', type: 'modal', private_metadata: 'alpha', title: { type: 'plain_text', text: 'Alpha tools' } };
const updates = (app) => app.views.filter((v) => v.method === 'update').map((v) => v.args);
const texts = (view) => view.blocks.map((b) => (b.text && b.text.text) || null);
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function stateOf(mod, typed) {
  const values = {};
  for (const [name, v] of Object.entries(typed)) {
    const p = mod.parameters.find((x) => x.name === name);
    const entry = p.enum ? { type: 'static_select', selected_option: { value: v } } : { type: 'plain_text_input', value: v };
    values[`${INPUT_BLOCK}${name}`] = { [VALUE_ACTION]: entry };
  }
  return { values };
}

// Opens the form as user, checks typed and confirms. Returns the result view
// (as Slack would send it back in a click) and the button on it, if any.
async function runIt(ctx, typed = { zone: 'north' }, user = { id: 'U1' }) {
  await ctx.app.dispatchAction(`${ctx.mod.id}:open`, { user, view: MENU_VIEW });
  const form = ctx.app.views.at(-1).args.view;
  const formId = `V${ctx.app.viewSeq}`;
  await ctx.app.dispatchView(FORM_CALLBACK, {
    user, view: { id: formId, hash: 'hf', title: form.title, private_metadata: form.private_metadata, state: stateOf(ctx.mod, typed) },
  });
  const screen = ctx.app.viewAcks.at(-1).view;
  const session = screen.blocks.find((b) => b.type === 'actions').elements[0].value;
  await ctx.app.dispatchAction(ACTIONS.confirm, {
    user, view: { id: formId, hash: 'hc', title: screen.title, private_metadata: screen.private_metadata }, value: session,
  });
  const last = updates(ctx.app).at(-1);
  const view = last.view;
  const button = view.blocks.map((b) => b.accessory).find((a) => a && a.action_id === PROVENANCE_ACTION)
    || view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements).find((e) => e.action_id === PROVENANCE_ACTION);
  const from = { id: formId, hash: `h${ctx.app.viewSeq}`, title: view.title, private_metadata: view.private_metadata };
  return { view, button, from };
}

async function clickHow(ctx, { from, button, user = { id: 'U1' }, value = button.value }) {
  await ctx.app.dispatchAction(PROVENANCE_ACTION, { user, view: from, value });
  return updates(ctx.app).at(-1);
}

test('every result that reached the data carries the button; the run record has exactly the AD-15 shape for 24 hours', async () => {
  const ctx = setup();
  const before = Date.now();
  const { view, button } = await runIt(ctx, { zone: 'north', code: 'AB' });
  const after = Date.now();
  assert.equal(button.text.text, 'How was this made?');
  assert.match(button.value, /^[0-9a-f]{32}$/);
  // Beside the headline, so the result keeps its order.
  assert.equal(view.blocks[0].text.text, '*Lapsed list: 2 rows.*');
  assert.equal(view.blocks[0].accessory, button);
  assert.equal(NAMESPACES.provenance, 24 * HOUR);
  const record = ctx.store.get('provenance', button.value);
  assert.deepEqual(Object.keys(record), [...provenance.RECORD_KEYS]);
  assert.deepEqual(provenance.RECORD_KEYS, ['runId', 'person', 'module', 'parameters', 'sql', 'source', 'fixtureVersion', 'ranAt', 'rowIds', 'rows']);
  assert.deepEqual(record, {
    runId: button.value,
    person: 'U1',
    module: 'lapsed',
    parameters: { zone: 'north', days: 90, code: 'AB' },
    sql: PULL.sql,
    source: 'MotherDuck (tinydb)',
    fixtureVersion: '3, as of 2026-09-30',
    ranAt: record.ranAt,
    rowIds: null,
    rows: null,
  });
  // When the query started (the runner's clock), as ISO 8601 UTC.
  assert.match(record.ranAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(record.ranAt) >= before && Date.parse(record.ranAt) <= after);
  // The stored SQL and parameters are exactly what the runner was given.
  const ran = ctx.data.runs.find((r) => r.sql !== provenance.VERSION_SQL);
  assert.equal(record.sql, ran.sql);
  assert.deepEqual(record.parameters, ran.params);
  // Still there just before 24 hours, gone after.
  ctx.clock.t = T0 + 24 * HOUR - 1;
  assert.ok(ctx.store.get('provenance', button.value));
  ctx.clock.t = T0 + 24 * HOUR;
  assert.equal(ctx.store.get('provenance', button.value), undefined);
});

test('zero rows also get the button; a run that never reached the data does not, and keeps no record', async () => {
  const empty = setup({ data: fakeData(() => []) });
  const { view, button } = await runIt(empty);
  assert.match(view.blocks[0].text.text, /no rows matched/);
  assert.ok(button);
  assert.ok(empty.store.get('provenance', button.value));

  const failed = setup({ data: fakeData(() => { throw new Error('Binder Error'); }) });
  const res = await runIt(failed);
  assert.equal(res.view.blocks[0].text.text, messageFor(new QueryFailed(), { admin: access.adminContact(profile) }));
  assert.equal(res.button, undefined);
  assert.ok(!failed.data.runs.some((r) => r.sql === provenance.VERSION_SQL));
});

test('the person who ran it sees privately, in the same view, the confirmed values, the exact SQL that ran, the source, the version and the time', async () => {
  const ctx = setup();
  const { button, from } = await runIt(ctx, { zone: 'north', code: 'AB' });
  const up = await clickHow(ctx, { from, button });
  // An update of the view the button is in, never a new view or a message.
  assert.equal(up.view_id, from.id);
  assert.equal(up.hash, from.hash);
  assert.equal(ctx.app.views.filter((v) => v.method === 'push').length, 1);
  assert.deepEqual(ctx.app.posted, []);
  assert.deepEqual(ctx.app.responded, []);
  const { view } = up;
  assert.equal(view.blocks[0].text.text, '*How Lapsed list was made*');
  assert.deepEqual(view.blocks.filter((b) => b.fields).map((b) => [b.fields[0].text, b.fields[1].text]), [
    ['*Zone*', 'north'], ['*Days*', '90'], ['*Code*', 'AB'],
  ]);
  const meta = texts(view).find((t) => t && t.startsWith('*Data source:*'));
  const ranAt = Date.parse(ctx.store.get('provenance', button.value).ranAt);
  const utc = `${new Date(ranAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  assert.equal(meta, '*Data source:* MotherDuck (tinydb)\n*Data version:* 3, as of 2026-09-30\n'
    + `*Ran:* <!date^${Math.floor(ranAt / 1000)}^{date_short_pretty} at {time}|${utc}>`);
  // The SQL shown is the SQL the runner executed, character for character.
  const sqlText = texts(view).filter((t) => t && t.includes('```')).map((t) => /```\n([\s\S]*)\n```$/.exec(t)[1]).join('');
  const executed = ctx.data.runs.find((r) => r.sql !== provenance.VERSION_SQL).sql;
  assert.equal(unescape(sqlText), executed);
  // An optional input left empty shows as such.
  const other = setup();
  const r2 = await runIt(other, { zone: 'south' });
  const v2 = (await clickHow(other, r2)).view;
  assert.deepEqual(v2.blocks.filter((b) => b.fields).map((b) => b.fields[1].text), ['south', '90', '(left empty)']);
  // Nothing typed is logged.
  assert.ok(!JSON.stringify(ctx.log.lines).includes('AB'));
});

test('another person clicking is refused and sees nothing about the run', async () => {
  const ctx = setup();
  const { button, from } = await runIt(ctx);
  const { view } = await clickHow(ctx, { from, button, user: { id: 'U2' } });
  assert.deepEqual(texts(view), [NOT_YOURS]);
  assert.ok(!JSON.stringify(view).includes('SELECT'));
  assert.ok(ctx.log.lines.some((l) => l.msg === 'run details refused' && l.fields.reason === 'not-yours'));
  // The record is untouched: the owner still sees it.
  assert.equal((await clickHow(ctx, { from, button })).view.blocks[0].text.text, '*How Lapsed list was made*');
});

test('after 24 hours, or for an unknown or malformed run id, the button says the details are gone rather than failing', async () => {
  const ctx = setup();
  const { button, from } = await runIt(ctx);
  ctx.clock.t = T0 + 24 * HOUR + 1;
  assert.deepEqual(texts((await clickHow(ctx, { from, button })).view), [GONE]);
  assert.deepEqual(texts((await clickHow(ctx, { from, button, value: 'f'.repeat(32) })).view), [GONE]);
  assert.deepEqual(texts((await clickHow(ctx, { from, button, value: '../x' })).view), [GONE]);
  assert.deepEqual(texts((await clickHow(ctx, { from, button, value: undefined })).view), [GONE]);
  assert.ok(!ctx.log.lines.some((l) => l.level === 'error'));
  assert.match(GONE, /no longer available/);
});

test('a replayed click shows the same details again; a person who lost access is refused', async () => {
  const ctx = setup();
  const { button, from } = await runIt(ctx);
  const first = await clickHow(ctx, { from, button });
  const again = await clickHow(ctx, { from: { ...from, hash: `h${ctx.app.viewSeq}` }, button });
  assert.deepEqual(again.view.blocks, first.view.blocks);
  ctx.allowed.fn = () => false;
  const refused = await clickHow(ctx, { from: { ...from, hash: `h${ctx.app.viewSeq}` }, button });
  assert.ok(!JSON.stringify(refused.view).includes('SELECT'));
  assert.match(texts(refused.view)[0], /^You don't have access to Lapsed list|^You're not set up/);
});

test('a click from outside a modal is told to use the hub window and shows nothing', async () => {
  const ctx = setup();
  const { button } = await runIt(ctx);
  await ctx.app.dispatchAction(PROVENANCE_ACTION, { user: { id: 'U1' }, value: button.value });
  assert.equal(ctx.app.responded.length, 1);
  assert.ok(!JSON.stringify(ctx.app.responded).includes('SELECT'));
});

test('everything that reaches Slack is escaped: the SQL, the label and the source cannot mention, link or close the code block', async () => {
  const nasty = {
    ...PULL,
    label: 'Lapsed <!channel>',
    sql: "SELECT name -- <!here> & <https://evil.test|x> ```\nFROM people WHERE zone = $zone AND days <= $days AND ($code IS NULL OR code = $code)",
  };
  const ctx = setup({ mod: nasty, data: fakeData(() => TWO, () => ({ source: 'MotherDuck', label: '<@U9>' })) });
  const { button, from } = await runIt(ctx);
  const { view } = await clickHow(ctx, { from, button });
  const text = JSON.stringify(view.blocks);
  assert.ok(!text.includes('<!channel>'));
  assert.ok(!text.includes('<!here>'));
  assert.ok(!text.includes('<https://evil'));
  assert.ok(!text.includes('<@U9>'));
  for (const t of texts(view).filter((x) => x && x.includes('```'))) assert.equal((t.match(/```/g) || []).length, 2, t);
  const sqlText = texts(view).filter((t) => t && t.includes('```')).map((t) => /```\n([\s\S]*)\n```$/.exec(t)[1]).join('');
  assert.equal(unescape(sqlText).replace(/​/g, ''), nasty.sql);
});

test('the source is only what describe() names: never a path, a token or a connection string', () => {
  const data = {
    describe: () => ({ source: 'local fixture', label: 'acme.duckdb', available: true, problem: 'token=abc /secret/path' }),
  };
  assert.equal(provenance.sourceOf(data), 'local fixture (acme.duckdb)');
  assert.equal(provenance.sourceOf({ describe: () => ({ available: true }) }), null);
  assert.equal(provenance.sourceOf({ describe: () => { throw new Error('x'); } }), null);
  assert.equal(provenance.sourceOf(null), null);
});

test('a long SQL splits into code blocks under Slack\'s section limit, without splitting an escape', () => {
  const sql = `SELECT ${'a & b, '.repeat(900)}1`;
  const blocks = provenance.sqlBlocks(sql);
  assert.ok(blocks.length > 1);
  for (const b of blocks) assert.ok(b.text.text.length <= 3000, String(b.text.text.length));
  const joined = blocks.map((b) => /```\n([\s\S]*)\n```$/.exec(b.text.text)[1]).join('');
  assert.equal(unescape(joined), sql);
  for (const b of blocks) assert.ok(!/&(a|am)?$/.test(/```\n([\s\S]*)\n```$/.exec(b.text.text)[1]));
});

test('detailsMessage takes extra blocks before the SQL (for Story 10.1)', () => {
  const record = provenance.buildRecord({
    runId: 'a'.repeat(32), person: 'U1', module: 'lapsed', parameters: {}, sql: 'SELECT 1', ranAt: new Date(T0),
  });
  const extra = { type: 'section', text: { type: 'mrkdwn', text: 'Scored by…' } };
  const msg = provenance.detailsMessage(record, { mod: { ...PULL, parameters: [] }, extra: [extra] });
  const i = msg.blocks.indexOf(extra);
  assert.ok(i > 0);
  assert.match(msg.blocks[i + 1].text.text, /^\*The SQL that ran:\*/);
  assert.match(msg.blocks[1].text.text, /none/);
  assert.equal(record.fixtureVersion, null);
  assert.deepEqual(texts(msg).find((t) => t && t.startsWith('*Data source')).split('\n').slice(0, 2), ['*Data source:* unknown', '*Data version:* unknown']);
});

test('the version query passes the SQL checker with a forbidden column set, and the real runner reads the version from fixture_meta', async (t) => {
  assert.deepEqual(sqlGuard.checkSql(provenance.VERSION_SQL, { forbiddenColumns: ['shops.postal_code'] }).ok, true);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-prov-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mini.duckdb');
  await build({ fixtureDir: MINI, out: file });
  const data = createData({ file, profile: { client: { id: 'mini' }, sql: { forbidden_columns: ['shops.postal_code'] } } });
  t.after(() => data.close());
  assert.equal(await provenance.readVersion(data, quietLog()), 'as of 2026-09-30');
  assert.equal(provenance.sourceOf(data), 'local fixture (mini.duckdb)');
  // An unreadable version never fails the run: it reads as unknown, logged.
  const log = quietLog();
  assert.equal(await provenance.readVersion({ run: async () => { throw new Error('Catalog Error'); } }, log), null);
  assert.ok(log.lines.some((l) => l.msg === 'data version unavailable'));
});

test('a push never reads the run record: only the scoped-pull engine loads the provenance module, and nothing names its namespace directly', () => {
  const root = path.resolve(__dirname, '../..');
  const loaders = [];
  const named = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        const rel = path.relative(root, p);
        if (/require\([^)]*\/provenance['"]\)/.test(src)) loaders.push(rel);
        if (/\.(get|set|consume|done|finish)\(\s*['"]provenance['"]/.test(src)) named.push(rel);
      }
    }
  };
  walk(path.join(root, 'kit'));
  // Epic 10's preview joins this list (Story 10.2); a push never does.
  assert.deepEqual(loaders.sort(), [
    'kit/runtime/archetypes/approval-write/preview.js', 'kit/runtime/archetypes/scoped-pull/index.js', 'kit/runtime/archetypes/scoped-pull/run.js',
  ]);
  assert.deepEqual(named, []);
});

// Story 10.1: a scored module's details carry its scoring line, before the
// SQL. The module is the scored fixture (test/fixtures/runtime/scored).
test('a scored list\'s "How was this made?" shows a scoring line: the inputs, weights and ranges, the tie rule and the limit kept', async () => {
  const scoredDir = path.join(FIX, 'scored');
  const ranked = Object.freeze({
    ...JSON.parse(fs.readFileSync(path.join(scoredDir, 'manifest.json'), 'utf8')),
    file: 'modules/ranked/manifest.json',
    sql: fs.readFileSync(path.join(scoredDir, 'ranked.sql'), 'utf8'),
  });
  const rows = JSON.parse(fs.readFileSync(path.join(scoredDir, 'rows.json'), 'utf8'));
  const ctx = setup({ mod: ranked, data: fakeData(() => rows) });
  const { button, from } = await runIt(ctx, { zone: 'north' });
  const { view } = await clickHow(ctx, { from, button });
  // The confirmed values include the limit, which the SQL never binds.
  assert.deepEqual(view.blocks.filter((b) => b.fields).map((b) => [b.fields[0].text, b.fields[1].text]), [['*Zone*', 'north'], ['*How many*', '3']]);
  const all = texts(view);
  const i = all.findIndex((t) => t && t.startsWith('*Scoring:*'));
  assert.ok(i > all.findIndex((t) => t && t.startsWith('*Data source:*')));
  assert.match(all[i + 1], /^\*The SQL that ran:\*/);
  assert.match(all[i], /Months as a client \(weight 2, 0 to 24\); Paid to date \(\$\) \(weight 3, 0 to 10,000\); Days since last visit \(weight -1, 0 to 100: lower is better\)/);
  assert.match(all[i], /ties by person_id\. The app kept the top 3 \(How many\); the SQL never uses that value\.$/);
  assert.match(all[i], /\(no AI\)/);
  // An unscored list has no scoring line.
  const plain = setup();
  const r = await runIt(plain);
  assert.ok(!texts((await clickHow(plain, r)).view).some((t) => t && t.startsWith('*Scoring:*')));
});
