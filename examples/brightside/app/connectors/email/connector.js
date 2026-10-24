'use strict';

// Brightside's mock email tool (Story 8.3): a stand-in for the email system a
// win-back list is pushed to, so the approval-write flow can be built and
// shown without a real vendor. It is the contract's write-path example: two
// writes, no reads. Built from kit/templates/connector; imports engine helpers
// only from '#sdk'.
//
// The "system" is the outbox file (./outbox.js, default var/outbox/email.jsonl,
// gitignored): each list and contact the tool accepts is a line there with its
// idempotency key. The same file is the connector's idempotency store, so a
// repeated key adds nothing even after a restart. If the outbox can't be read
// or has a torn or corrupt line, every write fails closed rather than treat it
// as empty, and one process writes at a time (a lockfile): see ./outbox.js.
//
// BRIGHTSIDE_EMAIL_KEY is a stand-in "API key", as the mock CRM's is: the
// contract reads it like any credential and fails closed when it is unset, but
// the mock checks nothing about its value. Any non-empty value works; never put
// a real credential in it. (With no credential at all, the shared suite's leak
// check can't pass: see the Story 8.3 PR.)
//
//   const email = connector.create({ log });   // optional: outboxPath, env
//   const { listId } = await email.write.createList({ name, idempotencyKey: listKey, dryRun: false });
//   await email.write.addContacts({ listId, contacts, idempotencyKey: listKey, dryRun: false });
//
// A contact is exactly { external_ref, email, first_name } (external_ref is the
// client_id): any other field, such as a phone or an address, is refused.
//
// Partial failure: when the tool refuses some contacts, the others are
// recorded with their keys, the failed ones record nothing, and the call fails
// with a ConnectorFailed whose reason gives both counts and the failed refs.
// A failed call does not use up its key, so a retry with the same input sends
// the same contacts again and the tool adds only the ones it has no key for:
// the failed ones. A contact's key carries its list (the write's key, listId
// and external_ref), so the same key on another list adds the contacts there
// rather than count them as done. A call that succeeds returns { listId, added, alreadyAdded }.

const crypto = require('node:crypto');
const { defineConnector } = require('#sdk');
const { openOutbox, outboxPath } = require('./outbox');

const FIELDS = Object.freeze(['external_ref', 'email', 'first_name']);
const MAX_NAME = 120;

function checkName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) {
    throw new Error(`name must be a non-empty string of at most ${MAX_NAME} characters`);
  }
  return name;
}

// The contacts as { external_ref, email, first_name } with external_ref a
// string; throws on a missing or extra field, or a ref given twice.
function checkContacts(contacts) {
  if (!Array.isArray(contacts) || !contacts.length) throw new Error('contacts must be a non-empty list');
  const refs = new Set();
  return contacts.map((c, i) => {
    if (!c || typeof c !== 'object') throw new Error(`contact ${i + 1} is not an object`);
    const extra = Object.keys(c).filter((k) => !FIELDS.includes(k));
    if (extra.length) throw new Error(`contact ${i + 1}: fields not allowed: ${extra.join(', ')} (allowed: ${FIELDS.join(', ')})`);
    const ref = typeof c.external_ref === 'number' ? String(c.external_ref) : c.external_ref;
    if (typeof ref !== 'string' || !ref.trim()) throw new Error(`contact ${i + 1}: external_ref (the client_id) is required`);
    if (typeof c.email !== 'string' || !c.email.includes('@')) throw new Error(`contact ${i + 1}: email is required`);
    if (c.first_name !== undefined && typeof c.first_name !== 'string') throw new Error(`contact ${i + 1}: first_name must be a string`);
    if (refs.has(ref)) throw new Error(`contact ${i + 1}: external_ref ${ref} is given twice`);
    refs.add(ref);
    return { external_ref: ref, email: c.email, first_name: c.first_name ?? '' };
  });
}

// The stand-in email tool over the outbox. simulate is test-only (deps.simulate):
//   failContacts: a Set of external_refs the tool refuses (read on every call)
function mockEmailTool(outbox, simulate = {}) {
  return {
    // A key the tool has seen returns that list; otherwise a new list.
    createList(name, key) {
      return outbox.transaction((tx) => {
        const seen = tx.find('list', key);
        if (seen) return { listId: seen.payload.listId, name: seen.payload.name };
        const listId = `list-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
        tx.append({ type: 'list', operation: 'createList', key, payload: { listId, name } });
        return { listId, name };
      });
    },
    // Adds each contact whose key it has not seen on this list. Returns what
    // it added, what it already had and what it refused. One locked read of
    // the outbox per batch.
    addContacts(listId, keyed) {
      return outbox.transaction((tx) => {
        if (!tx.records.some((r) => r.type === 'list' && r.payload && r.payload.listId === listId)) {
          throw new Error(`no list ${listId} in the email tool`);
        }
        const out = { added: 0, alreadyAdded: 0, failed: [] };
        const fail = simulate.failContacts || new Set();
        for (const { key, ...contact } of keyed) {
          const seen = tx.find('contact', key);
          if (seen && seen.payload && seen.payload.listId === listId) { out.alreadyAdded += 1; continue; }
          if (fail.has(contact.external_ref)) {
            out.failed.push({ external_ref: contact.external_ref, reason: 'the email tool refused the address' });
            continue;
          }
          tx.append({ type: 'contact', operation: 'addContacts', key, payload: { listId, ...contact } });
          out.added += 1;
        }
        return out;
      });
    },
  };
}

function declare(outbox) {
  return defineConnector({
    id: 'email',
    system: 'Brightside email tool (mock)',
    auth: { env: ['BRIGHTSIDE_EMAIL_KEY'] },
    // When set (to anything), every write refuses before any I/O. So does
    // APLABS_WRITES_OFF for every connector at once.
    killSwitchEnv: 'BRIGHTSIDE_EMAIL_OFF',
    rateLimit: { perSecond: 5, batchSize: 100 },

    connect({ secret, simulate }) {
      secret('BRIGHTSIDE_EMAIL_KEY');
      if (!outbox) throw new Error('the mock email tool needs its outbox (create it with connector.create)');
      return mockEmailTool(outbox, simulate);
    },

    write: {
      // input: { name, idempotencyKey }. The name carries the run date (AD-15).
      createList: {
        plan: ({ name }) => ({ create: 'list', name: checkName(name) }),
        async apply({ name }, ctx) {
          checkName(name);
          return ctx.request(() => ctx.client.createList(name, ctx.idempotencyKey));
        },
      },
      // input: { listId, contacts: [{ external_ref, email, first_name }], idempotencyKey }.
      addContacts: {
        plan: ({ listId, contacts }) => ({ listId, add: checkContacts(contacts).length }),
        async apply({ listId, contacts }, ctx) {
          const checked = checkContacts(contacts);
          const total = { added: 0, alreadyAdded: 0, failed: [] };
          for (const batch of ctx.batches(checked)) {
            // A key per contact (the write's key, the list and the ref), never
            // per batch: the same key on another list is another contact.
            const keyed = batch.map((c) => ({ ...c, key: `${ctx.idempotencyKey}:${listId}:${c.external_ref}` }));
            const res = await ctx.request(() => ctx.client.addContacts(listId, keyed), { size: batch.length });
            total.added += res.added;
            total.alreadyAdded += res.alreadyAdded;
            total.failed.push(...res.failed);
          }
          if (total.failed.length) {
            const which = total.failed.map((f) => `external_ref ${f.external_ref}: ${f.reason}`).join('; ');
            throw new Error(`${total.added + total.alreadyAdded} of ${checked.length} contacts added, ${total.failed.length} failed (${which}); `
              + 'retry with the same key to send only the failed ones');
          }
          return { listId, added: total.added, alreadyAdded: total.alreadyAdded };
        },
      },
    },
  });
}

const email = declare(null);

// deps as the contract's create(deps), plus outboxPath (default outboxPath(env)).
// The outbox is the idempotency store unless deps.idempotency is given.
function create(deps = {}) {
  const outbox = openOutbox(deps.outboxPath || outboxPath(deps.env || process.env));
  return declare(outbox).create({ ...deps, idempotency: deps.idempotency || outbox.ledger });
}

module.exports = Object.freeze({ ...email, create, FIELDS });
