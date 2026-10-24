'use strict';

// Brightside's mock CRM (Story 8.2): a stand-in for the CRM, so modules can
// look up a client the standard way without a real vendor. It is the
// contract's read-path example: one read, no writes. Built from
// kit/templates/connector; imports engine helpers only from '#sdk'.
//
// The "system" is the Brightside fixture, read through the query runner the
// app passes as deps.data, so every lookup is one bound, read-only query that
// passes the SQL guardrail and the profile's forbidden columns.
//
// BRIGHTSIDE_CRM_KEY is a stand-in "API key": the contract reads it like any
// credential and fails closed when it is unset, but the mock checks nothing
// about its value. Any non-empty value works; never put a real credential in it.

const { defineConnector } = require('#sdk');

// The only client fields a lookup may fetch (least privilege). Phone and
// address are never among them: they are forbidden columns in the profile too.
const FIELDS = Object.freeze(['client_id', 'first_name', 'last_name', 'email', 'zone_id']);

// One query per key. The select list is FIELDS, or the subset the call names,
// always in FIELDS order, so the text only ever holds allow-listed names.
const BY = Object.freeze({
  client_id: (cols) => `SELECT ${cols} FROM clients WHERE client_id = $client_id`,
  email: (cols) => `SELECT ${cols} FROM clients WHERE lower(email) = $email`,
});

// A deliberately simple email shape, checked after trimming and lower-casing:
// a local part (no spaces, no @, no leading, trailing or doubled dot, at most
// 64 characters), one @, and a domain of dot-separated labels. At most 254
// characters in all. It refuses what can't be an address; it doesn't try to
// accept every address the standard allows.
const EMAIL = /^(?!\.)(?!.*\.\.)[^\s@]{1,64}(?<!\.)@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

// The lookup's input as { key, value, fields }; throws on anything else.
function parse({ clientId, email, fields = FIELDS } = {}) {
  if (!Array.isArray(fields) || !fields.length) throw new Error('fields must be a non-empty list');
  const bad = fields.filter((f) => !FIELDS.includes(f));
  if (bad.length) throw new Error(`fields not allowed: ${bad.join(', ')} (allowed: ${FIELDS.join(', ')})`);
  const picked = FIELDS.filter((f) => fields.includes(f));
  if ((clientId === undefined) === (email === undefined)) throw new Error('give exactly one of clientId or email');
  if (clientId !== undefined) {
    const id = typeof clientId === 'string' && /^\s*\d+\s*$/.test(clientId) ? Number(clientId) : clientId;
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('clientId must be a positive whole number');
    return { key: 'client_id', value: id, fields: picked };
  }
  const normal = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normal) throw new Error('email must be a non-empty string');
  if (normal.length > 254 || !EMAIL.test(normal)) throw new Error('email must look like name@example.com');
  return { key: 'email', value: normal, fields: picked };
}

// The stand-in CRM client. simulate is test-only (deps.simulate):
//   authFailure: true  every call is refused with a 401, as a bad key would be
//   rateLimited: n     the next n calls are refused with a 429
function mockCrm({ data, simulate = {} }) {
  let limited = simulate.rateLimited || 0;
  return {
    async query(sql, params) {
      if (simulate.authFailure) throw Object.assign(new Error('the CRM rejected the API key'), { status: 401 });
      if (limited > 0) {
        limited -= 1;
        throw Object.assign(new Error('the CRM is rate limiting calls'), { status: 429 });
      }
      return data.run(sql, params, { declared: Object.keys(params) });
    },
  };
}

const crm = defineConnector({
  id: 'crm',
  system: 'Brightside CRM (mock)',
  auth: { env: ['BRIGHTSIDE_CRM_KEY'] },
  // Required by the contract; the mock has no writes for it to stop.
  killSwitchEnv: 'BRIGHTSIDE_CRM_OFF',
  // One client per lookup.
  rateLimit: { perSecond: 5, batchSize: 1 },

  connect({ data, simulate }) {
    if (!data || typeof data.run !== 'function') throw new Error('the mock CRM needs the query runner (create it with { data })');
    return mockCrm({ data, simulate });
  },

  read: {
    // input: { clientId } or { email }, and optionally fields (a subset of
    // FIELDS). Returns the client with only those fields, or null.
    async lookupClient(input, ctx) {
      const { key, value, fields } = parse(input);
      const sql = BY[key](fields.join(', '));
      // A 429 is retried by ctx.request (through the rate limit), then fails.
      const rows = await ctx.request(() => ctx.client.query(sql, { [key]: value }));
      return rows.length ? Object.fromEntries(fields.map((f) => [f, rows[0][f]])) : null;
    },
  },
});

module.exports = Object.freeze({ ...crm, FIELDS });
