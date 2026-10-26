'use strict';

// Story 13.2 (AD-R9, data-design §3): travelMatrix, the one governed read of
// coordinate columns. Real DuckDB tests build test/fixtures/routing-data into
// a temporary file and read it with test/fixtures/profiles/routing.yml; the
// MotherDuck-mode tests use the fake instance factory. No client path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { build } = require('../../kit/fixture/build');
const { loadProfile, validateProfile } = require('../../kit/lib/profile');
const sqlGuard = require('../../kit/runtime/sql');
const dataModule = require('../../kit/runtime/data');
const travel = require('../../kit/runtime/data/travel');
const { RoutingFault } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');
const routingEngine = require('../../kit/runtime/routing');
const sdk = require('../../kit/runtime/sdk');
const { createFakeMotherDuck } = require('../fixtures/fake-motherduck');

const { createData, QueryRefusedError } = dataModule;
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'routing-data');
const PROFILE_FILE = path.join(__dirname, '..', 'fixtures', 'profiles', 'routing.yml');
const SEEDS = path.join(FIXTURE, 'seeds');
const COORDINATE_COLUMNS = ['sites.pos_lat_e6', 'sites.pos_lon_e6', 'vans.home_lat_e6', 'vans.home_lon_e6'];
const TOKEN = 'fake-read-key-0000-not-a-credential';

// The seeds, read as plain CSV (no quoting in them), for the hand computation.
function seed(table) {
  const [head, ...lines] = fs.readFileSync(path.join(SEEDS, `${table}.csv`), 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}
const POSITIONS = new Map([
  ...seed('sites').filter((r) => r.pos_lat_e6).map((r) => [`site:${r.site_id}`, [Number(r.pos_lat_e6), Number(r.pos_lon_e6)]]),
  ...seed('vans').map((r) => [`van:${r.van_id}`, [Number(r.home_lat_e6), Number(r.home_lon_e6)]]),
]);

// The formula by hand: haversine km x detour / speed x 60, rounded to 1e-6,
// then up to a whole minute, never below the floor.
const rad = (deg) => (deg * Math.PI) / 180;
function km(a, b) {
  const [lat1, lon1] = POSITIONS.get(a).map((v) => v / 1e6);
  const [lat2, lon2] = POSITIONS.get(b).map((v) => v / 1e6);
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * travel.EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
const rawMinutes = (a, b, r) => ((km(a, b) * r.detour_factor) / r.speed_kmh) * 60;
const byHand = (a, b, r) => Math.max(r.min_travel_minutes, Math.ceil(Math.round(rawMinutes(a, b, r) * 1e6) / 1e6));

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-travel-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function builtFile(t) {
  const file = path.join(tmpDir(t), 'route-co.duckdb');
  await build({ fixtureDir: FIXTURE, out: file });
  return file;
}

// The fixture profile, optionally edited (re-validated, so defaults fill).
function profileWith(edit) {
  if (!edit) return loadProfile(PROFILE_FILE);
  const raw = YAML.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
  edit(raw);
  return validateProfile(raw);
}

async function source(t, profile = profileWith()) {
  const data = createData({ file: await builtFile(t), profile });
  t.after(() => data.close());
  return data;
}

const refused = (field, problem) => (err) => {
  assert.ok(err instanceof RoutingFault, `a RoutingFault, got ${err && err.stack}`);
  assert.deepEqual(err.details, { field, problem });
  assert.equal(err.message, `routing input refused: "${field}" ${problem}`);
  return true;
};

// Every coordinate value in the seeds, as an integer and as degrees.
const COORDINATE_TEXT = [...POSITIONS.values()].flat().flatMap((v) => [String(v), String(v / 1e6), (v / 1e6).toFixed(6)]);
const ADDRESSES = seed('sites').flatMap((r) => [r.street_address, r.phone]);

// --- The rectangle and the formula -----------------------------------------

test('returns the from x to rectangle in the order asked; minutes match haversine x detour / speed by hand', async (t) => {
  const profile = profileWith();
  const data = await source(t, profile);
  const from = ['van:v1', 'site:s1', 'site:s3'];
  const to = ['site:s2', 'site:s1', 'van:v2', 'site:s3'];
  const rows = await data.travelMatrix(from, to);
  assert.equal(rows.length, from.length * to.length);
  const expected = from.flatMap((a) => to.map((b) => ({ from_node: a, to_node: b, minutes: byHand(a, b, profile.routing) })));
  assert.deepEqual(rows, expected);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ['from_node', 'to_node', 'minutes']);
    assert.ok(Number.isSafeInteger(row.minutes));
  }
  // Pinned by hand once, so the test and the SQL cannot drift together.
  assert.equal(rows.find((r) => r.from_node === 'site:s1' && r.to_node === 'site:s2').minutes, 17);
  assert.equal(rows.find((r) => r.from_node === 'van:v1' && r.to_node === 'van:v2').minutes, 47);
});

test('a pair closer than the floor gets min_travel_minutes (default 5; a set floor wins)', async (t) => {
  const data = await source(t);
  assert.deepEqual(await data.travelMatrix(['site:s1'], ['site:s1']), [{ from_node: 'site:s1', to_node: 'site:s1', minutes: 5 }]);
  const profile = profileWith((p) => { p.routing.min_travel_minutes = 30; });
  const floored = await source(t, profile);
  const rows = await floored.travelMatrix(['site:s1'], ['site:s2', 'site:s3']);
  assert.ok(rawMinutes('site:s1', 'site:s2', profile.routing) < 30, 'the fixture pair is under the floor');
  assert.deepEqual(rows.map((r) => r.minutes), [30, byHand('site:s1', 'site:s3', profile.routing)]);
});

test('minutes are rounded to 1e-6 before rounding up: a float a hair over a whole minute is not a minute more', async (t) => {
  // A speed where the raw minutes come out a hair over 12 in floating point.
  const k = km('site:s1', 'site:s2');
  let speed = null;
  for (let i = 0; i < 64 && speed === null; i += 1) {
    const s = k * 5 * (1 - i * Number.EPSILON);
    const raw = ((k * 1) / s) * 60;
    if (raw > 12 && raw < 12 + 1e-9) speed = s;
  }
  assert.ok(speed !== null, 'found a speed that lands just over 12');
  const profile = profileWith((p) => { p.routing.detour_factor = 1; p.routing.speed_kmh = speed; });
  const data = await source(t, profile);
  assert.equal(Math.ceil(rawMinutes('site:s1', 'site:s2', profile.routing)), 13, 'a bare ceil would say 13');
  assert.deepEqual(await data.travelMatrix(['site:s1'], ['site:s2']), [{ from_node: 'site:s1', to_node: 'site:s2', minutes: 12 }]);
});

test('the rows feed the engine\'s travel port (routing.travel.fromMatrix) when the node kinds are the engine\'s', async (t) => {
  const profile = profileWith((p) => {
    p.routing.coordinates.nodes[0].kind = 'property';
    p.routing.coordinates.nodes[1].kind = 'crew';
  });
  const data = await source(t, profile);
  const rows = await data.travelMatrix(['crew:v1', 'property:s1'], ['property:s1', 'property:s2']);
  const drive = routingEngine.travel.fromMatrix(rows);
  assert.equal(drive('crew:v1', 'property:s2'), rows[1].minutes);
  assert.throws(() => drive('property:s2', 'crew:v1'), (err) => err instanceof RoutingFault && err.details.problem === 'no_travel');
});

test('an empty list is an empty rectangle, read from nothing', async (t) => {
  const data = createData({ file: path.join(tmpDir(t), 'none.duckdb'), profile: profileWith() });
  assert.deepEqual(await data.travelMatrix([], ['site:s1']), []);
  assert.deepEqual(await data.travelMatrix(['site:s1'], []), []);
});

// --- What never comes back ---------------------------------------------------

test('the output holds no coordinate value, address or phone (scan of the serialized result)', async (t) => {
  const data = await source(t);
  const ids = [...POSITIONS.keys()];
  const text = JSON.stringify(await data.travelMatrix(ids, ids));
  for (const v of [...COORDINATE_TEXT, ...ADDRESSES]) assert.ok(!text.includes(v), `the output holds ${v}`);
});

test('an unknown id and a place with no position are refused by list position, never by value', async (t) => {
  const data = await source(t);
  await assert.rejects(data.travelMatrix(['site:s1', 'site:s4'], ['site:s2']), refused('fromIds[1]', 'no_position'));
  await assert.rejects(data.travelMatrix(['site:s1'], ['site:s2', 'site:zz']), refused('toIds[1]', 'no_position'));
  await assert.rejects(data.travelMatrix(['van:s1'], ['site:s2']), refused('fromIds[0]', 'no_position'));
});

// --- Node ids: kind-prefixed, bound, capped ----------------------------------

test('node ids must be kind-prefixed ids of a declared kind, each once per list; refused before any query', async (t) => {
  const data = createData({ file: path.join(tmpDir(t), 'none.duckdb'), profile: profileWith() });
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await assert.rejects(data.travelMatrix('site:s1', ['site:s1']), refused('fromIds', 'not_list'));
  await assert.rejects(data.travelMatrix(['site:s1'], null), refused('toIds', 'not_list'));
  await assert.rejects(data.travelMatrix([7], ['site:s1']), refused('fromIds[0]', 'not_text'));
  for (const bad of ['s1', 'property:s1', 'crew:v1', 'site:', "site:s1' OR 1=1 --", 'site:s1,site:s2', 'SITE:s1', `site:${'x'.repeat(65)}`]) {
    await assert.rejects(data.travelMatrix(['site:s1'], ['site:s2', bad]), refused('toIds[1]', 'bad_node'), bad);
  }
  await assert.rejects(data.travelMatrix(['site:s1', 'van:v1', 'site:s1'], ['site:s1']), refused('fromIds[2]', 'duplicate'));
  assert.equal(checks.mock.callCount(), 0, 'nothing reached the guard or DuckDB');
});

test('node ids reach DuckDB only as bound parameters: the SQL text is the same static template for any ids', async (t) => {
  const data = await source(t);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await data.travelMatrix(['site:s1'], ['site:s2']);
  await data.travelMatrix(['van:v2', 'site:s3'], ['van:v1']);
  const sqls = checks.mock.calls.map((c) => c.arguments[0]);
  assert.equal(sqls.length, 4, 'the column-type query and the matrix query, twice');
  assert.equal(sqls[0], travel.COLUMN_TYPES_SQL);
  assert.equal(sqls[1], sqls[3], 'one static template');
  for (const sql of sqls) assert.ok(!/s1|s2|s3|v1|v2/.test(sql.replace(/\$\w+/g, '')), 'no id in the text');
  assert.match(sqls[1], /^SELECT from_node, to_node,$/m);
  assert.match(sqls[1], /AS INTEGER\) AS minutes$/m);
});

test('more than routing.max_pairs pairs is refused before running', async (t) => {
  const data = createData({ file: path.join(tmpDir(t), 'none.duckdb'), profile: profileWith((p) => { p.routing.max_pairs = 3; }) });
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await assert.rejects(data.travelMatrix(['site:s1', 'site:s2'], ['site:s1', 'site:s3']), refused('travelMatrix', 'too_many_pairs'));
  assert.equal(checks.mock.callCount(), 0);
  // Exactly the cap is allowed (and then fails only for want of the file).
  await assert.rejects(data.travelMatrix(['site:s1'], ['site:s1', 'site:s2', 'site:s3']), refused('travelMatrix', 'data_unavailable'));
});

test('a routing block without its cap or floor filled is refused, never read as "no limit"', async (t) => {
  const loaded = profileWith();
  for (const key of ['max_pairs', 'min_travel_minutes', 'speed_kmh', 'detour_factor']) {
    const routing = { ...loaded.routing };
    delete routing[key];
    const data = createData({ file: path.join(tmpDir(t), 'none.duckdb'), profile: { ...loaded, routing } });
    await assert.rejects(data.travelMatrix(['site:s1'], ['site:s2']), refused(`routing.${key}`, 'out_of_range'), key);
  }
});

test('with no routing block, travelMatrix refuses (routing is off)', async (t) => {
  const data = createData({ file: path.join(tmpDir(t), 'none.duckdb'), profile: { client: { id: 'x' }, sql: { forbidden_columns: [] } } });
  await assert.rejects(data.travelMatrix(['site:s1'], ['site:s2']), refused('routing', 'routing_off'));
});

// --- The column checks ---------------------------------------------------------

test('declaring street_address as a coordinate column is refused before the matrix query runs (not INTEGER/BIGINT)', async (t) => {
  const profile = profileWith((p) => {
    p.sql.forbidden_columns.push('sites.street_address');
    p.routing.coordinates.nodes[0].lat_column = 'street_address';
  });
  const data = await source(t, profile);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await assert.rejects(data.travelMatrix(['site:s1'], ['site:s2']), refused('routing.coordinates.nodes[0].lat_column', 'not_coordinate_column'));
  assert.deepEqual(checks.mock.calls.map((c) => c.arguments[0]), [travel.COLUMN_TYPES_SQL], 'only the column-type query ran');
});

test('a declared coordinate column the table lacks is refused the same way', async (t) => {
  const profile = profileWith((p) => {
    p.sql.forbidden_columns.push('vans.home_alt_e6');
    p.routing.coordinates.nodes[1].lon_column = 'home_alt_e6';
  });
  const data = await source(t, profile);
  await assert.rejects(data.travelMatrix(['site:s1'], ['van:v1']), refused('routing.coordinates.nodes[1].lon_column', 'not_coordinate_column'));
});

test('a name that is not a plain SQL identifier never reaches the template', () => {
  const routing = profileWith().routing;
  for (const [key, bad] of [['table', 'sites; DROP TABLE x'], ['id_column', 'site_id"'], ['lat_column', 'Pos'], ['kind', "site'"]]) {
    const nodes = routing.coordinates.nodes.map((n, i) => (i === 0 ? { ...n, [key]: bad } : n));
    assert.throws(() => travel.matrixSql({ ...routing, coordinates: { nodes } }), refused(`routing.coordinates.nodes[0].${key}`, 'bad_id'), key);
  }
});

// --- The guard: exactly the coordinate columns dropped ------------------------

test('checkSql runs with the profile\'s forbidden list minus exactly the declared coordinate columns', async (t) => {
  const profile = profileWith((p) => { p.sql.forbidden_columns.push('sites.phone', 'sites.street_address'); });
  const data = await source(t, profile);
  const checks = t.mock.method(sqlGuard, 'checkSql');
  await data.travelMatrix(['site:s1'], ['van:v1']);
  const [types, matrix] = checks.mock.calls.map((c) => c.arguments[1].forbiddenColumns);
  assert.deepEqual(types, profile.sql.forbidden_columns, 'the column-type query runs under the full list');
  assert.deepEqual(matrix, ['sites.phone', 'sites.street_address']);
  assert.deepEqual(
    profile.sql.forbidden_columns.filter((c) => !matrix.includes(c)).sort(),
    [...COORDINATE_COLUMNS].sort(),
    'only the four coordinate columns were dropped',
  );
  assert.deepEqual(travel.travelForbidden(['a.b', ...COORDINATE_COLUMNS, 'sites.pos_alt_e6'], profile.routing), ['a.b', 'sites.pos_alt_e6']);
});

test('every other forbidden column still applies: an id column the profile forbids is refused', async (t) => {
  const profile = profileWith((p) => { p.sql.forbidden_columns.push('sites.site_id'); });
  const data = await source(t, profile);
  await assert.rejects(data.travelMatrix(['site:s1'], ['site:s2']), refused('travelMatrix', 'query_refused'));
});

test('run() still refuses each coordinate column, and no option or export drops one', async (t) => {
  const data = await source(t);
  for (const fc of COORDINATE_COLUMNS) {
    const [table, column] = fc.split('.');
    await assert.rejects(data.run(`SELECT ${column} FROM ${table}`), (err) => err instanceof QueryRefusedError && err.rule === 'forbidden_column', fc);
    await assert.rejects(
      data.run(`SELECT ${column} FROM ${table}`, {}, { declared: [], forbiddenColumns: [], allowCoordinates: true }),
      (err) => err instanceof QueryRefusedError && err.rule === 'forbidden_column',
      `${fc} with options`,
    );
  }
  await assert.rejects(data.run('SELECT * FROM sites'), (err) => err instanceof QueryRefusedError && err.rule === 'wildcard');
  // createData takes no forbidden list of its own: the profile's always wins.
  const sneaky = createData({ file: await builtFile(t), profile: profileWith(), forbiddenColumns: [] });
  t.after(() => sneaky.close());
  await assert.rejects(sneaky.run('SELECT pos_lat_e6 FROM sites'), (err) => err instanceof QueryRefusedError && err.rule === 'forbidden_column');
  // The data module's exports: no runner but createData's, and travel.js only
  // pure helpers (the boundary test checks it opens no DuckDB).
  assert.deepEqual(Object.keys(dataModule).sort(), [
    'DataUnavailableError', 'LOCKDOWN', 'PARAM_RULES', 'QueryRefusedError', 'SOURCE', 'SOURCES', 'createData', 'dataPathFor',
    'extensionLoads', 'installedExtensions', 'openLocked', 'openMotherDuck', 'sourceOf',
  ]);
  for (const [name, value] of Object.entries(travel)) {
    if (typeof value === 'function') assert.notEqual(value.constructor.name, 'AsyncFunction', `${name} runs nothing`);
  }
});

test('the data object is frozen with exactly these keys: no override flag, no raw connection', async (t) => {
  const withRouting = await source(t);
  const without = createData({ file: path.join(tmpDir(t), 'none.duckdb'), profile: { client: { id: 'x' }, sql: { forbidden_columns: [] } } });
  for (const data of [withRouting, without]) {
    assert.ok(Object.isFrozen(data));
    assert.deepEqual(Object.keys(data), ['open', 'run', 'travelMatrix', 'describe', 'close']);
    for (const value of Object.values(data)) assert.equal(typeof value, 'function');
  }
  await withRouting.open();
  assert.deepEqual(Object.keys(withRouting), ['open', 'run', 'travelMatrix', 'describe', 'close'], 'unchanged once open');
});

// --- Errors: fixed text, shared limits ---------------------------------------

test('a DuckDB error is a fixed-text RoutingFault: no SQL, path or value', async (t) => {
  const profile = profileWith((p) => { p.routing.coordinates.nodes[0].id_column = 'site_ref'; });
  const file = await builtFile(t);
  const data = createData({ file, profile });
  t.after(() => data.close());
  const err = await data.travelMatrix(['site:s1'], ['site:s2']).catch((e) => e);
  refused('travelMatrix', 'query_failed')(err);
  for (const leak of ['site_ref', 'SELECT', 'pos_lat_e6', path.basename(file), path.dirname(file), 'Binder']) {
    assert.ok(!err.message.includes(leak) && !JSON.stringify(err.details).includes(leak), leak);
  }
  assert.equal(err.cause, undefined, 'the original error is not carried');
  const words = messageFor(err, { admin: 'Sam' });
  assert.ok(!words.includes('site_ref') && !words.includes('SELECT'));
});

test('a missing data file is a fixed-text RoutingFault (data unavailable)', async (t) => {
  const data = createData({ file: path.join(tmpDir(t), 'missing.duckdb'), profile: profileWith() });
  await assert.rejects(data.travelMatrix(['site:s1'], ['site:s2']), refused('travelMatrix', 'data_unavailable'));
});

const MD_PROFILE = () => ({ ...profileWith(), data: { source: 'motherduck', database: 'brightside_fixture' } });

test('MotherDuck: DuckDB text holding coordinates, SQL and the key never reaches the fault', async (t) => {
  const fake = createFakeMotherDuck({
    failOn: (sql) => (sql === travel.COLUMN_TYPES_SQL ? new Error(`Binder Error: 41.123457 -73654321 ${TOKEN} near "SELECT pos_lat_e6 FROM sites"`) : null),
  });
  const data = createData({ profile: MD_PROFILE(), token: TOKEN, connect: fake.create });
  t.after(() => data.close());
  const err = await data.travelMatrix(['site:s1'], ['site:s2']).catch((e) => e);
  refused('travelMatrix', 'data_unavailable')(err);
  for (const leak of ['41.123457', '-73654321', TOKEN, 'SELECT', 'pos_lat_e6']) assert.ok(!err.message.includes(leak), leak);
});

test('MotherDuck: the column types are checked there too, and the matrix query never runs on a text column', async (t) => {
  const fake = createFakeMotherDuck({
    rows: (sql) => (sql === travel.COLUMN_TYPES_SQL ? [
      { table_name: 'sites', column_name: 'pos_lat_e6', data_type: 'VARCHAR' },
      { table_name: 'sites', column_name: 'pos_lon_e6', data_type: 'INTEGER' },
      { table_name: 'vans', column_name: 'home_lat_e6', data_type: 'BIGINT' },
      { table_name: 'vans', column_name: 'home_lon_e6', data_type: 'BIGINT' },
    ] : []),
  });
  const data = createData({ profile: MD_PROFILE(), token: TOKEN, connect: fake.create });
  t.after(() => data.close());
  await assert.rejects(data.travelMatrix(['site:s1'], ['site:s2']), refused('routing.coordinates.nodes[0].lat_column', 'not_coordinate_column'));
  const statements = fake.state.instances.flatMap((i) => i.connections.flatMap((c) => c.statements));
  assert.ok(statements.includes(travel.COLUMN_TYPES_SQL));
  assert.ok(!statements.some((s) => s.includes('string_split')), 'the matrix query never reached DuckDB');
});

test('MotherDuck: travelMatrix shares the 30 s query limit (interrupted at the limit, fixed-text fault)', async (t) => {
  const fake = createFakeMotherDuck({ hangQueries: true });
  const data = createData({ profile: MD_PROFILE(), token: TOKEN, connect: fake.create, queryTimeoutMs: 20 });
  t.after(() => data.close());
  await data.open();
  await assert.rejects(data.travelMatrix(['site:s1'], ['site:s2']), refused('travelMatrix', 'data_unavailable'));
  assert.equal(fake.state.instances[0].connections[1].interrupted, 1, 'the shared timer interrupted the query');
});

test('RoutingFault words for travelMatrix name the field and never the value', () => {
  for (const problem of ['routing_off', 'too_many_pairs', 'not_coordinate_column', 'no_position', 'data_unavailable', 'query_refused', 'query_failed']) {
    const words = messageFor(new RoutingFault({ field: 'travelMatrix', problem }), { admin: 'Sam' });
    assert.match(words, /travelMatrix/, problem);
    assert.match(words, /please tell Sam/, problem);
  }
});

// --- The SDK -------------------------------------------------------------------

test('the sdk exports travelMatrix and the routing engine; travelMatrix reads only through the data object\'s own', async (t) => {
  assert.equal(sdk.routing, routingEngine);
  assert.equal(typeof sdk.routing.validateInput, 'function');
  assert.equal(sdk.RoutingFault, RoutingFault);
  const data = await source(t);
  assert.deepEqual(await sdk.travelMatrix(data, ['site:s1'], ['site:s1']), [{ from_node: 'site:s1', to_node: 'site:s1', minutes: 5 }]);
  for (const bad of [null, {}, { run: async () => [] }]) {
    await assert.rejects(sdk.travelMatrix(bad, ['site:s1'], ['site:s2']), refused('travelMatrix', 'data_unavailable'));
  }
});
