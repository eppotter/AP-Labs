#!/usr/bin/env node
'use strict';

// Brightside's fixture generator (Stories 7.1 and 7.2, AD-18). Offline and
// deterministic: the recorded seed (seed.json) and this code give
// byte-identical files. With the recorded seed it also plants the known
// truths' figures from targets.json and refuses to write if one misses.
//
//   npm run fixture:generate            write schema.sql and seeds/*.csv here
//   npm run fixture:check               regenerate into a temp dir and diff
//                                       against the committed files (CI)
//   node generate.js --seed N --clients N --out DIR   a one-off variant
//                                       (unplanted: targets fit the recorded seed)
//
// Seed files are CSV: a header row, rows in primary-key order, LF endings,
// integers as plain digits, dates as YYYY-MM-DD, NULL as an empty field.
// Exit codes: 0 ok, 1 check found a difference or a rule failed, 2 usage.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRng } = require('./lib/prng');
const { TABLES, schemaSql } = require('./lib/tables');
const { buildReference, ZONES, HISTORY_START, AS_OF } = require('./lib/reference');
const { checkRules } = require('./lib/rules');
const { buildActivity } = require('./lib/activity');
const { TRUTH_IDS, computeTruths } = require('./lib/truths');

// Bump when a change to this code changes the output for the same seed.
const GENERATOR_VERSION = 2;

const FIXTURE_DIR = __dirname;
const SEED_FILE = path.join(FIXTURE_DIR, 'seed.json');
const TARGETS_FILE = path.join(FIXTURE_DIR, 'targets.json');
const SEEDS_DIR = 'seeds';

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
  tables.fixture_meta = fixtureMeta(config, tables);
  const problems = checkRules(tables, { zones: ZONES, historyStart: HISTORY_START, asOf: AS_OF });
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

function writeFiles(outDir, files) {
  for (const [rel, content] of files) {
    const target = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

// Regenerate into a temp dir and compare byte for byte with `dir`, including
// any seed file in `dir` the generator no longer writes.
function checkCommitted(dir = FIXTURE_DIR, config = readSeedConfig()) {
  const { files } = generate(config);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brightside-fixture-'));
  const differences = [];
  try {
    writeFiles(tmp, files);
    for (const rel of files.keys()) {
      const committed = path.join(dir, rel);
      if (!fs.existsSync(committed)) differences.push(`${rel}: missing (run npm run fixture:generate)`);
      else if (!fs.readFileSync(committed).equals(fs.readFileSync(path.join(tmp, rel)))) {
        differences.push(`${rel}: differs from a fresh generate`);
      }
    }
    const seedsDir = path.join(dir, SEEDS_DIR);
    const extra = fs.existsSync(seedsDir) ? fs.readdirSync(seedsDir).filter((f) => !files.has(`${SEEDS_DIR}/${f}`)) : [];
    for (const f of extra.sort()) differences.push(`${SEEDS_DIR}/${f}: not written by the generator`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

module.exports = { generate, writeFiles, checkCommitted, readSeedConfig, readTargets, toCsv, main, GENERATOR_VERSION };
