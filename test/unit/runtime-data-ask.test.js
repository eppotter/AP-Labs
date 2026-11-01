'use strict';

// Ask's connection and the DuckDB-parse check (plan brightside-v1, D10, Story
// 19.7): kit/runtime/data/ask and kit/runtime/sql/ask. Real DuckDB on a build
// of test/fixtures/ask-guard (a made-up client, never a client's), plus a fake
// instance where a test needs to see or hold a call (streaming, the interrupt,
// a concurrent query, an error's text). The clock is frozen with mock.timers
// wherever the 10-second limit matters.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../kit/fixture/build');
const { validateProfile } = require('../../kit/lib/profile');
const { createData, openLocked } = require('../../kit/runtime/data');
const {
  createAskData, AskConfigError, PARSE_SQL, COLUMNS_SQL, ASK_SETTINGS,
} = require('../../kit/runtime/data/ask');
const { checkParsed, askTablesProblems, askForbiddenColumns } = require('../../kit/runtime/sql/ask');
const { RULES } = require('../../kit/runtime/sql');
const { AskQueryRefused } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');

const FIXTURE = path.join(__dirname, '../fixtures/ask-guard');
const TABLES = {
  zones: ['zone_id', 'name'],
  clients: ['client_id', 'zone_id', 'created_on'],
  properties: ['property_id', 'client_id', 'city'],
  visits: ['visit_id', 'property_id', 'visit_date', 'status'],
  fixture_meta: ['key', 'value'],
};

function profileWith(tables = TABLES, over = {}) {
  return validateProfile({
    schema_version: 1,
    client: { id: 'askguard', name: 'Ask Guard' },
    resources: [{ key: 'ASK_DATA', label: 'Ask data', admin_grantable: false }],
    users: [{ id: 'ada', name: 'Ada Admin', role: 'admin', grants: ['ASK_DATA'] }],
    sql: { forbidden_columns: ['properties.street_address'] },
    ask: { tables },
    ...over,
  });
}

let DIR = null;
let DB = null;
let DB2 = null; // the same data with a column added (a republish)
test.before(async () => {
  DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-ask-')));
  DB = path.join(DIR, 'v1.duckdb');
  await build({ fixtureDir: FIXTURE, out: DB });
  const v2 = path.join(DIR, 'v2');
  fs.cpSync(FIXTURE, v2, { recursive: true });
  const schema = fs.readFileSync(path.join(v2, 'schema.sql'), 'utf8');
  fs.writeFileSync(path.join(v2, 'schema.sql'), schema.replace('labour_minutes INTEGER NOT NULL\n', 'labour_minutes INTEGER NOT NULL,\n  crew_note VARCHAR NOT NULL\n'));
  const seeds = fs.readFileSync(path.join(v2, 'seeds/visits.csv'), 'utf8').trim().split('\n');
  fs.writeFileSync(path.join(v2, 'seeds/visits.csv'), `${seeds.map((l, i) => `${l},${i ? 'note' : 'crew_note'}`).join('\n')}\n`);
  DB2 = path.join(DIR, 'v2.duckdb');
  await build({ fixtureDir: v2, out: DB2 });
});
test.after(() => { if (DIR) fs.rmSync(DIR, { recursive: true, force: true }); });

// DuckDB's parse and the data's columns, through the tools' runner: the
// tokenizer never sees these SQL texts, so checkParsed is tested alone.
async function parsedOf(file, sqls) {
  const data = createData({ file, profile: profileWith() });
  try {
    const columns = new Map();
    for (const r of await data.run(COLUMNS_SQL)) {
      if (!columns.has(r.table_name)) columns.set(r.table_name, new Set());
      columns.get(r.table_name).add(r.column_name);
    }
    const out = [];
    for (const sql of sqls) {
      const [{ parsed }] = await data.run(PARSE_SQL, { sql }, { declared: ['sql'] });
      out.push(JSON.parse(parsed));
    }
    return { columns, parsed: out };
  } finally {
    data.close();
  }
}

const logger = () => {
  const entries = [];
  const at = (level) => (msg, fields = {}) => entries.push({ level, msg, ...fields });
  return { entries, log: { info: at('info'), warn: at('warn'), error: at('error') } };
};

// --- the DuckDB-parse check, alone ---------------------------------------------------------

test('the parse check alone refuses every refusal the tokenizer makes (the tokenizer bypassed)', async () => {
  const cases = [
    ['SELECT c.column_name FROM information_schema.columns c', RULES.TABLE_NOT_ALLOWED],
    ['SELECT t.table_name FROM duckdb_tables() t', RULES.TABLE_FUNCTION],
    ['SELECT COUNT(*) AS n FROM main.staff', RULES.TABLE_NOT_ALLOWED],
    ['SELECT COUNT(*) AS n FROM "staff"', RULES.TABLE_NOT_ALLOWED],
    ['SELECT s.n FROM (SELECT COUNT(*) AS n FROM staff) s', RULES.TABLE_NOT_ALLOWED],
    ['SELECT c.client_id FROM clients c JOIN pay_rates p ON p.staff_id = c.client_id', RULES.TABLE_NOT_ALLOWED],
    ['SELECT (SELECT x.y FROM (WITH staff AS (SELECT 1 AS y) SELECT staff.y FROM staff) x) AS v FROM staff', RULES.CTE_NOT_TOP_LEVEL],
    ['SELECT (SELECT x.y FROM (WITH staff AS (SELECT 1 AS y) SELECT staff.y FROM staff) x) AS v FROM zones', RULES.CTE_NOT_TOP_LEVEL],
    ['WITH clients AS (SELECT z.zone_id FROM zones z) SELECT clients.zone_id FROM clients', RULES.CTE_SHADOWS_TABLE],
    ['WITH staff AS (SELECT z.zone_id FROM zones z) SELECT staff.zone_id FROM staff', RULES.CTE_SHADOWS_TABLE],
    ['SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date <= current_date', RULES.CLOCK_FUNCTION],
    ['SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date <= now()', RULES.CLOCK_FUNCTION],
    ['SELECT 815', RULES.NO_ALLOWED_TABLE],
    ['SELECT c.email FROM clients c', RULES.COLUMN_NOT_ALLOWED],
    ['SELECT email FROM clients', RULES.COLUMN_NOT_ALLOWED],
    ['SELECT v.labour_minutes FROM visits v', RULES.COLUMN_NOT_ALLOWED],
    ['SELECT x.e FROM (SELECT first_name AS e FROM clients) x', RULES.COLUMN_NOT_ALLOWED],
    ['SELECT * FROM zones', RULES.WILDCARD],
    ['SELECT to_json(z) AS j FROM zones z', RULES.WHOLE_ROW],
    ['SELECT getenv(\'HOME\') AS h FROM zones z', RULES.BLOCKED_FUNCTION],
    ['SELECT z.zone_id FROM zones z; SELECT 1', RULES.MULTIPLE_STATEMENTS],
    // USING names its columns as plain strings, and NATURAL names none (PR #323 review).
    ['SELECT COUNT(a.client_id) AS n FROM clients a JOIN clients b USING (email)', RULES.COLUMN_NOT_ALLOWED],
    ['SELECT COUNT(v.visit_id) AS n FROM visits v JOIN visits w USING (visit_id, labour_minutes)', RULES.COLUMN_NOT_ALLOWED],
    ['SELECT COUNT(a.client_id) AS n FROM clients a NATURAL JOIN clients b', RULES.COLUMN_NOT_ALLOWED],
  ];
  const { columns, parsed } = await parsedOf(DB, cases.map(([sql]) => sql));
  parsed.forEach((tree, i) => {
    const v = checkParsed(tree, { allowedTables: TABLES, dataColumns: columns });
    assert.equal(v.ok, false, cases[i][0]);
    assert.equal(v.rule, cases[i][1], `${cases[i][0]}: ${v.detail}`);
  });
});

test('the parse check passes allowed queries and reports the tables read and an outer ORDER BY', async () => {
  const sqls = [
    "WITH meta AS (SELECT CAST(m.value AS DATE) AS as_of FROM fixture_meta m WHERE m.key = 'as_of') "
      + 'SELECT COUNT(v.visit_id) AS n FROM visits v, meta WHERE v.visit_date <= meta.as_of',
    'SELECT zone_id, COUNT(DISTINCT client_id) AS n FROM clients GROUP BY zone_id ORDER BY n DESC',
    'SELECT p.city FROM properties p JOIN clients c ON c.client_id = p.client_id WHERE c.zone_id = $zone',
    'SELECT COUNT(p.property_id) AS n FROM properties p JOIN clients c USING (client_id)',
    'SELECT v.visit_id, rank() OVER w AS r FROM visits v WINDOW w AS (ORDER BY v.visit_date)',
  ];
  const { columns, parsed } = await parsedOf(DB, sqls);
  const verdicts = parsed.map((tree) => checkParsed(tree, { allowedTables: TABLES, dataColumns: columns }));
  assert.deepEqual(verdicts, [
    { ok: true, tables: ['fixture_meta', 'visits'], ordered: false },
    { ok: true, tables: ['clients'], ordered: true },
    { ok: true, tables: ['clients', 'properties'], ordered: false },
    { ok: true, tables: ['clients', 'properties'], ordered: false },
    { ok: true, tables: ['visits'], ordered: false },
  ]);
});

test('an unknown parse shape refuses: a parse error, a strange node, expression or table, two statements', async () => {
  const { columns, parsed: [good] } = await parsedOf(DB, ['SELECT z.zone_id FROM zones z ORDER BY z.zone_id']);
  const opts = { allowedTables: TABLES, dataColumns: columns };
  assert.equal(checkParsed(good, opts).ok, true);
  const variant = (fn) => { const t = structuredClone(good); fn(t); return checkParsed(t, opts); };
  const bad = [
    checkParsed(null, opts),
    checkParsed({ error: true, error_message: 'Parser Error: syntax error' }, opts),
    checkParsed({ error: false }, opts),
    variant((t) => { t.statements[0].node.type = 'MYSTERY_NODE'; }),
    variant((t) => { t.statements[0].node.select_list[0].class = 'MYSTERY'; }),
    variant((t) => { t.statements[0].node.from_table.type = 'PIVOT'; }),
    variant((t) => { t.statements[0].node.modifiers[0].type = 'MYSTERY_MODIFIER'; }),
    variant((t) => { t.statements.push(t.statements[0]); }),
    variant((t) => { delete t.statements[0].node.cte_map; }),
  ];
  for (const v of bad) assert.equal(v.ok, false, JSON.stringify(v));
});

// --- boot's check ---------------------------------------------------------------------------

test('boot refuses an allowed table or column the data does not have, naming it (properties.zone_id)', async () => {
  const tables = { ...TABLES, properties: [...TABLES.properties, 'zone_id'], depots: ['depot_id'] };
  const ask = createAskData({ file: DB, profile: profileWith(tables) });
  await assert.rejects(ask.open(), (err) => {
    assert.ok(err instanceof AskConfigError);
    assert.deepEqual(err.problems, [
      'ask.tables names properties.zone_id, which the data does not have',
      'ask.tables names table depots, which the data does not have',
    ]);
    return true;
  });
  assert.equal(ask.describe().available, false);
});

test('boot refuses an allowed column whose bare name a hidden column shares, or a forbidden one', () => {
  const columns = new Map(Object.entries({
    zones: new Set(['zone_id', 'name']), clients: new Set(['client_id', 'zone_id', 'email']), properties: new Set(['property_id', 'street_address']),
  }));
  // clients.zone_id hidden while zones.zone_id is allowed.
  assert.deepEqual(askTablesProblems({ zones: ['zone_id', 'name'], clients: ['client_id'] }, columns), [
    'ask.tables allows zones.zone_id, but clients.zone_id is hidden and the guard matches column names bare, so it would refuse both',
  ]);
  // A forbidden column of a table Ask never reads still clashes by bare name.
  assert.deepEqual(askTablesProblems({ zones: ['zone_id', 'name'] }, columns, ['depots.name']), [
    'ask.tables allows zones.name, but depots.name is hidden and the guard matches column names bare, so it would refuse both',
  ]);
  assert.deepEqual(askTablesProblems({ zones: ['zone_id', 'name'], clients: ['client_id', 'zone_id'] }, columns), []);
  assert.deepEqual(askForbiddenColumns({ zones: ['zone_id', 'name'], clients: ['client_id', 'zone_id'] }, columns, ['properties.street_address']), [
    'clients.email', 'properties.street_address',
  ]);
});

// --- Ask's connection ----------------------------------------------------------------------

test('Ask runs an allowed query on the data; a hidden column, a hidden table or the clock is refused, the rule logged only', async () => {
  const { entries, log } = logger();
  const ask = createAskData({ file: DB, profile: profileWith(), log });
  try {
    const r = await ask.run('SELECT c.zone_id, COUNT(c.client_id) AS n FROM clients c GROUP BY c.zone_id ORDER BY c.zone_id;');
    assert.deepEqual(r, {
      rows: [{ zone_id: 'north', n: '1' }, { zone_id: 'south', n: '2' }], columns: ['zone_id', 'n'], tables: ['clients'], ordered: true,
    });
    for (const [sql, rule] of [
      ['SELECT c.email FROM clients c', 'forbidden_column'],
      ['SELECT s.name FROM staff s', 'table_not_allowed'],
      ['SELECT COUNT(v.visit_id) AS n FROM visits v WHERE v.visit_date < today()', 'clock_function'],
    ]) {
      await assert.rejects(ask.run(sql), (err) => err instanceof AskQueryRefused && err.reason === 'guard' && err.details.rule === rule);
    }
    assert.deepEqual(entries.map((e) => [e.msg, e.reason, e.rule]), [
      ['ask query refused', 'guard', 'forbidden_column'], ['ask query refused', 'guard', 'table_not_allowed'], ['ask query refused', 'guard', 'clock_function'],
    ]);
    assert.ok(!JSON.stringify(entries).includes('email'), 'the log holds the rule only');
  } finally {
    ask.close();
  }
});

test('at most 51 rows are read; parameters bind by name and an undeclared one is refused', async () => {
  const ask = createAskData({ file: DB, profile: profileWith() });
  try {
    const many = await ask.run('SELECT a.visit_id AS a, b.visit_id AS b, c.visit_id AS c FROM visits a, visits b, visits c');
    assert.equal(many.rows.length, 51, '64 rows in the data, 51 read');
    const one = await ask.run('SELECT COUNT(c.client_id) AS n FROM clients c WHERE c.zone_id = $zone', { zone: 'south' }, { declared: ['zone'] });
    assert.deepEqual(one.rows, [{ n: '2' }]);
    await assert.rejects(ask.run('SELECT COUNT(c.client_id) AS n FROM clients c WHERE c.zone_id = $zone', { zone: 'south' }),
      (err) => err.reason === 'guard' && err.details.rule === 'undeclared_parameter');
  } finally {
    ask.close();
  }
});

test('a column added after boot (a republish) is refused by the parse check, which reads the columns every time', async () => {
  const file = path.join(DIR, 'live.duckdb');
  fs.copyFileSync(DB, file);
  const ask = createAskData({ file, profile: profileWith() });
  try {
    await ask.open(); // boot: Ask's forbidden columns are fixed from v1
    ask.close();
    fs.copyFileSync(DB2, file); // republished with visits.crew_note
    for (const sql of [
      'SELECT v.crew_note FROM visits v',
      'SELECT crew_note FROM visits',
      // A USING column is a plain string in DuckDB's parse (PR #323 review).
      'SELECT COUNT(a.visit_id) AS n FROM visits a JOIN visits b USING (crew_note)',
    ]) {
      await assert.rejects(ask.run(sql), (err) => err.reason === 'guard' && err.details.rule === RULES.COLUMN_NOT_ALLOWED, sql);
    }
  } finally {
    ask.close();
  }
});

test('Ask\'s instance is locked, read-only, with memory_limit 512MB and 2 threads', async () => {
  assert.deepEqual(ASK_SETTINGS, { memory_limit: '512MB', threads: '2' });
  const seen = [];
  const ask = createAskData({
    file: DB, profile: profileWith(), openInstance: (f, settings) => { seen.push(settings); return openLocked(f, settings); },
  });
  await ask.open();
  ask.close();
  assert.deepEqual(seen, [ASK_SETTINGS]);
  const inst = await openLocked(DB, ASK_SETTINGS);
  const conn = await inst.connect();
  try {
    const read = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson()[0];
    const s = await read("SELECT current_setting('memory_limit') AS m, current_setting('threads') AS t, current_setting('access_mode') AS a");
    assert.deepEqual([String(s.t), s.a], ['2', 'read_only']);
    assert.match(String(s.m), /^(512\.0 MiB|488\.2 MiB|512MB)$/);
    await assert.rejects(conn.run("SET memory_limit = '4GB'"), /lock/i);
  } finally {
    conn.closeSync();
    inst.closeSync();
  }
});

test('a run that can\'t open the data, or finds ask.tables doesn\'t fit it, is refused with fixed words and a class only', async () => {
  const cases = [
    [{ file: path.join(DIR, 'missing.duckdb'), profile: profileWith() }, 'data_unavailable'],
    [{ file: DB, profile: profileWith({ ...TABLES, properties: [...TABLES.properties, 'zone_id'] }) }, 'ask_config'],
  ];
  for (const [opts, errorClass] of cases) {
    const { entries, log } = logger();
    const ask = createAskData({ ...opts, log });
    let caught;
    await assert.rejects(ask.run('SELECT COUNT(z.zone_id) AS n FROM zones z'), (err) => { caught = err; return true; });
    assert.ok(caught instanceof AskQueryRefused, errorClass);
    assert.deepEqual(caught.details, { reason: 'failed', rule: null, errorClass });
    assert.equal(messageFor(caught), "I couldn't run that query safely.");
    assert.deepEqual(entries, [{ level: 'warn', msg: 'ask query refused', reason: 'failed', errorClass }]);
    const everything = `${caught.message} ${JSON.stringify(entries)}`;
    for (const leak of ['missing.duckdb', 'does not exist', 'zone_id', DIR]) assert.ok(!everything.includes(leak), leak);
    ask.close();
  }
});

test('MotherDuck data: Ask\'s queries stay off (fail closed)', async () => {
  const ask = createAskData({ file: DB, profile: profileWith(TABLES, { data: { source: 'motherduck', database: 'askguard' } }) });
  await assert.rejects(ask.open(), (err) => err.code === 'DATA_UNAVAILABLE');
});

// --- the run, with a fake instance ---------------------------------------------------------

// A fake DuckDB instance over the real data's columns and parses: it records
// what was prepared and how it was read, and its query can be held or made to
// fail with a given error.
async function fakeInstance({ hold = false, error = null } = {}) {
  const real = await openLocked(DB, ASK_SETTINGS);
  const calls = { prepared: [], read: [], interrupts: 0, closed: 0 };
  let release = null;
  const inst = {
    async connect() {
      const conn = await real.connect();
      return {
        runAndReadAll: (sql, params) => conn.runAndReadAll(sql, params),
        async prepare(text) {
          calls.prepared.push(text);
          if (error) throw error;
          return {
            parameterCount: 0,
            async runAndReadAll() { calls.read.push('all'); throw new Error('never read whole'); },
            streamAndReadUntil(n) {
              calls.read.push(`stream ${n}`);
              if (!hold) return Promise.resolve({ getRowObjectsJson: () => [{ n: 1 }], columnNames: () => ['n'], closeSync() {} });
              return new Promise((resolve, reject) => { release = { resolve, reject }; });
            },
          };
        },
        interrupt() { calls.interrupts += 1; if (release) release.reject(new Error('INTERRUPT Error: Interrupted!')); },
        closeSync() { calls.closed += 1; conn.closeSync(); },
      };
    },
    closeSync() { real.closeSync(); },
  };
  return { inst, calls, release: () => release };
}

test('the checked SQL is prepared as it is, trailing ; stripped, and streamed: never wrapped, never read whole', async () => {
  const fake = await fakeInstance();
  const ask = createAskData({ file: DB, profile: profileWith(), openInstance: async () => fake.inst });
  try {
    await ask.run('SELECT COUNT(z.zone_id) AS n FROM zones z ;  -- end');
    assert.deepEqual(fake.calls.prepared, ['SELECT COUNT(z.zone_id) AS n FROM zones z']);
    assert.deepEqual(fake.calls.read, ['stream 51']);
  } finally {
    ask.close();
  }
});

test('a query past 10 seconds is interrupted and refused at once; another waits until it stops (frozen clock)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = await fakeInstance({ hold: true });
  const ask = createAskData({ file: DB, profile: profileWith(), openInstance: async () => fake.inst });
  try {
    const first = ask.run('SELECT COUNT(z.zone_id) AS n FROM zones z');
    while (!fake.release()) await new Promise((r) => setImmediate(r));
    // A second query while the first runs is refused, never queued (architect P3-14).
    await assert.rejects(ask.run('SELECT COUNT(z.zone_id) AS n FROM zones z'), (err) => err.reason === 'busy');
    t.mock.timers.tick(9999);
    assert.equal(fake.calls.interrupts, 0);
    t.mock.timers.tick(1);
    await assert.rejects(first, (err) => err instanceof AskQueryRefused && err.reason === 'timeout');
    assert.equal(fake.calls.interrupts, 1);
    assert.equal(messageFor(new AskQueryRefused('timeout')), 'That question took too long to answer; narrow it.');
    assert.equal(messageFor(new AskQueryRefused('busy')), 'Another question is being answered. Try again in a moment.');
  } finally {
    ask.close();
  }
});

test('DuckDB\'s error text never reaches the person or the log: fixed words, the error class only', async () => {
  const secret = new Error('Binder Error: Referenced column "first_name" not found; candidate bindings: "clients.first_name" = Ada');
  const fake = await fakeInstance({ error: secret });
  const { entries, log } = logger();
  const ask = createAskData({
    file: DB, profile: profileWith(), log, openInstance: async () => fake.inst,
  });
  try {
    let caught;
    await assert.rejects(ask.run('SELECT COUNT(z.zone_id) AS n FROM zones z'), (err) => { caught = err; return true; });
    assert.ok(caught instanceof AskQueryRefused);
    assert.deepEqual(caught.details, { reason: 'failed', rule: null, errorClass: 'binder' });
    const words = messageFor(caught);
    assert.equal(words, "I couldn't run that query safely.");
    const everything = `${caught.message} ${JSON.stringify(caught.details)} ${words} ${JSON.stringify(entries)}`;
    for (const leak of ['first_name', 'Ada', 'Referenced']) assert.ok(!everything.includes(leak), leak);
    assert.deepEqual(entries, [{ level: 'warn', msg: 'ask query refused', reason: 'failed', errorClass: 'binder' }]);
  } finally {
    ask.close();
  }
});
