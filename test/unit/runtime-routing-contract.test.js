'use strict';

// The depot node kind (Story 15.12, AD-R2 amended, AD-R23). A node id is
// property:<id>, crew:<id> or depot:<id>, in the input contract and in the
// travel port's matrix rows alike; any other prefix is still refused.
// Inputs are synthetic and come from test/fixtures/routing/*.json only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const routing = require('../../kit/runtime/routing');
const { RoutingFault } = require('../../kit/runtime/errors');
const { messageFor } = require('../../kit/runtime/messages');

const DAY = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/routing/route-depot.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

function faultOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof RoutingFault, `expected a RoutingFault, got ${err && err.name}`);
    return err.details;
  }
  return assert.fail('expected a RoutingFault');
}

test('depot:x as a crew baseNode is accepted by validateInput', () => {
  const input = clone(DAY.input);
  assert.equal(input.crews[0].baseNode, 'depot:office');
  assert.equal(routing.validateInput(input), input);
});

test('place:x is still refused as a baseNode and as a stop node, naming the field', () => {
  const base = clone(DAY.input);
  base.crews[0].baseNode = 'place:office';
  assert.deepEqual(faultOf(() => routing.validateInput(base)), { field: 'crews[0].baseNode', problem: 'bad_node' });
  const stop = clone(DAY.input);
  stop.stops[2].node = 'place:p3';
  assert.deepEqual(faultOf(() => routing.validateInput(stop)), { field: 'stops[2].node', problem: 'bad_node' });
  for (const bad of ['depot:', 'depot:a b', 'Depot:office', 'depots:office', 'depot:office:2']) {
    const input = clone(DAY.input);
    input.crews[0].baseNode = bad;
    assert.deepEqual(faultOf(() => routing.validateInput(input)), { field: 'crews[0].baseNode', problem: 'bad_node' }, bad);
  }
});

test('travel.fromMatrix accepts depot:x rows both ways and answers them', () => {
  const travel = routing.travel.fromMatrix(DAY.matrix);
  assert.equal(travel('depot:office', 'property:p2'), 20);
  assert.equal(travel('property:p5', 'depot:office'), 17);
});

test('travel.fromMatrix still refuses a place:x row, naming the field', () => {
  const from = clone(DAY.matrix);
  from[0].from_node = 'place:office';
  assert.deepEqual(faultOf(() => routing.travel.fromMatrix(from)), { field: 'matrix[0].from_node', problem: 'bad_node' });
  const to = clone(DAY.matrix);
  to[1].to_node = 'place:p2';
  assert.deepEqual(faultOf(() => routing.travel.fromMatrix(to)), { field: 'matrix[1].to_node', problem: 'bad_node' });
});

test('the bad_node words name all three node kinds and never the value', () => {
  const words = messageFor(new RoutingFault({ field: 'crews[0].baseNode', problem: 'bad_node' }), { admin: 'Sam' });
  assert.match(words, /depot:&lt;id&gt;/);
  assert.match(words, /crews\[0\]\.baseNode/);
});
