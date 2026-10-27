'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProfile, validateProfile, findProfilePath, ProfileError, PROFILE_REL, LLM_DEFAULTS } = require('../../kit/lib/profile');

const fixture = (name) => path.join(__dirname, '../fixtures/profiles', `${name}.yml`);
const parsed = (name) => YAML.parse(fs.readFileSync(fixture(name), 'utf8'));
const rejects = (profile, pattern) => assert.throws(() => validateProfile(profile), (err) => {
  assert.ok(err instanceof ProfileError);
  assert.equal(err.code, 'PROFILE_INVALID');
  assert.match(err.message, pattern);
  return true;
});

test('loads a full profile as declared', () => {
  const p = loadProfile(fixture('full'));
  assert.equal(p.client.id, 'fixture-co');
  assert.deepEqual(p.tiers.T3, ['pay/**']);
  assert.equal(p.gate.engagement_ttl_minutes, 30);
  assert.equal(p.resources.find((r) => r.key === 'OWNER_ONLY').admin_grantable, false);
  assert.deepEqual(p.users[1].deny, ['OWNER_ONLY']);
});

test('fills defaults on a minimal profile', () => {
  const p = loadProfile(fixture('minimal'));
  assert.deepEqual(p.tiers, {});
  assert.deepEqual(p.inert, []);
  assert.deepEqual(p.gate, { exempt: [], engagement_ttl_minutes: 60 });
  assert.deepEqual(p.resources, []);
  assert.deepEqual(p.verify, { checks: [], env_allow: [] });
  assert.deepEqual(p.sql, { forbidden_columns: [] });
  assert.deepEqual(p.users[0], { id: 'solo', name: 'Solo', role: 'admin', identities: {}, grants: [], deny: [] });
});

test('defaults a verify check timeout to 300 seconds', () => {
  const p = loadProfile(fixture('full'));
  assert.equal(p.verify.checks[0].timeout_seconds, 300);
  const q = validateProfile({ ...parsed('minimal'), verify: { checks: [{ id: 'u', run: ['x'], timeout_seconds: 5 }], env_allow: ['DB_URL'] } });
  assert.equal(q.verify.checks[0].timeout_seconds, 5);
  assert.deepEqual(q.verify.env_allow, ['DB_URL']);
});

test('defaults admin_grantable to true and open_access to false', () => {
  const p = validateProfile({ ...parsed('minimal'), resources: [{ key: 'X', label: 'X' }] });
  assert.equal(p.resources[0].admin_grantable, true);
  assert.equal(p.resources[0].open_access, false);
});

test('accepts sql.forbidden_columns as unique lower-case "table.column" strings', () => {
  const p = validateProfile({ ...parsed('minimal'), sql: { forbidden_columns: ['people.phone', 'sites.postal_code'] } });
  assert.deepEqual(p.sql.forbidden_columns, ['people.phone', 'sites.postal_code']);
  rejects({ ...parsed('minimal'), sql: { forbidden_columns: ['phone'] } }, /\/sql\/forbidden_columns\/0/);
  rejects({ ...parsed('minimal'), sql: { forbidden_columns: ['People.Phone'] } }, /\/sql\/forbidden_columns\/0/);
  rejects({ ...parsed('minimal'), sql: { forbidden_columns: ['a.b.c'] } }, /\/sql\/forbidden_columns\/0/);
  rejects({ ...parsed('minimal'), sql: { forbidden_columns: ['a.b', 'a.b'] } }, /\/sql\/forbidden_columns/);
  rejects({ ...parsed('minimal'), sql: { forbidden: [] } }, /\/sql has unknown key "forbidden"/);
});

test('llm settings are optional, default in code, and refuse unknown keys and bad values', () => {
  assert.deepEqual(loadProfile(fixture('minimal')).llm, {
    model: 'claude-sonnet-5-5', extraction_model: 'claude-sonnet-5-5', hourly_usd_limit: 2, max_tokens: 1024,
  });
  assert.deepEqual(loadProfile(fixture('minimal')).llm, { ...LLM_DEFAULTS });
  const set = validateProfile({ ...parsed('minimal'), llm: { model: 'claude-opus-5-5', hourly_usd_limit: 0.5, max_tokens: 8192 } }).llm;
  assert.deepEqual(set, { model: 'claude-opus-5-5', extraction_model: 'claude-sonnet-5-5', hourly_usd_limit: 0.5, max_tokens: 8192 });
  const llm = (v) => ({ ...parsed('minimal'), llm: v });
  rejects(llm({ hourly_usd_limit: 0 }), /\/llm\/hourly_usd_limit must be > 0/);
  rejects(llm({ hourly_usd_limit: -1 }), /\/llm\/hourly_usd_limit/);
  rejects(llm({ max_tokens: 0 }), /\/llm\/max_tokens must be >= 1/);
  rejects(llm({ max_tokens: 8193 }), /\/llm\/max_tokens must be <= 8192/);
  rejects(llm({ max_tokens: 10.5 }), /\/llm\/max_tokens must be integer/);
  rejects(llm({ model: 'Claude Sonnet' }), /\/llm\/model must match pattern/);
  rejects(llm({ api_key: 'x' }), /\/llm has unknown key "api_key"/);
});

test('jobs.enabled is optional, defaults to false, and refuses unknown keys and non-booleans (Story 11.1)', () => {
  assert.deepEqual(loadProfile(fixture('minimal')).jobs, { enabled: false });
  const jobs = (v) => ({ ...parsed('minimal'), jobs: v });
  assert.deepEqual(validateProfile(jobs({ enabled: true })).jobs, { enabled: true });
  assert.deepEqual(validateProfile(jobs({})).jobs, { enabled: false });
  assert.ok(Object.isFrozen(validateProfile(jobs({ enabled: true })).jobs));
  rejects(jobs({ enabled: 'yes' }), /\/jobs\/enabled must be boolean/);
  rejects(jobs({ enabled: 1 }), /\/jobs\/enabled must be boolean/);
  rejects(jobs({ enabled: true, schedule: '* * * * *' }), /\/jobs has unknown key "schedule"/);
  rejects(jobs([]), /\/jobs must be object/);
});

// Story 13.1 (AD-R10): one optional routing block. Absent = routing off.
const ROUTING_DEFAULTS = {
  min_travel_minutes: 5, max_pairs: 10000, max_points: 500, map_grid_e6: 2000, map_min_span_km: 5, gap_fill: { horizon_days: 14, limit: 5 },
};
const withRouting = (edit) => {
  const p = parsed('routing');
  edit(p.routing, p);
  return p;
};

test('a profile with no routing block has no routing key (routing off)', () => {
  for (const name of ['minimal', 'full', 'tiers', 'lowered-floors']) {
    assert.equal(Object.hasOwn(loadProfile(fixture(name)), 'routing'), false, name);
  }
});

test('a valid routing block loads with defaults filled (5, 10 000 pairs, 500 points, 2000 grid, 5 km, 14 days, 5)', () => {
  const p = loadProfile(fixture('routing'));
  const { coordinates, speed_kmh, detour_factor, limits } = parsed('routing').routing;
  assert.deepEqual(p.routing, { coordinates, speed_kmh, detour_factor, limits, ...ROUTING_DEFAULTS });
  assert.ok(Object.isFrozen(p.routing.coordinates.nodes[0]));
  assert.ok(Object.isFrozen(p.routing.gap_fill));
});

test('routing values the client sets win over the defaults', () => {
  const p = loadProfile(fixture('routing-full'));
  assert.deepEqual(p.routing, parsed('routing-full').routing);
  const partial = validateProfile(withRouting((r) => { r.gap_fill = { limit: 2 }; }));
  assert.deepEqual(partial.routing.gap_fill, { horizon_days: 14, limit: 2 });
});

test('routing defaults do not touch the parsed input (what the client wrote stays as written)', () => {
  const input = parsed('routing');
  const before = JSON.stringify(input);
  validateProfile(input);
  assert.equal(JSON.stringify(input), before);
});

test('routing refuses unknown keys at every level, naming the key', () => {
  rejects(withRouting((r) => { r.enabled = true; }), /\/routing has unknown key "enabled"/);
  rejects(withRouting((r) => { r.coordinates.source = 'x'; }), /\/routing\/coordinates has unknown key "source"/);
  rejects(withRouting((r) => { r.coordinates.nodes[0].alt_column = 'x'; }), /\/routing\/coordinates\/nodes\/0 has unknown key "alt_column"/);
  rejects(withRouting((r) => { r.limits.lunch = 720; }), /\/routing\/limits has unknown key "lunch"/);
  rejects(withRouting((r) => { r.gap_fill = { radius_km: 3 }; }), /\/routing\/gap_fill has unknown key "radius_km"/);
  rejects(withRouting((r) => { r.map_grid = 2000; }), /\/routing has unknown key "map_grid"/);
  rejects(withRouting((r) => { r.map_tiles = true; }), /\/routing has unknown key "map_tiles"/);
  rejects(withAudience((a) => { a.everyone = 'ROUTING_ALL_CREWS'; }), /\/routing\/audience has unknown key "everyone"/);
  rejects(withAudience((a) => { a.crew_leads[0].zone = 'north'; }), /\/routing\/audience\/crew_leads\/0 has unknown key "zone"/);
});

// Story 15.2 (AD-R10, AD-R13, AD-R17): the map keys and the map audience.
const withAudience = (edit) => {
  const p = parsed('routing-audience');
  edit(p.routing.audience, p);
  return p;
};

test('the map keys default (500 points, 2000 grid, 5 km) and a client\'s own values win', () => {
  const p = loadProfile(fixture('routing'));
  assert.equal(p.routing.max_points, 500);
  assert.equal(p.routing.map_grid_e6, 2000);
  assert.equal(p.routing.map_min_span_km, 5);
  assert.equal(Object.hasOwn(p.routing, 'audience'), false, 'audience has no default');
  const full = loadProfile(fixture('routing-full'));
  assert.deepEqual([full.routing.max_points, full.routing.map_grid_e6, full.routing.map_min_span_km], [120, 4000, 7.5]);
  const coarser = validateProfile(withRouting((r) => { r.map_grid_e6 = 2001; r.map_min_span_km = 5.5; r.max_points = 1; }));
  assert.deepEqual([coarser.routing.map_grid_e6, coarser.routing.map_min_span_km, coarser.routing.max_points], [2001, 5.5, 1]);
});

test('the map floors refuse a smaller value, naming the key (GRD-002 is signed against them)', () => {
  rejects(withRouting((r) => { r.map_grid_e6 = 1999; }), /\/routing\/map_grid_e6 must be >= 2000/);
  rejects(withRouting((r) => { r.map_grid_e6 = 0; }), /\/routing\/map_grid_e6 must be >= 2000/);
  rejects(withRouting((r) => { r.map_grid_e6 = 2500.5; }), /\/routing\/map_grid_e6 must be integer/);
  rejects(withRouting((r) => { r.map_min_span_km = 4.9; }), /\/routing\/map_min_span_km must be >= 5/);
  rejects(withRouting((r) => { r.map_min_span_km = '5'; }), /\/routing\/map_min_span_km must be number/);
  rejects(withRouting((r) => { r.max_points = 0; }), /\/routing\/max_points must be >= 1/);
  rejects(withRouting((r) => { r.max_points = 10.5; }), /\/routing\/max_points must be integer/);
  rejects(withRouting((r) => { r.max_points = 5001; }), /\/routing\/max_points must be <= 5000/);
});

test('the map defaults are filled after the profile is read: what the client wrote stays as written', () => {
  for (const name of ['routing', 'routing-audience']) {
    const input = parsed(name);
    const before = JSON.stringify(input);
    const p = validateProfile(input);
    assert.equal(JSON.stringify(input), before, name);
    assert.equal(Object.hasOwn(input.routing, 'map_grid_e6'), false, name);
    assert.equal(p.routing.map_grid_e6, 2000, name);
  }
  const input = withAudience((a) => { delete a.crew_leads; });
  const p = validateProfile(input);
  assert.deepEqual(p.routing.audience.crew_leads, []);
  assert.equal(Object.hasOwn(input.routing.audience, 'crew_leads'), false);
});

test('a valid audience loads as declared, frozen', () => {
  const p = loadProfile(fixture('routing-audience'));
  assert.deepEqual(p.routing.audience, parsed('routing-audience').routing.audience);
  assert.ok(Object.isFrozen(p.routing.audience.crew_leads[0]));
});

test('the audience refuses an undeclared key, naming it', () => {
  rejects(withAudience((a) => { a.all_crews = 'NOT_DECLARED'; }), /^\[profile\] refusing to start: \/routing\/audience\/all_crews "NOT_DECLARED" is not a declared resource key$/);
  rejects(withAudience((a) => { a.own_crew = 'NOT_DECLARED'; }), /\/routing\/audience\/own_crew "NOT_DECLARED" is not a declared resource key/);
  rejects(withAudience((a) => { a.all_crews = 'routing_all'; }), /\/routing\/audience\/all_crews must match pattern/);
  rejects(withAudience((a) => { delete a.own_crew; }), /\/routing\/audience must have required property 'own_crew'/);
  rejects(withAudience((a) => { delete a.all_crews; }), /\/routing\/audience must have required property 'all_crews'/);
  // One key for both would let every crew lead see every crew.
  rejects(withAudience((a) => { a.own_crew = a.all_crews; }), /\/routing\/audience\/own_crew must not be the same key as all_crews/);
});

test('the audience refuses a crew lead not in users, the same user twice, or a lead without the own_crew grant, naming the key', () => {
  rejects(
    withAudience((a) => { a.crew_leads[1].user = 'nobody'; }),
    /^\[profile\] refusing to start: \/routing\/audience\/crew_leads\/1\/user "nobody" is not in users$/,
  );
  rejects(
    withAudience((a) => { a.crew_leads.push({ user: 'lead-a', crew_id: 'v2' }); }),
    /^\[profile\] refusing to start: \/routing\/audience\/crew_leads has duplicate user "lead-a"$/,
  );
  rejects(
    withAudience((a) => { a.crew_leads.push({ user: 'member', crew_id: 'v3' }); }),
    /^\[profile\] refusing to start: \/routing\/audience\/crew_leads\/3\/user "member" does not hold the own_crew grant "ROUTING_OWN_CREW"$/,
  );
  // The dispatcher's all_crews grant is not own_crew; nor is the admin role.
  rejects(withAudience((a) => { a.crew_leads[0].user = 'dispatch'; }), /\/routing\/audience\/crew_leads\/0\/user "dispatch" does not hold the own_crew grant/);
  rejects(withAudience((a) => { a.crew_leads[0].user = 'admin'; }), /\/routing\/audience\/crew_leads\/0\/user "admin" does not hold the own_crew grant/);
  rejects(withAudience((a) => { a.crew_leads[0].crew_id = 'crew:v1'; }), /\/routing\/audience\/crew_leads\/0\/crew_id must match pattern/);
  rejects(withAudience((a) => { delete a.crew_leads[0].crew_id; }), /\/routing\/audience\/crew_leads\/0 must have required property 'crew_id'/);
  // Two leads may share a crew.
  assert.equal(validateProfile(withAudience((a) => { a.crew_leads[1].crew_id = 'v1'; })).routing.audience.crew_leads[1].crew_id, 'v1');
});

test('routing refuses a bad identifier, naming the key', () => {
  for (const bad of ['Sites', 'sites;drop', 'sites.x', '"sites"', '1sites', '', 'a'.repeat(64)]) {
    rejects(withRouting((r) => { r.coordinates.nodes[0].table = bad; }), /\/routing\/coordinates\/nodes\/0\/table must match pattern/);
  }
  for (const key of ['id_column', 'lat_column', 'lon_column']) {
    rejects(withRouting((r) => { r.coordinates.nodes[1][key] = 'x y'; }), new RegExp(`/routing/coordinates/nodes/1/${key} must match pattern`));
  }
  rejects(withRouting((r) => { r.coordinates.nodes[0].kind = 'site:x'; }), /\/routing\/coordinates\/nodes\/0\/kind must match pattern/);
  rejects(withRouting((r) => { r.coordinates.nodes[0].kind = 'Site'; }), /\/routing\/coordinates\/nodes\/0\/kind must match pattern/);
});

test('routing refuses a coordinate column missing from sql.forbidden_columns, naming the key', () => {
  rejects(
    withRouting((r, p) => { p.sql.forbidden_columns = p.sql.forbidden_columns.filter((c) => c !== 'vans.home_lon_e6'); }),
    /^\[profile\] refusing to start: \/routing\/coordinates\/nodes\/1\/lon_column "vans\.home_lon_e6" is not in sql\.forbidden_columns$/,
  );
  rejects(
    withRouting((r, p) => { delete p.sql; }),
    /\/routing\/coordinates\/nodes\/0\/lat_column "sites\.pos_lat_e6" is not in sql\.forbidden_columns.*\/routing\/coordinates\/nodes\/1\/lon_column/,
  );
  // The column is forbidden in another table only: still refused.
  rejects(
    withRouting((r) => { r.coordinates.nodes[0].table = 'vans'; }),
    /\/routing\/coordinates\/nodes\/0\/lat_column "vans\.pos_lat_e6" is not in sql\.forbidden_columns/,
  );
});

test('routing refuses duplicate kinds, a shared lat/lon column, limits out of order, and bad numbers', () => {
  rejects(withRouting((r) => { r.coordinates.nodes[1].kind = 'site'; }), /\/routing\/coordinates\/nodes has duplicate kind "site"/);
  rejects(withRouting((r) => { r.coordinates.nodes[0].lon_column = 'pos_lat_e6'; }), /\/routing\/coordinates\/nodes\/0 uses one column for lat_column and lon_column/);
  rejects(withRouting((r) => { r.limits.default_start = 400; }), /\/routing\/limits\/default_start must not be before earliest_start/);
  rejects(withRouting((r) => { r.limits.latest_finish = 1000; }), /\/routing\/limits\/latest_finish must not be before aim_finish/);
  rejects(withRouting((r) => { r.coordinates.nodes = []; }), /\/routing\/coordinates\/nodes must NOT have fewer than 1 items/);
  rejects(withRouting((r) => { delete r.speed_kmh; }), /\/routing must have required property 'speed_kmh'/);
  rejects(withRouting((r) => { delete r.limits; }), /\/routing must have required property 'limits'/);
  rejects(withRouting((r) => { delete r.limits.slot_minutes; }), /\/routing\/limits must have required property 'slot_minutes'/);
  rejects(withRouting((r) => { r.speed_kmh = 0; }), /\/routing\/speed_kmh must be > 0/);
  rejects(withRouting((r) => { r.detour_factor = 0.9; }), /\/routing\/detour_factor must be >= 1/);
  rejects(withRouting((r) => { r.min_travel_minutes = 2.5; }), /\/routing\/min_travel_minutes must be integer/);
  rejects(withRouting((r) => { r.max_pairs = 0; }), /\/routing\/max_pairs must be >= 1/);
  rejects(withRouting((r) => { r.limits.latest_finish = 1441; }), /\/routing\/limits\/latest_finish must be <= 1440/);
  rejects(withRouting((r) => { r.limits.slot_minutes = 0; }), /\/routing\/limits\/slot_minutes must be >= 1/);
  rejects(withRouting((r) => { r.limits.earliest_start = '06:00'; }), /\/routing\/limits\/earliest_start must be integer/);
  rejects(withRouting((r) => { r.gap_fill = { horizon_days: 0 }; }), /\/routing\/gap_fill\/horizon_days must be >= 1/);
  rejects(withRouting((r) => { r.gap_fill = { limit: 0 }; }), /\/routing\/gap_fill\/limit must be >= 1/);
  rejects(withRouting((r) => { r.gap_fill = { weights: { flexible: 'high' } }; }), /\/routing\/gap_fill\/weights\/flexible must be number/);
  rejects(withRouting((r) => { r.gap_fill = { weights: { 'Bad Name': 1 } }; }), /\/routing\/gap_fill\/weights/);
  rejects(withRouting((r) => { r.gap_fill = { weights: {} }; }), /\/routing\/gap_fill\/weights must NOT have fewer than 1 properties/);
});

test('data.source defaults to local; motherduck needs data.database, and local refuses it', () => {
  assert.deepEqual(loadProfile(fixture('minimal')).data, { source: 'local' });
  assert.deepEqual(validateProfile({ ...parsed('minimal'), data: { source: 'local' } }).data, { source: 'local' });
  assert.deepEqual(
    validateProfile({ ...parsed('minimal'), data: { source: 'motherduck', database: 'acme_fixture' } }).data,
    { source: 'motherduck', database: 'acme_fixture' },
  );
  rejects({ ...parsed('minimal'), data: { source: 'motherduck' } }, /^\[profile\] refusing to start: \/data\/database is required with data\.source: motherduck$/);
  rejects({ ...parsed('minimal'), data: { source: 'local', database: 'acme_fixture' } }, /\/data\/database is only allowed with data\.source: motherduck/);
  rejects({ ...parsed('minimal'), data: { database: 'acme_fixture' } }, /\/data\/database is only allowed with data\.source: motherduck/);
  rejects({ ...parsed('minimal'), data: { source: 'warehouse' } }, /\/data\/source must be equal to one of the allowed values/);
  rejects({ ...parsed('minimal'), data: { source: 'local', path: '/x' } }, /\/data has unknown key "path"/);
});

test('data.database must be a plain name, not my_db, sample_data or a *__publishing staging copy', () => {
  const md = (database) => ({ ...parsed('minimal'), data: { source: 'motherduck', database } });
  for (const bad of ['my_db', 'sample_data', 'acme__publishing']) {
    rejects(md(bad), /\/data\/database must not be my_db or sample_data \(MotherDuck's own\) or end in __publishing/);
  }
  for (const bad of ['Acme', '9lives', 'a-b', 'a"b', 'x'.repeat(64), '']) rejects(md(bad), /\/data\/database must match pattern/);
});

test('result is deep-frozen and the input is not mutated', () => {
  const input = parsed('full');
  const before = JSON.stringify(input);
  const p = validateProfile(input);
  assert.ok(Object.isFrozen(p.users[0].grants));
  assert.throws(() => { p.users[0].grants.push('SHARED'); }, TypeError);
  assert.equal(JSON.stringify(input), before);
});

test('rejects unknown keys at every level', () => {
  rejects({ ...parsed('minimal'), extra: 1 }, /unknown key "extra"/);
  rejects({ ...parsed('minimal'), tiers: { T4: [] } }, /\/tiers has unknown key "T4"/);
  rejects({ ...parsed('minimal'), users: [{ id: 'a', name: 'A', role: 'admin', slack_id: 'U1' }] }, /unknown key "slack_id"/);
});

test('rejects schema violations', () => {
  rejects({ ...parsed('minimal'), schema_version: 2 }, /schema_version/);
  rejects({ ...parsed('minimal'), users: [] }, /\/users/);
  rejects({ ...parsed('minimal'), users: [{ id: 'a', name: 'A', role: 'owner' }] }, /\/users\/0\/role/);
  rejects({ ...parsed('minimal'), client: { id: 'Bad Id', name: 'x' } }, /\/client\/id/);
  rejects({ ...parsed('minimal'), client: { id: 'ok', name: '   ' } }, /\/client\/name/);
  rejects({ ...parsed('minimal'), gate: { engagement_ttl_minutes: 0 } }, /engagement_ttl_minutes/);
  rejects({ ...parsed('minimal'), verify: { checks: [{ id: 'unit', run: 'npm test' }] } }, /\/verify\/checks\/0\/run must be array/);
  rejects({ ...parsed('minimal'), verify: { checks: [{ id: 'unit', run: [] }] } }, /\/verify\/checks\/0\/run/);
  rejects({ ...parsed('minimal'), verify: { checks: [{ id: 'unit', run: ['x'], timeout_seconds: 0 }] } }, /timeout_seconds/);
  rejects({ ...parsed('minimal'), verify: { checks: [{ id: 'unit', run: ['x'], timeout_seconds: 3601 }] } }, /timeout_seconds/);
  rejects({ ...parsed('minimal'), verify: { env_allow: ['lower'] } }, /\/verify\/env_allow\/0/);
  rejects({ ...parsed('minimal'), verify: { env_allow: ['A', 'A'] } }, /\/verify\/env_allow/);
  rejects([], /must be a YAML mapping/);
  rejects(null, /must be a YAML mapping/);
});

test('reports every schema error, not just the first', () => {
  const bad = { schema_version: 1, client: { id: 'ok', name: 'Ok' }, users: [{ id: 'a', name: 'A', role: 'x' }], extra: 1 };
  rejects(bad, /unknown key "extra"/);
  rejects(bad, /\/users\/0\/role/);
});

test('rejects grants and denies naming undeclared resources', () => {
  const p = parsed('full');
  p.users[1].grants = ['NOPE'];
  rejects(p, /\/users\/1\/grants names unknown resource "NOPE"/);
});

test('rejects duplicates', () => {
  const p = parsed('full');
  p.users[1].id = 'ada';
  p.resources[1].key = 'OWNER_ONLY';
  p.verify.checks.push({ id: 'unit', run: ['x'] });
  rejects(p, /duplicate resource key "OWNER_ONLY".*duplicate user id "ada".*duplicate verify check id "unit"/);
});

test('rejects two users with the same Slack id; distinct or absent ids are fine', () => {
  const p = parsed('full');
  p.users[0].identities = { slack: 'U0SAME' };
  p.users[1].identities = { slack: 'U0SAME' };
  rejects(p, /users ada, \S+ share identities.slack "U0SAME"/);
  p.users[1].identities = { slack: 'U0OTHER' };
  assert.equal(validateProfile(p).users[1].identities.slack, 'U0OTHER');
  delete p.users[1].identities;
  assert.doesNotThrow(() => validateProfile(p));
});

test('requires at least one admin', () => {
  rejects({ ...parsed('minimal'), users: [{ id: 'a', name: 'A', role: 'member' }] }, /at least one admin/);
});

test('refuses to start on unreadable, missing or non-YAML files', () => {
  assert.throws(() => loadProfile(null), /no \.aplabs\/profile\.yml found/);
  assert.throws(() => loadProfile('/nonexistent/profile.yml'), /cannot read profile/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-'));
  const bad = path.join(dir, 'p.yml');
  fs.writeFileSync(bad, 'a: 1\na: 2\n');
  assert.throws(() => loadProfile(bad), /not valid YAML/);
});

test('findProfilePath walks up to .aplabs/profile.yml, and APLABS_PROFILE overrides', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-'));
  fs.mkdirSync(path.join(root, '.aplabs'));
  fs.writeFileSync(path.join(root, PROFILE_REL), '');
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });

  const saved = process.env.APLABS_PROFILE;
  t.after(() => { if (saved === undefined) delete process.env.APLABS_PROFILE; else process.env.APLABS_PROFILE = saved; });
  delete process.env.APLABS_PROFILE;
  assert.equal(findProfilePath(deep), path.join(root, PROFILE_REL));
  assert.equal(findProfilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'none-'))), null);
  process.env.APLABS_PROFILE = '/elsewhere/profile.yml';
  assert.equal(findProfilePath(deep), '/elsewhere/profile.yml');
  process.env.APLABS_PROFILE = 'relative/profile.yml';
  assert.throws(() => findProfilePath(deep), /APLABS_PROFILE must be an absolute path/);
});
