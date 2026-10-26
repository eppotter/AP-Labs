'use strict';

// The dispatcher's routing CLI (Story 14.5, AD-R11) through its launcher,
// examples/brightside/bin/routing.js, as a real process on a temporary build
// of the fixture. Checked here: S1, S2 and S3 print crew names, client names,
// cities and times that match the data, and the numbers in targets.json; no
// output holds a coordinate (as stored or as degrees), a street address or a
// postal code, or anything that looks like one; nothing is written (the data
// file is unchanged, no file appears beside it or in the working directory);
// and every way out exits non-zero with a plain message. The CLI's name
// queries pass the guardrail with the coordinate and address columns
// forbidden.
//
// An example test (architecture carve-out): it reads Brightside's app dir and
// fixture (its targets and planted scenario ids), and is deleted with the
// example in a fork. Its profiles come from test fixtures
// (fixtures/routing-profile.yml, and fixtures/demo-profile.yml for a profile
// with no routing block), never profiles/brightside/.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { createData } = require('../../../kit/runtime/data');
const { checkSql } = require('../../../kit/runtime/sql');
const { NAMES_SQL } = require('../app/routing/cli');
const { S1, S2, S3 } = require('../fixture/lib/scenarios');
const { toDay, toIso } = require('../fixture/lib/days');

const ROOT = path.join(__dirname, '../../..');
const LAUNCHER = path.join(ROOT, 'examples/brightside/bin/routing.js');
const CLI = path.join(ROOT, 'examples/brightside/app/routing/cli.js');
const PROFILE = path.join(__dirname, 'fixtures/routing-profile.yml');
const NO_ROUTING_PROFILE = path.join(__dirname, 'fixtures/demo-profile.yml');
const profile = loadProfile(PROFILE);
const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/brightside/fixture/targets.json'), 'utf8')).routing;
const HIDDEN = ['geo_lat_e6', 'geo_lon_e6', 'base_geo_lat_e6', 'base_geo_lon_e6', 'street_address', 'postal_code'];

let tmp;
let dbDir;
let db;
let cwd;
let raw; // a test-only reader of the hidden columns, to scan the output for them
let asOf;
const outputs = [];
const dayOf = (offset) => toIso(toDay(asOf) + offset);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function baseEnv(over = {}) {
  const env = { ...process.env, APLABS_PROFILE: PROFILE, APLABS_DATA_PATH: db, ...over };
  delete env.APLABS_GOVERNING_PROFILE;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

function cli(args, { env = baseEnv(), file = LAUNCHER } = {}) {
  const r = spawnSync(process.execPath, [file, ...args], { cwd, env, encoding: 'utf8', timeout: 120000 });
  if (r.status === 0) outputs.push(r.stdout);
  return { code: r.status, out: r.stdout, err: r.stderr };
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-routing-cli-')));
  dbDir = path.join(tmp, 'data');
  cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(dbDir);
  fs.mkdirSync(cwd);
  db = path.join(dbDir, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: db });
  raw = createData({ file: db, profile: { sql: { forbidden_columns: [] } } });
  asOf = (await raw.run("SELECT value FROM fixture_meta WHERE key = 'as_of'"))[0].value;
});
after(() => {
  if (raw) raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const crewName = async (id) => (await raw.run('SELECT name FROM crews WHERE crew_id = $id', { id }, { declared: ['id'] }))[0].name;
async function placeOf(propertyId) {
  const [r] = await raw.run(
    'SELECT c.first_name, c.last_name, p.city FROM properties p JOIN clients c ON c.client_id = p.client_id WHERE p.property_id = $id',
    { id: propertyId }, { declared: ['id'] },
  );
  return `${r.first_name} ${r.last_name}, ${r.city}`;
}

test('the name queries pass the guardrail with the hidden columns forbidden, and name none of them', () => {
  for (const [name, text] of Object.entries(NAMES_SQL)) {
    assert.deepEqual(checkSql(text, { forbiddenColumns: profile.sql.forbidden_columns }), { ok: true }, name);
    for (const col of HIDDEN) assert.ok(!text.includes(col), `${name} names ${col}`);
  }
});

test('S1 optimize: the crew, every stop by client and city, booked drive minutes from targets.json', async () => {
  const day = dayOf(S1.dayOffset);
  const r = cli(['optimize', '--day', day, '--crew', String(S1.crewId)]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.ok(r.out.includes(`${await crewName(S1.crewId)} (crew ${S1.crewId}, zone `));
  assert.match(r.out, new RegExp(`Driving: booked ${TARGETS['route-optimize-s1-drive']} min, suggested \\d+ min\\. Hard-rule breaks: booked 0, suggested 0\\.`));
  const stops = await raw.run(
    "SELECT property_id FROM scheduled_visits WHERE crew_id = $crew AND visit_date = CAST($day AS DATE) AND status = 'scheduled'",
    { crew: S1.crewId, day }, { declared: ['crew', 'day'] },
  );
  assert.equal(stops.length, S1.stops);
  for (const s of stops) assert.ok(r.out.includes(await placeOf(s.property_id)), `property ${s.property_id}`);
  assert.equal((r.out.match(/^ {2}\d\. \d\d:\d\d {2}/gm) || []).length, S1.stops);
  assert.ok(!r.out.includes('a stop ['), 'every stop is named');
});

test('S2 gap: the top fill by name and city, and the valid count from targets.json', async () => {
  const r = cli(['gap', '--day', dayOf(S2.dayOffset), '--crew', String(S2.crewId)]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(`Gap fill for `) && r.out.includes(`${await crewName(S2.crewId)} (crew ${S2.crewId}`));
  assert.ok(r.out.includes(`  Cancelled: ${await placeOf((await raw.run('SELECT property_id FROM scheduled_visits WHERE scheduled_visit_id = $id', { id: S2.cancelled }, { declared: ['id'] }))[0].property_id)} [stop ${S2.cancelled}]`));
  assert.match(r.out, new RegExp(`  ${TARGETS['route-change-s2-count']} of \\d+ candidates fit`));
  const top = r.out.split('\n').find((l) => /^ {2}1\. \d\d:\d\d {2}/.test(l));
  assert.ok(top.includes(await placeOf(TARGETS['route-change-s2-top'])), top);
  assert.ok(r.out.includes(await placeOf(S2.runnerUp)));
  assert.match(r.out, /Left out: \d+ other visits \(add --all/);
  // --all names the two decoys with their reasons.
  const all = cli(['gap', '--day', dayOf(S2.dayOffset), '--crew', String(S2.crewId), '--all']);
  assert.equal(all.code, 0, all.err);
  const lines = all.out.split('\n');
  const reasonOf = async (pid) => {
    const head = `  ${await placeOf(pid)} [stop `;
    const k = lines.findIndex((l) => l.startsWith(head));
    assert.ok(k > 0, head);
    return lines[k + 1];
  };
  assert.match(await reasonOf(S2.morningDecoy), /time of day/i);
  assert.match(await reasonOf(S2.cadenceDecoy), /cadence/);
});

test('S3 change: the crew that is out, five placed in zone, one cross-zone recommendation, none to rebook', async () => {
  const r = cli(['change', '--day', dayOf(S3.dayOffset)]);
  assert.equal(r.code, 0, r.err);
  const target = TARGETS['route-change-s3-crosszone'];
  assert.ok(r.out.includes(`Not working: ${await crewName(S3.crewId)} (crew ${S3.crewId}, zone `));
  assert.ok(r.out.includes(`Placed in their zone (${target.in_zone}):`));
  assert.ok(r.out.includes(`Recommended for another zone, not placed (a dispatcher decides) (${target.cross_zone}):`));
  assert.ok(r.out.includes(`To rebook (${target.unplaced}):`));
  const cross = r.out.split('Recommended for another zone')[1].split('\n')[1];
  assert.ok(cross.includes(await placeOf(S3.orphanMorning)), cross);
  assert.ok(!r.out.includes('a stop ['), 'every stop is named');
});

test('every crew\'s day on the busiest scenario day prints too (optimize with no --crew)', () => {
  const r = cli(['optimize', '--day', dayOf(S3.dayOffset)]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Not working: .*\(crew 7\)/);
  assert.ok((r.out.match(/^\S.*\(crew \d+, zone \w+\): \d+ stops?, \d+ min driving$/gm) || []).length >= 10);
});

test('no output holds a coordinate, street address or postal code, or anything that looks like one', async () => {
  assert.ok(outputs.length >= 5, 'the scenario runs above printed');
  const text = outputs.join('\n');
  // Nothing coordinate-shaped: no run of five or more digits (a stored
  // coordinate is 8 or 9, a postal code 5), no decimal with three or more
  // places (degrees), and no column or word for a place.
  assert.deepEqual(text.match(/\d{5,}/g), null);
  assert.deepEqual(text.match(/\d+\.\d{3,}/g), null);
  assert.deepEqual(text.match(/\b(lat|lon|lng|latitude|longitude|geo_\w+|postal\w*|zip|street_address|address)\b/gi), null);
  // And none of the actual values, for every property and crew base.
  const props = await raw.run('SELECT street_address, postal_code, geo_lat_e6, geo_lon_e6 FROM properties');
  const bases = await raw.run('SELECT base_geo_lat_e6 AS geo_lat_e6, base_geo_lon_e6 AS geo_lon_e6 FROM crews');
  const streets = new Set();
  for (const p of props) {
    streets.add(p.street_address);
    // The street name alone ("Apple Lane"), as well as the full address.
    streets.add(p.street_address.replace(/^\d+\s+/, ''));
    assert.ok(!new RegExp(`\\b${p.postal_code}\\b`).test(text), 'a postal code');
  }
  for (const s of streets) assert.ok(!text.includes(s), 'a street address');
  for (const c of [...props, ...bases]) {
    for (const v of [c.geo_lat_e6, c.geo_lon_e6]) {
      const abs = Math.abs(v);
      for (const shown of [String(abs), (abs / 1e6).toFixed(6), (abs / 1e6).toFixed(4), (abs / 1e6).toFixed(3)]) {
        assert.ok(!text.includes(shown), 'a coordinate');
      }
    }
  }
});

test('nothing is written: the data file is unchanged and no file appears beside it or in the working directory', () => {
  const hash = sha(db);
  const { mtimeMs, size } = fs.statSync(db);
  for (const args of [
    ['optimize', '--day', dayOf(S1.dayOffset)],
    ['change', '--day', dayOf(S3.dayOffset)],
    ['gap', '--day', dayOf(S2.dayOffset), '--crew', String(S2.crewId), '--all'],
  ]) assert.equal(cli(args).code, 0);
  assert.equal(sha(db), hash);
  assert.deepEqual([fs.statSync(db).mtimeMs, fs.statSync(db).size], [mtimeMs, size]);
  assert.deepEqual(fs.readdirSync(dbDir), ['brightside.duckdb']);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('bad input exits 2 with a plain message and prints nothing on stdout', () => {
  const cases = [
    [[], /^routing: no command given\nusage: /],
    [['plan', '--day', '2026-10-01'], /^routing: unknown command "plan" \(use optimize, change or gap\)\n/],
    [['optimize'], /^routing: optimize needs --day YYYY-MM-DD\n/],
    [['change', '--day', '2026-02-30'], /^routing: --day must be a real date written YYYY-MM-DD \(got "2026-02-30"\)\n/],
    [['gap', '--day', '2026-10-02'], /^routing: gap needs --crew <crew number>\n/],
    [['change', '--day', '2026-10-02', '--crew', '2'], /^routing: change does not take --crew\n/],
    [['optimize', '--day', '2026-10-01', '--crew', '99'], /^routing: there is no crew 99\n$/],
    [['gap', '--day', '2026-10-02', '--crew', '99'], /^routing: there is no crew 99\n$/],
  ];
  for (const [args, want] of cases) {
    const r = cli(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.out, '', args.join(' '));
    assert.match(r.err, want, args.join(' '));
    assert.ok(!/\n\s+at /.test(r.err), 'no stack trace');
  }
});

test('--help prints the usage and exits 0', () => {
  const r = cli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^usage: node examples\/brightside\/bin\/routing\.js <command>/);
});

test('setup problems exit non-zero with a plain message: no profile, no routing block, relative or missing data file', () => {
  const noProfile = cli(['change', '--day', '2026-10-02'], { env: baseEnv({ APLABS_PROFILE: undefined }) });
  assert.equal(noProfile.code, 2);
  assert.match(noProfile.err, /^routing: no profile \(pass --profile, set APLABS_PROFILE or add /);
  const off = cli(['change', '--day', '2026-10-02'], { env: baseEnv({ APLABS_PROFILE: NO_ROUTING_PROFILE }) });
  assert.deepEqual([off.code, off.out, off.err], [2, '', 'routing: this profile has no routing: block, so routing is off\n']);
  const relative = cli(['change', '--day', '2026-10-02'], { env: baseEnv({ APLABS_DATA_PATH: 'data/brightside.duckdb' }) });
  assert.deepEqual([relative.code, relative.err], [2, 'routing: APLABS_DATA_PATH must be an absolute path\n']);
  const missing = cli(['change', '--day', '2026-10-02'], { env: baseEnv({ APLABS_DATA_PATH: path.join(tmp, 'none.duckdb') }) });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^routing: no built fixture at .*none\.duckdb\. Run npm run fixture:build first\.\n$/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('the commands file run directly points at the launcher and exits 2', () => {
  const r = cli(['change', '--day', '2026-10-02'], { file: CLI });
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /^routing: start the CLI with node examples\/brightside\/bin\/routing\.js/);
});

test('the launcher only reads: it opens the data through createData and writes no file', () => {
  const code = fs.readFileSync(LAUNCHER, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\b(writeFile|appendFile|createWriteStream|mkdir|unlink|rename|copyFile|rmSync|child_process)/.test(code));
  assert.match(code, /createData\(\{ file: where\.path, profile \}\)/);
});
