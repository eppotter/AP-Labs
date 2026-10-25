'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadProfile, validateProfile } = require('../../kit/lib/profile');
const { tierOf, tierFloor, maxTier, resolveTier, globMatcher, isEngineFloor, ENGINE_T3 } = require('../../kit/lib/tier');

const fixture = path.join(__dirname, '../fixtures/profiles/tiers.yml');
const profile = loadProfile(fixture);
const tier = (p) => tierOf(profile, p);

test('profile tiers, highest match wins', () => {
  assert.equal(tier('pay/charge.js'), 'T3');
  assert.equal(tier('secrets.json'), 'T3');
  assert.equal(tier('app/server.js'), 'T2');
  assert.equal(tier('Dockerfile'), 'T2');
  assert.equal(tier('lib/util.js'), 'T1');
  assert.equal(tier('pay/README.md'), 'T3', 'a tier rule beats inert');
});

test('unmatched code floors at T1, never T0', () => {
  assert.equal(tier('scripts/x.sh'), 'T1');
  assert.equal(tier('docs/build.js'), 'T0', 'docs/** is declared inert by this profile');
});

test('inert paths floor at T0', () => {
  assert.equal(tier('README.md'), 'T0');
  assert.equal(tier('docs/guide/setup.txt'), 'T0');
});

test('.aplabs/** is always T3, even when the profile marks it inert', () => {
  assert.equal(tier('.aplabs/profile.yml'), 'T3');
  assert.equal(tier('.APLABS/profile.yml'), 'T3');
});

test('agent instruction files are never inert', () => {
  // .claude/settings.json is an engine T3 floor (below); the rest of .claude/** stays T1.
  for (const p of ['CLAUDE.md', 'docs/claude.md', 'AGENTS.md', 'x/SKILL.md', 'CLAUDE.local.md', '.claude/settings.local.json', '.claude/agents/builder.md', 'a/.Claude/x.md']) {
    assert.equal(tier(p), 'T1', p);
  }
});

// Engine floors (#68). One sample file per guarded path, so the list and the
// tests cannot drift apart silently.
const GUARDED = {
  '.aplabs/**': '.aplabs/context/data.md',
  'kit/runtime/access/**': 'kit/runtime/access/index.js',
  'kit/lib/permissions/**': 'kit/lib/permissions/index.js',
  'kit/lib/profile/**': 'kit/lib/profile/schema.json',
  'kit/lib/secrets/**': 'kit/lib/secrets/index.js',
  'kit/fixture/publish.js': 'kit/fixture/publish.js',
  'kit/fixture/remote.js': 'kit/fixture/remote.js',
  'kit/fixture/motherduck.js': 'kit/fixture/motherduck.js',
  'kit/fixture/md-probe.js': 'kit/fixture/md-probe.js',
  'kit/runtime/data/**': 'kit/runtime/data/motherduck.js',
  'kit/runtime/sql/**': 'kit/runtime/sql/index.js',
  'kit/lib/tier/**': 'kit/lib/tier/index.js',
  'kit/lib/gate/**': 'kit/lib/gate/index.js',
  'kit/hooks/**': 'kit/hooks/README.md',
  '.claude/settings.json': '.claude/settings.json',
  '.codex/hooks.json': '.codex/hooks.json',
};

test('ENGINE_T3 lists exactly the guarded paths, and is frozen', () => {
  assert.deepEqual([...ENGINE_T3], Object.keys(GUARDED));
  assert.ok(Object.isFrozen(ENGINE_T3));
});

test('every engine floor scores T3, under a minimal profile and this one', () => {
  const minimal = validateProfile({ schema_version: 1, client: { id: 'm', name: 'M' }, users: [{ id: 'a', name: 'A', role: 'admin' }] });
  for (const p of Object.values(GUARDED)) {
    assert.equal(tierOf(minimal, p), 'T3', p);
    assert.equal(tier(p), 'T3', `${p} (a profile that marks **/*.md inert)`);
    assert.equal(tierFloor(minimal, ['README.md', p]), 'T3', `${p} in a change`);
  }
  assert.equal(tierOf(minimal, 'kit/lib/gate/deep/nested/x.js'), 'T3', '** matches any depth');
});

const lowered = loadProfile(path.join(__dirname, '../fixtures/profiles/lowered-floors.yml'));

test('a profile cannot lower an engine floor through tiers.T1, tiers.T2 or inert', () => {
  for (const p of Object.values(GUARDED)) assert.equal(tierOf(lowered, p), 'T3', p);
  // The fixture's rows do apply to everything else.
  assert.equal(tierOf(lowered, 'kit/fixture/build.js'), 'T2', 'tiers.T2 kit/fixture/**');
  assert.equal(tierOf(lowered, 'kit/runtime/slack/handle.js'), 'T1', 'tiers.T1 kit/**');
  assert.equal(tierOf(lowered, '.claude/settings.local.json'), 'T1');
  assert.deepEqual(resolveTier(lowered, ['kit/runtime/sql/index.js'], 'T1'), { floor: 'T3', tier: 'T3', belowFloor: true });
});

test('nearby paths outside the floors keep their current tier', () => {
  const minimal = validateProfile({ schema_version: 1, client: { id: 'm', name: 'M' }, users: [{ id: 'a', name: 'A', role: 'admin' }] });
  const nearby = [
    'kit/fixture/build.js', 'kit/fixture/query.js', 'kit/fixture/publish.test.js', 'kit/fixture/publish.jsx',
    'kit/runtime/slack/handle.js', 'kit/runtime/sqlite/x.js', 'kit/runtime/database/x.js', 'kit/runtime/connectors/contract.js',
    'kit/lib/review/index.js', 'kit/lib/tiers/x.js', 'kit/lib/gateway/x.js', 'kit/hooks.js', 'kit/lib/profile.js',
    '.codex/config.toml', 'docs/kit/hooks/README.md',
  ];
  for (const p of nearby) assert.equal(tierOf(minimal, p), 'T1', p);
  assert.equal(tier('kit/hooksREADME.md'), 'T0', 'a profile can still mark a nearby doc inert');
  assert.equal(tierOf(minimal, '.claude/agents/x.md'), 'T1', 'the rest of .claude/** is an instruction file, T1');
});

test('engine floors follow the engine rules: case, normalising, leaving the repo', () => {
  for (const p of ['KIT/Lib/Gate/index.js', 'Kit/Fixture/Publish.JS', '.CLAUDE/Settings.json', '.Codex/HOOKS.json', 'kit/runtime/SQL/x.js']) {
    assert.equal(tierOf(lowered, p), 'T3', p);
  }
  for (const p of ['./kit/lib/tier/index.js', 'docs/../kit/hooks/x.sh', 'kit\\lib\\secrets\\index.js', 'kit//runtime//data/x.js']) {
    assert.equal(tierOf(lowered, p), 'T3', p);
  }
  for (const p of ['../kit/lib/gate/index.js', '/repo/kit/lib/gate/index.js']) assert.equal(tierOf(lowered, p), 'T3', p);
});

test('isEngineFloor: guarded paths and paths leaving the repo; no profile involved', () => {
  for (const p of Object.values(GUARDED)) assert.ok(isEngineFloor(p), p);
  assert.ok(isEngineFloor('KIT/HOOKS/x.sh'));
  assert.ok(isEngineFloor('../x.js'));
  assert.ok(isEngineFloor('/etc/passwd'));
  assert.ok(isEngineFloor('docs/../.aplabs/profile.yml'));
  for (const p of ['kit/fixture/build.js', 'kit/runtime/slack/x.js', 'kit/lib/review/x.js', 'sandbox/a.js', '.claude/settings.local.json']) {
    assert.ok(!isEngineFloor(p), p);
  }
});

test('raising rules ignore case; the lowering (inert) rule does not', () => {
  assert.equal(tier('Pay/charge.js'), 'T3');
  assert.equal(tier('APP/server.js'), 'T2');
  assert.equal(tier('DOCS/guide.txt'), 'T1', 'case variant of an inert dir does not lower');
  assert.equal(tier('README.MD'), 'T1');
});

test('paths are normalised before matching', () => {
  assert.equal(tier('./pay/charge.js'), 'T3');
  assert.equal(tier('docs/../pay/charge.js'), 'T3', 'traversal out of an inert dir');
  assert.equal(tier('pay\\charge.js'), 'T3', 'Windows separators');
  assert.equal(tier('docs//guide.md'), 'T0');
});

test('paths outside the repo, absolute or empty floor at T3', () => {
  for (const p of ['../other/x.js', '/etc/passwd', 'C:/x.js', 'docs/../../x.md', '', '.']) assert.equal(tier(p), 'T3', JSON.stringify(p));
});

test('tierFloor: highest tier wins; T0 only when every path is inert', () => {
  assert.equal(tierFloor(profile, ['README.md', 'docs/a.md']), 'T0');
  assert.equal(tierFloor(profile, ['README.md', 'lib/a.js']), 'T1');
  assert.equal(tierFloor(profile, ['lib/a.js', 'app/b.js', 'README.md']), 'T2');
  assert.equal(tierFloor(profile, ['README.md', 'pay/x.js', 'lib/a.js']), 'T3');
});

test('tierFloor: no paths is an error, never T0', () => {
  assert.throws(() => tierFloor(profile, []), /no paths/);
  assert.throws(() => tierFloor(profile, undefined), /no paths/);
});

test('maxTier', () => {
  assert.equal(maxTier('T1', 'T3'), 'T3');
  assert.equal(maxTier('T2', 'T0'), 'T2');
  assert.equal(maxTier('bogus', 'T1'), 'T1');
  assert.equal(maxTier('T2', undefined), 'T2');
  assert.equal(maxTier(undefined, 'nope'), 'T0');
});

test('resolveTier: max(declared, floor) wins and a low declaration is a finding', () => {
  assert.deepEqual(resolveTier(profile, ['app/x.js'], 'T1'), { floor: 'T2', tier: 'T2', belowFloor: true });
  assert.deepEqual(resolveTier(profile, ['app/x.js'], 'T3'), { floor: 'T2', tier: 'T3', belowFloor: false });
  assert.deepEqual(resolveTier(profile, ['app/x.js']), { floor: 'T2', tier: 'T2', belowFloor: false });
  assert.deepEqual(resolveTier(profile, ['app/x.js'], 'T9'), { floor: 'T2', tier: 'T2', belowFloor: false });
});

test('a minimal profile with no tiers: code T1, markdown T1 (nothing declared inert)', () => {
  const minimal = validateProfile({ schema_version: 1, client: { id: 'm', name: 'M' }, users: [{ id: 'a', name: 'A', role: 'admin' }] });
  assert.equal(tierOf(minimal, 'pay/x.js'), 'T1');
  assert.equal(tierOf(minimal, 'README.md'), 'T1');
  assert.equal(tierOf(minimal, '.aplabs/profile.yml'), 'T3');
});

test('the same path tiers differently under two profiles', () => {
  const other = validateProfile({
    schema_version: 1, client: { id: 'o', name: 'O' }, users: [{ id: 'a', name: 'A', role: 'admin' }],
    tiers: { T3: ['app/**'] },
  });
  assert.equal(tierOf(profile, 'app/server.js'), 'T2');
  assert.equal(tierOf(other, 'app/server.js'), 'T3');
});

test('globMatcher', () => {
  const m = (g, p, o) => globMatcher(g, o)(p);
  assert.ok(m('a/**/b.js', 'a/b.js'));
  assert.ok(m('a/**/b.js', 'a/x/y/b.js'));
  assert.ok(!m('a/**/b.js', 'a/xb.js'), '**/ only matches whole directories');
  assert.ok(m('docs/**', 'docs/a/b.md'));
  assert.ok(m('docs/**', 'docs/'));
  assert.ok(!m('docs/**', 'docsx/a'));
  assert.ok(m('**/*.md', 'README.md'));
  assert.ok(m('**/*.md', 'a/b/c.md'));
  assert.ok(!m('a/*.js', 'a/x/b.js'), '* stays within one segment');
  assert.ok(m('a/*.js', 'a/.js'));
  assert.ok(!m('a.js', 'aXjs'), 'dots are literal');
  assert.ok(m('f[1].js', 'f[1].js'), 'brackets are literal');
  assert.ok(m('A/**', 'a/x', { nocase: true }));
  assert.ok(!m('A/**', 'a/x'));
  assert.ok(!m('ab', 'a'));
  assert.ok(!m('a', 'ab'));
});

test('globMatcher: hostile globs cannot stall the tier check (linear time)', () => {
  const glob = '*a'.repeat(60) + '*b';
  const input = 'a'.repeat(200) + 'c';
  const start = process.hrtime.bigint();
  assert.equal(globMatcher(glob)(input), false);
  assert.equal(globMatcher('**/'.repeat(60) + 'x')('a/'.repeat(100) + 'y'), false);
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 250, 'took too long');
});

test('schema caps glob length', () => {
  const base = { schema_version: 1, client: { id: 'g', name: 'G' }, users: [{ id: 'a', name: 'A', role: 'admin' }] };
  assert.throws(() => validateProfile({ ...base, inert: ['a'.repeat(257)] }), /\/inert\/0/);
});

test('paths are never trimmed: whitespace is part of a filename', () => {
  const p = validateProfile({ schema_version: 1, client: { id: 'w', name: 'W' }, users: [{ id: 'a', name: 'A', role: 'admin' }], inert: ['README.md'] });
  assert.equal(tierOf(p, 'README.md'), 'T0');
  assert.equal(tierOf(p, 'README.md '), 'T1');
  assert.equal(tierOf(p, ' README.md'), 'T1');
});

test('CLI: prints the result; exit 1 below floor, 2 on no paths or bad profile', () => {
  const cli = path.join(__dirname, '../../kit/lib/tier/index.js');
  const env = { ...process.env, APLABS_PROFILE: fixture };
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8' });

  let r = run(['app/x.js', 'README.md']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { floor: 'T2', tier: 'T2', belowFloor: false });

  r = run(['--declared', 'T1', 'pay/x.js']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).belowFloor, true);

  r = run([], 'lib/a.js\nREADME.md\n');
  assert.equal(JSON.parse(r.stdout).floor, 'T1');

  r = run([], 'README.md \n');
  assert.equal(JSON.parse(r.stdout).floor, 'T1', 'stdin lines are not trimmed');

  r = run([], '');
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');

  r = run(['--declared', 'T7', 'a.js']);
  assert.equal(r.status, 2);

  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-')), 'p.yml');
  fs.writeFileSync(bad, 'schema_version: 1\n');
  r = spawnSync(process.execPath, [cli, 'a.js'], { env: { ...process.env, APLABS_PROFILE: bad }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to start/);
});
