'use strict';

// Story 9.5: a scoped pull's Confirm runs the module's fixed SQL with only its
// declared inputs bound, and the results arrive privately: a summary in the
// module's view (views.update with the hash) and the CSV in the person's DM
// (conversations.open, then files.uploadV2 to that DM). Through the hub
// wiring with the fake Slack client and a stand-in query runner; the real
// runner on a local DuckDB file is used where the runner's own behaviour
// matters (startup check, data unavailable). The module is a fixture, never a
// client's manifest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { createRegistry, loadRegistry, loadModules } = require('../../kit/runtime/registry');
const { registerHubs } = require('../../kit/runtime/slack/hubs');
const { ACTIONS, FORM_CALLBACK, ROW_CAP } = require('../../kit/runtime/archetypes/scoped-pull');
const { INPUT_BLOCK, VALUE_ACTION } = require('../../kit/runtime/archetypes/scoped-pull/form');
const {
  checkQuery, placeholders, bindValues, boundNames, createRunner, runQuery, SCORED_LIMIT,
} = require('../../kit/runtime/archetypes/scoped-pull/run');
const { toCsv, BOM } = require('../../kit/runtime/archetypes/scoped-pull/csv');
const { deliverCsv, permalinkOf } = require('../../kit/runtime/archetypes/scoped-pull/deliver');
const { previewText, previewFit, PREVIEW_LIMIT } = require('../../kit/runtime/archetypes/scoped-pull/results');
const {
  DataUnavailable, AlreadyConfirmed, QueryBlocked, QueryFailed, CsvNotDelivered, ScoringFault,
} = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');
const { VERSION_SQL } = require('../../kit/runtime/slack/provenance');
const { createData, QueryRefusedError } = require('../../kit/runtime/data');
const { createStore } = require('../../kit/runtime/store');
const access = require('../../kit/runtime/access');
const { FakeSlackApp, invalidUpload } = require('../fixtures/fake-slack');

const ROOT = path.resolve(__dirname, '../..');
const FIX = path.join(__dirname, '../fixtures/runtime');
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
  sql: 'SELECT name, zone FROM people WHERE zone = $zone AND days <= $days AND ($code IS NULL OR code = $code)',
});

const ADMIN = access.adminContact(profile);
const TWO = [{ name: 'Ann', zone: 'north' }, { name: 'Bo', zone: 'north' }];
const UNAVAILABLE = messageFor(new DataUnavailable('x'));
const FAILED_REPLAY = messageFor(new AlreadyConfirmed({ done: true, failed: true }));
const DONE_REPLAY = messageFor(new AlreadyConfirmed({ done: true }));

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// A stand-in query runner: answer(sql, params, opts) gives the rows or throws.
function fakeData(answer = () => TWO) {
  const runs = [];
  return {
    runs,
    run: async (sql, params, opts) => { runs.push({ sql, params, opts }); return answer(sql, params, opts); },
    describe: () => ({ available: true }),
  };
}

function setup({ data = fakeData() } = {}) {
  const store = createStore();
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  const registry = createRegistry({ hubs: base.hubs, modules: [...base.modules, PULL] });
  registerHubs(app, { registry, profile, env: 'dev', log, store, data, canUse: () => true });
  return { app, log, store, data };
}

const MENU_VIEW = { id: 'VMENU', type: 'modal', private_metadata: 'alpha', title: { type: 'plain_text', text: 'Alpha tools' } };
const moduleRuns = (ctx) => ctx.data.runs.filter((r) => r.sql === PULL.sql);
const updates = (app) => app.views.filter((v) => v.method === 'update').map((v) => v.args);
const blockTexts = (view) => view.blocks.map((b) => (b.text && b.text.text) || (b.elements && b.elements[0] && b.elements[0].text) || null);

function stateOf(typed) {
  const values = {};
  for (const [name, v] of Object.entries(typed)) {
    const p = PULL.parameters.find((x) => x.name === name);
    const entry = p.enum ? { type: 'static_select', selected_option: { value: v } } : { type: 'plain_text_input', value: v };
    values[`${INPUT_BLOCK}${name}`] = { [VALUE_ACTION]: entry };
  }
  return { values };
}

// Opens the form as user, checks typed, and presses Confirm. Returns the
// final view, the session id and the Confirm screen's view as Slack sends it.
async function confirm(ctx, typed = { zone: 'north' }, user = { id: 'U1' }) {
  await ctx.app.dispatchAction('lapsed:open', { user, view: MENU_VIEW });
  const form = ctx.app.views.at(-1).args.view;
  const formId = `V${ctx.app.viewSeq}`;
  await ctx.app.dispatchView(FORM_CALLBACK, {
    user, view: { id: formId, hash: 'hf', title: form.title, private_metadata: form.private_metadata, state: stateOf(typed) },
  });
  const screen = ctx.app.viewAcks.at(-1).view;
  const session = screen.blocks.find((b) => b.type === 'actions').elements[0].value;
  const from = { id: formId, hash: 'hc', title: screen.title, private_metadata: screen.private_metadata };
  await ctx.app.dispatchAction(ACTIONS.confirm, { user, view: from, value: session });
  return { view: updates(ctx.app).at(-1).view, session, from };
}

test('checkQuery: the SQL checker, no "${", and every $name matched to a declared input both ways', () => {
  const params = PULL.parameters;
  assert.deepEqual(checkQuery(PULL.sql, params), []);
  assert.deepEqual(checkQuery('DELETE FROM people WHERE zone = $zone', [params[0]]).map((p) => p.replace(/\(.*\)/, '()')), ['its SQL is refused by the SQL checker ()']);
  assert.match(checkQuery("SELECT '${zone}' AS z, $zone AS zone", [params[0]])[0], /contains "\$\{"/);
  assert.deepEqual(checkQuery('SELECT $zone AS zone, $other AS other', [params[0]]), ['its SQL names $other, which is not a declared input']);
  assert.deepEqual(checkQuery('SELECT $zone AS zone', params), [
    'input "days" is declared but its SQL never uses $days',
    'input "code" is declared but its SQL never uses $code',
  ]);
  assert.match(checkQuery('SELECT $1 AS zone, $zone AS z', [params[0]])[0], /positional parameter/);
  // A $name inside a string, a quoted identifier or a comment is not a parameter.
  const hidden = "-- uses $nope\nSELECT '$nope' AS \"$nope\", $zone AS zone /* $nope */";
  assert.deepEqual([...placeholders(hidden).names], ['zone']);
  assert.deepEqual(checkQuery(hidden, [params[0]]), []);
});

test('checkQuery refuses a forbidden column (personal data the profile bars) and a wildcard while any is set', () => {
  const forbiddenColumns = ['people.phone'];
  assert.match(checkQuery('SELECT name, phone FROM people WHERE zone = $zone', [PULL.parameters[0]], { forbiddenColumns })[0], /forbidden_column/);
  assert.match(checkQuery('SELECT * FROM people WHERE zone = $zone', [PULL.parameters[0]], { forbiddenColumns })[0], /wildcard/);
});

test('startup stops on a scoped pull whose SQL fails the check, naming the module file; it never connects', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-sqlcheck-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'modules/pull'), { recursive: true });
  const zone = { name: 'zone', type: 'string', enum: ['north'] };
  fs.writeFileSync(path.join(dir, 'modules/pull/manifest.json'), JSON.stringify({
    id: 'pull', hub: 'h', label: 'Pull', description: 'd', resource: 'R', archetype: 'scoped-pull', environments: ['dev'], query: 'pull.sql', parameters: [zone],
  }));
  const load = (sql, sqlProfile = {}) => {
    fs.writeFileSync(path.join(dir, 'modules/pull/pull.sql'), sql);
    return loadModules(dir, { hubs: [{ id: 'h' }], profile: { resources: [{ key: 'R' }], ...sqlProfile } });
  };
  assert.deepEqual(load('SELECT name FROM people WHERE zone = $zone').problems, []);
  assert.deepEqual(load('SELECT name FROM people WHERE zone = $zone AND x = $limit').problems, [
    'modules/pull/manifest.json: field "query" (pull.sql) its SQL names $limit, which is not a declared input',
  ]);
  const barred = load('SELECT phone FROM people WHERE zone = $zone', { sql: { forbidden_columns: ['people.phone'] } });
  assert.match(barred.problems[0], /^modules\/pull\/manifest\.json: field "query" \(pull\.sql\) its SQL is refused by the SQL checker \(forbidden_column/);
  assert.deepEqual(barred.modules, []);
});

test('no SQL file in any app dir or template contains "${"', () => {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules') continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) walk(abs);
      else if (d.name.endsWith('.sql')) files.push(abs);
    }
  };
  // Every example's app dir, whichever examples this copy has (a fork or the
  // clean-bones copy has none of Brightside's). That the Brightside modules
  // are among the files scanned is checked by an example test
  // (examples/brightside/test/sql-scan.test.js), deleted with the example.
  const examples = path.join(ROOT, 'examples');
  if (fs.existsSync(examples)) for (const e of fs.readdirSync(examples)) walk(path.join(examples, e, 'app'));
  walk(path.join(ROOT, 'app'));
  walk(path.join(ROOT, 'kit/templates'));
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes('${'), path.relative(ROOT, f));
});

test('bindValues binds every declared input and nothing else; an optional input left empty binds null', () => {
  assert.deepEqual(bindValues(PULL.parameters, { zone: 'north', days: 30, extra: 'x' }), { zone: 'north', days: 30, code: null });
});

test('Confirm runs the fixed SQL with only the declared inputs, then shows the summary in the view and sends the CSV to the DM', async () => {
  const ctx = setup();
  const { view } = await confirm(ctx, { zone: 'north', code: 'AB' });
  // One run of the module's own SQL, its declared names, its values; then the
  // data version for "How was this made?" (Story 9.6), with no parameters.
  assert.deepEqual(ctx.data.runs, [
    { sql: PULL.sql, params: { zone: 'north', days: 90, code: 'AB' }, opts: { declared: ['zone', 'days', 'code'] } },
    { sql: VERSION_SQL, params: {}, opts: { declared: [] } },
  ]);
  // "Running…", then the result, both in place on the Confirm screen's view.
  const ups = updates(ctx.app);
  assert.deepEqual(ups.map((u) => u.view_id), ['V1', 'V1']);
  assert.equal(ups[0].hash, 'hc');
  assert.match(ups[0].view.blocks[0].text.text, /^\*Running Lapsed list…\*/);
  assert.equal(ups[1].hash, `h${ctx.app.viewSeq - 1}`);
  assert.equal(view.blocks[0].text.text, '*Lapsed list: 2 rows.*');
  assert.deepEqual(view.blocks.filter((b) => b.fields).map((b) => b.fields[1].text), ['north', '90', 'AB']);
  assert.match(blockTexts(view)[4], /^\*The rows:\*\n```\nname  zone\nAnn   north\nBo    north\n```$/);
  assert.equal(blockTexts(view).at(-1), 'The full list (2 rows) is a CSV in your DM with me. <https://fake.slack.test/files/F1|Open the CSV>');
  assert.equal(view.blocks.filter((b) => b.type === 'actions').length, 0);
  // The CSV: the DM opened for the person who confirmed, and only there.
  assert.deepEqual(ctx.app.dms, [{ user: 'U1', channel: 'D1' }]);
  assert.equal(ctx.app.uploads.length, 1);
  const up = ctx.app.uploads[0];
  assert.equal(up.channel_id, 'D1');
  assert.match(up.filename, /^lapsed-\d{8}-\d{4}\.csv$/);
  assert.equal(up.content, `${BOM}name,zone\r\nAnn,north\r\nBo,north\r\n`);
  assert.equal(up.initial_comment, 'Lapsed list: 2 rows, for Zone: north, Days: 90, Code: AB.');
  // Nothing in a channel, ever.
  assert.deepEqual(ctx.app.posted, []);
  assert.deepEqual(ctx.app.said, []);
  assert.deepEqual(ctx.app.responded, []);
  // The values a person chose are not logged.
  assert.ok(!JSON.stringify(ctx.log.lines).includes('AB'));
});

test('a replay after a complete run is told it ran once; the run is not repeated', async () => {
  const ctx = setup();
  const { session, from } = await confirm(ctx);
  await ctx.app.dispatchAction(ACTIONS.confirm, { user: { id: 'U1' }, view: { ...from, hash: `h${ctx.app.viewSeq}` }, value: session });
  assert.equal(blockTexts(updates(ctx.app).at(-1).view)[0], DONE_REPLAY);
  assert.equal(moduleRuns(ctx).length, 1);
  assert.equal(ctx.app.uploads.length, 1);
});

test('the row cap: the engine stops at 5,000 rows and says "first 5,000 of N" in the view, the CSV and its message', async () => {
  const many = Array.from({ length: 6200 }, (_, i) => ({ n: i + 1 }));
  const ctx = setup({ data: fakeData(() => many) });
  const { view } = await confirm(ctx);
  assert.equal(ROW_CAP, 5000);
  assert.equal(view.blocks[0].text.text, '*Lapsed list: the first 5,000 of 6,200 rows.*');
  assert.match(blockTexts(view)[3], /^\*The first 10:\*/);
  assert.match(blockTexts(view).at(-1), /^The CSV in your DM with me holds the first 5,000 of 6,200 rows\. Narrow the values to see the rest\./);
  const lines = ctx.app.uploads[0].content.trimEnd().split('\r\n');
  assert.equal(lines.length, 5001);
  assert.equal(lines[5000], '5000');
  assert.match(ctx.app.uploads[0].initial_comment, /^Lapsed list: the first 5,000 of 6,200 rows \(the engine stops at 5,000\)/);
});

test('zero rows: a plain message in the view, no CSV, and the session counts as done', async () => {
  const ctx = setup({ data: fakeData(() => []) });
  const { view, session, from } = await confirm(ctx);
  assert.equal(view.blocks[0].text.text, '*Lapsed list: no rows matched these values.* Nothing was sent to your DM.');
  assert.deepEqual(ctx.app.uploads, []);
  assert.deepEqual(ctx.app.dms, []);
  await ctx.app.dispatchAction(ACTIONS.confirm, { user: { id: 'U1' }, view: { ...from, hash: `h${ctx.app.viewSeq}` }, value: session });
  assert.equal(blockTexts(updates(ctx.app).at(-1).view)[0], DONE_REPLAY);
});

test('a refused query, a failed one, data unavailable and a timeout each say which in the view; nothing is sent; a replay is told it did not finish', async () => {
  const cases = [
    [() => { throw new QueryRefusedError('forbidden_column', 'x'); }, messageFor(new QueryBlocked('forbidden_column'), { admin: ADMIN }), 'list query refused'],
    [() => { throw new Error('Binder Error: no such column'); }, messageFor(new QueryFailed(), { admin: ADMIN }), 'list query failed'],
    [() => { throw new DataUnavailable('waiting to reconnect to MotherDuck'); }, UNAVAILABLE, 'data unavailable'],
    [() => { throw new DataUnavailable('query timed out after 30s'); }, UNAVAILABLE, 'data unavailable'],
  ];
  for (const [answer, words, logged] of cases) {
    const ctx = setup({ data: fakeData(answer) });
    const { view, session, from } = await confirm(ctx);
    assert.equal(view.blocks[0].text.text, words);
    assert.equal(blockTexts(view).at(-1), 'Open it again from the menu to try again.');
    assert.deepEqual(ctx.app.uploads, []);
    assert.ok(ctx.log.lines.some((l) => l.msg === logged && l.fields.module === 'lapsed'), logged);
    await ctx.app.dispatchAction(ACTIONS.confirm, { user: { id: 'U1' }, view: { ...from, hash: `h${ctx.app.viewSeq}` }, value: session });
    assert.equal(blockTexts(updates(ctx.app).at(-1).view)[0], FAILED_REPLAY);
    assert.equal(ctx.data.runs.length, 1);
  }
});

test('without a data source, Confirm shows the standard data-unavailable message', async () => {
  const ctx = setup({ data: null });
  const { view } = await confirm(ctx);
  assert.equal(view.blocks[0].text.text, UNAVAILABLE);
});

test('the real runner on a missing local file is data unavailable, shown plainly', async (t) => {
  const data = createData({ file: path.join(os.tmpdir(), 'aplabs-no-such-dir', 'none.duckdb'), profile });
  t.after(() => data.close());
  const ctx = setup({ data });
  const { view } = await confirm(ctx);
  assert.equal(view.blocks[0].text.text, UNAVAILABLE);
});

test('a CSV that does not reach the DM is said plainly: the view keeps the first rows but never passes them off as the whole list', async () => {
  const ctx = setup();
  ctx.app.filesFail = Object.assign(new Error('An API error occurred: not_in_channel'), { data: { error: 'not_in_channel' } });
  const { view, session, from } = await confirm(ctx);
  assert.equal(view.blocks[0].text.text, '*Lapsed list: 2 rows.*');
  assert.equal(blockTexts(view).at(-1), messageFor(new CsvNotDelivered(), { admin: ADMIN }));
  assert.ok(!JSON.stringify(view).includes('in your DM with me'));
  assert.ok(ctx.log.lines.some((l) => l.msg === 'list CSV not delivered'));
  await ctx.app.dispatchAction(ACTIONS.confirm, { user: { id: 'U1' }, view: { ...from, hash: `h${ctx.app.viewSeq}` }, value: session });
  assert.equal(blockTexts(updates(ctx.app).at(-1).view)[0], FAILED_REPLAY);
});

test('the CSV never goes to a channel: a conversations.open answer that is not a DM stops the upload', async () => {
  const ctx = setup();
  ctx.app.dmChannel = () => 'C0PUBLIC';
  const { view } = await confirm(ctx);
  assert.deepEqual(ctx.app.uploads, []);
  assert.equal(blockTexts(view).at(-1), messageFor(new CsvNotDelivered(), { admin: ADMIN }));
});

test('cell values reach Slack only escaped: no mention, link or broken code block; the CSV keeps them raw', async () => {
  const nasty = [{ name: '<!channel> & <https://evil.test|click>', note: '```\n*bold* <@U123>' }];
  const ctx = setup({ data: fakeData(() => nasty) });
  const { view } = await confirm(ctx);
  const text = JSON.stringify(view);
  assert.ok(!text.includes('<!channel>'));
  assert.ok(!text.includes('<https://evil'));
  assert.ok(!text.includes('<@U123>'));
  // Cut to the preview width before escaping, so an escape is never split.
  assert.match(text, /&lt;!channel&gt; &amp; &lt;https:\/\/e…/);
  assert.match(text, /&lt;@U123&gt;/);
  const table = blockTexts(view).find((t) => t && t.startsWith('*The rows:*'));
  assert.equal((table.match(/```/g) || []).length, 2);
  assert.ok(ctx.app.uploads[0].content.includes('"<!channel> & <https://evil.test|click>"') || ctx.app.uploads[0].content.includes('<!channel> & <https://evil.test|click>'));
  assert.ok(ctx.app.uploads[0].content.includes('"```\n*bold* <@U123>"'));
});

test('toCsv: RFC 4180 quoting, CRLF, a byte order mark, null as empty, and a formula guard that leaves plain numbers alone', () => {
  const csv = toCsv(['a', 'b', 'c'], [
    { a: 'x,y', b: 'say "hi"', c: null },
    { a: '=SUM(A1)', b: '-125', c: '+1 555' },
    { a: '@cmd', b: 42.5, c: { k: 1 } },
    { a: ' pad', b: 'line\nbreak', c: true },
  ]);
  assert.equal(csv, `${BOM}a,b,c\r\n"x,y","say ""hi""",\r\n'=SUM(A1),-125,'+1 555\r\n'@cmd,42.5,"{""k"":1}"\r\n" pad","line\nbreak",true\r\n`);
});

test('previewText cuts long cells and shows at most 10 rows', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ v: `${'x'.repeat(30)}${i}` }));
  const text = previewText(['v'], rows);
  assert.equal(text.split('\n').length, 2 + 1 + 10);
  assert.ok(text.includes(`${'x'.repeat(23)}…`));
});

test('the fake Slack enforces files.uploadV2\'s required fields, and deliverCsv sends them', async () => {
  assert.equal(invalidUpload({ channel_id: 'D1', filename: 'a.csv', content: 'x' }), null);
  // Like Slack (Story 15.1), an upload with no channel is accepted: the file
  // is shared nowhere. deliverCsv's own check is below.
  assert.equal(invalidUpload({ filename: 'a.csv', content: 'x' }), null);
  assert.match(invalidUpload({ channel_id: '', filename: 'a.csv', content: 'x' }), /channel_id/);
  assert.match(invalidUpload({ channel_id: 'D1', content: 'x' }), /filename/);
  assert.match(invalidUpload({ channel_id: 'D1', filename: 'a.csv', content: '' }), /content or file/);
  assert.match(invalidUpload({ filename: 'a.png', file: Buffer.alloc(0) }), /non-empty/);
  assert.match(invalidUpload({ filename: 'a.png', file: Buffer.from('x'), content: 'x' }), /not both/);
  assert.match(invalidUpload({ channels: 'C1', channel_id: 'D1', filename: 'a.csv', content: 'x' }), /retired/);
  const app = new FakeSlackApp({});
  await assert.rejects(app.client.files.uploadV2({ content: 'x' }), (e) => e.data.error === 'invalid_arguments');
  const res = await deliverCsv({ client: app.client, person: 'U7', filename: 'a.csv', title: 'A', content: 'x', comment: 'c' });
  assert.deepEqual(res, { channel: 'D7', permalink: 'https://fake.slack.test/files/F1' });
  assert.deepEqual(app.uploads, [{ channel_id: 'D7', filename: 'a.csv', title: 'A', content: 'x', initial_comment: 'c' }]);
  assert.equal(permalinkOf({ files: [{ files: [{ id: 'F', permalink: 'javascript:x' }] }] }), null);
  await assert.rejects(deliverCsv({ client: {}, person: 'U7', filename: 'a', content: 'x' }), /no Slack files client/);
});

// Moved from the fake (Story 15.1, F2): the fake now accepts an unshared
// upload as Slack does, so deliverCsv's own test proves the CSV always names
// the person's DM as channel_id and is never uploaded anywhere else.
test('deliverCsv always uploads to the person\'s DM (channel_id required), and refuses before uploading when it is not a DM', async () => {
  const app = new FakeSlackApp({});
  await deliverCsv({ client: app.client, person: 'U7', filename: 'a.csv', title: 'A', content: 'x', comment: 'c' });
  assert.equal(app.uploads.length, 1);
  assert.equal(typeof app.uploads[0].channel_id, 'string');
  assert.equal(app.uploads[0].channel_id, app.dms[0].channel);
  assert.match(app.uploads[0].channel_id, /^D[A-Z0-9]+$/);
  for (const channel of ['C0123456789', 'G0123456789', 'U7', '', null]) {
    const other = new FakeSlackApp({});
    other.dmChannel = () => channel;
    await assert.rejects(deliverCsv({ client: other.client, person: 'U7', filename: 'a.csv', content: 'x' }), /did not return a DM/, String(channel));
    assert.deepEqual(other.uploads, [], String(channel));
  }
});

// Story 9.4 hands the AI service to the hubs for one use: the plain-English
// reader (archetypes/scoped-pull/extract). Only that file may name it, and it
// imports nothing that holds rows (scoped-pull-extract.test.js checks its
// imports and what it sends).
test('rows never reach the AI: the scoped-pull engine does not import the AI service, and the hubs give it only to the reader', () => {
  const dir = path.join(ROOT, 'kit/runtime/archetypes/scoped-pull');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/require\([^)]*llm[^)]*\)/.test(src), f);
    if (f !== 'extract.js') assert.ok(!/\bllm\b/.test(src.replace(/\/\/[^\n]*/g, '')), `${f} names the AI service`);
  }
  const hubs = fs.readFileSync(path.join(ROOT, 'kit/runtime/slack/hubs.js'), 'utf8');
  assert.ok(!/require\([^)]*llm[^)]*\)/.test(hubs));
  const uses = hubs.replace(/\/\/[^\n]*/g, '').split('\n').filter((l) => /\bllm\b/.test(l)).map((l) => l.trim());
  // Story 16.1: the hubs get each hub's view (forHub); a view's bound AI
  // service goes only to that hub's reader. data and llm remain only as the
  // test seam (hub-view everyHubSeesAll), which boot never uses.
  assert.deepEqual(uses, [
    'registry, profile, env, log, store, forHub = null, data = null, llm = null, connectors = null, canUse = defaultCanUse(profile),',
    "if (forHub && (data || llm)) throw new TypeError('registerHubs takes forHub, or (a test seam) data and llm, never both');",
    'const viewFor = forHub || everyHubSeesAll({ data, llm }).forHub;',
    'store, log, run: createRunner({ data: view.data, log, admin, store, hooks }), read: view.llm ? createReader({ llm: view.llm, log }) : null,',
    // Story 16.8: Add context's upload hands its hub's AI the uploaded file's
    // bytes only (readFile), never rows: no runner is in reach there.
    'const { llm } = viewOf(mod.hub);',
    "if (!llm) throw new LlmUnavailable('off');",
    '({ text } = await llm.readFile({',
  ]);
  const app = fs.readFileSync(path.join(ROOT, 'kit/runtime/app/index.js'), 'utf8');
  assert.match(app, /registerHubs\(app, \{ registry, profile, env, log, store, forHub, connectors, mapFiles, rules, slackFiles \}\)/);
  // The approval-write archetype (Story 10.2) shows rows too: none of its files reaches or names the AI.
  const writeDir = path.join(ROOT, 'kit/runtime/archetypes/approval-write');
  for (const f of fs.readdirSync(writeDir)) {
    const src = fs.readFileSync(path.join(writeDir, f), 'utf8');
    assert.ok(!/require\([^)]*llm[^)]*\)/.test(src), f);
    assert.ok(!/\bllm\b/.test(src.replace(/\/\/[^\n]*/g, '')), `${f} names the AI service`);
  }
  // The run record (Story 9.6) holds rows; its file never reaches or names the AI service.
  const provenance = fs.readFileSync(path.join(ROOT, 'kit/runtime/slack/provenance.js'), 'utf8');
  assert.ok(!/require\([^)]*llm[^)]*\)/.test(provenance));
  assert.ok(!/\bllm\b/.test(provenance.replace(/\/\/[^\n]*/g, '')));
  assert.ok(!/require\([^)]*(extract|provenance)[^)]*\)/.test(fs.readFileSync(path.join(dir, 'extract.js'), 'utf8')));
});

test('createRunner without a Slack client still answers: the CSV is reported as not delivered', async () => {
  const run = createRunner({ data: fakeData(), log: quietLog() });
  const res = await run(PULL, { zone: 'north', days: 90 }, 'U1', {});
  assert.equal(res.failed, true);
  assert.match(JSON.stringify(res.message), /The CSV didn't arrive/);
});

// Story 10.1: a scored list. The fixture module (test/fixtures/runtime/scored)
// declares four scoring inputs, its row id and its limit input; its SQL ends
// with ORDER BY person_id LIMIT 5001 and never names the limit.
const SCORED_DIR = path.join(FIX, 'scored');
const RANKED = Object.freeze({
  ...JSON.parse(fs.readFileSync(path.join(SCORED_DIR, 'manifest.json'), 'utf8')),
  file: 'modules/ranked/manifest.json',
  sql: fs.readFileSync(path.join(SCORED_DIR, 'ranked.sql'), 'utf8'),
});
const RANKED_ROWS = JSON.parse(fs.readFileSync(path.join(SCORED_DIR, 'rows.json'), 'utf8'));
const scoredCheck = (sql, mod = RANKED) => checkQuery(sql, mod.parameters, { scoring: mod.scoring, rowId: mod.row_id });
const ORDER_PROBLEM = 'a scored module\'s SQL must end with an ORDER BY whose last key is the row id (ORDER BY ..., person_id) just before LIMIT 5001, so the rows kept at the cap are the same every time';
const LIMIT_PROBLEM = 'a scored module\'s SQL must end with LIMIT 5001 (the 5,000-row cap plus one), as a literal; the engine keeps the person\'s number after scoring';

function setupRanked({ data = fakeData(() => RANKED_ROWS), mod = RANKED } = {}) {
  const store = createStore();
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  const registry = createRegistry({ hubs: base.hubs, modules: [...base.modules, mod] });
  registerHubs(app, { registry, profile, env: 'dev', log, store, data, canUse: () => true });
  return { app, log, store, data, mod };
}

async function confirmRanked(ctx, zone = 'north') {
  const user = { id: 'U1' };
  await ctx.app.dispatchAction(`${ctx.mod.id}:open`, { user, view: MENU_VIEW });
  const form = ctx.app.views.at(-1).args.view;
  const formId = `V${ctx.app.viewSeq}`;
  const state = { values: { [`${INPUT_BLOCK}zone`]: { [VALUE_ACTION]: { type: 'static_select', selected_option: { value: zone } } } } };
  await ctx.app.dispatchView(FORM_CALLBACK, { user, view: { id: formId, hash: 'hf', title: form.title, private_metadata: form.private_metadata, state } });
  const screen = ctx.app.viewAcks.at(-1).view;
  const session = screen.blocks.find((b) => b.type === 'actions').elements[0].value;
  const from = { id: formId, hash: 'hc', title: screen.title, private_metadata: screen.private_metadata };
  await ctx.app.dispatchAction(ACTIONS.confirm, { user, view: from, value: session });
  return { view: updates(ctx.app).at(-1).view, session, from };
}

test('checkQuery on a scored module: the limit input is exempt from "never used" and refused when the SQL names it', () => {
  assert.deepEqual(scoredCheck(RANKED.sql), []);
  const named = RANKED.sql.replace('WHERE zone = $zone', 'WHERE zone = $zone AND rank_no <= $limit');
  assert.deepEqual(scoredCheck(named), [
    'its SQL names $limit, the scoring limit; the engine keeps the top $limit after scoring, so the SQL must never use it',
  ]);
  // Without scoring, the same input must be used, as before.
  assert.deepEqual(checkQuery(RANKED.sql, RANKED.parameters), ['input "limit" is declared but its SQL never uses $limit']);
});

test('checkQuery on a scored module: the SQL must end with ORDER BY ..., <row id> then a literal LIMIT 5001', () => {
  const head = 'SELECT person_id, name, tenure, spend, idle, rise FROM people WHERE zone = $zone';
  // Accepted: a qualified row id, a direction, NULLS, a trailing semicolon and comment, other keys first.
  assert.deepEqual(scoredCheck(`${head}\nORDER BY spend DESC, p.person_id DESC NULLS LAST\nLIMIT 5001;\n-- the end\n`), []);
  assert.deepEqual(scoredCheck(`${head} ORDER BY COALESCE(spend, 0) DESC, "person_id" limit 5001`), []);
  // No ORDER BY, or one whose last key is not the row id.
  assert.deepEqual(scoredCheck(`${head} LIMIT 5001`), [ORDER_PROBLEM]);
  assert.deepEqual(scoredCheck(`${head} ORDER BY person_id, spend DESC LIMIT 5001`), [ORDER_PROBLEM]);
  assert.deepEqual(scoredCheck('SELECT person_id, name, tenure, spend, idle, rise, 1 AS person_id_2 FROM people WHERE zone = $zone ORDER BY person_id_2 LIMIT 5001'), [ORDER_PROBLEM]);
  // An ORDER BY inside a subquery doesn't order the result.
  assert.deepEqual(scoredCheck(`SELECT person_id, name, tenure, spend, idle, rise FROM (SELECT * FROM people ORDER BY person_id) t WHERE zone = $zone LIMIT 5001`), [ORDER_PROBLEM]);
  // No LIMIT, another number, or a LIMIT only in a comment or a string.
  assert.deepEqual(scoredCheck(`${head} ORDER BY person_id`), [LIMIT_PROBLEM]);
  assert.deepEqual(scoredCheck(`${head} ORDER BY person_id LIMIT 5000`), [LIMIT_PROBLEM]);
  assert.deepEqual(scoredCheck(`${head} ORDER BY person_id LIMIT 50010`), [LIMIT_PROBLEM]);
  assert.deepEqual(scoredCheck(`${head} ORDER BY person_id -- LIMIT 5001`), [LIMIT_PROBLEM]);
  assert.deepEqual(scoredCheck(`${head} ORDER BY person_id LIMIT 5001 OFFSET 10`), [LIMIT_PROBLEM]);
  // An input or the row id the SQL never returns.
  assert.deepEqual(scoredCheck('SELECT person_id, tenure, spend, idle FROM people WHERE zone = $zone ORDER BY person_id LIMIT 5001'), [
    'its SQL never returns "rise", which the scoring needs (a scoring input or the row id)',
  ]);
  assert.deepEqual(scoredCheck("SELECT 'rise' AS x, person_id, tenure, spend, idle FROM people WHERE zone = $zone ORDER BY person_id LIMIT 5001"), [
    'its SQL never returns "rise", which the scoring needs (a scoring input or the row id)',
  ]);
});

test('bindValues leaves out a scored module\'s limit input; the run declares only the bound names', () => {
  assert.deepEqual(bindValues(RANKED.parameters, { zone: 'north', limit: 3 }, { omit: 'limit' }), { zone: 'north' });
  assert.deepEqual(boundNames(RANKED), ['zone']);
  assert.deepEqual(boundNames(PULL), ['zone', 'days', 'code']);
});

test('a scored list: Confirm scores every row in the engine, keeps the top limit, and shows score and reason in the view and the CSV', async () => {
  const ctx = setupRanked();
  const { view } = await confirmRanked(ctx);
  // The limit is never bound: the SQL gets the zone only.
  assert.deepEqual(ctx.data.runs[0], { sql: RANKED.sql, params: { zone: 'north' }, opts: { declared: ['zone'] } });
  assert.equal(view.blocks[0].text.text, '*Ranked list: the top 3 of 5 rows, by score.*');
  assert.deepEqual(view.blocks.filter((b) => b.fields).map((b) => b.fields[1].text), ['north', '3']);
  assert.equal(blockTexts(view)[3], [
    '*The top 3:*',
    '```',
    'score  person_id  name  reason',
    '79     1          Ann   Months as a client: 24; Paid to date ($): 5,000',
    '64     2          Bo    Paid to date ($): 10,000; Months as a client: 12',
    '64     10         Eve   Paid to date ($): 10,000; Months as a client: 12',
    '```',
  ].join('\n'));
  assert.equal(blockTexts(view).at(-1), 'The ranked list (3 rows) is a CSV in your DM with me. <https://fake.slack.test/files/F1|Open the CSV>');
  const up = ctx.app.uploads[0];
  assert.equal(up.content, `${BOM}${[
    'score,person_id,name,tenure,spend,idle,rise,reason',
    '79,1,Ann,24,5000,0,true,"Months as a client: 24; Paid to date ($): 5,000"',
    '64,2,Bo,12,10000.00,50,false,"Paid to date ($): 10,000; Months as a client: 12"',
    '64,10,Eve,12,10000,50,false,"Paid to date ($): 10,000; Months as a client: 12"',
  ].join('\r\n')}\r\n`);
  assert.equal(up.initial_comment, 'Ranked list: the top 3 of 5 rows, by score, for Zone: north, How many: 3.');
  // A second run on the same data gives the same CSV.
  const again = setupRanked();
  await confirmRanked(again);
  assert.equal(again.app.uploads[0].content, up.content);
});

test('a scored list at the cap: 5,001 rows back, the engine ranks only the first 5,000 and says so', async () => {
  const worst = { tenure: 0, spend: 0, idle: 100, rise: false };
  const many = Array.from({ length: 5001 }, (_, i) => ({ person_id: i + 1, name: `P${i + 1}`, ...worst }));
  many[3999] = { ...many[3999], tenure: 24 };
  // The 5,001st row would score 100, but it is past the cap: never ranked.
  many[5000] = { person_id: 5001, name: 'Late', tenure: 24, spend: 10000, idle: 0, rise: true };
  const ctx = setupRanked({ data: fakeData(() => many) });
  const { view } = await confirmRanked(ctx);
  assert.equal(SCORED_LIMIT, ROW_CAP + 1);
  assert.equal(view.blocks[0].text.text, '*Ranked list: the top 3 by score, of the first 5,000 rows.*');
  assert.equal(blockTexts(view)[1], 'The ranking covers only the first 5,000 rows the query returned; more matched. Narrow the values to rank them all.');
  const lines = ctx.app.uploads[0].content.replace(BOM, '').trimEnd().split('\r\n');
  assert.deepEqual(lines.slice(1).map((l) => l.split(',').slice(0, 2).join(',')), ['29,4000', '0,1', '0,2']);
  assert.ok(!ctx.app.uploads[0].content.includes('Late'));
  assert.match(ctx.app.uploads[0].initial_comment, /^Ranked list: the top 3 by score, of the first 5,000 rows \(the ranking covers only the first 5,000\)/);
  assert.equal(blockTexts(view).at(-1), 'The CSV in your DM with me holds the top 3 by score, of the first 5,000 rows. <https://fake.slack.test/files/F1|Open the CSV>');
});

test('a scored list whose rows can\'t be scored stops: the plain message names the input, nothing is sent, the log names module and input', async () => {
  const rows = RANKED_ROWS.map((r) => (r.person_id === 3 ? { ...r, spend: null } : r));
  const ctx = setupRanked({ data: fakeData(() => rows) });
  const { view, session, from } = await confirmRanked(ctx);
  const words = messageFor(new ScoringFault({ module: 'ranked', input: 'spend', label: 'Paid to date ($)', problem: 'null' }), { admin: ADMIN });
  assert.equal(view.blocks[0].text.text, words);
  assert.match(words, /COALESCE/);
  assert.deepEqual(ctx.app.uploads, []);
  assert.equal(view.blocks[0].accessory, undefined, 'no "How was this made?" for a run that stopped');
  const logged = ctx.log.lines.find((l) => l.msg === 'list scoring failed');
  assert.deepEqual(logged.fields, { module: 'ranked', input: 'spend', problem: 'null' });
  // The run did not finish: a replay says so.
  await ctx.app.dispatchAction(ACTIONS.confirm, { user: { id: 'U1' }, view: { ...from, hash: `h${ctx.app.viewSeq}` }, value: session });
  assert.equal(blockTexts(updates(ctx.app).at(-1).view)[0], FAILED_REPLAY);
  // A missing input column, and a non-numeric value, stop it the same way.
  for (const [bad, input, problem] of [[RANKED_ROWS.map(({ idle, ...r }) => r), 'idle', 'missing'], [RANKED_ROWS.map((r) => ({ ...r, tenure: 'long' })), 'tenure', 'not_number']]) {
    const c = setupRanked({ data: fakeData(() => bad) });
    await confirmRanked(c);
    assert.deepEqual(c.log.lines.find((l) => l.msg === 'list scoring failed').fields, { module: 'ranked', input, problem });
    assert.deepEqual(c.app.uploads, []);
  }
});

// The run record's push rows (Story 10.1) are picked by the approval-write
// archetype through the runner's reuse hook since Story 10.2: their tests are
// in test/unit/runtime-approval-preview.test.js. Without the hook, a record
// keeps none.
test('without the reuse hook, a run record keeps no push rows and the result has no Push button', async () => {
  const store = createStore();
  const run = createRunner({ data: fakeData(() => RANKED_ROWS), log: quietLog(), store });
  const { client } = new FakeSlackApp({ views: true });
  const res = await run(RANKED, { zone: 'north', limit: 3 }, 'U1', { client });
  const record = store.get('provenance', res.message.blocks[0].accessory.value);
  assert.equal(record.rowIds, null);
  assert.equal(record.rows, null);
  assert.ok(!res.message.blocks.some((b) => b.type === 'actions'));
});

test('a scored list\'s limit: only null or undefined keeps every row; any other non-integer stops the run as a setup fault', async () => {
  for (const limit of [null, undefined]) {
    const out = await runQuery({ data: fakeData(() => RANKED_ROWS), mod: RANKED, values: { zone: 'north', limit }, log: quietLog() });
    assert.equal(out.kind, 'rows');
    assert.equal(out.rows.length, 5);
  }
  for (const limit of ['3', 2.5, -1, NaN, true, {}]) {
    const log = quietLog();
    const out = await runQuery({ data: fakeData(() => RANKED_ROWS), mod: RANKED, values: { zone: 'north', limit }, log });
    assert.equal(out.kind, 'scoring', `limit ${String(limit)}`);
    assert.ok(out.error instanceof ScoringFault);
    assert.deepEqual(out.error.details, { module: 'ranked', input: 'limit', label: 'How many', problem: 'bad_limit' });
    assert.deepEqual(log.lines.find((l) => l.msg === 'list scoring failed').fields, { module: 'ranked', input: 'limit', problem: 'bad_limit' });
  }
});

test('two rows with the same row id stop a scored run with a duplicate_row_id fault; nothing is sent', async () => {
  const rows = [...RANKED_ROWS, { ...RANKED_ROWS[1], name: 'Bo again' }];
  const ctx = setupRanked({ data: fakeData(() => rows) });
  const { view } = await confirmRanked(ctx);
  const fault = new ScoringFault({ module: 'ranked', input: 'person_id', label: 'person_id', problem: 'duplicate_row_id' });
  assert.equal(view.blocks[0].text.text, messageFor(fault, { admin: ADMIN }));
  assert.match(view.blocks[0].text.text, /two rows have the same "person_id"/);
  assert.deepEqual(ctx.app.uploads, []);
  assert.deepEqual(ctx.log.lines.find((l) => l.msg === 'list scoring failed').fields, { module: 'ranked', input: 'person_id', problem: 'duplicate_row_id' });
  // The same id as a number and as text is the same row.
  const mixed = setupRanked({ data: fakeData(() => [...RANKED_ROWS, { ...RANKED_ROWS[0], person_id: '1' }]) });
  await confirmRanked(mixed);
  assert.equal(mixed.log.lines.find((l) => l.msg === 'list scoring failed').fields.problem, 'duplicate_row_id');
});

test('the preview stays under Slack\'s section limit: rows are dropped from the end, never cut mid-table', () => {
  const columns = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'reason'];
  const rows = Array.from({ length: 10 }, (_, i) => Object.fromEntries(columns.map((c) => [c, `${c}${i}`.padEnd(40, 'x')])));
  const fit = previewFit(columns, rows, { full: ['reason'] });
  assert.ok(fit.text.length <= PREVIEW_LIMIT);
  assert.ok(fit.shown < 10 && fit.shown > 0);
  assert.equal(fit.text.split('\n').length, 3 + fit.shown);
  assert.equal(previewFit(['a'], [{ a: 1 }, { a: 2 }]).shown, 2);
});
