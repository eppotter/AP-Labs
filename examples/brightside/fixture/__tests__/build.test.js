'use strict';

// Story 7.3: Brightside's committed schema and seeds build into DuckDB.
// Example test (AD-1 carve-out): it reads Brightside's own fixture and goes
// with it in a fork. It builds into a temporary directory, never var/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, readRows } = require('../../../../kit/fixture/build');

const FIXTURE_DIR = path.join(__dirname, '..');

function meta() {
  const lines = fs.readFileSync(path.join(FIXTURE_DIR, 'seeds', 'fixture_meta.csv'), 'utf8').trim().split('\n').slice(1);
  return Object.fromEntries(lines.map((l) => l.split(',')));
}

test('Brightside builds in under 60 seconds with every table at its fixture_meta count', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brightside-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'brightside.duckdb');

  const result = await build({ fixtureDir: FIXTURE_DIR, out });
  assert.ok(result.ms < 60_000, `build took ${result.ms} ms`);

  const m = meta();
  const expected = Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('rows_')).map(([k, v]) => [k.slice(5), Number(v)]));
  assert.equal(Object.keys(expected).length, 13);
  const loaded = Object.fromEntries(result.tables.filter((x) => x.name !== 'fixture_meta').map((x) => [x.name, x.rows]));
  assert.deepEqual(loaded, expected);

  // Counted again from the file itself, opened read-only.
  const union = Object.keys(expected).map((table) => `SELECT '${table}' AS t, count(*)::INT AS n FROM ${table}`).join(' UNION ALL ');
  const counted = Object.fromEntries((await readRows(out, union)).map((r) => [r.t, r.n]));
  assert.deepEqual(counted, expected);

  // Spot rows: the first client and property, with zero-padded postal codes kept as text.
  assert.deepEqual(await readRows(out, 'SELECT client_id, zone_id, first_name, last_name, email, created_on FROM clients WHERE client_id = 1'), [
    { client_id: 1, zone_id: 'central', first_name: 'Briar', last_name: 'Redley', email: 'briar.redley.1@home.invalid', created_on: '2024-12-07' },
  ]);
  assert.deepEqual(await readRows(out, 'SELECT property_id, client_id, city, postal_code FROM properties WHERE property_id = 1'), [
    { property_id: 1, client_id: 1, city: 'Centerpoint', postal_code: '00402' },
  ]);
  // A one-package invoice line has a NULL add-on, not an empty string.
  assert.deepEqual(await readRows(out, 'SELECT line_id, package_id, add_on_id, amount_cents FROM invoice_lines WHERE line_id = 1'), [
    { line_id: 1, package_id: 'standard', add_on_id: null, amount_cents: '14600' },
  ]);
  assert.deepEqual(await readRows(out, "SELECT value FROM fixture_meta WHERE key = 'as_of'"), [{ value: m.as_of }]);
});
