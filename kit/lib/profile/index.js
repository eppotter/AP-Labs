'use strict';

// Loads a client profile (.aplabs/profile.yml) and validates it against
// profiles/_schema/profile.schema.json, then checks what the schema cannot
// express (cross-references, uniqueness, at least one admin).
//
// Posture: REFUSE TO START on a malformed profile. A bad profile fails loudly
// here rather than surfacing later as wrong tiers or wrong access decisions.
//
// Location: APLABS_PROFILE (absolute path) when set. Otherwise walk up from the
// start directory (default: cwd, the client repo) to the first directory that
// has .aplabs/profile.yml.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const Ajv2020 = require('ajv/dist/2020');

const PROFILE_REL = path.join('.aplabs', 'profile.yml');
const SCHEMA_PATH = path.resolve(__dirname, '../../../profiles/_schema/profile.schema.json');

class ProfileError extends Error {
  constructor(message, file) {
    super(`[profile] refusing to start: ${message}${file ? ` (${file})` : ''}`);
    this.name = 'ProfileError';
    this.code = 'PROFILE_INVALID';
  }
}

class NotGoverningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotGoverningError';
    this.code = 'PROFILE_NOT_GOVERNING';
  }
}

// The AI settings' defaults (AD-16, Story 9.1). Every model named here must be
// priced in kit/runtime/llm/prices.js (a test checks).
const LLM_DEFAULTS = Object.freeze({
  model: 'claude-sonnet-5-5',
  extraction_model: 'claude-sonnet-5-5',
  hourly_usd_limit: 2,
  max_tokens: 1024,
});

// The routing block's defaults (AD-R10, Story 13.1). The block itself has no
// default: absent means routing is off. Filled only on a copy, so the parsed
// profile (what the client wrote) is never changed. The map keys (Story 15.2,
// AD-R10, AD-R13): map_grid_e6 and map_min_span_km are also their floors (the
// schema refuses a smaller value; GRD-002 is signed against them). audience
// has no default: absent means no one is in the map's audience.
const ROUTING_DEFAULTS = Object.freeze({
  min_travel_minutes: 5,
  max_pairs: 10000,
  max_points: 500,
  map_grid_e6: 2000,
  map_min_span_km: 5,
  gap_fill: Object.freeze({ horizon_days: 14, limit: 5 }),
});

const LIMIT_ORDER = Object.freeze(['earliest_start', 'default_start', 'aim_finish', 'latest_finish']);

// What the schema cannot say about routing: each coordinate column must also be
// forbidden to every other query (AD-R9), node kinds are unique (they prefix
// node ids), a node's lat and lon are two columns, the day limits are in order,
// and the map audience (AD-R17) names declared keys and known, granted people.
function routingProblems(routing, forbidden, p) {
  const problems = [];
  const banned = new Set(forbidden);
  const nodes = routing.coordinates.nodes;
  for (const d of duplicates(nodes.map((n) => n.kind))) problems.push(`/routing/coordinates/nodes has duplicate kind "${d}"`);
  nodes.forEach((n, i) => {
    if (n.lat_column === n.lon_column) problems.push(`/routing/coordinates/nodes/${i} uses one column for lat_column and lon_column`);
    for (const key of ['lat_column', 'lon_column']) {
      const column = `${n.table}.${n[key]}`;
      if (!banned.has(column)) problems.push(`/routing/coordinates/nodes/${i}/${key} "${column}" is not in sql.forbidden_columns`);
    }
  });
  for (let i = 1; i < LIMIT_ORDER.length; i += 1) {
    const [before, key] = [LIMIT_ORDER[i - 1], LIMIT_ORDER[i]];
    if (routing.limits[key] < routing.limits[before]) problems.push(`/routing/limits/${key} must not be before ${before}`);
  }
  if (routing.audience) problems.push(...audienceProblems(routing.audience, p));
  return problems;
}

// The map audience (AD-R17): both keys declared in resources and different
// (or every crew lead would see every crew); each crew lead a known user,
// listed once, holding the own_crew grant.
function audienceProblems(audience, p) {
  const problems = [];
  const keys = new Set(p.resources.map((r) => r.key));
  for (const key of ['all_crews', 'own_crew']) {
    if (!keys.has(audience[key])) problems.push(`/routing/audience/${key} "${audience[key]}" is not a declared resource key`);
  }
  if (audience.all_crews === audience.own_crew) problems.push('/routing/audience/own_crew must not be the same key as all_crews');
  const users = new Map(p.users.map((u) => [u.id, u]));
  for (const d of duplicates(audience.crew_leads.map((l) => l.user))) problems.push(`/routing/audience/crew_leads has duplicate user "${d}"`);
  audience.crew_leads.forEach((lead, i) => {
    const user = users.get(lead.user);
    if (!user) problems.push(`/routing/audience/crew_leads/${i}/user "${lead.user}" is not in users`);
    else if (!user.grants.includes(audience.own_crew)) {
      problems.push(`/routing/audience/crew_leads/${i}/user "${lead.user}" does not hold the own_crew grant "${audience.own_crew}"`);
    }
  });
  return problems;
}

let _validate = null;
function schemaValidator() {
  if (!_validate) {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    _validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  }
  return _validate;
}

// Plain words for the data block's rules (schema: data.source and
// data.database); Ajv's own say "boolean schema is false" or "must NOT be valid".
const DATA_MESSAGES = Object.freeze({
  '/data/database false schema': '/data/database is only allowed with data.source: motherduck',
  '/data/database not': '/data/database must not be my_db or sample_data (MotherDuck\'s own) or end in __publishing (publish\'s staging copy)',
});

function formatSchemaError(e) {
  const where = e.instancePath || '(root)';
  if (e.keyword === 'additionalProperties') return `${where} has unknown key "${e.params.additionalProperty}"`;
  const plain = DATA_MESSAGES[`${where} ${e.keyword}`];
  if (plain) return plain;
  if (where === '/data' && e.keyword === 'required') return '/data/database is required with data.source: motherduck';
  return `${where} ${e.message}`;
}

// The "must match then/else schema" lines only repeat the error under them.
const isEcho = (e) => e.keyword === 'if';

// env defaults to process.env; the runtime passes its own (tests inject one).
function findProfilePath(startDir = process.cwd(), env = process.env) {
  const override = env.APLABS_PROFILE;
  if (override) {
    // Relative would resolve against whatever cwd the hook happens to run in.
    // The value is not echoed: name the variable only.
    if (!path.isAbsolute(override)) throw new ProfileError('APLABS_PROFILE must be an absolute path');
    return override;
  }
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, PROFILE_REL);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The profile that governs a command run as a check. `npm run verify` names
// the profile that defined the check in APLABS_GOVERNING_PROFILE (absolute),
// so it wins; else findProfilePath. An explicit path (a --profile flag,
// relative to cwd) must be that profile when one governs: a fork that copies
// a check naming another client's profile fails instead of silently
// enforcing that client's rules (issue #77). Returns a path or null. Throws
// ProfileError, or a NotGoverningError for an explicit path that isn't it.
function governingProfilePath(explicit, cwd = process.cwd(), env = process.env) {
  let governing;
  if (env.APLABS_GOVERNING_PROFILE) {
    if (!path.isAbsolute(env.APLABS_GOVERNING_PROFILE)) throw new ProfileError('APLABS_GOVERNING_PROFILE must be an absolute path');
    governing = env.APLABS_GOVERNING_PROFILE;
  } else {
    governing = findProfilePath(cwd, env);
  }
  if (!explicit) return governing;
  const named = path.resolve(cwd, explicit);
  if (governing && !sameFile(named, governing)) {
    throw new NotGoverningError(`--profile ${explicit} is not the governing profile (${governing})`);
  }
  return named;
}

function sameFile(a, b) {
  const real = (f) => {
    try {
      return fs.realpathSync(f);
    } catch {
      return path.resolve(f);
    }
  };
  return real(a) === real(b);
}

function duplicates(values) {
  const seen = new Set();
  return values.filter((v) => (seen.has(v) ? true : (seen.add(v), false)));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Validates a parsed profile object. Returns it with defaults filled, deep-frozen.
// Throws ProfileError listing every problem found.
function validateProfile(profile, file) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new ProfileError('profile must be a YAML mapping', file);
  }
  const validate = schemaValidator();
  if (!validate(profile)) {
    throw new ProfileError(validate.errors.filter((e) => !isEcho(e)).map(formatSchemaError).join('; '), file);
  }

  const p = structuredClone(profile);
  p.tiers = p.tiers || {};
  p.inert = p.inert || [];
  p.gate = { exempt: [], engagement_ttl_minutes: 60, ...p.gate };
  p.resources = (p.resources || []).map((r) => ({ admin_grantable: true, open_access: false, ...r }));
  p.stages = { addons: [], ...p.stages };
  p.verify = { checks: [], env_allow: [], ...p.verify };
  p.sql = { forbidden_columns: [], ...p.sql };
  p.data = { source: 'local', ...p.data };
  p.jobs = { enabled: false, ...p.jobs };
  p.llm = { ...LLM_DEFAULTS, ...p.llm };
  p.verify.checks = p.verify.checks.map((c) => ({ timeout_seconds: 300, ...c }));
  p.users = p.users.map((u) => ({ identities: {}, grants: [], deny: [], ...u }));

  const problems = [];
  const keys = new Set(p.resources.map((r) => r.key));
  for (const d of duplicates(p.resources.map((r) => r.key))) problems.push(`duplicate resource key "${d}"`);
  for (const d of duplicates(p.users.map((u) => u.id))) problems.push(`duplicate user id "${d}"`);
  for (const d of duplicates(p.verify.checks.map((c) => c.id))) problems.push(`duplicate verify check id "${d}"`);
  // The runtime maps a Slack id to exactly one person (Story 6.3).
  for (const d of duplicates(p.users.map((u) => u.identities.slack).filter((s) => s !== undefined))) {
    const ids = p.users.filter((u) => u.identities.slack === d).map((u) => u.id).join(', ');
    problems.push(`users ${ids} share identities.slack "${d}"`);
  }
  p.users.forEach((u, i) => {
    for (const field of ['grants', 'deny']) {
      for (const k of u[field]) {
        if (!keys.has(k)) problems.push(`/users/${i}/${field} names unknown resource "${k}"`);
      }
    }
  });
  if (!p.users.some((u) => u.role === 'admin')) problems.push('`users` must include at least one admin');
  if (p.routing) {
    p.routing = { ...ROUTING_DEFAULTS, ...p.routing, gap_fill: { ...ROUTING_DEFAULTS.gap_fill, ...p.routing.gap_fill } };
    if (p.routing.audience) p.routing.audience = { crew_leads: [], ...p.routing.audience };
    problems.push(...routingProblems(p.routing, p.sql.forbidden_columns, p));
  }

  if (problems.length) throw new ProfileError(problems.join('; '), file);
  return deepFreeze(p);
}

// Loads and validates the profile at `file` (default: findProfilePath()).
function loadProfile(file = findProfilePath()) {
  if (!file) throw new ProfileError(`no ${PROFILE_REL} found (set APLABS_PROFILE or add one at the repo root)`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ProfileError(`cannot read profile: ${err.message}`, file);
  }
  let parsed;
  try {
    // The yaml package rejects duplicate mapping keys by default (uniqueKeys).
    parsed = YAML.parse(text);
  } catch (err) {
    throw new ProfileError(`profile is not valid YAML: ${err.message}`, file);
  }
  return validateProfile(parsed, file);
}

module.exports = {
  loadProfile, validateProfile, findProfilePath, governingProfilePath, ProfileError, NotGoverningError, PROFILE_REL, LLM_DEFAULTS, ROUTING_DEFAULTS,
};
