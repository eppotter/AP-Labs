'use strict';

// A fixture connector for the approval-write tests (Stories 10.2, 10.3): one
// write, sendList({ name, contacts, idempotencyKey }). Its plan skips a
// contact with no address (reason "no address"); its apply sends the rest in
// batches of 2, keyed per contact (the write's key and the ref), so a retry
// with the same key and input sends only what the "system" lacks
// (perItemIdempotency). It counts the instances create() makes and keeps what
// it was sent, so a test can see one instance per process, that a preview
// sends nothing, and that a push never sends a contact twice.
//
// Test levers on state (reset() puts them back, with a fresh idempotency store):
//   failRefs     a Set of refs the system refuses (a PartialFailure)
//   beforeSend   async ({ batch, index }) => {}, run inside each request before
//                the system applies it: a test can hold a push in flight, flip
//                a kill switch partway, or throw (an outage, or { status: 401 })
//   trusting     true: apply sends every contact it is given, re-checking
//                nothing (a fork connector that relies on the archetype to
//                leave out the skipped rows, review R1-1)
//   received     every contact apply was given
//   skipRef      a function (contact) => ref the plan reports for a skipped
//                contact (default its ref): a test can make it unmatched

const { defineConnector, PartialFailure } = require('#sdk');

const ok = (c) => typeof c.address === 'string' && c.address.includes('@');

function freshLedger() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); }, map: m };
}

const state = {
  created: 0, sent: [], deps: null, delivered: new Set(), failRefs: new Set(), beforeSend: null, ledger: freshLedger(), requests: 0, trusting: false, received: [], skipRef: null,
};

function reset() {
  state.sent.length = 0;
  state.delivered = new Set();
  state.failRefs = new Set();
  state.beforeSend = null;
  state.ledger = freshLedger();
  state.requests = 0;
  state.trusting = false;
  state.received = [];
  state.skipRef = null;
}

const mail = defineConnector({
  id: 'mail',
  system: 'Fixture mail tool',
  auth: { env: [] },
  killSwitchEnv: 'FIXTURE_MAIL_OFF',
  rateLimit: { perSecond: 1000, batchSize: 2 },
  connect: () => ({
    // Adds each contact whose key it hasn't seen; refuses the failRefs.
    async send(keyed, index) {
      state.requests += 1;
      if (state.beforeSend) await state.beforeSend({ batch: keyed, index });
      const out = { added: 0, alreadyAdded: 0, failedRefs: [] };
      for (const { key, ...contact } of keyed) {
        if (state.delivered.has(key)) { out.alreadyAdded += 1; continue; }
        if (state.failRefs.has(String(contact.ref))) { out.failedRefs.push(String(contact.ref)); continue; }
        state.delivered.add(key);
        state.sent.push(contact);
        out.added += 1;
      }
      return out;
    },
  }),
  write: {
    sendList: {
      perItemIdempotency: true,
      plan: ({ name, contacts }) => ({
        name,
        add: contacts.filter(ok).length,
        skipped: contacts.filter((c) => !ok(c)).map((c) => ({ ref: state.skipRef ? state.skipRef(c) : String(c.ref), reason: 'no address' })),
      }),
      async apply({ contacts }, ctx) {
        state.received.push(...contacts);
        const send = state.trusting ? contacts : contacts.filter(ok);
        const total = { added: 0, alreadyAdded: 0, failedRefs: [] };
        let index = 0;
        for (const batch of ctx.batches(send)) {
          const keyed = batch.map((c) => ({ ...c, key: `${ctx.idempotencyKey}:${c.ref}` }));
          const i = index;
          index += 1;
          const res = await ctx.request(() => ctx.client.send(keyed, i), { size: batch.length });
          total.added += res.added;
          total.alreadyAdded += res.alreadyAdded;
          total.failedRefs.push(...res.failedRefs);
        }
        if (total.failedRefs.length) {
          const succeeded = total.added + total.alreadyAdded;
          throw new PartialFailure(`${succeeded} of ${send.length} added`, { succeeded, failed: total.failedRefs.length, failedRefs: total.failedRefs });
        }
        return { added: total.added, alreadyAdded: total.alreadyAdded };
      },
    },
  },
});

module.exports = Object.freeze({
  ...mail,
  create(deps) {
    state.created += 1;
    state.deps = deps;
    return mail.create({ ...deps, idempotency: state.ledger });
  },
  state,
  reset,
});
