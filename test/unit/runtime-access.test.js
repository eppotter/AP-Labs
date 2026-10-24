'use strict';

// Story 6.3: menus and dispatch governed by the profile. A Slack id maps to a
// profile user via identities.slack; kit/lib/permissions decides each entry's
// resource key (deny beats allow); an unknown person sees only open access and
// is told who to ask; a key the profile does not declare is a configuration
// fault, never a denial. Fixture profile: test/fixtures/runtime/access.yml.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { createRegistry } = require('../../kit/runtime/registry');
const { registerHubs, NOT_AVAILABLE } = require('../../kit/runtime/slack/hubs');
const { personFor, decide, adminContact } = require('../../kit/runtime/access');
const { messageFor } = require('../../kit/runtime/messages');
const { NotSetUp, AccessDenied, ConfigFault } = require('../../kit/runtime/errors');
const { createStore } = require('../../kit/runtime/store');
const { FakeSlackApp } = require('../fixtures/fake-slack');

const profile = loadProfile(path.join(__dirname, '../fixtures/runtime/access.yml'));
const ADMIN = '<@UADA> or Dee &lt;D&gt;';

function mod(id, resource, ran) {
  return Object.freeze({
    id, hub: 'main', label: `${id[0].toUpperCase()}${id.slice(1)}`, description: `${id} entry`,
    resource, archetype: 'handler', environments: ['dev'],
    run: async (ctx) => { ran.push({ id, person: ctx.person.id }); await ctx.reply(`ran ${id}`); },
  });
}

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// "typo" names a key the profile does not declare: boot refuses it (registry
// tests); here it reaches the runtime to prove it is reported as a fault.
function setup() {
  const ran = [];
  const modules = [mod('open', 'OPEN_THING', ran), mod('reports', 'REPORTS', ran), mod('payroll', 'PAYROLL', ran), mod('typo', 'TYPO_THING', ran)];
  const registry = createRegistry({ hubs: [{ id: 'main', name: 'Main', command: '/main' }], modules });
  const app = new FakeSlackApp({});
  const log = quietLog();
  registerHubs(app, { registry, profile, env: 'dev', log, store: createStore() });
  return { app, log, ran };
}

// The Open buttons' module ids, in menu order (Help is tested in runtime-welcome).
const buttons = (msg) => msg.blocks.filter((b) => b.accessory && /:open$/.test(b.accessory.action_id))
  .map((b) => b.accessory.action_id.replace(/:open$/, ''));
const notice = (msg) => msg.blocks.find((b) => b.type === 'context');

async function menuFor(slackId) {
  const s = setup();
  await s.app.dispatchCommand('/main', { user_id: slackId });
  return { ...s, menu: s.app.responded[0] };
}

test('personFor maps a Slack id to the one profile user with it, else null', () => {
  assert.equal(personFor(profile, 'UBO').id, 'bo');
  assert.equal(personFor(profile, 'UNOPE'), null);
  assert.equal(personFor(profile, ''), null);
  assert.equal(personFor(profile, undefined), null);
  assert.equal(personFor(profile, '__proto__'), null);
});

test('decide asks kit/lib/permissions with the profile user id', () => {
  assert.equal(decide(profile, personFor(profile, 'UBO'), 'REPORTS'), 'allowed');
  assert.equal(decide(profile, null, 'REPORTS'), 'denied');
  assert.equal(decide(profile, null, 'OPEN_THING'), 'allowed');
  assert.equal(decide(profile, null, 'TYPO_THING'), 'error');
});

test('adminContact mentions admins with a Slack id and names the rest, escaped', () => {
  assert.equal(adminContact(profile), ADMIN);
});

test('allow: a granted entry shows and its click runs the handler', async () => {
  const { app, menu, ran } = await menuFor('UBO');
  assert.deepEqual(buttons(menu), ['open', 'reports']);
  assert.equal(notice(menu), undefined);
  await app.dispatchAction('reports:open', { user: { id: 'UBO', name: 'bo' } });
  assert.deepEqual(ran, [{ id: 'reports', person: 'UBO' }]);
  assert.equal(app.responded[1].text, 'ran reports');
});

test('an admin gets admin-grantable keys but not one marked admin_grantable: false', async () => {
  const { menu } = await menuFor('UADA');
  assert.deepEqual(buttons(menu), ['open', 'reports']);
});

test('deny: a replayed click on an entry the person may not use is refused at dispatch, naming it and who to ask', async () => {
  const { app, log, ran } = setup();
  await app.dispatchAction('payroll:open', { user: { id: 'UADA' } });
  assert.equal(app.acks, 1);
  assert.deepEqual(ran, []);
  assert.equal(app.responded[0].text, `You don't have access to Payroll; ask ${ADMIN}.`);
  assert.equal(app.responded[0].response_type, 'ephemeral');
  const refused = log.lines.find((l) => l.msg === 'hub action refused');
  assert.equal(refused.fields.reason, 'AccessDenied');
  assert.equal(refused.fields.user, 'ada');
});

test('deny beats allow: a granted key the user also denies is hidden and refused', async () => {
  const { app, menu, ran } = await menuFor('UBO');
  assert.ok(!buttons(menu).includes('payroll'));
  await app.dispatchAction('payroll:open', { user: { id: 'UBO' } });
  assert.deepEqual(ran, []);
  assert.match(app.responded[1].text, /^You don't have access to Payroll; ask /);
});

test('deny beats open access for a known person', async () => {
  const { app, menu, ran } = await menuFor('UCY');
  assert.deepEqual(buttons(menu), []);
  assert.ok(menu.blocks.some((b) => b.type === 'section' && /Nothing is available/.test(b.text.text)));
  await app.dispatchAction('open:open', { user: { id: 'UCY' } });
  assert.deepEqual(ran, []);
  assert.equal(app.responded[1].text, `You don't have access to Open; ask ${ADMIN}.`);
});

test('unknown person: only open-access entries show, with a not-set-up notice naming who to ask', async () => {
  const { app, menu, ran } = await menuFor('USTRANGER');
  assert.deepEqual(buttons(menu), ['open']);
  const expected = `You're not set up in Tiny &amp; Co's bot yet, so you only see what's open to everyone. Ask ${ADMIN} to add you.`;
  assert.equal(notice(menu).elements[0].text, expected);
  assert.ok(menu.text.endsWith(expected));
  await app.dispatchAction('open:open', { user: { id: 'USTRANGER', name: 's' } });
  assert.deepEqual(ran, [{ id: 'open', person: 'USTRANGER' }]);
  // A closed entry: told they are not set up, without naming the entry.
  await app.dispatchAction('reports:open', { user: { id: 'USTRANGER' } });
  assert.equal(app.responded[2].text, expected);
  assert.equal(ran.length, 1);
});

test('a payload with no user id is treated as an unknown person', async () => {
  const { app, ran } = setup();
  await app.dispatchAction('reports:open', { user: {} });
  assert.deepEqual(ran, []);
  assert.match(app.responded[0].text, /^You're not set up/);
});

test('misconfigured key: hidden from the menu and logged; a click is a configuration fault, never a denial', async () => {
  const { app, log, menu, ran } = await menuFor('UADA');
  assert.ok(!buttons(menu).includes('typo'));
  const fault = log.lines.find((l) => l.msg === 'access configuration fault');
  assert.equal(fault.level, 'error');
  assert.deepEqual(fault.fields, { module: 'typo', resource: 'TYPO_THING' });
  await app.dispatchAction('typo:open', { user: { id: 'UADA' } });
  assert.deepEqual(ran, []);
  const reply = app.responded[1].text;
  assert.equal(reply, `That option isn't set up correctly, so I can't open it right now. I've logged the problem; please tell ${ADMIN}.`);
  assert.ok(!/access/i.test(reply));
  assert.equal(log.lines.filter((l) => l.msg === 'hub action refused').pop().fields.reason, 'ConfigFault');
});

test('environment-hidden and unknown entries still get the generic reply before any access check', async () => {
  const { app } = setup();
  await app.dispatchAction('ghost:open', { user: { id: 'UBO' } });
  assert.deepEqual(app.responded.map((r) => r.text), [NOT_AVAILABLE]);
});

test('messages: each refusal kind has one plain message; other errors have none', () => {
  assert.equal(messageFor(new AccessDenied({ label: 'A&B', admin: 'X' })), "You don't have access to A&amp;B; ask X.");
  assert.match(messageFor(new NotSetUp({ client: 'C', admin: 'X' })), /not set up in C's bot yet.*Ask X to add you\./);
  assert.match(messageFor(new ConfigFault({ admin: 'X' })), /isn't set up correctly.*tell X\./);
  assert.equal(messageFor(new Error('boom')), null);
  assert.equal(new AccessDenied({}).name, 'AccessDenied');
});
