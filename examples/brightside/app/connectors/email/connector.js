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
// A mock declares no credential (auth.env is empty, #90), as the mock CRM
// doesn't: there is nothing to keep secret.
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
// with a PartialFailure (a ConnectorFailed) carrying { succeeded, failed,
// failedRefs }: the failed contacts' external_refs, never their email (#90).
// Its text is counts only. addContacts declares perItemIdempotency, so the
// person is told a retry with the same key is safe.
// A failed call does not use up its key, so a retry with the same input sends
// the same contacts again and the tool adds only the ones it has no key for:
// the failed ones. A contact's key carries its list (the write's key, listId
// and external_ref), so the same key on another list adds the contacts there
// rather than count them as done. A call that succeeds returns { listId, added, alreadyAdded }.
//
// pushList (Story 10.2, plan epic-10 decision 3): the one write the
// approval-write archetype calls for a Win-back push. It creates the list and
// adds its contacts in batches, under one idempotency key:
//
//   await email.write.pushList({ name, contacts, idempotencyKey, dryRun: false });
//
// Its plan (the preview's dry run) lists the contacts the tool would refuse as
// skipped, with a short reason (no email), and apply sends only the others,
// so what the person approved is what goes. Every request returns only counts
// and id-shaped refs, so the contract keeps each answer in its progress
// record and a push that dies partway resumes (10.0): the list step returns
// { listId } (never the name), each contact batch { added, alreadyAdded,
// failedRefs } (no reason text). A list id always has a digit, so it is
// id-shaped. It declares perItemIdempotency: each contact is keyed (the push's
// key, the list and the ref), so a retry with the same key and input adds
// only what failed. createList and addContacts stay for other callers.
//
// listKey (optional, Story 10.3 review R2-1): the list's own key, when it
// differs from the write's. The approval-write archetype retries the failed
// contacts of a push under a derived key, but they belong on the SAME list:
// it passes the first push's key as listKey on every push and retry, and the
// list and each contact are keyed by it (else by idempotencyKey), so a retry
// adds to the list the first push made and never makes a second one.
//
// sendEmails (Story 20.1, plan brightside-v1 D14, D14a, GRD-010): appointment
// emails, a reminder or a change notice, in the contract's { name, contacts }
// shape so the approval-write archetype pushes them as it pushes a list:
//
//   await email.write.sendEmails({ name, contacts, idempotencyKey, listKey?, dryRun: false });
//
// Each contact is exactly { external_ref, email, first_name, kind, visit_date,
// window, crew_name, package_name, before_date?, before_window?,
// before_crew_name?, reason? } (external_ref is the scheduled_visit_id); any
// other field is refused, and the template fields are checked by
// ./templates.js (a missing or malformed one, a change that changes nothing).
// The connector renders each email in its dry run, so the preview shows the
// exact subject and body, and apply sends what was previewed: plan returns
// { name, send, skipped, emails: [{ ref, to, kind, subject, body }], limits }.
// No AI writes or polishes the text.
//
// The address parse is strict (D14): exactly one address, lower case, no
// display name, comma or whitespace, no trailing dot, ending in ".invalid".
// A contact without one is skipped ("no email"), one with any other address
// is skipped ("address refused"), the same way in plan and apply, so it never
// reaches the outbox; the mock tool refuses such an address too.
//
// Limits (D14): at most 50 emails a push (more and both plan and apply refuse
// the whole push, so nothing is sent) and 200 a UTC day in the outbox
// (checked with the push's emails inside one locked outbox transaction: over
// it, the whole push is refused and nothing is sent).
//
// Idempotency (D14a): each email's key is the push's key (listKey when given,
// as for pushList, else idempotencyKey), its kind, its scheduled_visit_id and
// a hash of its new date, window and crew. A repeat sends nothing; a second,
// different change to the same visit is a new email. It declares
// perItemIdempotency: a retry with the same key and input sends only the
// emails that failed. Every request answers only counts and id-shaped refs.

const crypto = require('node:crypto');
const path = require('node:path');
const { defineConnector, PartialFailure } = require('#sdk');
const {
  openOutbox, outboxPath, emailsSentOn, dayOf,
} = require('./outbox');
const templates = require('./templates');

const FIELDS = Object.freeze(['external_ref', 'email', 'first_name']);
const MAX_NAME = 120;

// A contact the tool would refuse for its data, not its shape: no usable
// email. Returned by sortContacts as skipped, never sent.
const SKIP_NO_EMAIL = 'no email';

// sendEmails: a contact's fields, its skip reason for an address the tool
// refuses, and the limits (D14).
const EMAIL_FIELDS = Object.freeze(['external_ref', 'email', ...templates.FIELDS]);
const SKIP_ADDRESS = 'address refused';
const LIMITS = Object.freeze({ perPush: 50, perDay: 200 });
const MAX_ADDRESS = 254;
// One plain address, lower case, ending in .invalid: a local part of dot-
// separated atoms, then dot-separated domain labels. No display name, quote,
// angle bracket, comma, whitespace, upper case or trailing dot can match.
const ADDRESS = /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+invalid$/;

// True when the tool takes the address: a string matching ADDRESS, at most
// 254 characters. Anything else (two addresses, "Name <a@b.invalid>", a comma,
// a space, "a@b.invalid.", "A@b.invalid", "a@b.com") is refused.
function isAllowedAddress(email) {
  return typeof email === 'string' && email.length <= MAX_ADDRESS && ADDRESS.test(email);
}

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

// pushList's contacts split into those to send and those the tool would
// refuse (skipped: [{ ref, reason }]). The shape is checked as in
// checkContacts (an unknown field or a missing ref throws); a missing or
// unusable email is a skip, decided the same way by plan and apply.
function sortContacts(contacts) {
  if (!Array.isArray(contacts) || !contacts.length) throw new Error('contacts must be a non-empty list');
  const send = [];
  const skipped = [];
  const refs = new Set();
  contacts.forEach((c, i) => {
    if (!c || typeof c !== 'object') throw new Error(`contact ${i + 1} is not an object`);
    const extra = Object.keys(c).filter((k) => !FIELDS.includes(k));
    if (extra.length) throw new Error(`contact ${i + 1}: fields not allowed: ${extra.join(', ')} (allowed: ${FIELDS.join(', ')})`);
    const ref = typeof c.external_ref === 'number' ? String(c.external_ref) : c.external_ref;
    if (typeof ref !== 'string' || !ref.trim()) throw new Error(`contact ${i + 1}: external_ref (the client_id) is required`);
    if (refs.has(ref)) throw new Error(`contact ${i + 1}: external_ref ${ref} is given twice`);
    refs.add(ref);
    if (typeof c.email !== 'string' || !c.email.includes('@')) {
      skipped.push({ ref, reason: SKIP_NO_EMAIL });
      return;
    }
    const firstName = typeof c.first_name === 'string' ? c.first_name : '';
    send.push({ external_ref: ref, email: c.email, first_name: firstName });
  });
  return { send, skipped };
}

// sendEmails' contacts: { send: [{ external_ref, to, kind, subject, body,
// change }], skipped: [{ ref, reason }] }. Throws on a list over the push
// limit, a missing or extra field, a ref given twice or template fields
// ./templates.js refuses; a missing email or an address the tool refuses is
// a skip, decided the same way by plan and apply. change: a hash of the new
// date, window and crew, part of the email's key.
function sortEmails(contacts) {
  if (!Array.isArray(contacts) || !contacts.length) throw new Error('contacts must be a non-empty list');
  if (contacts.length > LIMITS.perPush) {
    throw new Error(`${contacts.length} emails is over the limit of ${LIMITS.perPush} a push, so none is sent`);
  }
  const send = [];
  const skipped = [];
  const refs = new Set();
  contacts.forEach((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`contact ${i + 1} is not an object`);
    const extra = Object.keys(c).filter((k) => !EMAIL_FIELDS.includes(k));
    if (extra.length) throw new Error(`contact ${i + 1}: fields not allowed: ${extra.join(', ')} (allowed: ${EMAIL_FIELDS.join(', ')})`);
    const ref = typeof c.external_ref === 'number' && Number.isSafeInteger(c.external_ref) ? String(c.external_ref) : c.external_ref;
    if (typeof ref !== 'string' || !ref.trim()) throw new Error(`contact ${i + 1}: external_ref (the scheduled_visit_id) is required`);
    if (refs.has(ref)) throw new Error(`contact ${i + 1}: external_ref ${ref} is given twice`);
    refs.add(ref);
    const { external_ref: _ref, email: to, ...fields } = c;
    let rendered;
    try {
      rendered = templates.render(fields);
    } catch (err) {
      throw new Error(`contact ${i + 1}: ${err.message}`);
    }
    if (to === undefined || to === null || to === '') {
      skipped.push({ ref, reason: SKIP_NO_EMAIL });
      return;
    }
    if (!isAllowedAddress(to)) {
      skipped.push({ ref, reason: SKIP_ADDRESS });
      return;
    }
    const change = crypto.createHash('sha256')
      .update(JSON.stringify([fields.visit_date, fields.window, fields.crew_name.trim()])).digest('hex').slice(0, 12);
    send.push({
      external_ref: ref, to, kind: rendered.kind, subject: rendered.subject, body: rendered.body, change,
    });
  });
  return { send, skipped };
}

// A list id from its key: "list-" and 12 hex characters, with a 0 added when
// those have no digit, so it is always id-shaped (the contract keeps only
// id-shaped strings in a progress record).
function listIdFor(key) {
  const id = `list-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  return /[0-9]/.test(id) ? id : `${id}0`;
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
        const listId = listIdFor(key);
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
    // Sends each email whose key it has not seen, as one locked transaction:
    // the day limit is checked first, against the emails it would add, and
    // over it nothing is sent. An address it doesn't take is refused (failed),
    // as a real tool refuses one. Returns what it sent, what it already had
    // and the refs it refused.
    sendEmails(push, keyed, { perDay }) {
      return outbox.transaction((tx) => {
        const fresh = keyed.filter((e) => !tx.find('email', e.key));
        const today = emailsSentOn(tx.records, dayOf());
        if (today + fresh.length > perDay) {
          throw new Error(`the email tool has sent ${today} emails today; ${fresh.length} more is over the limit of ${perDay} a day, so none is sent`);
        }
        const out = { sent: 0, alreadySent: keyed.length - fresh.length, failedRefs: [] };
        const fail = simulate.failContacts || new Set();
        for (const { key, ...email } of fresh) {
          if (fail.has(email.external_ref) || !isAllowedAddress(email.to)) {
            out.failedRefs.push(email.external_ref);
            continue;
          }
          tx.append({ type: 'email', operation: 'sendEmails', key, payload: { push, ...email } });
          out.sent += 1;
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
    auth: { env: [] },
    // When set (to anything), every write refuses before any I/O. So does
    // APLABS_WRITES_OFF for every connector at once.
    killSwitchEnv: 'BRIGHTSIDE_EMAIL_OFF',
    rateLimit: { perSecond: 5, batchSize: 100 },

    connect({ simulate }) {
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
        // Each contact is keyed (write key, list, ref) and the tool adds only
        // keys it hasn't seen, so a retry with the same key and input sends
        // only the failed ones: a partial failure may say retrying is safe.
        perItemIdempotency: true,
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
            // Counts only in the text: the refs ride in failedRefs (the
            // engine masks any that aren't id-shaped), never in a message.
            const succeeded = total.added + total.alreadyAdded;
            throw new PartialFailure(`${succeeded} of ${checked.length} contacts added, ${total.failed.length} failed`, {
              succeeded, failed: total.failed.length, failedRefs: total.failed.map((f) => f.external_ref),
            });
          }
          return { listId, added: total.added, alreadyAdded: total.alreadyAdded };
        },
      },
      // input: { name, contacts: [{ external_ref, email, first_name }], idempotencyKey }.
      // One push: the list, then its contacts in batches, under one key.
      pushList: {
        perItemIdempotency: true,
        plan: ({ name, contacts }) => {
          const { send, skipped } = sortContacts(contacts);
          return { create: 'list', name: checkName(name), add: send.length, skipped };
        },
        async apply({ name, contacts, listKey }, ctx) {
          checkName(name);
          if (listKey !== undefined && (typeof listKey !== 'string' || !listKey)) throw new Error('listKey must be a non-empty string');
          const base = listKey || ctx.idempotencyKey;
          const { send, skipped } = sortContacts(contacts);
          // The list step carries no items (size 0) and answers only its id.
          const { listId } = await ctx.request(async () => {
            const made = await ctx.client.createList(name, base);
            return { listId: made.listId };
          }, { size: 0 });
          const total = { added: 0, alreadyAdded: 0, failedRefs: [] };
          for (const batch of ctx.batches(send)) {
            const keyed = batch.map((c) => ({ ...c, key: `${base}:${listId}:${c.external_ref}` }));
            // Counts and refs only, never the tool's reason text.
            const res = await ctx.request(async () => {
              const out = await ctx.client.addContacts(listId, keyed);
              return { added: out.added, alreadyAdded: out.alreadyAdded, failedRefs: out.failed.map((f) => f.external_ref) };
            }, { size: batch.length });
            total.added += res.added;
            total.alreadyAdded += res.alreadyAdded;
            total.failedRefs.push(...res.failedRefs);
          }
          if (total.failedRefs.length) {
            const succeeded = total.added + total.alreadyAdded;
            throw new PartialFailure(`${succeeded} of ${send.length} contacts added, ${total.failedRefs.length} failed`, {
              succeeded, failed: total.failedRefs.length, failedRefs: total.failedRefs,
            });
          }
          return { listId, added: total.added, alreadyAdded: total.alreadyAdded, skipped: skipped.length };
        },
      },
      // input: { name, contacts: [{ external_ref, email, first_name, kind, visit_date, window,
      // crew_name, package_name, before_date?, before_window?, before_crew_name?, reason? }],
      // idempotencyKey, listKey? }. Appointment emails (Story 20.1, D14a).
      sendEmails: {
        perItemIdempotency: true,
        plan: ({ name, contacts }) => {
          checkName(name);
          const { send, skipped } = sortEmails(contacts);
          return {
            name,
            send: send.length,
            skipped,
            emails: send.map((e) => ({
              ref: e.external_ref, to: e.to, kind: e.kind, subject: e.subject, body: e.body,
            })),
            limits: { ...LIMITS },
          };
        },
        async apply({ name, contacts, listKey }, ctx) {
          checkName(name);
          if (listKey !== undefined && (typeof listKey !== 'string' || !listKey)) throw new Error('listKey must be a non-empty string');
          const base = listKey || ctx.idempotencyKey;
          const { send, skipped } = sortEmails(contacts);
          const total = { sent: 0, alreadySent: 0, failedRefs: [] };
          // At most 50 emails (the push limit) in batches of 100: one
          // request, so the day limit is checked once for the whole push.
          for (const batch of ctx.batches(send)) {
            const keyed = batch.map(({ change, ...e }) => ({ ...e, key: `${base}:${e.kind}:${e.external_ref}:${change}` }));
            // Counts and refs only, never an address or the text.
            const res = await ctx.request(async () => {
              const out = await ctx.client.sendEmails(name, keyed, { perDay: LIMITS.perDay });
              return { sent: out.sent, alreadySent: out.alreadySent, failedRefs: out.failedRefs };
            }, { size: batch.length });
            total.sent += res.sent;
            total.alreadySent += res.alreadySent;
            total.failedRefs.push(...res.failedRefs);
          }
          if (total.failedRefs.length) {
            const succeeded = total.sent + total.alreadySent;
            throw new PartialFailure(`${succeeded} of ${send.length} emails sent, ${total.failedRefs.length} failed`, {
              succeeded, failed: total.failedRefs.length, failedRefs: total.failedRefs,
            });
          }
          return { sent: total.sent, alreadySent: total.alreadySent, skipped: skipped.length };
        },
      },
    },
  });
}

const email = declare(null);

// One outbox and one declared connector per outbox file, for the process: every
// create() on a file shares its idempotency store object, and with it the
// contract's in-flight writes, so two instances racing one key apply once and
// a reused key with another input is refused (DEP-012).
const BY_FILE = new Map();
function forFile(file) {
  const resolved = path.resolve(file);
  if (!BY_FILE.has(resolved)) {
    const outbox = openOutbox(resolved);
    BY_FILE.set(resolved, { outbox, connector: declare(outbox) });
  }
  return BY_FILE.get(resolved);
}

// deps as the contract's create(deps), plus outboxPath (default outboxPath(env)).
// The outbox is the idempotency store unless deps.idempotency is given.
function create(deps = {}) {
  const { outbox, connector } = forFile(deps.outboxPath || outboxPath(deps.env || process.env));
  return connector.create({ ...deps, idempotency: deps.idempotency || outbox.ledger });
}

module.exports = Object.freeze({
  ...email, create, FIELDS, SKIP_NO_EMAIL, EMAIL_FIELDS, SKIP_ADDRESS, LIMITS, isAllowedAddress,
});
