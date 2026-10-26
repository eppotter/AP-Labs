'use strict';

// The travel port (Story 12.1, AD-R3). The engine never works out distance:
// it calls travel(fromNode, toNode) and gets whole minutes back, synchronously.
// fromMatrix builds that function over a prefetched rectangle of rows
// { from_node, to_node, minutes } (from travelMatrix today; a maps connector
// later supplies the same shape). A pair the matrix lacks throws RoutingFault,
// never 0, so a missing drive is never mistaken for a free one. There is no
// return leg to base and no self pair unless the rows hold one.

const { RoutingFault } = require('../errors');
const { NODE } = require('./contract');

const KEY_SEP = '\u0000';

function checkRow(row, at) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new RoutingFault({ field: at, problem: 'not_object' });
  for (const key of ['from_node', 'to_node']) {
    if (row[key] === undefined) throw new RoutingFault({ field: `${at}.${key}`, problem: 'missing' });
    if (typeof row[key] !== 'string' || !NODE.test(row[key])) throw new RoutingFault({ field: `${at}.${key}`, problem: 'bad_node' });
  }
  if (row.minutes === undefined) throw new RoutingFault({ field: `${at}.minutes`, problem: 'missing' });
  if (!Number.isSafeInteger(row.minutes)) throw new RoutingFault({ field: `${at}.minutes`, problem: 'not_integer' });
  if (row.minutes < 0) throw new RoutingFault({ field: `${at}.minutes`, problem: 'out_of_range' });
}

function fromMatrix(rows) {
  if (!Array.isArray(rows)) throw new RoutingFault({ field: 'matrix', problem: 'not_list' });
  const minutes = new Map();
  rows.forEach((row, i) => {
    checkRow(row, `matrix[${i}]`);
    const key = `${row.from_node}${KEY_SEP}${row.to_node}`;
    if (minutes.has(key)) throw new RoutingFault({ field: `matrix[${i}]`, problem: 'duplicate' });
    minutes.set(key, row.minutes);
  });
  return Object.freeze(function travel(fromNode, toNode) {
    const m = minutes.get(`${fromNode}${KEY_SEP}${toNode}`);
    if (m === undefined) throw new RoutingFault({ field: 'travel', problem: 'no_travel', from: String(fromNode), to: String(toNode) });
    return m;
  });
}

module.exports = { fromMatrix };
