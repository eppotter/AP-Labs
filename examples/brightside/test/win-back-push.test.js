'use strict';

// Brightside's Win-back push (Story 10.3) against the mock email tool's
// outbox: Approve pushes the top 25 once, as one list
// (win-back-north-<UTC run date>) with 25 contacts; a second click, a replay
// or a same-tick double click adds nothing; a new pull of the same rows the
// same day is "already sent today; nothing new sent"; a kill switch on before
// Approve refuses without consuming, and one flipped mid-push stops honestly;
// a partial failure offers "Retry the failed ones", which adds only the
// failed contact, so the outbox holds each contact once.
//
// An example test (architecture carve-out): it reads Brightside's app dir,
// fixture data and mock email tool, and is deleted with the example in a
// fork. Its profile and Slack ids come from a test fixture
// (fixtures/win-back-profile.yml, no slack.ops_channel: escalations are
// logged only), never from profiles/brightside/.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { loadRegistry } = require('../../../kit/runtime/registry');
const { createStore } = require('../../../kit/runtime/store');
const approvalWrite = require('../../../kit/runtime/archetypes/approval-write');
const { testLog } = require('../../../kit/runtime/sdk');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');

const ROOT = path.join(__dirname, '../../..');
const PROFILE_PATH = path.join(__dirname, 'fixtures/win-back-profile.yml');
const APP_DIR = path.join(ROOT, 'examples/brightside/app');
const profile = loadProfile(PROFILE_PATH);
const { registry } = loadRegistry({ appDir: APP_DIR, profile });
const winBack = registry.module('win-back');
const email = require('../app/connectors/email/connector.js');
const ADMIN = profile.users.find((u) => u.role === 'admin').identities.slack;
const MENU = { id: 'VMENU', type: 'modal', private_metadata: 'brightside', title: { type: 'plain_text', text: 'Brightside' } };
const SYSTEM = 'Brightside email tool (mock)';

let tmp;
let FIXTURE;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-win-back-push-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

class ViewsSlackApp extends FakeSlackApp {
  constructor(options) { super({ ...options, views: true }); }
}

let seq = 0;
// Boots the app on the fixture build with its own outbox (a fresh
// APLABS_VAR_DIR) and store. env: extra env (an object a test may change).
async function boot(t, { env = {} } = {}) {
  seq += 1;
  const varDir = path.join(tmp, `var-${seq}`);
  const lines = [];
  const store = createStore();
  Object.assign(env, {
    APLABS_VAR_DIR: varDir,
    APLABS_NO_KEYCHAIN: '1',
    // Fake values, shaped like the real ones; nothing here is a credential.
    SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
    SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
    APLABS_PROFILE: PROFILE_PATH,
    APLABS_APP_DIR: APP_DIR,
    APLABS_DATA_PATH: FIXTURE,
  });
  const res = await main({
    env,
    cwd: os.tmpdir(),
    deps: {
      App: ViewsSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain'), store,
    },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => res.data.close());
  const outbox = path.join(varDir, 'outbox', 'email.jsonl');
  return {
    app: res.app, store, outbox, lines, env,
  };
}

const last = (app) => app.views.at(-1).args.view;
const actionsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const head = (view) => view.blocks[0].text.text;

// The outbox's records of one type ([] with no file).
function records(file, type) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === type);
}
const contactRefs = (file) => records(file, 'contact').map((r) => r.payload.external_ref);

// Runs Win-back North, top 25, presses Push and returns the Approve token.
async function preview(ctx) {
  const { app } = ctx;
  await app.dispatchAction('win-back:open', { user: { id: ADMIN }, view: MENU });
  const form = last(app);
  const formId = `V${app.viewSeq}`;
  const state = { values: {
    'sp-input:zone': { value: { type: 'static_select', selected_option: { value: 'north' } } },
    'sp-input:limit': { value: { type: 'plain_text_input', value: '25' } },
  } };
  await app.dispatchView('scoped-pull:form', {
    user: { id: ADMIN }, view: { id: formId, hash: `h${app.viewSeq}`, title: form.title, private_metadata: form.private_metadata, state },
  });
  const confirm = app.viewAcks.at(-1).view;
  const from = { id: formId, hash: 'hc', title: confirm.title, private_metadata: confirm.private_metadata, state: { values: {} } };
  await app.dispatchAction('scoped-pull:confirm', { user: { id: ADMIN }, view: from, value: actionsOf(confirm)[0].value });
  const push = actionsOf(last(app)).find((b) => b.action_id === 'approval-write:push');
  await app.dispatchAction('approval-write:push', { user: { id: ADMIN }, view: { ...from, hash: `h${app.viewSeq}` }, value: push.value });
  ctx.from = from;
  return actionsOf(last(app)).find((b) => b.action_id === 'approval-write:approve').value;
}

async function click(ctx, action, value, user = ADMIN) {
  await ctx.app.dispatchAction(action, { user: { id: user }, view: { ...ctx.from, hash: `h${ctx.app.viewSeq}` }, value });
  return last(ctx.app);
}

const today = () => new Date().toISOString().slice(0, 10);

test('Approve pushes the top 25 once: "Pushed 25, skipped 0, failed 0", and the outbox holds the list once with 25 contacts', async (t) => {
  const ctx = await boot(t);
  const token = await preview(ctx);
  const entry = ctx.store.get('approval', token);
  const view = await click(ctx, 'approval-write:approve', token);
  assert.equal(head(view), `*Pushed 25 to email tool*, skipped 0, failed 0. List: win-back-north-${today()}.`);
  const lists = records(ctx.outbox, 'list');
  assert.equal(lists.length, 1);
  assert.equal(lists[0].payload.name, `win-back-north-${today()}`);
  assert.deepEqual(contactRefs(ctx.outbox), entry.rows.map((r) => String(r.client_id)), 'exactly the approved rows, in rank order');
  const first = records(ctx.outbox, 'contact')[0].payload;
  assert.deepEqual(Object.keys(first).sort(), ['email', 'external_ref', 'first_name', 'listId'], 'never the score');
  // A second click, and a replayed payload: "already done", nothing added.
  const again = await click(ctx, 'approval-write:approve', token);
  assert.match(head(again), /^You already approved this push, so it ran once and I won't send it again\. \*Pushed 25 to email tool\*/);
  await click(ctx, 'approval-write:approve', token);
  assert.equal(records(ctx.outbox, 'contact').length, 25);
  assert.equal(records(ctx.outbox, 'list').length, 1);
  // Someone else replaying it learns nothing.
  assert.match(head(await click(ctx, 'approval-write:approve', token, 'U0FIXTUREMAX')), /^This preview is no longer valid/);
  assert.deepEqual(ctx.app.posted, []);
});

test('a same-tick double Approve adds the list and its contacts once', async (t) => {
  const ctx = await boot(t);
  const token = await preview(ctx);
  const view = { ...ctx.from, hash: 'hx' };
  await Promise.all([1, 2].map(() => ctx.app.dispatchAction('approval-write:approve', { user: { id: ADMIN }, view, value: token })));
  assert.equal(records(ctx.outbox, 'list').length, 1);
  assert.equal(records(ctx.outbox, 'contact').length, 25);
  assert.equal(new Set(contactRefs(ctx.outbox)).size, 25);
  const heads = ctx.app.views.slice(-2).map((v) => head(v.args.view)).sort();
  assert.match(heads[0], /^\*Pushed 25 to email tool\*/);
  assert.equal(heads[1], "You already approved this push and it's still running, so I won't send it twice.");
});

test('the same rows pulled again the same day: "already sent today; nothing new sent", and the outbox is unchanged (N6)', async (t) => {
  const ctx = await boot(t);
  await click(ctx, 'approval-write:approve', await preview(ctx));
  const before = fs.readFileSync(ctx.outbox, 'utf8');
  const second = await preview(ctx);
  const view = await click(ctx, 'approval-write:approve', second);
  assert.equal(head(view), `*Already sent today; nothing new sent.* email tool already has this list with these rows, so I didn't send it again (skipped 0). List: win-back-north-${today()}.`);
  assert.equal(fs.readFileSync(ctx.outbox, 'utf8'), before, 'nothing written');
});

test('BRIGHTSIDE_EMAIL_OFF or APLABS_WRITES_OFF on before Approve: nothing sent, the preview stays valid', async (t) => {
  for (const name of ['BRIGHTSIDE_EMAIL_OFF', 'APLABS_WRITES_OFF']) {
    const ctx = await boot(t);
    const token = await preview(ctx);
    ctx.env[name] = '1';
    const view = await click(ctx, 'approval-write:approve', token);
    assert.equal(head(view), `Sending to ${SYSTEM} is switched off right now, so nothing was sent. Please tell your admin.`, name);
    assert.equal(fs.existsSync(ctx.outbox), false);
    assert.ok(ctx.store.get('approval', token), 'not consumed');
    delete ctx.env[name];
    assert.match(head(await click(ctx, 'approval-write:approve', token)), /^\*Pushed 25 to email tool\*/);
  }
});

test('BRIGHTSIDE_EMAIL_OFF flipped mid-push (after the list is made): the contacts are not sent, the reply says so, and it is escalated (logged)', async (t) => {
  const env = {};
  // Off from the moment the outbox holds the list: between the push's two requests.
  Object.defineProperty(env, 'BRIGHTSIDE_EMAIL_OFF', {
    enumerable: true,
    get: () => (env.APLABS_VAR_DIR && records(path.join(env.APLABS_VAR_DIR, 'outbox', 'email.jsonl'), 'list').length ? '1' : undefined),
  });
  const ctx = await boot(t, { env });
  const token = await preview(ctx);
  const view = await click(ctx, 'approval-write:approve', token);
  assert.match(head(view), new RegExp(`^Sending to ${SYSTEM.replace(/[()]/g, '\\$&')} was switched off partway through: 0 items were sent before it stopped, and the rest weren't\\.`));
  assert.ok(!head(view).includes('Pushed'));
  assert.equal(records(ctx.outbox, 'list').length, 1);
  assert.equal(records(ctx.outbox, 'contact').length, 0);
  assert.deepEqual(ctx.store.done('approval', token).result.counts, {
    total: 25, sent: 0, already: 0, skipped: 0, failed: 25,
  });
  assert.deepEqual(ctx.app.posted, [], 'no ops channel in this profile: logged only');
  assert.ok(ctx.lines.some((l) => l.includes('push escalated (logged only') && l.includes('KillSwitchMidPush')));
});

test('a partial failure offers "Retry the failed ones"; the retry adds only the failed contact, so the outbox holds each contact once (DEP-013)', async (t) => {
  const ctx = await boot(t);
  const token = await preview(ctx);
  const entry = ctx.store.get('approval', token);
  const failing = String(entry.rows[3].client_id);
  // The archetype over the same outbox, with the mock refusing one contact.
  const simulate = { failContacts: new Set([failing]) };
  const tool = email.create({ log: testLog(), outboxPath: ctx.outbox, simulate });
  const aw = approvalWrite.createApprovalWrite({ store: ctx.store, log: testLog(), connectors: { get: () => tool } });
  const shown = [];
  const show = async (m) => { shown.push(m); };
  const resolve = () => ({ mod: winBack });
  await aw.click({ verb: 'approve', value: token, person: ADMIN, resolve, show });
  const view = shown.at(-1);
  assert.match(head(view), new RegExp(`^Sent 24 of 25 to ${SYSTEM.replace(/[()]/g, '\\$&')}; 1 failed\\. Nothing was sent twice, so trying again is safe`));
  assert.equal(records(ctx.outbox, 'contact').length, 24);
  assert.ok(!contactRefs(ctx.outbox).includes(failing));
  const retry = actionsOf(view).find((b) => b.action_id === 'approval-write:retry');
  assert.equal(retry.text.text, 'Retry the failed ones');
  const again = ctx.store.get('approval', retry.value);
  assert.equal(again.originalKey, entry.idempotencyKey);
  assert.notEqual(again.idempotencyKey, entry.idempotencyKey, 'its own derived key (review R2-1)');
  assert.deepEqual(again.rows.map((r) => String(r.client_id)), [failing], 'only the failed row');
  // The tool takes it now.
  simulate.failContacts.delete(failing);
  await aw.click({ verb: 'retry', value: retry.value, person: ADMIN, resolve, show });
  assert.equal(head(shown.at(-1)), `*Retried 1 that failed: sent 1, failed 0.* List: win-back-north-${today()}.`);
  assert.equal(records(ctx.outbox, 'list').length, 1);
  assert.equal(records(ctx.outbox, 'contact').length, 25);
  assert.deepEqual([...contactRefs(ctx.outbox)].sort(), entry.rows.map((r) => String(r.client_id)).sort(), 'each contact once');
});
