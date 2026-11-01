'use strict';

// Story 19.6 (plan brightside-v1, D11): the verify check query-rule:<id>
// (kit/query-rules/cli.js --check) against real DuckDB, and the
// `npm run query-rules` commands. Each test builds the minimal fixture in
// test/fixtures/fixture-build/mini (regions, shops with a forbidden
// postal_code, fixture_meta) into its own temporary folder, beside a made-up
// profile, data.md and allow-list. Never a client's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { build } = require('../../kit/fixture/build');
const { main, parseArgs } = require('../../kit/query-rules/cli');
const { queryRuleChecksFor } = require('../../kit/lib/query-rules');
const { createAskQueue } = require('../../kit/runtime/knowledge/ask-queue');

const MINI = path.join(__dirname, '..', 'fixtures', 'fixture-build', 'mini');
const PROFILE = [
  'schema_version: 1',
  'client: { id: mini, name: Mini }',
  'users:',
  '  - { id: solo, name: Solo, role: admin }',
  'sql:',
  '  forbidden_columns: [shops.postal_code]',
  '',
].join('\n');
// closed_on and postal_code are in the data but not allowed.
const ALLOW = {
  tables: {
    regions: ['region_id', 'name'],
    shops: ['shop_id', 'region_id', 'opened_on', 'revenue_cents'],
    fixture_meta: ['key', 'value'],
  },
};
const TRUTHS = [
  '## Known truths', '',
  '```truth', 'id: vale-revenue', 'statement: Vale shops earned 125000 cents.', 'run: [node, -e, "console.log(125000)"]',
  'expect: 125000', 'owner: Ada Owner', 'signed_off: 2026-10-01', '```', '',
  '```truth', 'id: shop-count', 'statement: 3 shops.', 'run: [node, -e, "console.log(3)"]',
  'expect: 3', 'owner: Ada Owner', 'signed_off: 2026-10-01', '```', '',
  '```truth', 'id: unsigned-count', 'statement: 3 shops, unsigned.', 'run: [node, -e, "console.log(3)"]',
  'expect: 3', 'owner: Ada Owner', 'signed_off: pending', '```', '',
].join('\n');

function rule(over = {}) {
  const base = {
    id: 'QR-001',
    kind: 'metric',
    metric: 'MET-001',
    question_patterns: ['revenue of a region'],
    definition: 'Revenue of the shops in a region.',
    sql: 'SELECT SUM(s.revenue_cents) AS cents FROM shops s WHERE s.region_id = $region',
    params: { region: { type: 'zone' } },
    grain: 'one row, one number',
    unit: 'cents',
    reads: { shops: ['revenue_cents', 'region_id'] },
    check: { truth: 'vale-revenue', params: { region: 'vale' } },
    owner: 'Ada Owner',
    status: 'approved',
    signed_off: '2026-10-31',
    signed_off_by: 'Ada Owner',
  };
  return { ...base, ...over };
}
const block = (data) => `\`\`\`query-rule\n${YAML.stringify(data)}\`\`\`\n`;

let DB = null;
test.before(async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-qr-db-')));
  DB = path.join(dir, 'mini.duckdb');
  await build({ fixtureDir: MINI, out: DB });
});
test.after(() => { if (DB) fs.rmSync(path.dirname(DB), { recursive: true, force: true }); });

// A governed folder: profile.yml, context/data.md with the truths and the given
// rules, and context/ask-tables.yml (unless allow is null).
function repo(t, rules, { allow = ALLOW } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-qr-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'context'));
  fs.writeFileSync(path.join(root, 'profile.yml'), PROFILE);
  fs.writeFileSync(path.join(root, 'context', 'data.md'), `# Data\n\n${TRUTHS}\n## Query rules\n\n${rules.map(block).join('\n')}`);
  if (allow) fs.writeFileSync(path.join(root, 'context', 'ask-tables.yml'), YAML.stringify(allow));
  const env = {
    APLABS_GOVERNING_PROFILE: path.join(root, 'profile.yml'), APLABS_DATA_PATH: DB, APLABS_VAR_DIR: path.join(root, 'var'),
  };
  return { root, env };
}

async function run(t, argv, rules, opts) {
  const { root, env } = repo(t, rules, opts);
  const out = [];
  const err = [];
  const code = await main(argv, {
    env: { ...env, ...((opts && opts.env) || {}) }, cwd: root, out: (l) => out.push(l), err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), root, env };
}
const check = (t, rules, id = 'QR-001', opts) => run(t, ['--check', id], rules, opts);

// --- passes ----------------------------------------------------------------------------

test('a rule passes when its reviewed SQL, run with check.params, gives the signed truth\'s figure', async (t) => {
  const r = await check(t, [rule()]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, 'PASS query-rule:QR-001: 125000 matches truth vale-revenue (125000 ± 0)');
});

test('a rule with CTEs, joins and a stated figure passes; rows and sum check a breakdown', async (t) => {
  const sql = [
    "WITH meta AS (SELECT CAST(m.value AS DATE) AS as_of FROM fixture_meta m WHERE m.key = 'as_of')",
    'SELECT r.region_id, r.name AS region, COUNT(s.shop_id) AS shops',
    'FROM shops s JOIN regions r ON r.region_id = s.region_id CROSS JOIN meta',
    'WHERE s.opened_on <= meta.as_of',
    'GROUP BY r.region_id, r.name ORDER BY r.region_id',
  ].join('\n');
  const breakdown = rule({
    sql,
    params: {},
    unit: 'count',
    reads: { fixture_meta: ['key', 'value'], shops: ['shop_id', 'region_id', 'opened_on'], regions: ['region_id', 'name'] },
    check: { truth: 'shop-count', params: {}, rows: 2, sum: 'shops' },
  });
  const r = await run(t, ['--check', 'QR-001', '--rows'], [breakdown]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^PASS query-rule:QR-001: 3 matches truth shop-count/);
  assert.match(r.out, /\{"region_id":"hill","region":"Hill","shops":"1"\}/);
  const wrongRows = await check(t, [{ ...breakdown, check: { ...breakdown.check, rows: 3 } }]);
  assert.equal(wrongRows.code, 1);
  assert.match(wrongRows.out, /expected 3 rows, got 2/);
});

test('the traps entry passes on its own: it has no SQL', async (t) => {
  const r = await check(t, [{
    id: 'QR-000', kind: 'traps', traps: ['a trap'], owner: 'Ada Owner', status: 'approved', signed_off: '2026-10-31', signed_off_by: 'Ada Owner',
  }], 'QR-000');
  assert.equal(r.code, 0);
  assert.match(r.out, /PASS query-rule:QR-000: traps entry with 1 traps/);
});

// --- fails --------------------------------------------------------------------------------

test('a rule linked to a pending truth fails, whatever its figure', async (t) => {
  const r = await check(t, [rule({ sql: 'SELECT COUNT(s.shop_id) AS n FROM shops s', params: {}, reads: { shops: ['shop_id'] }, check: { truth: 'unsigned-count', params: {} } })]);
  assert.equal(r.code, 1);
  assert.match(r.out, /the linked truth unsigned-count is not signed off/);
});

test('a wrong figure fails, naming both numbers', async (t) => {
  const r = await check(t, [rule({ check: { expect: 1250, params: { region: 'vale' } } })]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL query-rule:QR-001: 125000, but its stated figure expects 1250/);
});

test('a rule whose reads go outside the allow-list fails, naming the column', async (t) => {
  const r = await check(t, [rule({ reads: { shops: ['revenue_cents', 'region_id', 'closed_on'] } })]);
  assert.equal(r.code, 1);
  assert.match(r.out, /reads shops\.closed_on, which the allow-list does not allow/);
});

test('SQL that reads a column its reads leave out fails, qualified or bare, even behind an alias', async (t) => {
  const cases = [
    'SELECT SUM(s.revenue_cents) AS cents FROM shops s WHERE s.region_id = $region AND s.closed_on IS NULL',
    'SELECT SUM(revenue_cents) AS cents FROM shops WHERE region_id = $region AND closed_on IS NULL',
    'SELECT SUM(revenue_cents) AS closed_on FROM shops WHERE region_id = $region AND closed_on IS NULL',
    'SELECT SUM(x.revenue_cents) AS cents FROM (SELECT s.revenue_cents, s.closed_on FROM shops s WHERE s.region_id = $region) x',
  ];
  for (const sql of cases) {
    const r = await check(t, [rule({ sql })]);
    assert.equal(r.code, 1, sql);
    assert.match(r.out, /the SQL reads (shops\.)?closed_on, which reads does not list/, sql);
  }
});

test('SQL that reads a table its reads leave out fails', async (t) => {
  const sql = 'SELECT SUM(s.revenue_cents) AS cents FROM shops s JOIN regions r ON r.region_id = s.region_id WHERE r.region_id = $region';
  const r = await check(t, [rule({ sql })]);
  assert.equal(r.code, 1);
  assert.match(r.out, /the SQL reads table regions, which reads does not list/);
  const extra = await check(t, [rule({ reads: { shops: ['revenue_cents', 'region_id'], regions: ['region_id'] } })]);
  assert.equal(extra.code, 1);
  assert.match(extra.out, /reads lists regions, which the SQL does not read/);
});

test('a CTE named like a data table, a qualified table and a wildcard each fail', async (t) => {
  const cases = [
    ['WITH regions AS (SELECT s.revenue_cents FROM shops s WHERE s.region_id = $region) SELECT SUM(regions.revenue_cents) AS cents FROM regions', /regions is a data table/],
    ['SELECT SUM(s.revenue_cents) AS cents FROM main.shops s WHERE s.region_id = $region', /a qualified table name/],
    ['SELECT SUM(s.revenue_cents) AS cents FROM (SELECT * FROM shops WHERE region_id = $region) s', /wildcard|selects every column/],
  ];
  for (const [sql, want] of cases) {
    const r = await check(t, [rule({ sql })]);
    assert.equal(r.code, 1, sql);
    assert.match(r.out, want, sql);
  }
});

test('the profile\'s forbidden columns still apply, even when the allow-list and reads name one', async (t) => {
  const allow = { tables: { ...ALLOW.tables, shops: [...ALLOW.tables.shops, 'postal_code'] } };
  const sql = 'SELECT COUNT(s.shop_id) AS n FROM shops s WHERE s.postal_code = $code';
  const r = await check(t, [rule({
    sql, params: { code: { type: 'enum', values: ['10001'] } }, reads: { shops: ['shop_id', 'postal_code'] }, check: { expect: 1, params: { code: '10001' } },
  })], 'QR-001', { allow });
  assert.equal(r.code, 1);
  assert.match(r.out, /forbidden_column/);
});

test('no allow-list, no built data, a malformed or missing rule: each fails closed', async (t) => {
  const none = await check(t, [rule()], 'QR-001', { allow: null });
  assert.equal(none.code, 1);
  assert.match(none.out, /no allow-list/);
  const noData = await check(t, [rule()], 'QR-001', { env: { APLABS_DATA_PATH: path.join(os.tmpdir(), 'aplabs-no-such.duckdb') } });
  assert.equal(noData.code, 1);
  assert.match(noData.out, /fixture:build/);
  const bad = await check(t, [rule({ unit: 'dollars' })]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /unit must be one of/);
  const missing = await check(t, [rule()], 'QR-009');
  assert.equal(missing.code, 1);
  assert.match(missing.out, /no such rule/);
});

// --- verify and --status -------------------------------------------------------------------

test('verify runs every rule that is not retired as query-rule:<id>', (t) => {
  const { root } = repo(t, [rule(), rule({ id: 'QR-002', status: 'retired' }), rule({ id: 'QR-003', unit: 'x' })]);
  const checks = queryRuleChecksFor(path.join(root, 'profile.yml'));
  assert.deepEqual(checks.map((c) => c.id), ['query-rule:QR-001', 'query-rule:QR-003']);
  assert.deepEqual(checks[0].run, ['node', 'kit/query-rules/cli.js', '--check', 'QR-001']);
  assert.ok(checks[1].problem);
});

test('--status lists each rule, its sign-off and that it was not checked on this machine', async (t) => {
  const r = await run(t, ['--status'], [rule(), rule({ id: 'QR-002', status: 'draft', signed_off: 'pending', signed_off_by: 'pending' })]);
  assert.equal(r.code, 0);
  assert.match(r.out, /QR-001 {2}metric {2}approved {2}signed 2026-10-31 by Ada Owner {2}not checked on this machine/);
  assert.match(r.out, /QR-002 {2}metric {2}draft {2}not signed/);
});

// --- the review queue commands ---------------------------------------------------------------

const silent = { info() {}, warn() {}, error() {} };

test('--queue lists the waiting questions; --new drafts a rule from one; --done clears it', async (t) => {
  const { root, env } = repo(t, [rule()]);
  const queue = createAskQueue({ clientId: 'mini', varDir: env.APLABS_VAR_DIR, log: silent });
  const entry = await queue.add({ hub: 'mini-v1', reason: 'no_rule', question: 'Which region has the most shops?' });
  const io = () => {
    const lines = [];
    return { lines, opts: { env, cwd: root, out: (l) => lines.push(l), err: (l) => lines.push(l) } };
  };
  let c = io();
  assert.equal(await main(['--queue'], c.opts), 0);
  assert.match(c.lines.join('\n'), new RegExp(`${entry.id} {2}\\d{4}-\\d{2}-\\d{2} {2}mini-v1 {2}no_rule {2}Which region has the most shops\\?`));

  c = io();
  assert.equal(await main(['--new', 'QR-002', '--from', entry.id], c.opts), 0);
  const text = fs.readFileSync(path.join(root, 'context', 'data.md'), 'utf8');
  assert.match(text, /id: QR-002[\s\S]*Which region has the most shops\?[\s\S]*status: draft/);
  c = io();
  assert.equal(await main(['--new', 'QR-002', '--from', entry.id], c.opts), 1, 'an id already used is refused');
  assert.match(c.lines.join('\n'), /already in data.md/);

  c = io();
  assert.equal(await main(['--done', entry.id], c.opts), 0);
  assert.deepEqual(await queue.list(), []);
  c = io();
  assert.equal(await main(['--done', entry.id], c.opts), 1);
  c = io();
  assert.equal(await main(['--queue'], c.opts), 0);
  assert.match(c.lines.join('\n'), /The review queue is empty/);
});

test('usage: one command, ids in their shapes', () => {
  assert.ok(parseArgs([]).error);
  assert.ok(parseArgs(['--status', '--queue']).error);
  assert.ok(parseArgs(['--check', 'QR-1']).error);
  assert.ok(parseArgs(['--new', 'QR-001']).error, '--new needs --from');
  assert.ok(parseArgs(['--done', 'nope']).error);
  assert.ok(parseArgs(['--status', '--rows']).error);
  assert.deepEqual(parseArgs(['--check', 'QR-001', '--rows']), {
    cmd: 'check', id: 'QR-001', from: null, rows: true,
  });
});
