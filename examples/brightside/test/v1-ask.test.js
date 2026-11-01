'use strict';

// Brightside v1's Ask and Request a tool (plan brightside-v1, D7, D9, D12,
// Story 19.3), end to end through the booted engine with the fake Slack
// client and a stand-in Anthropic client (it checks each request as the real
// API does; nothing reaches the real API).
//
// /brightside-v1 sees context, data and rules. With the data connected (the
// built fixture) and the rules set up (signed fixture files), a route
// question points to its route skill with Run, whether the AI sorts it as a
// tool or as data; a person without the routing key never sees the skill and
// gets "There's no tool for that yet"; a data question no skill fits gets
// the same line until Ask writes queries (Story 19.8). Request a tool posts
// from v1 (D12). Data sources counts the approved rule cards.
//
// Ways out, each tested (architect P2-12): Ask's Run into a route skill,
// then Back (the skill is pushed onto the answer, whose own Back returns to
// the menu); the answer view's trigger expired before the click (the map's
// existing "open it from the menu" fallback); and Request a tool from v1's
// Ask: preview, Post, Edit, Cancel, Slack refusing (not_in_channel) and Try
// again, a double Post.
//
// An example test (architecture carve-out): it reads Brightside's app dir and
// fixture, and its profile and client files come from test fixtures
// (fixtures/demo-profile.yml with the routing fixture's Office added, and
// test/fixtures/runtime/data-sources/context), never profiles/brightside/.
// Deleted with the example in a fork.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../../kit/runtime/app');
const { build } = require('../../../kit/fixture/build');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const { checkRequest } = require('../../../test/fixtures/fake-anthropic');
const askTool = require('../../../kit/runtime/archetypes/ask');
const br = require('../../../kit/runtime/archetypes/build-request');
const { ASK_WORDS, BUILD_REQUEST_WORDS } = require('../../../kit/runtime/messages');

const ROOT = path.join(__dirname, '../../..');
const APP = path.join(ROOT, 'examples/brightside/app');
const DEMO_PROFILE = path.join(__dirname, 'fixtures/demo-profile.yml');
const SIGNED_CONTEXT = path.join(ROOT, 'test/fixtures/runtime/data-sources/context');
const V1 = 'brightside-v1';
const ELY = { id: 'U0FIXTUREELY', name: 'ely' };
const STEVEN = { id: 'U0FIXTURESTEVEN', name: 'steven' };
const ANN = { id: 'U0FIXTUREANN', name: 'ann' }; // an admin with no routing key
const CHANNEL = 'C0FIXTUREREQ';
const ROUTE_QUESTION = "Crew 4's stops on Oct 1 zig-zag. Can you fix the order?";
const MAP_NEEDS_WINDOW = "The map opens in its own window, which Slack didn't open this time. Type the hub's command and press its button there again.";

let tmp;
let FIXTURE;
const PROFILES = {};

// The demo profile with the routing fixture's Office (so Optimize a route
// opens) and Ann; ctx: how the client files beside it are set up.
function writeProfile(name, ctx) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  let text = fs.readFileSync(DEMO_PROFILE, 'utf8');
  const STEVEN_LINE = /^ {2}- \{ id: steven, .*$/m;
  const CREW_NODE = /^ {6}- \{ kind: crew, .*$/m;
  const AUDIENCE = /^ {2}audience:$/m;
  const FORBIDDEN_END = /^ {4}- crews\.base_geo_lon_e6$/m;
  for (const re of [STEVEN_LINE, CREW_NODE, AUDIENCE, FORBIDDEN_END]) assert.match(text, re);
  text = text
    .replace(STEVEN_LINE, (line) => `${line}\n  - { id: ann, name: Ann Admin, role: admin, identities: { slack: ${ANN.id} } }`)
    .replace(CREW_NODE, (line) => `${line}\n      - { kind: depot, table: depots, id_column: depot_id, lat_column: geo_lat_e6, lon_column: geo_lon_e6 }`)
    .replace(AUDIENCE, (line) => `  depot: { node: "depot:office", label: Office }\n${line}`)
    .replace(FORBIDDEN_END, (line) => `${line}\n    - depots.geo_lat_e6\n    - depots.geo_lon_e6`);
  fs.writeFileSync(path.join(dir, 'profile.yml'), text);
  fs.cpSync(SIGNED_CONTEXT, path.join(dir, 'context'), { recursive: true });
  ctx(path.join(dir, 'context'));
  return path.join(dir, 'profile.yml');
}
const card = (id) => `\n### ${id}: A fixture rule\n- type: access_rule\n- rule: x\n- status: approved\n`;

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-v1-ask-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
  // Signed files, one signed truth, and two approved rule cards.
  PROFILES.ready = writeProfile('ready', (dir) => fs.appendFileSync(path.join(dir, 'guardrails.md'), card('GRD-001') + card('GRD-002')));
  // guardrails.md unsigned: the rules are not set up, and its cards count 0.
  PROFILES.unsigned = writeProfile('unsigned', (dir) => {
    const f = path.join(dir, 'guardrails.md');
    const text = fs.readFileSync(f, 'utf8').replace(/^signed_off: .*$/m, 'signed_off: pending').replace(/^signed_off_by: .*$/m, 'signed_off_by: pending');
    fs.writeFileSync(f, text + card('GRD-001'));
  });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A stand-in Anthropic client: checks each request as the real API does.
// route_question answers with route (a function of the request, or an
// object); summarize_request with a title and summary; a plain ask with text.
function fakeModel({ route = { kind: 'context' } } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      messages: {
        async create(params) {
          calls.push(params);
          checkRequest(params);
          const usage = { input_tokens: 100, output_tokens: 20 };
          const tool = params.tools && params.tools[0].name;
          if (tool === askTool.TOOL_NAME) {
            return { content: [{ type: 'tool_use', id: 'tu_1', name: tool, input: route }], stop_reason: 'tool_use', usage };
          }
          if (tool === br.TOOL_NAME) {
            return {
              content: [{ type: 'tool_use', id: 'tu_2', name: tool, input: { title: 'Unpaid balances with emails', summary: 'The person wants a list of clients with the highest unpaid balance and how to reach them.' } }],
              stop_reason: 'tool_use',
              usage,
            };
          }
          return { content: [{ type: 'text', text: 'Brightside reschedules with 24 hours notice.' }], stop_reason: 'end_turn', usage };
        },
      },
    },
  };
}

let seq = 0;
// Boots the app as the live bot runs it, on its own var dir. member: whether
// the bot is in the build-request channel.
async function boot(t, { profile = PROFILES.ready, model = fakeModel(), member = true } = {}) {
  seq += 1;
  const varDir = path.join(tmp, `var-${seq}`);
  const lines = [];
  class App extends FakeSlackApp {
    constructor(options) { super({ ...options, views: true, channels: member ? [CHANNEL] : [] }); }
  }
  const res = await main({
    env: {
      APLABS_NO_KEYCHAIN: '1',
      // Fake values, shaped like the real ones; nothing here is a credential.
      SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
      SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
      ANTHROPIC_API_KEY: 'sk-ant-api00-fake-v1-ask-key-value',
      APLABS_PROFILE: profile,
      APLABS_APP_DIR: APP,
      APLABS_DATA_PATH: FIXTURE,
      APLABS_VAR_DIR: varDir,
      APLABS_ENV: 'dev',
    },
    cwd: os.tmpdir(),
    deps: {
      App, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain'), llm: { createClient: () => model.client },
    },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  t.after(() => {
    res.engineJobs.stop();
    res.jobs.stop();
    res.data.close();
  });
  return { app: res.app, lines, model };
}

const lastCall = (app) => app.views.at(-1);
const lastView = (app) => lastCall(app).args.view;
const texts = (view) => view.blocks.map((b) => (b.text && b.text.text) || '');
const buttonsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const logged = (lines, msg) => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);

// /brightside-v1, then Ask, then the question. Returns the menu's and the
// answer's ids and the answer view.
async function askOnV1(app, question, user = ELY) {
  await app.dispatchCommand('/brightside-v1', { user_id: user.id });
  const menu = lastCall(app);
  assert.equal(menu.method, 'open');
  const menuView = { ...menu.args.view, id: `V${app.viewSeq}`, private_metadata: V1 };
  await app.dispatchAction('v1-ask:open', { user, view: menuView });
  const pushed = lastCall(app);
  assert.equal(pushed.method, 'push');
  const formId = `V${app.viewSeq}`;
  const form = { ...pushed.args.view, id: formId };
  await app.dispatchView(askTool.FORM_CALLBACK, {
    user,
    view: { ...form, state: { values: { [askTool.QUESTION_BLOCK]: { [askTool.QUESTION_ACTION]: { type: 'plain_text_input', value: question } } } } },
  });
  const answer = lastCall(app);
  assert.equal(answer.method, 'update');
  assert.equal(answer.args.view_id, formId);
  return { menuId: menuView.id, answerId: formId, answer: { ...answer.args.view, id: formId } };
}

// --- route questions point to the skills ------------------------------------------------

test('a route question sorted as a tool, or as data, gets "Optimize a route can help with that. Press Run to use it." with Run', async (t) => {
  for (const kind of ['module', 'data']) {
    const { app, model } = await boot(t, { model: fakeModel({ route: { kind, module_id: 'v1-route-optimize' } }) });
    const { answer } = await askOnV1(app, ROUTE_QUESTION);
    assert.equal(texts(answer)[0], '*Optimize a route* can help with that. Press Run to use it.', kind);
    assert.deepEqual(buttonsOf(answer).map((b) => [b.action_id, b.text.text]), [['v1-route-optimize:open', 'Run'], [askTool.ACTIONS.again, 'Ask another']], kind);
    // One route call, with no business context, listing Ely's route skills.
    assert.equal(model.calls.length, 1);
    assert.ok(!model.calls[0].system.includes('<client_context file='), 'the route call carries no context');
    assert.ok(!model.calls[0].system.includes('DATA_PROSE_NEVER_SHOWN'));
    for (const id of ['v1-route-optimize', 'v1-route-cancellation', 'v1-route-crew-out', 'v1-route-add-stop', 'v1-route-map']) {
      assert.ok(model.calls[0].system.includes(`<tool id="${id}">`), id);
    }
  }
});

test('Steven gets the same answer as Ely (the same grants)', async (t) => {
  const { app } = await boot(t, { model: fakeModel({ route: { kind: 'data', module_id: 'v1-route-optimize' } }) });
  const { answer } = await askOnV1(app, ROUTE_QUESTION, STEVEN);
  assert.equal(buttonsOf(answer)[0].action_id, 'v1-route-optimize:open');
});

test('an admin without the routing key never sees the route skills: the route question gets "There\'s no tool for that yet", with Request a tool', async (t) => {
  for (const route of [{ kind: 'data' }, { kind: 'data', module_id: 'v1-route-optimize' }, { kind: 'module', module_id: 'v1-route-optimize' }]) {
    const { app, model } = await boot(t, { model: fakeModel({ route }) });
    const { answer } = await askOnV1(app, ROUTE_QUESTION, ANN);
    assert.ok(!model.calls[0].system.includes('v1-route-'), 'the AI is never shown a skill Ann can\'t open');
    assert.ok(!buttonsOf(answer).some((b) => /^v1-route-/.test(b.action_id)), JSON.stringify(route));
    if (route.kind === 'data') {
      assert.equal(texts(answer)[0], ASK_WORDS.noToolYet(), JSON.stringify(route));
      assert.deepEqual(buttonsOf(answer).map((b) => b.action_id), [askTool.ACTIONS.buildRequest, askTool.ACTIONS.again]);
    }
  }
});

test('a data question no route skill fits gets "There\'s no tool for that yet" with Request a tool; nothing is queried (Ask writes no query until Story 19.8)', async (t) => {
  const { app, model, lines } = await boot(t, { model: fakeModel({ route: { kind: 'data' } }) });
  const { answer } = await askOnV1(app, 'What was paid revenue in September 2026?');
  assert.equal(texts(answer)[0], ASK_WORDS.noToolYet());
  assert.deepEqual(buttonsOf(answer).map((b) => b.action_id), [askTool.ACTIONS.buildRequest, askTool.ACTIONS.again]);
  assert.equal(model.calls.length, 1, 'one route call; data is connected, so no notes call');
  assert.equal(logged(lines, 'query run').length, 0);
});

test('readiness gates the route skill: with guardrails.md unsigned, the route question gets the "rules aren\'t set up" message and no Run', async (t) => {
  const { app } = await boot(t, { profile: PROFILES.unsigned, model: fakeModel({ route: { kind: 'module', module_id: 'v1-route-optimize' } }) });
  const { answer } = await askOnV1(app, ROUTE_QUESTION);
  assert.equal(texts(answer)[0], ASK_WORDS.dataNoRules());
  assert.ok(!buttonsOf(answer).some((b) => /:open$/.test(b.action_id)));
});

// --- ways out: Run, Back, an expired view ------------------------------------------------

test('way out, Run then Back: the skill is pushed onto the answer (the third view) and its Back returns there; the answer\'s Back returns to the menu', async (t) => {
  const { app, lines } = await boot(t, { model: fakeModel({ route: { kind: 'module', module_id: 'v1-route-optimize' } }) });
  const { menuId, answerId, answer } = await askOnV1(app, ROUTE_QUESTION);
  assert.equal(app.parentOf(answerId), menuId, 'the answer\'s Back returns to the menu');
  assert.equal(answer.close.text, 'Back');
  const run = buttonsOf(answer)[0];
  const pushed = [];
  const push = app.client.views.push;
  app.client.views.push = async (args) => { const res = await push(args); pushed.push(res.view.id); return res; };
  await app.dispatchAction(run.action_id, { user: ELY, value: run.value, view: answer });
  assert.equal(pushed.length, 1, 'one push: the skill');
  const [skillId] = pushed;
  assert.equal(app.parentOf(skillId), answerId, 'Back returns to the answer');
  assert.equal(app.depthOf(skillId), 3, 'the third view');
  const skill = lastView(app);
  assert.equal(skill.title.text, 'Optimize a route');
  assert.equal(skill.close.text, 'Back');
  // The skill's first step: a crew and a day, updated in place (never pushed).
  const controls = buttonsOf(skill).map((e) => e.action_id);
  assert.ok(controls.some((a) => /^routing-map:(crew|day)$/.test(a)), String(controls));
  // Back: Slack pops the skill's view (the map asks for view_closed, which
  // lets its session go); the answer is still there, then the menu.
  assert.equal(skill.notify_on_close, true, 'the map view asks for view_closed');
  assert.equal(await app.dispatchViewClosed(skill.callback_id, { user: ELY, view: { ...skill, id: skillId } }), 1);
  assert.ok(logged(lines, 'map view closed').length >= 1, 'the map view\'s files are let go');
  assert.equal(app.parentOf(answerId), menuId);
});

test('a context question on v1 is answered from the hub\'s prompt (its context files), with "Not what you needed?" and Request a tool', async (t) => {
  const { app, model } = await boot(t, { model: fakeModel({ route: { kind: 'context' } }) });
  const { answer } = await askOnV1(app, 'How much notice does a customer need to reschedule?');
  assert.equal(texts(answer)[0], 'Brightside reschedules with 24 hours notice.');
  assert.ok(texts(answer).includes(ASK_WORDS.notWhatYouNeeded()));
  assert.deepEqual(buttonsOf(answer).map((b) => b.action_id), [askTool.ACTIONS.buildRequest, askTool.ACTIONS.again]);
  // The sentinel the route and summary calls never carry is in this one.
  assert.ok(model.calls[1].system.includes('DATA_PROSE_NEVER_SHOWN'));
});

test('way out, the answer view\'s trigger expired before Run: the map\'s existing fallback in place, "press its button there again"; nothing else opens', async (t) => {
  const { app, lines } = await boot(t, { model: fakeModel({ route: { kind: 'module', module_id: 'v1-route-optimize' } }) });
  const { answerId, answer } = await askOnV1(app, ROUTE_QUESTION);
  const run = buttonsOf(answer)[0];
  const push = app.client.views.push;
  app.client.views.push = async (args) => { app.expireTriggers(); return push(args); };
  const before = app.views.length;
  await app.dispatchAction(run.action_id, { user: ELY, value: run.value, view: answer });
  const after = app.views.slice(before);
  assert.deepEqual(after.map((v) => v.method), ['push', 'update']);
  assert.equal(after[1].args.view_id, answerId, 'shown in place on the answer');
  assert.ok(texts(after[1].args.view).includes(MAP_NEEDS_WINDOW), texts(after[1].args.view).join(' | '));
  assert.ok(!JSON.stringify(after[1].args.view).includes('routing-map:'), 'no map control');
  assert.ok(logged(lines, 'hub modal fallback').some((l) => l.where === 'open' && l.reason === 'expired_trigger_id'));
});

// --- Request a tool from v1's Ask (D12) --------------------------------------------------

// Ask, then Request a tool on the answer: the form with the question filled
// in. Returns { form } (the view the form is in, with its id).
async function requestFromAsk(app, user = ELY) {
  const question = 'List the clients with the highest unpaid balance and their emails.';
  const { answer, answerId } = await askOnV1(app, question, user);
  const request = buttonsOf(answer).find((b) => b.action_id === askTool.ACTIONS.buildRequest);
  assert.ok(request, 'Request a tool is offered on v1');
  await app.dispatchAction(request.action_id, { user, value: request.value, view: answer });
  const shown = lastCall(app);
  assert.equal(shown.method, 'update');
  assert.equal(shown.args.view_id, answerId);
  const form = { ...shown.args.view, id: answerId };
  assert.equal(form.callback_id, br.FORM_CALLBACK);
  assert.equal(form.title.text, 'Request a tool');
  assert.equal(form.blocks[0].element.initial_value, question);
  return { form, question };
}
async function preview(app, form, need, user = ELY) {
  await app.dispatchView(br.FORM_CALLBACK, {
    user,
    view: { ...form, state: { values: { [br.NEED_BLOCK]: { [br.NEED_ACTION]: { type: 'plain_text_input', value: need } } } } },
  });
  const view = lastView(app);
  const id = (buttonsOf(view).find((b) => b.action_id === br.ACTIONS.post) || {}).value;
  return { view: { ...view, id: form.id }, id };
}
const click = (app, actionId, id, from, user = ELY) => app.dispatchAction(actionId, { user, value: id, view: from });

test('Request a tool from v1\'s Ask: the preview, then Post posts once to the channel, naming the v1 hub and the requester', async (t) => {
  const { app, model } = await boot(t, { model: fakeModel({ route: { kind: 'data' } }) });
  const { form, question } = await requestFromAsk(app);
  const { view, id } = await preview(app, form, question);
  assert.ok(texts(view).includes(BUILD_REQUEST_WORDS.willPost()));
  assert.deepEqual(buttonsOf(view).map((b) => b.text.text), ['Post', 'Edit', 'Cancel']);
  // The summary call carried no business context, though v1 sees all three.
  const summary = model.calls.find((c) => c.tools && c.tools[0].name === br.TOOL_NAME);
  assert.ok(!summary.system.includes('<client_context file='));
  assert.ok(!summary.system.includes('DATA_PROSE_NEVER_SHOWN'));
  assert.ok(!summary.system.includes('<added_context'));
  await click(app, br.ACTIONS.post, id, view);
  assert.equal(app.posted.length, 1);
  assert.equal(app.posted[0].channel, CHANNEL);
  assert.match(app.posted[0].text, /^\*New build request:\* Unpaid balances with emails\nFrom <@U0FIXTUREELY> on the Brightside v1 hub, /);
  assert.ok(app.posted[0].text.includes(`> ${question}`));
  assert.deepEqual(texts(lastView(app)), [BUILD_REQUEST_WORDS.posted()]);
});

test('Request a tool from v1\'s Ask, way out, Edit: the form with the words kept; the old preview can no longer post', async (t) => {
  const { app } = await boot(t, { model: fakeModel({ route: { kind: 'data' } }) });
  const { form } = await requestFromAsk(app);
  const { view, id } = await preview(app, form, 'A list of unpaid balances.');
  await click(app, br.ACTIONS.edit, id, view);
  const edited = lastView(app);
  assert.equal(edited.callback_id, br.FORM_CALLBACK);
  assert.equal(edited.blocks[0].element.initial_value, 'A list of unpaid balances.');
  await click(app, br.ACTIONS.post, id, view);
  assert.deepEqual(app.posted, []);
});

test('Request a tool from v1\'s Ask, way out, Cancel: "Cancelled. Nothing was posted."; a later Post is told it was cancelled', async (t) => {
  const { app } = await boot(t, { model: fakeModel({ route: { kind: 'data' } }) });
  const { form } = await requestFromAsk(app);
  const { view, id } = await preview(app, form, 'A list of unpaid balances.');
  await click(app, br.ACTIONS.cancel, id, view);
  assert.deepEqual(texts(lastView(app)), [BUILD_REQUEST_WORDS.cancelled()]);
  await click(app, br.ACTIONS.post, id, view);
  assert.deepEqual(texts(lastView(app)), [BUILD_REQUEST_WORDS.wasCancelled()]);
  assert.deepEqual(app.posted, []);
});

test('Request a tool from v1\'s Ask, way out, Slack refuses the post (not_in_channel): Try again; once the bot is in the channel it posts exactly once', async (t) => {
  const { app, lines } = await boot(t, { model: fakeModel({ route: { kind: 'data' } }), member: false });
  const { form } = await requestFromAsk(app);
  const { view, id } = await preview(app, form, 'A list of unpaid balances.');
  await click(app, br.ACTIONS.post, id, view);
  assert.deepEqual(app.posted, []);
  assert.deepEqual(app.refusedPosts.map((r) => r.error), ['not_in_channel']);
  const refused = lastView(app);
  assert.match(texts(refused)[0], /^Slack didn't take the post, so nothing was posted\. Press Try again, or Back to leave it\./);
  assert.deepEqual(buttonsOf(refused).map((b) => [b.action_id, b.text.text, b.value]), [[br.ACTIONS.post, 'Try again', id]]);
  assert.deepEqual(logged(lines, 'build request not posted').map((l) => l.reason), ['not_in_channel']);
  app.memberOf.add(CHANNEL);
  await click(app, br.ACTIONS.post, id, view);
  await click(app, br.ACTIONS.post, id, view);
  assert.equal(app.posted.length, 1, 'posted exactly once');
  assert.deepEqual(texts(lastView(app)), [BUILD_REQUEST_WORDS.alreadyPosted()]);
});

test('Request a tool from v1\'s Ask, a double Post: posted once; the second click is told it is being posted', async (t) => {
  const { app } = await boot(t, { model: fakeModel({ route: { kind: 'data' } }) });
  const { form } = await requestFromAsk(app);
  const { view, id } = await preview(app, form, 'A list of unpaid balances.');
  let release;
  app.postGate = new Promise((r) => { release = r; });
  const first = click(app, br.ACTIONS.post, id, view);
  await new Promise((r) => setImmediate(r));
  await click(app, br.ACTIONS.post, id, view);
  assert.deepEqual(texts(lastView(app)), [BUILD_REQUEST_WORDS.posting()]);
  release();
  await first;
  assert.equal(app.posted.length, 1);
});

test('Request a tool opened from v1\'s menu shows its form (no longer "not on this hub")', async (t) => {
  const { app } = await boot(t);
  await app.dispatchCommand('/brightside-v1', { user_id: ELY.id });
  const menu = lastView(app);
  const row = menu.blocks.find((b) => b.block_id === 'entry:v1-build-request');
  assert.equal(row.accessory.action_id, 'v1-build-request:open');
  await app.dispatchAction('v1-build-request:open', { user: ELY, view: { ...menu, id: `V${app.viewSeq}`, private_metadata: V1 } });
  assert.equal(lastView(app).callback_id, br.FORM_CALLBACK);
});

// --- Data sources' rule-card count (D7) ---------------------------------------------------

test('Data sources on v1 counts the approved rule cards: 2 when guardrails.md is signed, 0 while it is not', async (t) => {
  for (const [profile, n] of [[PROFILES.ready, 2], [PROFILES.unsigned, 0]]) {
    const { app } = await boot(t, { profile });
    await app.dispatchAction('v1-data-sources:open', { user: ELY, view: { id: 'VMENU', type: 'modal', private_metadata: V1 } });
    const text = texts(lastView(app)).join('\n');
    assert.match(text, new RegExp(`\\n• Rule cards approved: ${n}\\n`), text);
  }
});
