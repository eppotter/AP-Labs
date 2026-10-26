'use strict';

// The dispatcher's read-only routing CLI (Story 14.5, AD-R11): the commands.
//
//   node examples/brightside/bin/routing.js optimize --day <date> [--crew <n>]
//   node examples/brightside/bin/routing.js change   --day <date>
//   node examples/brightside/bin/routing.js gap      --day <date> --crew <n> [--all]
//
// This file parses the arguments, builds the input with the adapter, runs the
// engine and prints the result through format.js. It is app code, so it
// imports only '#sdk' and its own folder (test/unit/engine-boundary.test.js):
// it cannot open the data file itself. The launcher,
// examples/brightside/bin/routing.js, loads the governing profile, opens the
// full data object (createData, which has travelMatrix) and calls execute().
// Run directly, this file says so and exits 2.
//
// Read only: nothing is written (no file, no table, no message). The data
// object is the query runner's, which opens DuckDB read-only; the two name
// queries below read only crew and zone names, client names and the city,
// and pass the guardrail with the address, postal code and coordinate
// columns forbidden.
//
// Exit codes: 0 printed; 1 the data is not available or the engine refused
// the day's input; 2 bad input (an unknown command or option, a missing or
// impossible date, an unknown crew, a profile with no routing block).

const sdk = require('#sdk');
const { createAdapter } = require('./adapter');
const format = require('./format');

const { routing: engine } = sdk;

const LAUNCHER = 'node examples/brightside/bin/routing.js';
const USAGE = [
  `usage: ${LAUNCHER} <command> --day YYYY-MM-DD [options] [--profile <file>]`,
  '  optimize --day <date> [--crew <n>]      a better order for each crew\'s booked day',
  '  change   --day <date>                   where the stops of a crew that is out could go',
  '  gap      --day <date> --crew <n> [--all] visits that could be moved up into a cancelled slot',
  'Suggestions only: nothing is written anywhere.',
].join('\n');

const COMMANDS = Object.freeze(['optimize', 'change', 'gap']);
const OPTIONS = Object.freeze({
  optimize: ['--day', '--crew'],
  change: ['--day'],
  gap: ['--day', '--crew', '--all'],
});
const FLAGS = new Set(['--all']);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CREW = /^[1-9]\d{0,5}$/;

// Crew and zone names, and client name and city per property booked from
// $day to $day + $horizon_days (the gap-fill horizon covers every candidate).
const NAMES_SQL = Object.freeze({
  crews: [
    'SELECT c.crew_id, c.name AS crew_name, z.name AS zone_name',
    'FROM crews c',
    'JOIN zones z ON z.zone_id = c.zone_id',
    'ORDER BY c.crew_id',
  ].join('\n'),
  places: [
    "SELECT p.property_id, cl.first_name || ' ' || cl.last_name AS client_name, p.city",
    'FROM properties p',
    'JOIN clients cl ON cl.client_id = p.client_id',
    'WHERE p.property_id IN (',
    '  SELECT sv.property_id FROM scheduled_visits sv',
    '  WHERE sv.visit_date >= CAST($day AS DATE)',
    '    AND sv.visit_date <= CAST($day AS DATE) + CAST($horizon_days AS INTEGER)',
    ')',
    'ORDER BY p.property_id',
  ].join('\n'),
});

// A real calendar date: the pattern, then the day exists (2026-02-30 does not).
function isRealDate(text) {
  const m = ISO_DATE.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

// argv (after the script) -> { command, day, crew, all, profile } or
// { help: true } or { error }.
function parseArgs(argv) {
  if (argv.length === 0) return { error: 'no command given' };
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) return { error: `unknown command "${command}" (use optimize, change or gap)` };
  const args = { command, day: null, crew: null, all: false, profile: null };
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 1) {
    const opt = rest[i];
    if (opt !== '--profile' && !OPTIONS[command].includes(opt)) {
      return { error: opt.startsWith('-') ? `${command} does not take ${opt}` : `unexpected "${opt}"` };
    }
    if (seen.has(opt)) return { error: `${opt} given twice` };
    seen.add(opt);
    if (FLAGS.has(opt)) {
      args.all = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${opt} needs a value` };
    i += 1;
    if (opt === '--day') args.day = value;
    else if (opt === '--crew') args.crew = value;
    else args.profile = value;
  }
  if (args.day === null) return { error: `${command} needs --day YYYY-MM-DD` };
  if (!isRealDate(args.day)) return { error: `--day must be a real date written YYYY-MM-DD (got "${args.day}")` };
  if (command === 'gap' && args.crew === null) return { error: 'gap needs --crew <crew number>' };
  if (args.crew !== null && !CREW.test(args.crew)) return { error: `--crew must be a crew number (got "${args.crew}")` };
  return args;
}

async function namesFor(data, day, horizonDays) {
  const crews = await data.run(NAMES_SQL.crews);
  const places = await data.run(NAMES_SQL.places, { day, horizon_days: horizonDays }, { declared: ['day', 'horizon_days'] });
  return {
    crews: new Map(crews.map((r) => [String(r.crew_id), { name: r.crew_name, zone: r.zone_name }])),
    places: new Map(places.map((r) => [String(r.property_id), { client: r.client_name, city: r.city }])),
  };
}

const unknownCrew = (err) => err && err.code === 'ROUTING_FAULT' && err.details
  && ['crewIds', 'crewId'].includes(err.details.field) && err.details.problem === 'unknown_crew';

// Runs one parsed command against a full data object and the profile's
// routing block. out and err are writable streams (process.stdout and
// process.stderr in the launcher). Returns the exit code.
async function execute(args, { data, routing, out, err }) {
  const fail = (code, message) => {
    err.write(`routing: ${message}\n`);
    return code;
  };
  if (!routing) return fail(2, 'this profile has no routing: block, so routing is off');
  try {
    const adapter = createAdapter({ data, routing });
    const horizonDays = routing.gap_fill.horizon_days;
    if (args.command === 'optimize') {
      const crewIds = args.crew === null ? undefined : [args.crew];
      const { input, travel } = await adapter.dayInput({ day: args.day, crewIds });
      const result = engine.optimizeDay(input, { travel });
      const names = await namesFor(data, args.day, horizonDays);
      out.write(format.formatOptimize({ input, result, names, crewIds }));
    } else if (args.command === 'change') {
      const { input, travel } = await adapter.dayInput({ day: args.day });
      const result = engine.placeOrphans(input, { travel });
      const names = await namesFor(data, args.day, horizonDays);
      out.write(format.formatChange({ input, result, names }));
    } else {
      const { input, travel } = await adapter.gapInput({ day: args.day, crewId: args.crew });
      const result = engine.fillGap(input, { travel, horizonDays, limit: routing.gap_fill.limit });
      const names = await namesFor(data, args.day, horizonDays);
      out.write(format.formatGap({ input, result, names, crewId: args.crew, all: args.all }));
    }
    return 0;
  } catch (e) {
    if (unknownCrew(e)) return fail(2, `there is no crew ${args.crew}`);
    if (e && e.code === 'DATA_UNAVAILABLE') return fail(1, `the data is not available (${e.reason})`);
    if (e && e.code === 'QUERY_REFUSED') return fail(1, `a query was refused (${e.rule})`);
    if (e && e.code === 'ROUTING_FAULT') return fail(1, `cannot plan ${args.day}: ${e.message}`);
    throw e;
  }
}

if (require.main === module) {
  process.stderr.write(`routing: start the CLI with ${LAUNCHER} (it opens the data; this file holds the commands)\n${USAGE}\n`);
  process.exitCode = 2;
}

module.exports = { parseArgs, execute, isRealDate, NAMES_SQL, USAGE, LAUNCHER };
