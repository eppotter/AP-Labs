'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const at = (p) => path.join(root, p);
const readJson = (p) => JSON.parse(fs.readFileSync(at(p), 'utf8'));

test('scaffold layout exists', () => {
  for (const p of [
    'kit/plugin/.claude-plugin/plugin.json',
    'kit/plugin/hooks',
    'kit/plugin/agents',
    'kit/plugin/skills',
    'kit/lib/profile/index.js',
    'kit/lib/permissions/index.js',
    'kit/lib/tier/index.js',
    'kit/verify/run-all.sh',
    'profiles/_schema/profile.schema.json',
    'profiles/brightside/profile.yml',
    'examples/brightside-install',
    'test/acceptance',
    'docs/adr',
  ]) {
    assert.ok(fs.existsSync(at(p)), `missing ${p}`);
  }
});

test('plugin manifest names the kit', () => {
  const manifest = readJson('kit/plugin/.claude-plugin/plugin.json');
  assert.equal(manifest.name, 'ap-labs-kit');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('profile schema is a 2020-12 JSON Schema', () => {
  const schema = readJson('profiles/_schema/profile.schema.json');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('not-implemented helper throws a coded error', () => {
  const { notImplemented } = require(at('kit/lib/not-implemented'));
  assert.throws(() => notImplemented('x')(), { code: 'NOT_IMPLEMENTED' });
});

test('verify harness reports zero checks as skipped, not passed', () => {
  const out = execFileSync('bash', [at('kit/verify/run-all.sh')], { encoding: 'utf8' });
  assert.match(out, /SKIPPED/);
  assert.doesNotMatch(out, /PASS/);
});
