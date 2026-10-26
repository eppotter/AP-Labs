'use strict';

// The dispatcher's routing CLI (Story 14.5) on hand-made rows: argument
// parsing (every way out), execute() against a fake full data object, and
// the text format. App code: it requires only '#sdk' and the routing folder.
// The same CLI through its launcher on the built fixture (S1 to S3, the
// coordinate and address scan, nothing written) is
// examples/brightside/test/routing-cli.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testContext, DataUnavailableError, QueryRefusedError } = require('#sdk');
const { parseArgs, execute, isRealDate, NAMES_SQL, USAGE } = require('../cli');
const { SQL } = require('../adapter');
const format = require('../format');

const ROUTING = Object.freeze({
  max_pairs: 10000,
  gap_fill: { horizon_days: 14, limit: 5 },
  limits: { earliest_start: 360, default_start: 480, aim_finish: 1080, latest_finish: 1380, slot_minutes: 15 },
});
const DAY = '2026-10-02';

const crewRow = (crewId, zone, over = {}) => ({
  crew_id: crewId, zone_id: zone, headcount_planned: 3, headcount_present: 3, leads_planned: 1, leads_present: 1, ...over,
});
const visitRow = (id, propertyId, crewId, order, over = {}) => ({
  scheduled_visit_id: id, property_id: propertyId, crew_id: crewId, status: 'scheduled', visit_date: DAY, route_order: order,
  start_minutes: 480 + (order - 1) * 120, scheduled_minutes: 60, labour_minutes: 180,
  preferred_crew: null, preferred_crew_strength: null, allowed_days: null, allowed_days_strength: null, time_window: null, time_window_strength: null,
  ...over,
});
const candidateRow = (id, propertyId, date) => ({
  scheduled_visit_id: id, property_id: propertyId, crew_id: 1, visit_date: date, scheduled_minutes: 60, labour_minutes: 90, frequency: 'biweekly', prev_visit_date: null,
  preferred_crew: null, preferred_crew_strength: null, allowed_days: null, allowed_days_strength: null, time_window: null, time_window_strength: null,
});

const CREW_NAMES = [
  { crew_id: 1, crew_name: 'Test crew One', zone_name: 'Northside' },
  { crew_id: 2, crew_name: 'Test crew Two', zone_name: 'Northside' },
];
const PLACES = [
  { property_id: 100, client_name: 'Ada Alpha', city: 'Aville' },
  { property_id: 101, client_name: 'Ben Beta', city: 'Bville' },
  { property_id: 102, client_name: 'Cy Gamma', city: 'Cville' },
  { property_id: 200, client_name: 'Di Delta', city: 'Dville' },
];

// A fake full data object: the adapter's queries and the CLI's two name
// queries by their text, and 10 minutes for every drive asked.
function fakeData({ crews = [crewRow(1, 'n'), crewRow(2, 'n')], visits = [], candidates = [] } = {}) {
  const queries = [];
  return {
    queries,
    run: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === SQL.crews) return crews;
      if (sql === SQL.day) return visits;
      if (sql === SQL.candidates) return candidates;
      if (sql === NAMES_SQL.crews) return CREW_NAMES;
      if (sql === NAMES_SQL.places) return PLACES;
      if (/fixture_meta/.test(sql)) return [{ value: '2026-09-30' }];
      throw new Error('unexpected query');
    },
    describe: () => ({ source: 'fake', label: null, available: true, problem: null }),
    travelMatrix: async (fromIds, toIds) => fromIds.flatMap((f) => toIds.map((t) => ({ from_node: f, to_node: t, minutes: 10 }))),
  };
}

function streams() {
  const text = { out: '', err: '' };
  return { text, out: { write: (s) => { text.out += s; } }, err: { write: (s) => { text.err += s; } } };
}

async function runCli(argv, data, routing = ROUTING) {
  const s = streams();
  const args = parseArgs(argv);
  assert.ok(!args.error && !args.help, JSON.stringify(args));
  const code = await execute(args, { data, routing, out: s.out, err: s.err });
  return { code, ...s.text };
}

// --- parsing: every way out ---------------------------------------------------

test('parseArgs reads each command with its options', () => {
  assert.deepEqual(parseArgs(['optimize', '--day', DAY]), { command: 'optimize', day: DAY, crew: null, all: false, profile: null });
  assert.deepEqual(parseArgs(['optimize', '--crew', '4', '--day', DAY]), { command: 'optimize', day: DAY, crew: '4', all: false, profile: null });
  assert.deepEqual(parseArgs(['change', '--day', DAY]), { command: 'change', day: DAY, crew: null, all: false, profile: null });
  assert.deepEqual(parseArgs(['gap', '--day', DAY, '--crew', '2', '--all']), { command: 'gap', day: DAY, crew: '2', all: true, profile: null });
  assert.deepEqual(parseArgs(['change', '--day', DAY, '--profile', 'p.yml']), { command: 'change', day: DAY, crew: null, all: false, profile: 'p.yml' });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.deepEqual(parseArgs(['gap', '-h']), { help: true });
});

test('parseArgs refuses bad input with a plain message', () => {
  const cases = [
    [[], /no command given/],
    [['plan', '--day', DAY], /unknown command "plan" \(use optimize, change or gap\)/],
    [['--day', DAY], /unknown command "--day"/],
    [['optimize'], /optimize needs --day YYYY-MM-DD/],
    [['optimize', '--day'], /--day needs a value/],
    [['optimize', '--day', '--crew', '4'], /--day needs a value/],
    [['optimize', '--day', DAY, '--day', DAY], /--day given twice/],
    [['optimize', '--day', DAY, '--all'], /optimize does not take --all/],
    [['change', '--day', DAY, '--crew', '3'], /change does not take --crew/],
    [['optimize', '--day', DAY, 'extra'], /unexpected "extra"/],
    [['gap', '--day', DAY], /gap needs --crew <crew number>/],
    [['gap', '--day', DAY, '--crew', 'two'], /--crew must be a crew number \(got "two"\)/],
    [['gap', '--day', DAY, '--crew', '0'], /--crew must be a crew number/],
    [['optimize', '--day', DAY, '--crew', '-1'], /--crew must be a crew number \(got "-1"\)/],
    [['optimize', '--day', DAY, '--crew', '--all'], /--crew needs a value/],
  ];
  for (const [argv, want] of cases) {
    const got = parseArgs(argv);
    assert.ok(got.error, argv.join(' '));
    assert.match(got.error, want, argv.join(' '));
  }
});

test('--day must be a real date: the pattern, then the day exists', () => {
  for (const day of ['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29', '2026-04-31', '2026-10-2', '02-10-2026', 'tomorrow', '2026-10-02T00:00']) {
    assert.equal(isRealDate(day), false, day);
    assert.match(parseArgs(['change', '--day', day]).error, /--day must be a real date written YYYY-MM-DD/, day);
  }
  for (const day of ['2028-02-29', '2026-10-02', '2026-11-01', '2026-12-31']) assert.equal(isRealDate(day), true, day);
});

test('the usage names the three commands and that nothing is written', () => {
  for (const word of ['optimize', 'change', 'gap', '--day', '--crew', '--all', 'nothing is written']) assert.ok(USAGE.includes(word), word);
});

// --- execute: answers and refusals --------------------------------------------

test('optimize prints crew names, client names, cities and times, and writes only to out', async () => {
  const data = fakeData({ visits: [visitRow(10, 100, 1, 1), visitRow(11, 101, 1, 2), visitRow(12, 102, 2, 1)] });
  const r = await runCli(['optimize', '--day', DAY], data);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.match(r.out, /^Suggested routes for Friday 2026-10-02\n/);
  assert.match(r.out, /Suggestion only: nothing has been changed/);
  assert.match(r.out, /Test crew One \(crew 1, zone Northside\): 2 stops/);
  assert.match(r.out, /Test crew Two \(crew 2, zone Northside\): 1 stop,/);
  assert.match(r.out, / 1\. 08:00 {2}Ada Alpha, Aville \[stop 10\]/);
  assert.match(r.out, /Ben Beta, Bville \[stop 11/);
  assert.match(r.out, /Cy Gamma, Cville \[stop 12\]/);
  assert.ok(!r.out.includes('a stop ['), 'every stop is named');
  // Only reads: the adapter's queries and the two name queries.
  for (const q of data.queries) assert.match(q.sql, /^\s*(--|WITH|SELECT)/);
});

test('optimize --crew keeps one crew and says so', async () => {
  const data = fakeData({ visits: [visitRow(10, 100, 1, 1), visitRow(12, 102, 2, 1)] });
  const r = await runCli(['optimize', '--day', DAY, '--crew', '2'], data);
  assert.equal(r.code, 0);
  assert.match(r.out, /\(Test crew Two \(crew 2\) only\)/);
  assert.ok(!r.out.includes('Ada Alpha'));
});

test('a day with no stops booked says so and exits 0', async () => {
  const r = await runCli(['optimize', '--day', '2031-01-01'], fakeData());
  assert.equal(r.code, 0);
  assert.match(r.out, /No stops are booked on 2031-01-01\./);
});

test('change lists the crew that is out, what is placed, recommended, rebooked and shifted', async () => {
  const data = fakeData({
    crews: [crewRow(1, 'n'), crewRow(2, 'n', { leads_present: 0, headcount_present: 2 })],
    visits: [visitRow(10, 100, 1, 1), visitRow(12, 102, 2, 1)],
  });
  const r = await runCli(['change', '--day', DAY], data);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Route change for Friday 2026-10-02\n/);
  assert.match(r.out, /Not working: Test crew Two \(crew 2, zone Northside\)/);
  assert.match(r.out, /Placed in their zone \(1\):\n {2}\d\d:\d\d {2}Cy Gamma, Cville \[stop 12\]: Test crew Two \(crew 2\) to Test crew One \(crew 1\)/);
  assert.match(r.out, /Recommended for another zone, not placed \(a dispatcher decides\) \(0\):\n {2}none/);
  assert.match(r.out, /To rebook \(0\):\n {2}none/);
  assert.match(r.out, /Existing stops to confirm a new time \(\d\):/);
});

test('change on a day every crew works says there is nothing to place', async () => {
  const r = await runCli(['change', '--day', DAY], fakeData({ visits: [visitRow(10, 100, 1, 1)] }));
  assert.equal(r.code, 0);
  assert.match(r.out, /Result: every crew is working today; nothing to place\./);
});

test('gap ranks the candidates by name and city; --all lists those left out with their reasons', async () => {
  const visits = [visitRow(10, 100, 1, 1), visitRow(11, 101, 1, 2, { status: 'cancelled' }), visitRow(12, 102, 1, 3)];
  const data = () => fakeData({ visits, candidates: [candidateRow(20, 200, '2026-10-06'), candidateRow(21, 100, '2026-10-07')] });
  const r = await runCli(['gap', '--day', DAY, '--crew', '1'], data());
  assert.equal(r.code, 0);
  assert.match(r.out, /^Gap fill for Friday 2026-10-02, Test crew One \(crew 1, zone Northside\)\n/);
  assert.match(r.out, /Gap 1: 09:00 to 12:00 \(180 min\), after Ada Alpha, Aville \[stop 10\], before Cy Gamma, Cville \[stop 12\]/);
  assert.match(r.out, /Cancelled: Ben Beta, Bville \[stop 11\]/);
  assert.match(r.out, / 1\. \d\d:\d\d {2}Di Delta, Dville \[stop 20\], booked for 2026-10-06 \(4 days earlier\)/);
  assert.match(r.out, /Left out: 1 other visit \(add --all to list each with its reason\)\./);
  const all = await runCli(['gap', '--day', DAY, '--crew', '1', '--all'], data());
  assert.match(all.out, /Left out \(1\):\n {2}Ada Alpha, Aville \[stop 21\]\n {5}\S/);
});

test('gap on a crew with nothing cancelled says there is no gap', async () => {
  const r = await runCli(['gap', '--day', DAY, '--crew', '2'], fakeData({ visits: [visitRow(10, 100, 1, 1, { status: 'cancelled' })] }));
  assert.equal(r.code, 0);
  assert.match(r.out, /Result: no visit was cancelled on Test crew Two \(crew 2\) on 2026-10-02; no gap to fill\./);
});

test('an unknown crew exits 2 with a plain message (optimize and gap)', async () => {
  for (const argv of [['optimize', '--day', DAY, '--crew', '99'], ['gap', '--day', DAY, '--crew', '99']]) {
    const r = await runCli(argv, fakeData());
    assert.deepEqual([r.code, r.out, r.err], [2, '', 'routing: there is no crew 99\n'], argv.join(' '));
  }
});

test('data that is not available exits 1 with a plain message', async () => {
  const data = { ...fakeData(), run: async () => { throw new DataUnavailableError('the data file does not exist'); } };
  const r = await runCli(['change', '--day', DAY], data);
  assert.deepEqual([r.code, r.out, r.err], [1, '', 'routing: the data is not available (the data file does not exist)\n']);
});

test('a refused query exits 1 naming the rule only', async () => {
  const data = { ...fakeData(), run: async () => { throw new QueryRefusedError('forbidden_column', 'properties.street_address'); } };
  const r = await runCli(['change', '--day', DAY], data);
  assert.deepEqual([r.code, r.out, r.err], [1, '', 'routing: a query was refused (forbidden_column)\n']);
});

test('a module ctx.data (no travelMatrix) is refused: exit 1, nothing printed', async () => {
  const rows = fakeData({ visits: [visitRow(10, 100, 1, 1)] });
  const { data } = testContext({ rows: (sql) => rows.run(sql) });
  const r = await runCli(['change', '--day', DAY], data);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /^routing: cannot plan 2026-10-02: routing input refused: "travelMatrix" data_unavailable\n$/);
});

test('a profile with no routing block exits 2: routing is off', async () => {
  const r = await runCli(['change', '--day', DAY], fakeData(), null);
  assert.deepEqual([r.code, r.out, r.err], [2, '', 'routing: this profile has no routing: block, so routing is off\n']);
});

test('an unexpected failure is not swallowed', async () => {
  const data = { ...fakeData(), run: async () => { throw new TypeError('boom'); } };
  await assert.rejects(execute(parseArgs(['change', '--day', DAY]), { data, routing: ROUTING, ...streams() }), /boom/);
});

// --- format and the read-only shape -------------------------------------------

test('format helpers: clock times and weekdays from the calendar alone', () => {
  assert.equal(format.clock(0), '00:00');
  assert.equal(format.clock(485), '08:05');
  assert.equal(format.clock(1380), '23:00');
  assert.equal(format.weekday('2026-11-01'), 'Sunday');
  assert.equal(format.weekday('2026-10-02'), 'Friday');
  const names = { crews: new Map(), places: new Map([['7', { client: 'Ed Eps', city: 'Eville' }]]) };
  assert.equal(format.placeWords(names, 'property:7'), 'Ed Eps, Eville');
  assert.equal(format.placeWords(names, 'property:8'), 'a stop');
  assert.equal(format.placeWords(names, 'crew:7'), 'a stop');
});

test('the CLI and its format write nothing: no fs, no process spawn, no network, no connector', () => {
  for (const file of ['cli.js', 'format.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/require\(\s*['"](node:)?(fs|child_process|net|http|https|dgram|worker_threads)['"]\s*\)/.test(code), `${file} requires a writer`);
    assert.ok(!/\b(writeFile|appendFile|createWriteStream|mkdir|unlink|rename|copyFile|rmSync|connector)/i.test(code), `${file} names a write`);
  }
});
