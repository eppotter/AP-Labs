#!/usr/bin/env node
'use strict';

// Brightside's fixture generator (Stories 7.1 and 7.2, AD-18). Offline and
// deterministic: the recorded seed (seed.json) and this code give
// identical files (for a .csv.gz, identical unzipped content). With the recorded seed it also plants the known
// truths' figures from targets.json and refuses to write if one misses.
//
//   npm run fixture:generate            write schema.sql and seeds/*.csv.gz here
//   npm run fixture:check               regenerate in memory and diff against
//                                       the committed files (CI)
//   node generate.js --seed N --clients N --out DIR   a one-off variant
//                                       (unplanted: targets fit the recorded seed)
//
// Seed files are CSV: a header row, rows in primary-key order, LF endings,
// integers as plain digits, dates as YYYY-MM-DD, NULL as an empty field.
// Every seed but fixture_meta.csv (tiny, and it keeps the version readable) is
// stored gzip-compressed as seeds/<table>.csv.gz, which keeps the committed
// seeds under the 10 MB cap. The gzip carries no name or time, a fixed level
// and OS byte 255, but its deflate bytes can still differ between zlib builds
// (a Mac and CI's Linux), so the check compares unzipped content plus the
// header, and writing leaves a .gz alone when its content already matches.
// generate() returns every file under its plain name (seeds/<table>.csv);
// storedName() gives the name on disk.
// Exit codes: 0 ok, 1 check found a difference or a rule failed, 2 usage.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRng, deriveSeed } = require('./lib/prng');
const { TABLES, schemaSql } = require('./lib/tables');
const { buildReference, ZONES, HISTORY_START, AS_OF } = require('./lib/reference');
const { checkRules } = require('./lib/rules');
const { buildActivity } = require('./lib/activity');
const { TRUTH_IDS, computeTruths } = require('./lib/truths');
const { buildOperations, OPERATIONS_STREAM } = require('./lib/operations');
const { checkOperations } = require('./lib/operations-rules');
const { buildRouting, scheduleHorizonEnd, ROUTING_STREAM } = require('./lib/routing');
const { checkRouting } = require('./lib/routing-rules');

// Bump when a change to this code changes the output for the same seed.
const GENERATOR_VERSION = 4;

const FIXTURE_DIR = __dirname;
const SEED_FILE = path.join(FIXTURE_DIR, 'seed.json');
const TARGETS_FILE = path.join(FIXTURE_DIR, 'targets.json');
const SEEDS_DIR = 'seeds';
const PLAIN_SEEDS = new Set([`${SEEDS_DIR}/fixture_meta.csv`]);
const GZIP_LEVEL = 9;
const GZIP_OS_UNKNOWN = 255;

const USAGE = 'Usage: node examples/brightside/fixture/generate.js [--check] [--seed <n>] [--clients <n>] [--out <dir>]';

// The recorded config: seed.json plus the planted targets.
function readSeedConfig(file = SEED_FILE, targetsFile = TARGETS_FILE) {
  return { ...JSON.parse(fs.readFileSync(file, 'utf8')), targets: readTargets(targetsFile) };
}

function readTargets(file = TARGETS_FILE) {
  const { truths } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = Object.keys(truths || {}).sort();
  if (ids.join() !== TRUTH_IDS.slice().sort().join() || !ids.every((id) => Number.isSafeInteger(truths[id]) && truths[id] >= 0)) {
    throw new Error(`${path.basename(file)}: truths must give a whole number for exactly ${TRUTH_IDS.join(', ')}`);
  }
  return truths;
}

function fixtureMeta(config, tables) {
  const rows = [
    { key: 'as_of', value: AS_OF },
    { key: 'generator_version', value: String(GENERATOR_VERSION) },
    { key: 'history_start', value: HISTORY_START },
    { key: 'schedule_horizon_end', value: scheduleHorizonEnd(AS_OF) },
    { key: 'seed', value: String(config.seed) },
  ];
  for (const table of TABLES) {
    if (table.name !== 'fixture_meta') rows.push({ key: `rows_${table.name}`, value: String(tables[table.name].length) });
  }
  return rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function csvValue(v, where) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError(`${where}: ${v} is not an integer`);
    return String(v);
  }
  if (typeof v !== 'string' || v === '') throw new TypeError(`${where}: expected a non-empty string, got ${JSON.stringify(v)}`);
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function toCsv(table, rows) {
  const names = table.columns.map((c) => c.name);
  const lines = [names.join(',')];
  for (const row of rows) {
    lines.push(names.map((n) => csvValue(row[n], `${table.name}.${n}`)).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// Generate every table and file in memory. With targets, plant them. Throws
// if a rule fails or a planted figure misses its target.
function generate(config) {
  const { seed, clients, targets = null } = config;
  if (!Number.isSafeInteger(clients) || clients < 1) throw new RangeError(`clients must be a positive integer, got ${clients}`);
  if (config.generator_version !== undefined && config.generator_version !== GENERATOR_VERSION) {
    throw new Error(`seed.json records generator_version ${config.generator_version}, this generator is ${GENERATOR_VERSION}: update seed.json and regenerate`);
  }
  const rng = createRng(seed);
  // Reference draws first, so adding activity left the reference files unchanged.
  const tables = buildReference(rng, { clients });
  Object.assign(tables, buildActivity(rng, tables, { asOf: AS_OF, targets }));
  // Labour, home details and the schedule: their own stream, after everything
  // above is final, so no earlier draw or value moves.
  const opsRng = createRng(deriveSeed(seed, OPERATIONS_STREAM));
  Object.assign(tables, buildOperations(opsRng, tables, { historyStart: HISTORY_START, asOf: AS_OF }));
  // Coordinates and the booked schedule (Story 14.1): their own stream too,
  // after the operations tables are final.
  const routingRng = createRng(deriveSeed(seed, ROUTING_STREAM));
  Object.assign(tables, buildRouting(routingRng, tables, { zones: ZONES, asOf: AS_OF }));
  tables.fixture_meta = fixtureMeta(config, tables);
  const ruleOpts = { zones: ZONES, historyStart: HISTORY_START, asOf: AS_OF };
  const problems = checkRules(tables, ruleOpts).concat(checkOperations(tables, ruleOpts), checkRouting(tables, ruleOpts));
  if (problems.length > 0) {
    throw new Error(`generated data breaks ${problems.length} rule(s):\n  ${problems.slice(0, 20).join('\n  ')}`);
  }
  if (targets) {
    const got = computeTruths(tables, { asOf: AS_OF });
    const missed = TRUTH_IDS.filter((id) => got[id] !== targets[id]);
    if (missed.length > 0) throw new Error(`planted figures missed: ${missed.map((id) => `${id} ${got[id]} (target ${targets[id]})`).join(', ')}`);
  }
  const files = new Map();
  files.set('schema.sql', schemaSql());
  for (const table of TABLES) {
    files.set(`${SEEDS_DIR}/${table.name}.csv`, toCsv(table, tables[table.name]));
  }
  return { tables, files };
}

// The name a generated file is stored under: seeds/<table>.csv.gz for every
// seed but the plain ones, else its own name.
function storedName(rel) {
  return rel.startsWith(`${SEEDS_DIR}/`) && !PLAIN_SEEDS.has(rel) ? `${rel}.gz` : rel;
}

// Deterministic gzip: no name, comment or time (zlib writes none), a fixed
// level, and the OS byte set to 255 (unknown) rather than the build's own.
function gzipSeed(content) {
  const gz = zlib.gzipSync(Buffer.from(content), { level: GZIP_LEVEL });
  gz[9] = GZIP_OS_UNKNOWN;
  return gz;
}

// What is wrong with a stored .gz's header, or null when it is one gzipSeed
// could have written. The deflate bytes are not compared (see the top).
function gzipHeaderProblem(buf) {
  if (buf.length < 18 || buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 8) return 'not a gzip file';
  if (buf[3] !== 0) return 'its gzip header stores a name, comment or extra field';
  if (buf.readUInt32LE(4) !== 0) return 'its gzip header stores a time';
  if (buf[9] !== GZIP_OS_UNKNOWN) return `its gzip header has OS byte ${buf[9]}, not ${GZIP_OS_UNKNOWN}`;
  return null;
}

// A stored file compared with what the generator writes for it: null when it
// matches, else the problem. A .gz matches on a valid header and identical
// unzipped content; anything else must match byte for byte.
function storedProblem(file, rel, content) {
  if (!fs.existsSync(file)) return 'missing (run npm run fixture:generate)';
  const raw = fs.readFileSync(file);
  if (storedName(rel) === rel) return raw.equals(Buffer.from(content)) ? null : 'differs from a fresh generate';
  const header = gzipHeaderProblem(raw);
  if (header) return header;
  let unzipped;
  try {
    unzipped = zlib.gunzipSync(raw);
  } catch (error) {
    return `does not unzip: ${error.message}`;
  }
  return unzipped.equals(Buffer.from(content)) ? null : 'differs from a fresh generate';
}

// Writes each file under its stored name. A .gz whose header is valid and
// whose unzipped content already matches is left alone, so files never churn
// between machines. The other form of a seed (a stale seeds/<table>.csv for a
// compressed table, or a .gz for a plain one) is deleted.
function writeFiles(outDir, files) {
  for (const [rel, content] of files) {
    const stored = storedName(rel);
    const target = path.join(outDir, stored);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stored === rel) {
      fs.writeFileSync(target, content);
      if (rel.startsWith(`${SEEDS_DIR}/`)) fs.rmSync(`${target}.gz`, { force: true });
    } else {
      if (storedProblem(target, rel, content) !== null) fs.writeFileSync(target, gzipSeed(content));
      fs.rmSync(path.join(outDir, rel), { force: true });
    }
  }
}

// Regenerate in memory and compare with `dir` (unzipped content for a .gz),
// including any seed file in `dir` the generator no longer writes.
function checkCommitted(dir = FIXTURE_DIR, config = readSeedConfig()) {
  const { files } = generate(config);
  const differences = [];
  const stored = new Set();
  for (const [rel, content] of files) {
    const name = storedName(rel);
    stored.add(name);
    const problem = storedProblem(path.join(dir, name), rel, content);
    if (problem) differences.push(`${name}: ${problem}`);
  }
  const seedsDir = path.join(dir, SEEDS_DIR);
  const extra = fs.existsSync(seedsDir) ? fs.readdirSync(seedsDir).filter((f) => !stored.has(`${SEEDS_DIR}/${f}`)) : [];
  for (const f of extra.sort()) differences.push(`${SEEDS_DIR}/${f}: not written by the generator`);
  return differences;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    const integer = () => {
      const v = value();
      if (!/^\d+$/.test(v)) throw new Error(`${a} must be a whole number, got ${v}`);
      return Number(v);
    };
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--check') args.check = true;
    else if (a === '--seed') args.seed = integer();
    else if (a === '--clients') args.clients = integer();
    else if (a === '--out') args.out = path.resolve(value());
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.check && (args.seed !== undefined || args.clients !== undefined || args.out)) {
    throw new Error('--check always uses the recorded seed.json and the committed files; drop the other flags');
  }
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`fixture: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    if (args.check) {
      const differences = checkCommitted();
      if (differences.length > 0) {
        console.error(`fixture: committed files do not match the generator:\n  ${differences.join('\n  ')}\nRun npm run fixture:generate and commit the result.`);
        return 1;
      }
      console.log('fixture: committed files match a fresh generate');
      return 0;
    }
    const recorded = readSeedConfig();
    const variant = args.seed !== undefined || args.clients !== undefined;
    const config = variant ? { seed: args.seed ?? recorded.seed, clients: args.clients ?? recorded.clients } : recorded;
    const outDir = args.out || FIXTURE_DIR;
    const { tables, files } = generate(config);
    writeFiles(outDir, files);
    const counts = TABLES.map((t) => `${t.name} ${tables[t.name].length}`).join(', ');
    console.log(`fixture: seed ${config.seed} wrote ${files.size} files to ${path.relative(process.cwd(), outDir) || '.'} (${counts})`);
    return 0;
  } catch (error) {
    console.error(`fixture: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { generate, writeFiles, checkCommitted, storedName, gzipSeed, gzipHeaderProblem, readSeedConfig, readTargets, toCsv, main, GENERATOR_VERSION };
