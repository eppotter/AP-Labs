'use strict';

// A fixture connector for the approval-write tests (Story 10.2): one write,
// sendList({ name, contacts, idempotencyKey }). Its plan skips a contact with
// no address (reason "no address"); its apply sends the rest. It counts the
// instances create() makes and keeps what it was sent, so a test can see one
// instance per process and that a preview sends nothing.

const { defineConnector } = require('#sdk');

const state = { created: 0, sent: [], deps: null };
const ok = (c) => typeof c.address === 'string' && c.address.includes('@');

const mail = defineConnector({
  id: 'mail',
  system: 'Fixture mail tool',
  auth: { env: [] },
  killSwitchEnv: 'FIXTURE_MAIL_OFF',
  rateLimit: { perSecond: 1000, batchSize: 50 },
  connect: () => ({ send: (items) => { state.sent.push(...items); return { sent: items.length }; } }),
  write: {
    sendList: {
      perItemIdempotency: true,
      plan: ({ name, contacts }) => ({
        name,
        add: contacts.filter(ok).length,
        skipped: contacts.filter((c) => !ok(c)).map((c) => ({ ref: String(c.ref), reason: 'no address' })),
      }),
      async apply({ contacts }, ctx) {
        const send = contacts.filter(ok);
        return ctx.request(() => ctx.client.send(send), { size: send.length });
      },
    },
  },
});

module.exports = Object.freeze({
  ...mail,
  create(deps) {
    state.created += 1;
    state.deps = deps;
    return mail.create(deps);
  },
  state,
});
