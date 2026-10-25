'use strict';

// Brightside's SQL files (Story 9.5): the engine test "no SQL file in any app
// dir or template contains ${" (test/unit/scoped-pull-run.test.js) walks every
// examples/<name>/app dir. This example test pins that the walk really reaches
// Brightside's scoped pulls, Win-back, Unpaid invoices and Labour cost, and that each is
// fixed SQL text.
//
// An example test (architecture carve-out): it reads Brightside's app dir and
// is deleted with the example in a fork, so the engine test stays free of
// client paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '../app');

test('the Brightside app dir holds the Win-back, Unpaid invoices and Labour cost SQL, and none contains "${"', () => {
  const files = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) walk(abs);
      else if (d.name.endsWith('.sql')) files.push(path.relative(APP_DIR, abs));
    }
  };
  walk(APP_DIR);
  assert.ok(files.includes(path.join('modules', 'win-back', 'win-back.sql')), files.join(', '));
  assert.ok(files.includes(path.join('modules', 'unpaid-invoices', 'unpaid-invoices.sql')), files.join(', '));
  assert.ok(files.includes(path.join('modules', 'labour-cost', 'labour-cost.sql')), files.join(', '));
  for (const f of files) assert.ok(!fs.readFileSync(path.join(APP_DIR, f), 'utf8').includes('${'), f);
});
