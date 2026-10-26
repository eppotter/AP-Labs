'use strict';

// Brightside's routing truths (Story 14.4, data-design §5, runtime AD-18):
// the planted scenarios S1 to S3 run through Brightside's adapter and the
// routing engine, on the same governed, read-only data as the app, and print
// one number for `npm run verify` to judge against data.md.
//
//   node examples/brightside/fixture/truths/routing.js <truth-id>
//
//   route-optimize-s1-drive    S1: the booked drive minutes (travelMatrix);
//                              fails unless optimized <= booked, no hard
//                              break (booked or optimized) and none unplaced
//   route-change-s2-top        S2: the property_id of the top-ranked fill
//   route-change-s2-count      S2: how many candidates are valid
//   route-change-s3-crosszone  S3: in-zone, cross-zone recommendations and
//                              unplaced as one number, 100 x in-zone + 10 x
//                              cross-zone + unplaced (5 / 1 / 0 prints 510);
//                              a count above 9 cannot be written that way
//                              and fails
//
// A truth prints one number (kit/lib/truths), so S3's three counts are packed
// into one; each count is also printed on its own line above it for a person
// reading the output. The profile and data file are found as the query
// runner finds them (kit/fixture/query.js): the governing profile, and
// APLABS_DATA_PATH or <var>/fixture/<client id>.duckdb. Build the fixture
// first: npm run fixture:build.
//
// Output never holds a coordinate (GRD-002): the adapter reads drive times
// only through travelMatrix, which returns whole minutes, and this script
// prints only counts, minutes and ids. An error prints fixed text: a refusal's
// own fixed message, else only the error's class name, never a raw message
// that could quote data.
//
// Exit codes: 0 printed, 1 the scenario missed a condition, the fixture is
// not built or a read failed, 2 usage or profile error.

const fs = require('node:fs');
const sdk = require('#sdk');
const { governingProfilePath, loadProfile, PROFILE_REL } = require('../../../../kit/lib/profile');
const { createData, dataPathFor } = require('../../../../kit/runtime/data');
const { RuntimeRefusal } = require('../../../../kit/runtime/errors');
const { notBuilt, shownPath, PROFILE_ERRORS } = require('../../../../kit/fixture/validate');
const { createAdapter } = require('../../app/routing/adapter');
const { S1, S2, S3 } = require('../lib/scenarios');
const { toDay, toIso } = require('../lib/days');

const { routing: engine } = sdk;

const USAGE = 'usage: node examples/brightside/fixture/truths/routing.js <truth-id>';
const AS_OF_SQL = "SELECT value FROM fixture_meta WHERE key = 'as_of'";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROPERTY_NODE = /^property:(\d+)$/;

// A scenario that misses one of its conditions: fixed text, no data.
class Missed extends Error {}

// S3's three counts as one number: each must be a single digit.
function packS3({ in_zone: inZone, cross_zone: crossZone, unplaced }) {
  for (const n of [inZone, crossZone, unplaced]) {
    if (!Number.isSafeInteger(n) || n < 0 || n > 9) throw new Missed('S3: a count is outside 0 to 9 and cannot be packed into one number');
  }
  return inZone * 100 + crossZone * 10 + unplaced;
}

async function s1Drive({ adapter, dayOf }) {
  const { input, travel } = await adapter.dayInput({ day: dayOf(S1.dayOffset), crewIds: [String(S1.crewId)] });
  const result = engine.optimizeDay(input, { travel });
  if (result.booked.hardBreaks !== 0) throw new Missed('S1: the booked day breaks a hard rule');
  if (result.cost.hardBreaks !== 0) throw new Missed('S1: the optimized day breaks a hard rule');
  if (result.unplaced.length !== 0) throw new Missed('S1: the optimized day leaves a stop unplaced');
  if (!(result.cost.driveMinutes <= result.booked.driveMinutes)) throw new Missed('S1: the optimized day drives longer than the booked day');
  return [`optimized drive minutes ${result.cost.driveMinutes}`, result.booked.driveMinutes];
}

async function s2Gap({ adapter, dayOf, routing }) {
  const { input, travel } = await adapter.gapInput({ day: dayOf(S2.dayOffset), crewId: S2.crewId });
  const gf = routing.gap_fill || {};
  const opts = { travel, horizonDays: gf.horizon_days, limit: gf.limit };
  if (gf.weights) opts.weights = gf.weights;
  const result = engine.fillGap(input, opts);
  if (result.gaps.length !== 1) throw new Missed('S2: the crew\'s day does not have exactly one gap');
  return { input, gap: result.gaps[0] };
}

async function s2Top(ctx) {
  const { input, gap } = await s2Gap(ctx);
  if (gap.candidates.length === 0) throw new Missed('S2: no valid candidate');
  const top = input.candidates.find((c) => c.stopId === gap.candidates[0].stopId);
  const m = top && PROPERTY_NODE.exec(top.node);
  if (!m) throw new Missed('S2: the top candidate is not a property');
  return [m[1]];
}

async function s2Count(ctx) {
  const { gap } = await s2Gap(ctx);
  return [gap.valid];
}

async function s3CrossZone({ adapter, dayOf }) {
  const { input, travel } = await adapter.dayInput({ day: dayOf(S3.dayOffset) });
  const result = engine.placeOrphans(input, { travel });
  if (result.crewsOut.length !== 1 || result.crewsOut[0] !== String(S3.crewId)) throw new Missed('S3: the planted crew is not the one crew out');
  const counts = {
    in_zone: result.moves.filter((m) => !m.crossZone).length,
    cross_zone: result.moves.filter((m) => m.crossZone && m.recommendation).length,
    unplaced: result.unplaced.length,
  };
  return [`in_zone ${counts.in_zone}`, `cross_zone ${counts.cross_zone}`, `unplaced ${counts.unplaced}`, packS3(counts)];
}

const TRUTHS = Object.freeze({
  'route-optimize-s1-drive': s1Drive,
  'route-change-s2-top': s2Top,
  'route-change-s2-count': s2Count,
  'route-change-s3-crosszone': s3CrossZone,
});

// Fixed text for an error: a refusal's or a miss's own message (fixed by
// construction), else the class name only.
function describe(err) {
  if (err instanceof Missed || err instanceof RuntimeRefusal) return err.message;
  return `failed (${(err && err.constructor && err.constructor.name) || 'Error'})`;
}

async function main(argv, { env = process.env, cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    out(USAGE);
    return 0;
  }
  if (argv.length !== 1 || !Object.hasOwn(TRUTHS, argv[0])) {
    err(`routing truth: expected one of ${Object.keys(TRUTHS).join(', ')}\n${USAGE}`);
    return 2;
  }
  const id = argv[0];
  let profile;
  try {
    const profileFile = governingProfilePath(null, cwd, env);
    if (!profileFile) {
      err(`routing truth: no profile (set APLABS_PROFILE or add ${PROFILE_REL})`);
      return 2;
    }
    profile = loadProfile(profileFile);
  } catch (e) {
    if (!PROFILE_ERRORS.has(e.code)) throw e;
    err(`routing truth: ${e.message}`);
    return 2;
  }
  if (!profile.routing) {
    err('routing truth: the profile has no routing block');
    return 2;
  }
  const where = dataPathFor(profile, env);
  if (where.problem) {
    err(`routing truth: ${where.problem}`);
    return 2;
  }
  if (!fs.existsSync(where.path)) {
    err(`routing truth: ${notBuilt(shownPath(cwd, where.path))}`);
    return 1;
  }
  const data = createData({ file: where.path, profile });
  try {
    const rows = await data.run(AS_OF_SQL);
    const asOf = rows.length === 1 ? rows[0].value : null;
    if (typeof asOf !== 'string' || !ISO_DATE.test(asOf)) throw new Missed('fixture_meta has no as_of date');
    const dayOf = (offset) => toIso(toDay(asOf) + offset);
    const adapter = createAdapter({ data, routing: profile.routing });
    const lines = await TRUTHS[id]({ adapter, dayOf, routing: profile.routing });
    for (const line of lines) out(String(line));
    return 0;
  } catch (e) {
    err(`routing truth ${id}: ${describe(e)}`);
    return 1;
  } finally {
    data.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`routing truth: ${describe(e)}`);
    process.exitCode = 1;
  });
}

module.exports = { main, packS3, describe, Missed, TRUTH_IDS: Object.freeze(Object.keys(TRUTHS)), USAGE };
