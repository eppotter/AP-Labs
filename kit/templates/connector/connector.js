'use strict';

// TODO: one or two lines on which system this connects to and what for.
// Guide: kit/templates/connector.md. This is trusted, reviewed code, not
// sandboxed. Import engine helpers only from '#sdk'.
//
// The template talks to an in-memory stand-in for the system (connect below),
// so it runs and passes the contract suite as it is. Replace connect with the
// system's real client and each operation's body with real calls; keep every
// call inside ctx.request so the rate limit, auth handling and redaction apply.

const { defineConnector } = require('#sdk');

// The only record fields a read may ask for (least privilege: never fetch more).
const FIELDS = ['id', 'name', 'email'];

module.exports = defineConnector({
  id: 'my-system',
  system: 'My System',
  // Env var NAMES the connector reads, never values. Read once, then cached.
  auth: { env: ['MY_SYSTEM_TOKEN'] },
  // When set (to anything), every write refuses before any I/O. So does
  // APLABS_WRITES_OFF for every connector at once.
  killSwitchEnv: 'MY_SYSTEM_OFF',
  // From the system's documented limits; the engine waits, never drops.
  rateLimit: { perSecond: 5, batchSize: 100 },

  // Builds the client once per process, with the credential. Replace with the
  // real client, for example one that sends `Authorization: Bearer <token>`.
  // On a 401 or 403 the client must throw an error with that status.
  connect({ secret, simulate }) {
    const token = secret('MY_SYSTEM_TOKEN');
    return inMemorySystem(token, simulate);
  },

  read: {
    // input: { id, fields }. Returns only the fields asked for, or null.
    async getRecord({ id, fields = ['id'] }, ctx) {
      const bad = fields.filter((f) => !FIELDS.includes(f));
      if (bad.length) throw new Error(`getRecord: unknown fields ${bad.join(', ')}`);
      const record = await ctx.request(() => ctx.client.get(id));
      return record ? Object.fromEntries(fields.map((f) => [f, record[f]])) : null;
    },
  },

  write: {
    // plan(input) says what would be written: no I/O, used for a dry run.
    // apply(input, ctx) writes. ctx.idempotencyKey is the caller's key; pass it
    // on to the system when its API takes one.
    createList: {
      plan: ({ name }) => ({ create: 'list', name }),
      async apply({ name }, ctx) {
        const list = await ctx.request(() => ctx.client.createList(name, ctx.idempotencyKey));
        return { listId: list.id };
      },
    },
    // input: { listId, items: [{ id, email, name }], idempotencyKey }.
    addItems: {
      plan: ({ listId, items = [] }) => ({ listId, add: items.length }),
      async apply({ listId, items = [] }, ctx) {
        if (items.some((item) => !item || item.id === undefined)) throw new Error('addItems: every item needs an id');
        let added = 0;
        for (const batch of ctx.batches(items)) {
          // A key per item (the write's key plus the item's id), never per
          // batch: a retry after a partial failure resends only the items the
          // system has not seen, however the rows are ordered or batched.
          const keyed = batch.map((item) => ({ ...item, key: `${ctx.idempotencyKey}:${item.id}` }));
          added += await ctx.request(() => ctx.client.addItems(listId, keyed), { size: batch.length });
        }
        return { listId, added };
      },
    },
  },
});

// The stand-in system. Delete it once connect returns the real client.
// simulate is test-only (deps.simulate): simulate.state shares the stand-in's
// lists across instances, so a test can see what reached the "system".
function inMemorySystem(token, { state = {} } = {}) {
  const records = new Map([['r1', { id: 'r1', name: 'Example', email: 'example@example.invalid', phone: 'never returned' }]]);
  state.lists ??= new Map();
  state.seen ??= new Map();
  const { lists, seen } = state;
  const once = (key, fn) => {
    if (!seen.has(key)) seen.set(key, fn());
    return seen.get(key);
  };
  return {
    authorised: Boolean(token),
    get: async (id) => records.get(id) || null,
    createList: async (name, key) => once(key, () => {
      const list = { id: `list-${lists.size + 1}`, name, items: [] };
      lists.set(list.id, list);
      return list;
    }),
    // Adds the items whose key it has not seen; returns how many it added.
    addItems: async (listId, items) => {
      const list = lists.get(listId) || { items: [] };
      let added = 0;
      for (const { key, ...item } of items) {
        once(key, () => { list.items.push(item); added += 1; });
      }
      return added;
    },
  };
}
