'use strict';

// Story 14.4: the routing truth script's own edges (truths/routing.js). The
// five truths reconciling under verify, and the no-coordinate scan of their
// output, are in validate.test.js on a temp build. Example test (AD-1
// carve-out): it goes with Brightside's fixture in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { main, packS3, describe, Missed, TRUTH_IDS } = require('../truths/routing');
const { RoutingFault } = require('../../../../kit/runtime/errors');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const PROFILE_FILE = path.join(REPO, 'profiles', 'brightside', 'profile.yml');

async function run(argv, env) {
  const [out, err] = [[], []];
  const code = await main(argv, { env, cwd: REPO, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

test('the script answers the four engine truths of data-design §5', () => {
  assert.deepEqual(TRUTH_IDS, ['route-optimize-s1-drive', 'route-change-s2-top', 'route-change-s2-count', 'route-change-s3-crosszone']);
});

test('S3 packs in-zone, cross-zone and unplaced into one number, each a single digit', () => {
  assert.equal(packS3({ in_zone: 5, cross_zone: 1, unplaced: 0 }), 510);
  assert.equal(packS3({ in_zone: 0, cross_zone: 0, unplaced: 6 }), 6);
  for (const bad of [{ in_zone: 10, cross_zone: 0, unplaced: 0 }, { in_zone: 5, cross_zone: -1, unplaced: 0 }, { in_zone: 5, cross_zone: 1, unplaced: 0.5 }]) {
    assert.throws(() => packS3(bad), Missed);
  }
});

test('an unknown or missing truth id is a usage error (exit 2) and reads nothing', async () => {
  for (const argv of [[], ['route-nope'], ['route-change-s2-top', 'extra'], ['__proto__']]) {
    const { code, out, err } = await run(argv, { APLABS_GOVERNING_PROFILE: PROFILE_FILE });
    assert.equal(code, 2, argv.join(' '));
    assert.deepEqual(out, []);
    assert.match(err.join('\n'), /expected one of route-optimize-s1-drive/);
  }
});

test('with the fixture not built it exits 1 with a plain message and prints no number', async () => {
  const { code, out, err } = await run(['route-change-s2-top'], {
    APLABS_GOVERNING_PROFILE: PROFILE_FILE,
    APLABS_DATA_PATH: path.join(REPO, 'var', 'no-such-dir', 'missing.duckdb'),
  });
  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.match(err.join('\n'), /^routing truth: /);
});

test('with no profile it exits 2', async () => {
  const { code, out } = await run(['route-change-s2-top'], { APLABS_GOVERNING_PROFILE: path.join(REPO, 'no-such-profile.yml') });
  assert.equal(code, 2);
  assert.deepEqual(out, []);
});

test('an error prints fixed text: a refusal or a miss shows its message, anything else only its class name', () => {
  assert.equal(describe(new Missed('S1: the booked day breaks a hard rule')), 'S1: the booked day breaks a hard rule');
  assert.match(describe(new RoutingFault({ field: 'day', problem: 'bad_date' })), /routing input refused: "day" bad_date/);
  // A raw error could quote data (a value in a DuckDB message): never shown.
  assert.equal(describe(new Error('value -40211185 out of range')), 'failed (Error)');
  assert.equal(describe(new TypeError('x -129.81216')), 'failed (TypeError)');
  assert.equal(describe(null), 'failed (Error)');
});
