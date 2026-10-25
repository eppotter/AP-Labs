'use strict';

// Story 7.5: the hub dispatcher hands a handler the query runner, and the
// Brightside Dataset module answers privately from it. The module's code is
// the example app's; its data is the minimal engine fixture
// (test/fixtures/fixture-build/), built into a temporary directory, and its
// profile is a fixture, never a client's. An example test (architecture
// carve-out, moved here from test/unit in Story 6.5): it reads the example app
// dir and is deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../../kit/fixture/build');
const { createData } = require('../../../kit/runtime/data');
const { DataUnavailable } = require('../../../kit/runtime/errors');
const { messageFor } = require('../../../kit/runtime/messages');
const { createRegistry } = require('../../../kit/runtime/registry');
const { registerHubs } = require('../../../kit/runtime/slack/hubs');
const { createStore } = require('../../../kit/runtime/store');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');

// The reply a person sees when the data is unavailable.
const DATA_UNAVAILABLE = messageFor(new DataUnavailable('test'));

const REPO = path.join(__dirname, '..', '..', '..');
const MINI = path.join(REPO, 'test', 'fixtures', 'fixture-build', 'mini');
const DATASET = path.join(__dirname, '..', 'app', 'modules', 'dataset');
const PROFILE = Object.freeze({
  client: { id: 'tiny', name: 'Tiny' },
  resources: [{ key: 'DATASET', label: 'Dataset', open_access: true }],
  users: [],
});
const HUB = Object.freeze({ id: 'brightside', command: '/hub', name: 'Hub', description: 'Hub', file: 'hubs/brightside.json' });

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-dataset-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

const manifest = JSON.parse(fs.readFileSync(path.join(DATASET, 'manifest.json'), 'utf8'));
const datasetModule = { ...manifest, file: 'modules/dataset/manifest.json', run: require(path.join(DATASET, manifest.handler)) };

function setup(data, modules = [datasetModule]) {
  const app = new FakeSlackApp({});
  const log = quietLog();
  const registry = createRegistry({ hubs: [HUB], modules });
  registerHubs(app, { registry, profile: PROFILE, env: 'dev', log, store: createStore(), data });
  return { app, log };
}

test('the Dataset entry replies privately with the source, fixture version, as-of date and row counts', async (t) => {
  const file = path.join(tmpDir(t), 'tiny.duckdb');
  await build({ fixtureDir: MINI, out: file });
  const data = createData({ file, profile: PROFILE });
  t.after(() => data.close());
  const { app } = setup(data);
  await app.dispatchAction('dataset:open');
  assert.equal(app.responded.length, 1);
  const [reply] = app.responded;
  assert.equal(reply.response_type, 'ephemeral');
  assert.equal(reply.text, [
    '*Dataset*',
    'Source: local fixture (tiny.duckdb)',
    'Fixture version: not recorded',
    'As of: 2026-09-30',
    'Published: local build',
    'Tables (2):',
    '• regions: 2',
    '• shops: 3',
  ].join('\n'));
});

test('the Dataset entry shows the fixture version and formats large counts', async (t) => {
  const fixture = path.join(tmpDir(t), 'fixture');
  fs.cpSync(MINI, fixture, { recursive: true });
  fs.appendFileSync(path.join(fixture, 'seeds', 'fixture_meta.csv'), 'generator_version,7\n');
  const file = path.join(tmpDir(t), 'v.duckdb');
  await build({ fixtureDir: fixture, out: file });
  const replies = [];
  const data = createData({ file, profile: PROFILE });
  t.after(() => data.close());
  await datasetModule.run({ data: { run: (sql) => data.run(sql), describe: data.describe }, reply: async (m) => replies.push(m) });
  assert.match(replies[0], /^Fixture version: 7$/m);

  const fake = {
    run: async () => [{ key: 'as_of', value: '2026-01-01' }, { key: 'rows_visits', value: '40895' }],
    describe: () => ({ source: 'local fixture', label: 'x.duckdb', available: true, problem: null }),
  };
  await datasetModule.run({ data: fake, reply: async (m) => replies.push(m) });
  assert.match(replies[1], /^• visits: 40,895$/m);
});

test('the Dataset template passes the guardrail even with forbidden columns configured, and declares no parameters', async (t) => {
  const file = path.join(tmpDir(t), 'tiny.duckdb');
  await build({ fixtureDir: MINI, out: file });
  const data = createData({ file, profile: { ...PROFILE, sql: { forbidden_columns: ['shops.postal_code'] } } });
  t.after(() => data.close());
  const sql = fs.readFileSync(path.join(DATASET, 'fixture_meta.sql'), 'utf8');
  assert.ok(!sql.includes('${'), 'no string interpolation in a template');
  assert.equal(manifest.parameters, undefined);
  assert.ok((await data.run(sql)).length > 0);
});

test('on MotherDuck the Dataset entry reads fixture_meta and fixture_publish in one query and shows the database, version and publish time', async (t) => {
  const { createFakeMotherDuck } = require('../../../test/fixtures/fake-motherduck');
  const remoteSql = fs.readFileSync(path.join(DATASET, 'fixture_meta_remote.sql'), 'utf8');
  const fake = createFakeMotherDuck({
    database: 'tiny_fixture',
    rows: (sql) => {
      assert.equal(sql, remoteSql, 'the remote template, unchanged');
      return [
        { src: 'meta', key: 'as_of', value: '2026-09-30' },
        { src: 'meta', key: 'generator_version', value: '2' },
        { src: 'meta', key: 'rows_shops', value: '1200' },
        { src: 'publish', key: 'fixture_version', value: '2+0123456789ab' },
        { src: 'publish', key: 'generator_version', value: '2' },
        { src: 'publish', key: 'published_at', value: '2026-10-24T21:00:00.000Z' },
      ];
    },
  });
  // Fake values only; nothing here is a credential.
  const profile = { ...PROFILE, data: { source: 'motherduck', database: 'tiny_fixture' }, sql: { forbidden_columns: ['shops.postal_code'] } };
  const data = createData({ profile, token: 'fake-read-key-not-a-credential', connect: fake.create });
  t.after(() => data.close());
  await data.open();
  const { app } = setup(data);
  await app.dispatchAction('dataset:open');
  assert.equal(app.responded[0].text, [
    '*Dataset*',
    'Source: MotherDuck (tiny_fixture)',
    'Fixture version: 2+0123456789ab',
    'As of: 2026-09-30',
    'Published: 2026-10-24T21:00:00.000Z',
    'Tables (1):',
    '• shops: 1,200',
  ].join('\n'));
  // One query per click, on a connection that ran USE first.
  const conns = fake.state.instances[0].connections.slice(1);
  assert.deepEqual(conns.map((c) => c.statements), [['USE "tiny_fixture"', remoteSql]]);
  assert.ok(!remoteSql.includes('${'), 'no string interpolation in a template');
});

test('when the data file is missing, the person is told plainly and the app keeps answering', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'tiny.duckdb');
  const data = createData({ file, profile: PROFILE });
  t.after(() => data.close());
  const { app, log } = setup(data);
  await app.dispatchAction('dataset:open');
  assert.deepEqual(app.responded.map((r) => r.text), [DATA_UNAVAILABLE]);
  assert.equal(app.responded[0].response_type, 'ephemeral');
  assert.ok(log.lines.some((l) => l.level === 'warn' && l.msg === 'data unavailable' && l.fields.module === 'dataset'));
  assert.ok(!log.lines.some((l) => l.level === 'error'), 'not treated as a crash');

  // The file is built while the app runs: the next click answers.
  await build({ fixtureDir: MINI, out: file });
  await app.dispatchAction('dataset:open');
  assert.match(app.responded[1].text, /^As of: 2026-09-30$/m);
});

test('with no data source at all, a module that reads data is told it is unavailable', async () => {
  const { app } = setup(null);
  await app.dispatchAction('dataset:open');
  assert.deepEqual(app.responded.map((r) => r.text), [DATA_UNAVAILABLE]);
});

test('a handler\'s data.run refuses a parameter its manifest does not declare', async (t) => {
  const file = path.join(tmpDir(t), 'tiny.duckdb');
  await build({ fixtureDir: MINI, out: file });
  const data = createData({ file, profile: PROFILE });
  t.after(() => data.close());
  const seen = [];
  const probe = (declared) => ({
    id: `probe-${declared.length}`, hub: 'brightside', label: 'Probe', description: 'Probe', resource: 'DATASET',
    archetype: 'handler', environments: ['dev'], file: 'x', parameters: declared.map((name) => ({ name, type: 'string' })),
    run: async (ctx) => {
      try {
        seen.push(await ctx.data.run('SELECT count(*)::INT AS n FROM shops WHERE region_id = $region', { region: 'vale' }));
      } catch (err) {
        seen.push(err.rule);
      }
      await ctx.reply('done');
    },
  });
  const { app } = setup(data, [probe([]), probe(['region'])]);
  await app.dispatchAction('probe-0:open');
  await app.dispatchAction('probe-1:open');
  assert.deepEqual(seen, ['undeclared_parameter', [{ n: 2 }]]);
});
