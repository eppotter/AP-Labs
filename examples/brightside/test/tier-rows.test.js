'use strict';

// Brightside's runtime tier rows (Story 6.1): `node kit/lib/tier` returns each
// row's tier for a path under it. An example test (architecture carve-out): it
// reads profiles/brightside/ and is deleted with the example in a fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '../../..');
const PROFILE = path.join(ROOT, 'profiles/brightside/profile.yml');
const TIER_CLI = path.join(ROOT, 'kit/lib/tier/index.js');

const ROWS = {
  'kit/runtime/archetypes/approval-write/index.js': 'T3',
  'kit/runtime/connectors/contract.js': 'T3',
  'kit/lib/secrets/index.js': 'T3',
  // Brightside's T2 rows for sql, data and llm are overridden by the engine's
  // T3 floor (#68; llm since Story 9.1).
  'kit/runtime/sql/guardrail.js': 'T3',
  'kit/runtime/data/index.js': 'T3',
  'kit/runtime/llm/index.js': 'T3',
  // Story 13.3: the routing engine is a declared T2 for Brightside.
  'kit/runtime/routing/index.js': 'T2',
  'kit/runtime/routing/contract.js': 'T2',
};

function tierCli(paths) {
  const r = spawnSync(process.execPath, [TIER_CLI, ...paths], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, APLABS_PROFILE: PROFILE },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

for (const [file, tier] of Object.entries(ROWS)) {
  test(`brightside tier rows: ${file} is ${tier}`, () => {
    assert.equal(tierCli([file]).tier, tier);
  });
}

test('brightside tier rows: other runtime paths stay T1', () => {
  assert.equal(tierCli(['kit/runtime/slack/handle.js']).tier, 'T1');
});
