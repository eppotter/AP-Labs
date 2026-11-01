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
// llm.upload_hourly_usd_limit's default (Story 16.8), capped at the hourly limit.
const UPLOAD_DEFAULT_USD = 1;

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

// The street map's defaults (AD-R18, Story 15.9). The block itself has no
// default: absent means no street map and no tile request.
const BASEMAP_DEFAULTS = Object.freeze({
  max_zoom: 19,
  cache_days: 7,
  max_cached_tiles: 512,
});

const LIMIT_ORDER =Object.freeze(['earliest_start', 'default_start', 'aim_finish', 'latest_finish']);

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
  if (routing.basemap) problems.push(...basemapProblems(routing.basemap));
  if (routing.depot) problems.push(...depotProblems(routing.depot, nodes));
  return problems;
}

// The Office (AD-R23, Story 15.13): what the schema cannot say. Its node's
// kind must be a declared node source, so its position is read from the data
// like any other node's and never written in the profile. The label is shown
// as text in Slack, so it is plain text on one line with no Slack formatting
// character (a colon too: :name: is an emoji). Each refusal names the key and
// never echoes the label. That the node's row exists is checked at first use
// (mapPoints and travelMatrix refuse a node with no position).
const DEPOT_LABEL_BANNED = /[<>&*_~`|:]/;
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
function depotProblems(depot, nodes) {
  const at = (key) => `/routing/depot/${key}`;
  const problems = [];
  const kind = depot.node.slice(0, depot.node.indexOf(':'));
  if (!nodes.some((n) => n.kind === kind)) problems.push(`${at('node')} kind "${kind}" is not declared in routing.coordinates.nodes`);
  if (!depot.label.trim()) problems.push(`${at('label')} must not be empty`);
  else if (NOT_ONE_LINE.test(depot.label)) problems.push(`${at('label')} must be one line of plain text`);
  else if (depot.label !== depot.label.trim()) problems.push(`${at('label')} must not start or end with a space`);
  else if (DEPOT_LABEL_BANNED.test(depot.label)) problems.push(`${at('label')} must not hold any of < > & * _ ~ \` | :`);
  return problems;
}

// The street map's source (AD-R18): what the schema cannot say about its
// strings. Every refusal names the key. The template is the only address the
// tile fetcher ever calls, so it must be a plain https URL to a named host
// with the three tile numbers in its path and nothing a request could smuggle
// (credentials, a query, a fragment, other placeholders). The attribution is
// shown in Slack, so it holds no Slack formatting characters. The User-Agent
// carries a contact, as the providers' tile policies ask.
const PLACEHOLDERS = ['{z}', '{x}', '{y}'];
const ATTRIBUTION_MAX = 120;
const ATTRIBUTION_BANNED = /[<>&*_~`|]/;
// A library's or a browser's own User-Agent: providers block these.
const DEFAULT_AGENTS = /^\s*(node|undici|node-fetch|axios|got|python|curl|wget|go-http-client|java|okhttp|libwww|mozilla|aiohttp|httpie|postman|requests|fetch)\b/i;
const CONTACT_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const CONTACT_URL = /https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const HEADER_SAFE = /^[\x20-\x7e]+$/;

function basemapProblems(b) {
  const at = (key) => `/routing/basemap/${key}`;
  const problems = [];
  const template = templateProblem(b.url_template);
  if (template) problems.push(`${at('url_template')} ${template}`);
  const text = b.attribution.trim();
  if (!text) problems.push(`${at('attribution')} must not be empty`);
  else if (b.attribution.length > ATTRIBUTION_MAX) problems.push(`${at('attribution')} must be at most ${ATTRIBUTION_MAX} characters`);
  else if (ATTRIBUTION_BANNED.test(b.attribution)) problems.push(`${at('attribution')} must not hold any of < > & * _ ~ \` |`);
  else if (/[\r\n\t]/.test(b.attribution)) problems.push(`${at('attribution')} must be one line`);
  const link = linkProblem(b.attribution_url);
  if (link) problems.push(`${at('attribution_url')} ${link}`);
  if (!HEADER_SAFE.test(b.user_agent)) problems.push(`${at('user_agent')} must be printable ASCII on one line`);
  else if (DEFAULT_AGENTS.test(b.user_agent)) problems.push(`${at('user_agent')} must name this app, not a library's or browser's default`);
  else if (!CONTACT_EMAIL.test(b.user_agent) && !CONTACT_URL.test(b.user_agent)) {
    problems.push(`${at('user_agent')} must hold a contact (an email address or an https URL)`);
  }
  return problems;
}

// Why a URL fails the shared rules (https, a named host, no credentials),
// or null. url is already parsed.
function hostProblem(url) {
  if (url.protocol !== 'https:') return 'must be an https URL';
  if (url.username || url.password) return 'must not hold a user name or password';
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return 'must not name localhost';
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return 'must not name an IP address';
  if (!host.includes('.')) return 'must name a full host name';
  return null;
}

function templateProblem(template) {
  for (const ph of PLACEHOLDERS) {
    if (template.split(ph).length !== 2) return `must hold exactly one ${ph}`;
  }
  const rest = PLACEHOLDERS.reduce((s, ph) => s.replace(ph, ''), template);
  if (/[{}]/.test(rest)) return 'must hold no placeholder other than {z}, {x} and {y}';
  if (/[\s\\]/.test(template)) return 'must not hold spaces or backslashes';
  const scheme = /^https:\/\/[^/?#]*/i.exec(template);
  if (!scheme) return 'must be an https URL';
  if (/[{]/.test(scheme[0])) return 'must keep {z}, {x} and {y} in the path, not the host';
  if (/[?#]/.test(template)) return template.includes('#') ? 'must not hold a fragment' : 'must not hold a query';
  let url;
  try {
    url = new URL(template.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
  } catch {
    return 'is not a valid URL';
  }
  return hostProblem(url);
}

function linkProblem(link) {
  if (/[\s<>|\\]/.test(link)) return 'must not hold spaces or any of < > | \\';
  let url;
  try {
    url = new URL(link);
  } catch {
    return 'is not a valid URL';
  }
  return hostProblem(url);
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

// Ask's queries (plan brightside-v1, D10, GRD-009, Story 19.7): who may get
// them is the ASK_DATA resource, granted by name only. What the schema can't
// say: the key is declared, never conferred by the admin role and never
// open_access; no allowed column is a forbidden one, or shares a forbidden
// one's bare name (the guard matches names bare, so it would refuse it
// anyway); no allowed table has a name DuckDB's own catalogue uses. That the
// tables and columns exist is checked against the data at boot
// (kit/runtime/data/ask).
const ASK_DATA_KEY = 'ASK_DATA';
const ASK_DEFAULTS = Object.freeze({ queries_per_hour: 10 });
const CATALOGUE_NAME = /^(duckdb_|pg_|sqlite_|information_schema$)/;

function askProblems(ask, p) {
  const problems = [];
  const resource = p.resources.find((r) => r.key === ASK_DATA_KEY);
  if (!resource) problems.push(`/ask needs the resource ${ASK_DATA_KEY} (the people who may get query answers), with admin_grantable: false`);
  else {
    if (resource.admin_grantable !== false) problems.push(`resource ${ASK_DATA_KEY} must have admin_grantable: false (granted by name only, GRD-009)`);
    if (resource.open_access) problems.push(`resource ${ASK_DATA_KEY} must not be open_access`);
  }
  const forbidden = new Set(p.sql.forbidden_columns);
  const bare = new Map(p.sql.forbidden_columns.map((fc) => [fc.split('.')[1], fc]));
  for (const [table, columns] of Object.entries(ask.tables)) {
    if (CATALOGUE_NAME.test(table)) problems.push(`/ask/tables/${table} is a name DuckDB's own catalogue uses`);
    for (const c of columns) {
      if (forbidden.has(`${table}.${c}`)) problems.push(`/ask/tables/${table} allows ${c}, which is in sql.forbidden_columns`);
      else if (bare.has(c)) problems.push(`/ask/tables/${table} allows ${c}, which shares its name with the forbidden column ${bare.get(c)}`);
    }
  }
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
  // Uploads' own spend cap (plan brightside-v0, D5, Story 16.8): default $1,
  // or the hourly limit when that is lower; never above the hourly limit.
  p.llm.upload_hourly_usd_limit ??= Math.min(UPLOAD_DEFAULT_USD, p.llm.hourly_usd_limit);
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
  if (p.llm.upload_hourly_usd_limit > p.llm.hourly_usd_limit) {
    problems.push(`llm.upload_hourly_usd_limit (${p.llm.upload_hourly_usd_limit}) must be at most llm.hourly_usd_limit (${p.llm.hourly_usd_limit})`);
  }
  if (p.routing) {
    p.routing = { ...ROUTING_DEFAULTS, ...p.routing, gap_fill: { ...ROUTING_DEFAULTS.gap_fill, ...p.routing.gap_fill } };
    if (p.routing.audience) p.routing.audience = { crew_leads: [], ...p.routing.audience };
    if (p.routing.basemap) p.routing.basemap = { ...BASEMAP_DEFAULTS, ...p.routing.basemap };
    problems.push(...routingProblems(p.routing, p.sql.forbidden_columns, p));
  }
  if (p.ask) {
    p.ask = { ...ASK_DEFAULTS, ...p.ask };
    problems.push(...askProblems(p.ask, p));
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
  loadProfile, validateProfile, findProfilePath, governingProfilePath, ProfileError, NotGoverningError, PROFILE_REL, LLM_DEFAULTS, ROUTING_DEFAULTS, BASEMAP_DEFAULTS,
  ASK_DATA_KEY, ASK_DEFAULTS,
};
