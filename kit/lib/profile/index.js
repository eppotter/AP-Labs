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

let _validate = null;
function schemaValidator() {
  if (!_validate) {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    _validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  }
  return _validate;
}

function formatSchemaError(e) {
  const where = e.instancePath || '(root)';
  if (e.keyword === 'additionalProperties') return `${where} has unknown key "${e.params.additionalProperty}"`;
  return `${where} ${e.message}`;
}

function findProfilePath(startDir = process.cwd()) {
  if (process.env.APLABS_PROFILE) return process.env.APLABS_PROFILE;
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, PROFILE_REL);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
    throw new ProfileError(validate.errors.map(formatSchemaError).join('; '), file);
  }

  const p = structuredClone(profile);
  p.tiers = p.tiers || {};
  p.inert = p.inert || [];
  p.gate = { exempt: [], engagement_ttl_minutes: 60, ...p.gate };
  p.resources = (p.resources || []).map((r) => ({ admin_grantable: true, ...r }));
  p.verify = { checks: [], ...p.verify };
  p.users = p.users.map((u) => ({ identities: {}, grants: [], deny: [], ...u }));

  const problems = [];
  const keys = new Set(p.resources.map((r) => r.key));
  for (const d of duplicates(p.resources.map((r) => r.key))) problems.push(`duplicate resource key "${d}"`);
  for (const d of duplicates(p.users.map((u) => u.id))) problems.push(`duplicate user id "${d}"`);
  for (const d of duplicates(p.verify.checks.map((c) => c.id))) problems.push(`duplicate verify check id "${d}"`);
  p.users.forEach((u, i) => {
    for (const field of ['grants', 'deny']) {
      for (const k of u[field]) {
        if (!keys.has(k)) problems.push(`/users/${i}/${field} names unknown resource "${k}"`);
      }
    }
  });
  if (!p.users.some((u) => u.role === 'admin')) problems.push('`users` must include at least one admin');

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

module.exports = { loadProfile, validateProfile, findProfilePath, ProfileError, PROFILE_REL };
