'use strict';

// Story 7.6: kit/fixture/validate runs a fixture's checks/*.sql through the
// query runner, and kit/fixture/query is the bridge a known truth's `run`
// uses. Engine tests: they read test/fixtures/fixture-validate (checks, truths
// and a profile) over the minimal fixture in test/fixtures/fixture-build/mini,
// never a client's. Each builds into its own temporary directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

try {
  require.resolve('@duckdb/node-api');
} catch {
  throw new Error('fixture-validate tests: @duckdb/node-api is not installed. Run npm ci in this worktree, then rerun npm test.');
}

const { build, isFixtureBuild } = require('../../kit/fixture/build');
const { readHeader, loadChecks, validate, parseArgs } = require('../../kit/fixture/validate');
const query = require('../../kit/fixture/query');

const REPO = path.join(__dirname, '..', '..');
const MINI = path.join(__dirname, '..', 'fixtures', 'fixture-build', 'mini');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'fixture-validate');
const PROFILE = path.join(FIXTURE, 'profile.yml');
const VALIDATE = path.join(REPO, 'kit', 'fixture', 'validate.js');
const QUERY = path.join(REPO, 'kit', 'fixture', 'query.js');
const VERIFY = path.join(REPO, 'kit', 'verify', 'run-all.js');
const node = process.execPath;

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-fixture-validate-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function builtDb(t) {
  const out = path.join(tmpDir(t), 'mini.duckdb');
  await build({ fixtureDir: MINI, out });
  return out;
}

// A writable copy of the fixture's checks, for tests that add or break one.
function checksCopy(t, extra = {}) {
  const dir = path.join(tmpDir(t), 'fixture');
  fs.cpSync(path.join(FIXTURE, 'checks'), path.join(dir, 'checks'), { recursive: true });
  for (const [name, sql] of Object.entries(extra)) fs.writeFileSync(path.join(dir, 'checks', name), sql);
  return dir;
}

const cli = (file, args, env = {}, cwd = REPO) => spawnSync(node, [file, ...args], {
  cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
});

test('readHeader: the first comment line is the description; protected-columns lines list columns', () => {
  assert.deepEqual(readHeader('-- Every shop has a region.\n-- protected-columns: Shops.Postal_Code, a.b\n-- more\nSELECT 1'), {
    description: 'Every shop has a region.', protectedColumns: ['shops.postal_code', 'a.b'],
  });
  // Only the leading comment block counts: a directive after the SQL starts is ignored.
  assert.deepEqual(readHeader('SELECT 1\n-- protected-columns: a.b'), { description: '', protectedColumns: [] });
});

test('parseArgs: needs a fixture dir; --db and --name take values', () => {
  assert.deepEqual(parseArgs(['f', '--db', 'x.duckdb']), { fixtureDir: 'f', db: 'x.duckdb', name: null, profile: null });
  assert.match(parseArgs([]).error, /missing <fixture-dir>/);
  assert.match(parseArgs(['f', '--db']).error, /--db needs a value/);
  assert.match(parseArgs(['f', '--nope']).error, /unknown option/);
});

test('CLI: every check passes on a good build, run in name order, with the profile\'s forbidden columns', async (t) => {
  const db = await builtDb(t);
  const r = cli(VALIDATE, [FIXTURE, '--db', db], { APLABS_PROFILE: PROFILE });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').slice(0, 3), [
    'PASS shops-closed-after-opened', 'PASS shops-postal-code-digits', 'PASS shops-region-resolves',
  ]);
  assert.match(r.stdout, /: 3 checks, 3 passed, 0 failed$/m);
});

test('a check that returns rows fails with its row count and description, never the rows\' values', async (t) => {
  const db = await builtDb(t);
  const dir = checksCopy(t, {
    'zz-leaky.sql': '-- No postal code starts with 0.\n-- protected-columns: shops.postal_code\nSELECT shop_id, postal_code FROM shops WHERE postal_code LIKE \'0%\'\n',
  });
  const r = cli(VALIDATE, [dir, '--db', db], { APLABS_PROFILE: PROFILE });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL zz-leaky: 2 rows \(No postal code starts with 0\.\)$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /00402|00013/);
  assert.match(r.stdout, /: 4 checks, 3 passed, 1 failed$/m);
});

test('a forbidden column is refused unless the check declares it; the declaration lifts it for that check only', async (t) => {
  const db = await builtDb(t);
  const checks = loadChecks(checksCopy(t, {
    'undeclared.sql': '-- Names postal_code without declaring it.\nSELECT shop_id FROM shops WHERE postal_code = \'x\'\n',
  }));
  const results = await validate({ checks, db, forbiddenColumns: ['shops.postal_code'] });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId['shops-postal-code-digits'].outcome, 'pass');
  assert.equal(byId.undeclared.outcome, 'fail');
  assert.match(byId.undeclared.error, /query refused \(forbidden_column\)/);
  // With no profile there is nothing to lift: every check runs.
  const open = await validate({ checks, db, forbiddenColumns: [] });
  assert.ok(open.every((r) => r.outcome === 'pass'), JSON.stringify(open));
});

// Issue #77 item 2: DuckDB quotes the value it failed on ("Could not convert
// string '00402x'"), so a check that lifted a protected column shows only the
// error's class, never the message.
test('a check that lifted a protected column and errors shows only the error class, never the value', async (t) => {
  const db = await builtDb(t);
  const dir = checksCopy(t, {
    'zz-cast.sql': "-- Postal codes cast to numbers.\n-- protected-columns: shops.postal_code\nSELECT shop_id FROM shops WHERE CAST(postal_code || 'x' AS INTEGER) > 0\n",
  });
  const results = await validate({ checks: loadChecks(dir), db, forbiddenColumns: ['shops.postal_code'] });
  const cast = results.find((r) => r.id === 'zz-cast');
  assert.equal(cast.outcome, 'fail');
  assert.equal(cast.error, 'Conversion Error (message withheld: the check reads a protected column)');
  assert.doesNotMatch(JSON.stringify(results), /00402|00013|x'/);
  // A check that lifted nothing keeps DuckDB's first line: it can name no protected value.
  const plain = await validate({ checks: loadChecks(checksCopy(t, { 'zz-bad.sql': '-- Bad.\nSELECT nope FROM shops\n' })), db, forbiddenColumns: ['shops.postal_code'] });
  assert.match(plain.find((r) => r.id === 'zz-bad').error, /Binder Error: .*nope/);
});

// Issue #77 item 3: --db can point at any file, real data included, so a
// check may lift a protected column only on a file fixture:build wrote. The
// exception is for synthetic data only.
test('a check that lifts a protected column runs only on the fixture:build output; other checks still run', async (t) => {
  const real = path.join(tmpDir(t), 'real.duckdb');
  await build({ fixtureDir: MINI, out: real, stamp: false });
  assert.equal(await isFixtureBuild(real), false);
  assert.equal(await isFixtureBuild(await builtDb(t)), true);
  const results = await validate({ checks: loadChecks(FIXTURE), db: real, forbiddenColumns: ['shops.postal_code'] });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId['shops-postal-code-digits'].outcome, 'fail');
  assert.equal(byId['shops-postal-code-digits'].error, 'refused: protected-columns runs only on the npm run fixture:build output (the exception is for synthetic data only)');
  assert.equal(byId['shops-region-resolves'].outcome, 'pass');
  // With nothing forbidden there is nothing to lift, so nothing is refused.
  const open = await validate({ checks: loadChecks(FIXTURE), db: real, forbiddenColumns: [] });
  assert.ok(open.every((r) => r.outcome === 'pass'), JSON.stringify(open));
  const r = cli(VALIDATE, [FIXTURE, '--db', real], { APLABS_PROFILE: PROFILE });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL shops-postal-code-digits: could not run: refused: protected-columns runs only on the npm run fixture:build output/m);
  // A file that is not a DuckDB database at all is not a build either.
  const junk = path.join(tmpDir(t), 'junk.duckdb');
  fs.writeFileSync(junk, 'not a database');
  assert.equal(await isFixtureBuild(junk), false);
});

test('a check that is not a read-only query fails as could not run', async (t) => {
  const db = await builtDb(t);
  const dir = checksCopy(t, { 'writes.sql': "-- Tries to write.\nDELETE FROM shops WHERE shop_id = 1\n" });
  const r = cli(VALIDATE, [dir, '--db', db], { APLABS_PROFILE: PROFILE });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL writes: could not run: query refused/m);
});

test('no built fixture fails plainly, naming the fix; no checks fails too; usage is exit 2', async (t) => {
  const dir = tmpDir(t);
  let r = cli(VALIDATE, [FIXTURE, '--db', path.join(dir, 'missing.duckdb')], { APLABS_PROFILE: PROFILE });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no built fixture at .*missing\.duckdb\. Run npm run fixture:build first\./);
  // The default file is the one fixture:build writes, under APLABS_VAR_DIR.
  r = cli(VALIDATE, [FIXTURE, '--name', 'mini'], { APLABS_PROFILE: PROFILE, APLABS_VAR_DIR: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fixture[/\\]mini\.duckdb\. Run npm run fixture:build first\./);

  const db = await builtDb(t);
  fs.mkdirSync(path.join(dir, 'empty'));
  r = cli(VALIDATE, [path.join(dir, 'empty'), '--db', db], { APLABS_PROFILE: PROFILE });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no checks\/\*\.sql/);

  assert.equal(cli(VALIDATE, []).status, 2);
});

// Issue #77 item 1: no profile means no forbidden columns are known, so the
// validator refuses to run rather than run every check unguarded.
test('no profile fails closed with exit 2, like query, and runs no check', async (t) => {
  const db = await builtDb(t);
  const r = cli(VALIDATE, [FIXTURE, '--db', db], {}, tmpDir(t));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /fixture:validate: no profile \(pass --profile, set APLABS_PROFILE or add \.aplabs\/profile\.yml\)/);
  assert.doesNotMatch(r.stdout, /PASS|FAIL/);
});

// --- kit/fixture/query: the truth bridge ---

test('query: prints the single value of a one-row, one-column query', async (t) => {
  const db = await builtDb(t);
  const env = { APLABS_PROFILE: PROFILE, APLABS_DATA_PATH: db };
  let r = cli(QUERY, [path.join(FIXTURE, 'truths', 'open-shops.sql')], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '2\n');
  // BIGINT cents arrive as text and print whole.
  r = cli(QUERY, [path.join(FIXTURE, 'truths', 'revenue.sql')], env);
  assert.equal(r.stdout, '125000\n');
});

test('query: more than one row or column, NULL, a refused query or a forbidden column fails with exit 1', async (t) => {
  const db = await builtDb(t);
  const dir = tmpDir(t);
  const env = { APLABS_PROFILE: PROFILE, APLABS_DATA_PATH: db };
  const run = (name, sql) => {
    fs.writeFileSync(path.join(dir, name), sql);
    return cli(QUERY, [path.join(dir, name)], env);
  };
  assert.match(run('rows.sql', 'SELECT shop_id FROM shops').stderr, /expected 1 row, got 3/);
  assert.match(run('cols.sql', 'SELECT 1 AS a, 2 AS b').stderr, /expected 1 column, got 2/);
  assert.match(run('null.sql', "SELECT MAX(shop_id) AS m FROM shops WHERE region_id = 'none'").stderr, /the value is NULL/);
  // The profile's forbidden columns apply in full: no declaration lifts them here.
  const r = run('pii.sql', '-- protected-columns: shops.postal_code\nSELECT MAX(postal_code) AS p FROM shops');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /query refused \(forbidden_column\)/);
  assert.equal(r.stdout, '');
});

test('query: a missing fixture names the fix; no profile or bad usage is exit 2', (t) => {
  const dir = tmpDir(t);
  let r = cli(QUERY, [path.join(FIXTURE, 'truths', 'open-shops.sql')], { APLABS_PROFILE: PROFILE, APLABS_VAR_DIR: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no built fixture at .*mini\.duckdb\. Run npm run fixture:build first\./);
  r = cli(QUERY, [path.join(FIXTURE, 'truths', 'open-shops.sql')], {}, dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no profile/);
  assert.equal(cli(QUERY, []).status, 2);
  assert.deepEqual(query.parseArgs(['a.sql', 'b.sql']), { error: 'expected one <sql-file>' });
  assert.deepEqual(query.parseArgs(['--profile', 'p.yml', 'a.sql']), { profile: 'p.yml', file: 'a.sql' });
  assert.match(query.parseArgs(['a.sql', '--profile']).error, /--profile needs a value/);
});

// --- the governing profile (issue #77 item 4) ---

// A copy of the fixture profile somewhere else: another client's, as far as
// the commands can tell.
function otherProfile(t) {
  const file = path.join(tmpDir(t), 'other.yml');
  fs.copyFileSync(PROFILE, file);
  return file;
}

test('an explicit --profile that is not the governing profile fails with exit 2, for validate and query', async (t) => {
  const db = await builtDb(t);
  const other = otherProfile(t);
  const sql = path.join(FIXTURE, 'truths', 'open-shops.sql');
  for (const governing of [{ APLABS_GOVERNING_PROFILE: PROFILE }, { APLABS_PROFILE: PROFILE }]) {
    let r = cli(VALIDATE, [FIXTURE, '--db', db, '--profile', other], governing, tmpDir(t));
    assert.equal(r.status, 2, JSON.stringify(governing));
    assert.match(r.stderr, /^fixture:validate: --profile .*other\.yml is not the governing profile \(.*profile\.yml\)/m);
    assert.doesNotMatch(r.stdout, /PASS|FAIL/);
    r = cli(QUERY, ['--profile', other, sql], { ...governing, APLABS_DATA_PATH: db }, tmpDir(t));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^query: --profile .*other\.yml is not the governing profile/m);
    assert.equal(r.stdout, '');
  }
  // Naming the governing profile itself is fine, relative or not.
  const r = cli(QUERY, ['--profile', path.relative(REPO, PROFILE), sql], { APLABS_GOVERNING_PROFILE: PROFILE, APLABS_DATA_PATH: db });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '2\n');
});

test('with no --profile, validate and query use the governing profile verify passes; a relative one is refused', async (t) => {
  const db = await builtDb(t);
  const sql = path.join(FIXTURE, 'truths', 'open-shops.sql');
  let r = cli(QUERY, [sql], { APLABS_GOVERNING_PROFILE: PROFILE, APLABS_DATA_PATH: db }, tmpDir(t));
  assert.equal(r.status, 0, r.stderr);
  // It wins over APLABS_PROFILE: verify's profile is the one that defines the check.
  r = cli(QUERY, [sql], { APLABS_GOVERNING_PROFILE: PROFILE, APLABS_PROFILE: otherProfile(t), APLABS_DATA_PATH: db }, tmpDir(t));
  assert.equal(r.status, 0, r.stderr);
  r = cli(VALIDATE, [FIXTURE, '--db', db], { APLABS_GOVERNING_PROFILE: 'profile.yml' }, tmpDir(t));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /APLABS_GOVERNING_PROFILE must be an absolute path/);
});

// --- npm run verify: truths through the bridge, context beside the profile ---

// A profile outside any .aplabs/ folder (the template's profiles/<client>/
// layout), with its data.md in context/ beside it, as APLABS_PROFILE selects.
// APLABS_PROFILE never reaches a check, and no argv names a profile (as
// Brightside's don't, issue #77): verify passes the governing profile as
// APLABS_GOVERNING_PROFILE. APLABS_DATA_PATH is allowed only to point at the temp build.
function profileRepo(t, db) {
  const dir = tmpDir(t);
  const profileFile = path.join(dir, 'profiles', 'mini', 'profile.yml');
  const profile = YAML.parse(fs.readFileSync(PROFILE, 'utf8'));
  profile.verify = {
    checks: [{ id: 'fixture-validate', run: [node, VALIDATE, FIXTURE, '--db', db] }],
    env_allow: ['APLABS_DATA_PATH'],
  };
  fs.mkdirSync(path.join(dir, 'profiles', 'mini', 'context'), { recursive: true });
  fs.writeFileSync(profileFile, YAML.stringify(profile));
  const truth = (id, file, expect) => ['```truth', `id: ${id}`, `statement: ${id}`,
    `run: [${node}, ${QUERY}, ${path.join(FIXTURE, 'truths', file)}]`, `expect: ${expect}`, 'tolerance: 0',
    'owner: Solo', 'signed_off: pending', '```'].join('\n');
  fs.writeFileSync(path.join(dir, 'profiles', 'mini', 'context', 'data.md'),
    `# Data\n\n## Known truths\n\n${truth('open-shops', 'open-shops.sql', 2)}\n\n${truth('vale-revenue', 'revenue.sql', 125000)}\n`);
  return { dir, profileFile };
}

test('verify: with APLABS_PROFILE, the fixture check and each truth run through the bridge and pass', async (t) => {
  const db = await builtDb(t);
  const { dir, profileFile } = profileRepo(t, db);
  const r = cli(VERIFY, [], { APLABS_PROFILE: profileFile, APLABS_DATA_PATH: db }, dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const summary = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(summary.results.map((x) => [x.id, x.outcome]), [
    ['fixture-validate', 'pass'], ['truth:open-shops', 'pass'], ['truth:vale-revenue', 'pass'],
  ]);
});

test('verify: a missing fixture fails the check and every truth; it never passes silently', (t) => {
  const missing = path.join(tmpDir(t), 'missing.duckdb');
  const { dir, profileFile } = profileRepo(t, missing);
  const r = cli(VERIFY, [], { APLABS_PROFILE: profileFile, APLABS_DATA_PATH: missing }, dir);
  assert.equal(r.status, 1);
  const summary = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(summary.results.map((x) => x.outcome), ['fail', 'fail', 'fail']);
  assert.match(r.stderr, /Run npm run fixture:build first\./);
});
