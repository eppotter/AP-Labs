'use strict';

// Story 16.6 (plan brightside-v0, D11, D13, review A4, B1, B3): the
// build-request archetype (kit/runtime/archetypes/build-request) through the
// hubs, and its channel exception (kit/runtime/slack/channel.js). Fixtures
// only: test/fixtures/runtime/build-request has a blank hub (sees nothing), a
// hub that sees context and one that sees data, each with a Build request
// module, and a profile with a fake channel id (profile-unset.yml has none).
// Every clock the code reads (the store, the AI service, the archetype) is
// the one test clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProfile, validateProfile } = require('../../kit/lib/profile');
const { loadRegistry, loadModules, loadHubs } = require('../../kit/runtime/registry');
const { createHubViews } = require('../../kit/runtime/slack/hub-view');
const { registerHubs, FORM_NEEDS_WINDOW } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { PLAIN_ERROR } = require('../../kit/runtime/slack/handle');
const { createLlm } = require('../../kit/runtime/llm');
const { LlmUnavailable } = require('../../kit/runtime/errors');
const { BUILD_REQUEST_WORDS: WORDS } = require('../../kit/runtime/messages');
const channel = require('../../kit/runtime/slack/channel');
const br = require('../../kit/runtime/archetypes/build-request');
const { FakeSlackApp } = require('../fixtures/fake-slack');
const { checkRequest } = require('../fixtures/fake-anthropic');

const FIX = path.join(__dirname, '../fixtures/runtime/build-request');
const PROFILE_PATH = path.join(FIX, 'profile.yml');
const profile = loadProfile(PROFILE_PATH);
const unsetProfile = loadProfile(path.join(FIX, 'profile-unset.yml'));
const { registry, problems: loadProblems } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });
const CHANNEL = 'C0BUILDREQ1';
const ADMIN = { id: 'UADA', name: 'ada' };
const MEMBER = { id: 'UBO', name: 'bo' };
const T0 = Date.UTC(2026, 9, 30, 14, 5);
const MIN = 60 * 1000;
const KEY = 'sk-ant-test-not-a-real-key';
const MENTIONS = '@here @channel @everyone <!here> <!channel> <https://x.example|y> <@U123>';

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

// A stand-in Anthropic client: checks each request as the real API does,
// then answers with the summarize_request tool (input), or fails. gate: a
// promise every answer waits for (a slow model).
function fakeModel({ input = { title: 'A weekly cleaning report', summary: 'The person wants a weekly report of cleanings.' }, fail = null, gate = null } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        checkRequest(params);
        if (gate) await gate;
        if (fail) throw fail;
        return {
          content: [{ type: 'tool_use', id: 'tu_1', name: br.TOOL_NAME, input }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 40 },
        };
      },
    },
  };
}

// The hubs, wired with one clock. llm: 'real' (createLlm with model), null
// (no AI service) or a stand-in service ({ forHub }).
function setup({
  prof = profile, model = fakeModel(), llm = 'real', channels = [CHANNEL], env = {},
} = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const store = createStore({ now });
  const log = quietLog();
  const service = llm === 'real'
    ? createLlm({
      apiKey: KEY, profile: prof, profilePath: PROFILE_PATH, store, log, env, now, deps: { createClient: () => model },
    })
    : llm;
  const app = new FakeSlackApp({ views: true, channels });
  const hubViews = createHubViews({ hubs: registry.hubs, llm: service });
  registerHubs(app, {
    registry, profile: prof, env: 'dev', log, store, forHub: hubViews.forHub, buildRequest: { now },
  });
  return {
    app, log, store, clock, model,
  };
}

const MENU = (hub) => ({ id: 'VMENU', type: 'modal', private_metadata: hub, hash: 'hmenu' });
const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const texts = (blocks) => blocks.map((b) => (b.text && b.text.text) || '');
const allText = (blocks) => texts(blocks).join('\n');
const buttonsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const lastUpdate = (app) => calls(app, 'update').at(-1).view;
const settle = () => new Promise((r) => setImmediate(r));

// Opens the form on hub and returns the pushed view.
async function openForm(app, hub = 'blank', user = ADMIN) {
  await app.dispatchAction(`${hub}-request:open`, { user, view: MENU(hub) });
  return calls(app, 'push').at(-1).view;
}

// The form submitted with need, as Slack sends it (the pushed view, with state).
function submitted(form, need, id = 'VFORM') {
  return {
    ...form,
    id,
    hash: 'hform',
    state: { values: { [br.NEED_BLOCK]: { [br.NEED_ACTION]: { type: 'plain_text_input', value: need } } } },
  };
}

// Open, submit, and wait for the preview. Returns { preview, id }.
async function toPreview(ctx, need = 'A weekly report of the cleanings each crew did.', { hub = 'blank', user = ADMIN } = {}) {
  const form = await openForm(ctx.app, hub, user);
  await ctx.app.dispatchView(br.FORM_CALLBACK, { user, view: submitted(form, need) });
  const preview = lastUpdate(ctx.app);
  const post = buttonsOf(preview).find((b) => b.action_id === br.ACTIONS.post);
  return { preview, id: post && post.value };
}

// A click on the preview's button, from the preview view.
function click(ctx, actionId, id, { user = ADMIN, hash } = {}) {
  return ctx.app.dispatchAction(actionId, {
    user, value: id, view: { id: 'VFORM', type: 'modal', private_metadata: 'blank', ...(hash ? { hash } : {}), title: { type: 'plain_text', text: 'Build request' } },
  });
}

// --- the profile, the registry and the manifest -----------------------------------

test('slack.build_requests_channel is optional and must be a channel id; an unknown key beside it is refused', () => {
  const base = { schema_version: 1, client: { id: 'x', name: 'X' }, users: [{ id: 'a', name: 'A', role: 'admin' }] };
  assert.equal(validateProfile({ ...base, slack: {} }, 't').slack.build_requests_channel, undefined);
  for (const ok of ['C0BUILDREQ1', 'G12345678']) assert.equal(validateProfile({ ...base, slack: { build_requests_channel: ok } }, 't').slack.build_requests_channel, ok);
  for (const bad of ['#ai-build-requests', 'D0DMCHAN12', 'U0PERSON01', 'c0lower1234', 'C123', '']) {
    assert.throws(() => validateProfile({ ...base, slack: { build_requests_channel: bad } }, 't'), /build_requests_channel/, JSON.stringify(bad));
  }
  assert.throws(() => validateProfile({ ...base, slack: { build_requests_channel: 'C0BUILDREQ1', build_request_channel: 'C0BUILDREQ1' } }, 't'), /slack has unknown key "build_request_channel"/);
});

test('the fixture app loads: build-request is a built archetype, on a blank hub and on hubs that see context or data', () => {
  assert.deepEqual(loadProblems, []);
  assert.deepEqual(registry.modules.map((m) => [m.id, m.archetype, m.hub]), [
    ['blank-request', 'build-request', 'blank'], ['ctx-request', 'build-request', 'ctx'], ['data-request', 'build-request', 'data'],
  ]);
});

test('a build-request manifest may not name a handler, query, parameters or row_id: the engine shows it', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-br-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(FIX, 'app'), dir, { recursive: true });
  const f = path.join(dir, 'modules/blank-request/manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({
    ...m, handler: 'h.js', query: 'q.sql', parameters: [], row_id: 'id',
  }));
  const { hubs } = loadHubs(dir);
  const { problems } = loadModules(dir, { hubs, profile });
  assert.deepEqual(problems, [
    'modules/blank-request/manifest.json: field "handler" is not used by a build-request module (the engine shows it)',
    'modules/blank-request/manifest.json: field "query" is not used by a build-request module (the engine shows it)',
    'modules/blank-request/manifest.json: field "parameters" is not used by a build-request module (the engine shows it)',
    'modules/blank-request/manifest.json: field "row_id" is not used by a build-request module (the engine shows it)',
  ]);
});

test('the menu shows Build request to the admin (the role confers BUILD_REQUEST), not to a member', async () => {
  const { app } = setup();
  await app.dispatchCommand('/blank', { user_id: 'UADA' });
  await app.dispatchCommand('/blank', { user_id: 'UBO' });
  const ids = (v) => v.blocks.filter((b) => b.accessory && /:open$/.test(b.accessory.action_id)).map((b) => b.accessory.action_id);
  const [admin, member] = calls(app, 'open').map((c) => c.view);
  assert.deepEqual(ids(admin), ['blank-request:open']);
  assert.deepEqual(ids(member), []);
});

// --- the channel exception ---------------------------------------------------------

const FIELDS = {
  hub: { name: 'Blank tools', sees: [] }, requester: 'UADA', title: 'A title', summary: 'A summary.', need: 'My words.', summarised: true, at: T0,
};

test('channel.js: build-request is the second declared exception, and only a hub that sees neither context nor data may post', async () => {
  assert.deepEqual(Object.keys(channel.EXCEPTIONS), ['write-escalation', 'build-request']);
  for (const sees of [[], ['rules']]) assert.equal(channel.mayPostBuildRequest(sees), true, JSON.stringify(sees));
  for (const sees of [['context'], ['data'], ['context', 'data', 'rules'], undefined, 'none']) assert.equal(channel.mayPostBuildRequest(sees), false, JSON.stringify(sees));
  const posted = [];
  const client = { chat: { postMessage: async (a) => { posted.push(a); return { ok: true }; } } };
  for (const sees of [['context'], ['data'], ['data', 'rules']]) {
    await assert.rejects(channel.postToChannel({
      client, exception: 'build-request', channel: CHANNEL, fields: { ...FIELDS, hub: { name: 'Full', sees } },
    }), (err) => err instanceof channel.ChannelPostRefused && /sees context or data/.test(err.message), JSON.stringify(sees));
  }
  assert.deepEqual(posted, []);
  await channel.postToChannel({
    client, exception: 'build-request', channel: CHANNEL, fields: FIELDS,
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].unfurl_links, false);
  assert.equal(posted[0].unfurl_media, false);
  assert.equal(posted[0].text, [
    '*New build request:* A title',
    'From <@UADA> on the Blank tools hub, <!date^1793369100^{date_short_pretty} at {time}|2026-10-30 14:05 UTC>',
    '',
    'A summary.',
    '',
    '_In their words:_',
    '> My words.',
  ].join('\n'));
});

test('channel.js refuses a build request it cannot vouch for: a requester that is not a Slack id, empty or over-long fields, a DM or a person', async () => {
  const client = { chat: { postMessage: async () => assert.fail('nothing refused reaches Slack') } };
  const bad = [
    { ...FIELDS, requester: 'ada' },
    { ...FIELDS, requester: '<!here>' },
    { ...FIELDS, need: '   ' },
    { ...FIELDS, need: 'x'.repeat(501) },
    { ...FIELDS, title: 'x'.repeat(81) },
    { ...FIELDS, summary: 'x'.repeat(601) },
    { ...FIELDS, summarised: 'yes' },
    { ...FIELDS, at: 'now' },
    { ...FIELDS, hub: null },
  ];
  for (const fields of bad) {
    await assert.rejects(channel.postToChannel({
      client, exception: 'build-request', channel: CHANNEL, fields,
    }), channel.ChannelPostRefused, JSON.stringify(fields));
  }
  for (const to of ['D0DMCHAN12', 'U0PERSON01', '#ai-build-requests']) {
    await assert.rejects(channel.postToChannel({
      client, exception: 'build-request', channel: to, fields: FIELDS,
    }), channel.ChannelPostRefused);
  }
});

// --- Open ----------------------------------------------------------------------------

test('Open on the blank hub pushes the form: "What do you need?", at most 500 characters, submit Preview', async () => {
  const { app } = setup();
  const form = await openForm(app);
  assert.equal(form.callback_id, br.FORM_CALLBACK);
  assert.equal(form.submit.text, 'Preview');
  assert.equal(form.close.text, 'Back');
  assert.equal(form.private_metadata, 'blank:blank-request');
  const [input] = form.blocks;
  assert.equal(input.type, 'input');
  assert.equal(input.label.text, 'What do you need?');
  assert.equal(input.element.type, 'plain_text_input');
  assert.equal(input.element.max_length, 500);
  assert.equal(input.element.initial_value, undefined);
  assert.deepEqual(app.posted, []);
});

test('way out, the channel unset: the tool says it is not set up and names the admin; no form opens', async () => {
  const { app } = setup({ prof: unsetProfile });
  const shown = await openForm(app);
  assert.equal(shown.callback_id, 'hub:module');
  assert.equal(shown.submit, undefined);
  assert.deepEqual(texts(shown.blocks), ["Build requests aren't set up yet: no channel to post them to. Ask <@UADA> to set one up."]);
  assert.ok(!shown.blocks.some((b) => b.type === 'input'));
});

test('a hub that sees context, and one that sees data: the tool says "not available on this hub yet"; no form opens', async () => {
  const { app } = setup();
  for (const hub of ['ctx', 'data']) {
    const shown = await openForm(app, hub);
    assert.deepEqual(texts(shown.blocks), [WORDS.notOnThisHub()], hub);
    assert.match(shown.blocks[0].text.text, /not available on this hub yet/);
    assert.equal(shown.submit, undefined);
  }
});

test('way out, an expired trigger at Open: the form goes in place on the menu (the existing fallback), logged; it still submits', async () => {
  const ctx = setup();
  ctx.app.issueTrigger = (id) => { ctx.app.triggers.set(id, Date.now() - 4000); return id; };
  await ctx.app.dispatchAction('blank-request:open', { user: ADMIN, view: MENU('blank') });
  assert.deepEqual(ctx.app.views.map((v) => v.method), ['push', 'update']);
  const [update] = calls(ctx.app, 'update');
  assert.equal(update.view_id, 'VMENU');
  assert.equal(update.view.callback_id, br.FORM_CALLBACK);
  assert.deepEqual(ctx.log.lines.filter((l) => l.msg === 'hub modal fallback').map((l) => l.fields), [
    { where: 'open', reason: 'expired_trigger_id', hub: 'blank', via: 'views.update' },
  ]);
  // The form, shown in place, submits as usual.
  await ctx.app.dispatchView(br.FORM_CALLBACK, { user: ADMIN, view: submitted(update.view, 'Need a report', 'VMENU') });
  assert.equal(ctx.app.viewAcks.at(-1).response_action, 'update');
  assert.equal(lastUpdate(ctx.app).blocks.at(-1).type, 'actions');
});

test('way out, Open from an old message menu: the form needs the hub window, and the person is told so', async () => {
  const { app } = setup();
  await app.dispatchAction('blank-request:open', { user: ADMIN });
  assert.equal(app.responded.length, 1);
  assert.equal(app.responded[0].text, FORM_NEEDS_WINDOW);
});

// --- the form's submit --------------------------------------------------------------

test('way out, an empty or over-long need: an error beside the field in the ack; nothing is summarised or posted', async () => {
  const ctx = setup();
  const form = await openForm(ctx.app);
  for (const [need, error] of [['', WORDS.empty()], ['   \n ', WORDS.empty()], ['x'.repeat(501), WORDS.tooLong(500)]]) {
    await ctx.app.dispatchView(br.FORM_CALLBACK, { user: ADMIN, view: submitted(form, need) });
    assert.deepEqual(ctx.app.viewAcks.at(-1), { response_action: 'errors', errors: { [br.NEED_BLOCK]: error } });
  }
  assert.equal(ctx.model.calls.length, 0);
  assert.deepEqual(calls(ctx.app, 'update'), []);
  assert.deepEqual(ctx.app.posted, []);
});

test('the ack comes first: "Thinking…" in the view at once, and the preview only once the slow summary is back (D13)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setup({ model: fakeModel({ gate }) });
  const form = await openForm(ctx.app);
  const running = ctx.app.dispatchView(br.FORM_CALLBACK, { user: ADMIN, view: submitted(form, 'A weekly report of cleanings.') });
  await settle();
  assert.equal(ctx.app.viewAcks.length, 1, 'acked before the summary is back');
  const ack = ctx.app.viewAcks[0];
  assert.equal(ack.response_action, 'update');
  assert.deepEqual(texts(ack.view.blocks), ['Thinking…']);
  assert.equal(ack.view.submit, undefined);
  assert.equal(ack.view.close.text, 'Back');
  assert.deepEqual(calls(ctx.app, 'update'), []);
  release();
  await running;
  const [update] = calls(ctx.app, 'update');
  assert.equal(update.view_id, 'VFORM');
  assert.equal(update.hash, undefined, 'the ack changed the hash, so the update carries none');
  assert.match(allText(update.view.blocks), /This will post to the build-request channel as you:/);
});

test('the preview shows the title, the summary and the person\'s words exactly as they will post, with Post, Edit and Cancel; the AI got the summarize_request tool', async () => {
  const ctx = setup();
  const { preview, id } = await toPreview(ctx, 'A weekly report of the cleanings each crew did.');
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.deepEqual(buttonsOf(preview).map((b) => [b.action_id, b.text.text, b.value]), [
    [br.ACTIONS.post, 'Post', id], [br.ACTIONS.edit, 'Edit', id], [br.ACTIONS.cancel, 'Cancel', id],
  ]);
  const shown = allText(preview.blocks);
  assert.match(shown, /^This will post to the build-request channel as you:\n\*New build request:\* A weekly cleaning report\nFrom <@UADA> on the Blank tools hub/);
  assert.match(shown, /The person wants a weekly report of cleanings\./);
  assert.match(shown, /> A weekly report of the cleanings each crew did\./);
  // One structured call, with the one tool, as the API takes it (checkRequest).
  assert.equal(ctx.model.calls.length, 1);
  const [sent] = ctx.model.calls;
  assert.deepEqual(sent.tools.map((t) => t.name), ['summarize_request']);
  assert.equal(sent.tools[0].effects, undefined);
  assert.deepEqual(sent.tools[0].input_schema.required, ['title', 'summary']);
  assert.equal(sent.tools[0].input_schema.properties.title.maxLength, 80);
  assert.equal(sent.tools[0].input_schema.properties.summary.maxLength, 600);
  assert.equal(sent.tool_choice.type, 'auto');
  assert.deepEqual(ctx.app.posted, [], 'nothing posts before Post');
  // Nothing the person typed is logged.
  assert.ok(!JSON.stringify(ctx.log.lines).includes('cleanings each crew'));
});

test('the Anthropic fake refuses a tool the real API refuses: an extra field (effects), a bad name, a schema that is not an object', () => {
  const tool = { name: 'summarize_request', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } };
  checkRequest({ tools: [tool] });
  for (const bad of [
    { ...tool, effects: 'none' },
    { ...tool, name: 'summarize request' },
    { ...tool, input_schema: { type: 'string' } },
    { ...tool, input_schema: { type: 'object', properties: {}, required: ['a'] } },
  ]) assert.throws(() => checkRequest({ tools: [bad] }), (err) => err.status === 400, JSON.stringify(bad));
  assert.throws(() => checkRequest({ tools: tool }), (err) => err.status === 400);
});

test('way out, the AI off, over its limit, failing or not calling its tool: the preview shows the person\'s own words, labelled not summarised', async () => {
  const stand = (fn) => ({ forHub: () => ({ ask: async () => assert.fail('no ask'), structured: fn }) });
  const cases = [
    ['no AI service', { llm: null }],
    ['switched off', { env: { APLABS_LLM_OFF: '1' } }],
    ['over its limit', { llm: stand(async () => { throw new LlmUnavailable('over_budget'); }) }],
    ['failing', { model: fakeModel({ fail: Object.assign(new Error('boom'), { name: 'APIError', status: 500 }) }) }],
    ['not calling its tool', { llm: stand(async () => ({ toolInput: null })) }],
    ['an empty title', { model: fakeModel({ input: { title: '  ', summary: 'x' } }) }],
  ];
  for (const [name, opts] of cases) {
    const ctx = setup(opts);
    const { preview, id } = await toPreview(ctx, 'Please build a tool\nthat lists repeat clients.');
    const shown = allText(preview.blocks);
    assert.equal(texts(preview.blocks)[0], WORDS.notSummarised(), name);
    assert.match(shown, /\*New build request:\* Please build a tool\n/, name);
    assert.match(shown, /_Not summarised: their own words\._\n> Please build a tool\n> that lists repeat clients\./, name);
    await click(ctx, br.ACTIONS.post, id);
    assert.equal(ctx.app.posted.length, 1, name);
    assert.match(ctx.app.posted[0].text, /_Not summarised: their own words\._/, name);
  }
});

test('way out, the person closes the screen while the summary runs: nothing is posted, the preview is dropped, logged at info with no person data', async () => {
  const ctx = setup();
  ctx.app.viewsFail.update = Object.assign(new Error('An API error occurred: not_found'), { data: { ok: false, error: 'not_found' } });
  const form = await openForm(ctx.app);
  await ctx.app.dispatchView(br.FORM_CALLBACK, { user: ADMIN, view: submitted(form, 'A secret plan for the roster.') });
  assert.equal(ctx.model.calls.length, 1, 'the work finishes');
  assert.deepEqual(ctx.app.posted, []);
  const line = ctx.log.lines.find((l) => l.msg === 'build request preview dropped');
  assert.equal(line.level, 'info');
  assert.deepEqual(line.fields, { reason: 'not_found' });
  assert.ok(!JSON.stringify(ctx.log.lines).includes('secret plan'));
  assert.ok(!ctx.log.lines.some((l) => l.level === 'error'));
});

test('access is re-checked at submit: a person without the key is refused in the ack, and nothing is summarised', async () => {
  const ctx = setup();
  const form = await openForm(ctx.app);
  await ctx.app.dispatchView(br.FORM_CALLBACK, { user: MEMBER, view: submitted(form, 'Need a tool') });
  const ack = ctx.app.viewAcks.at(-1);
  assert.equal(ack.response_action, 'update');
  assert.match(allText(ack.view.blocks), /access to Build request/);
  assert.equal(ctx.model.calls.length, 0);
});

test('a hand-made submit naming a module on a hub that sees data is refused as not available on this hub; nothing is summarised', async () => {
  const ctx = setup();
  const form = await openForm(ctx.app);
  await ctx.app.dispatchView(br.FORM_CALLBACK, { user: ADMIN, view: { ...submitted(form, 'Need a tool'), private_metadata: 'data:data-request' } });
  assert.deepEqual(texts(ctx.app.viewAcks.at(-1).view.blocks), [WORDS.notOnThisHub()]);
  assert.equal(ctx.model.calls.length, 0);
});

// --- Post, and exactly once ----------------------------------------------------------

test('Post posts once to the profile\'s channel, naming the requester, with unfurls off; the view says "Posted."', async () => {
  const ctx = setup();
  const { preview, id } = await toPreview(ctx);
  ctx.clock.t += 2 * MIN;
  await click(ctx, br.ACTIONS.post, id);
  assert.equal(ctx.app.posted.length, 1);
  const [post] = ctx.app.posted;
  assert.equal(post.channel, CHANNEL);
  assert.equal(post.unfurl_links, false);
  assert.equal(post.unfurl_media, false);
  assert.match(post.text, /^\*New build request:\* A weekly cleaning report\nFrom <@UADA> on the Blank tools hub, <!date\^1793369220\^/);
  // The preview showed this same text (but for the time).
  const previewed = allText(preview.blocks).replace(/<!date[^>]*>/, '');
  assert.ok(previewed.includes(post.text.replace(/<!date[^>]*>/, '')));
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), ['Posted. The AP Labs team will pick it up.']);
  assert.deepEqual(ctx.log.lines.filter((l) => l.msg === 'build request posted').map((l) => l.fields), [{ module: 'blank-request', summarised: true }]);
});

const NO_MENTION = (text) => {
  const mentions = text.match(/<[@!#][^>]*>/g) || [];
  return mentions.filter((m) => !m.startsWith('<!date^'));
};

test('mentions: a need holding @here, @channel, @everyone, <!here>, <!channel>, a link and a user mention posts as plain text; the only mention is the requester', async () => {
  const ctx = setup({ llm: null });
  const { id } = await toPreview(ctx, `Please ${MENTIONS} thanks`);
  await click(ctx, br.ACTIONS.post, id);
  const { text } = ctx.app.posted[0];
  assert.deepEqual(NO_MENTION(text), ['<@UADA>']);
  assert.doesNotMatch(text, /@(here|channel|everyone)/i);
  assert.doesNotMatch(text, /<https?:/);
  assert.match(text, /@‍here @‍channel @‍everyone &lt;!here&gt; &lt;!channel&gt; &lt;https:\/\/x\.example\|y&gt; &lt;@U123&gt;/);
});

test('mentions: an AI title and summary holding the same post as plain text; the only mention is the requester', async () => {
  const ctx = setup({ model: fakeModel({ input: { title: `T ${MENTIONS}`.slice(0, 80), summary: `S ${MENTIONS}` } }) });
  const { id } = await toPreview(ctx, 'An ordinary request.');
  await click(ctx, br.ACTIONS.post, id);
  const { text } = ctx.app.posted[0];
  assert.deepEqual(NO_MENTION(text), ['<@UADA>']);
  assert.doesNotMatch(text, /@(here|channel|everyone)/i);
  assert.doesNotMatch(text, /<https?:/);
  assert.match(text, /S @‍here @‍channel @‍everyone &lt;!here&gt;/);
});

test('way out, Slack refuses the post (not_in_channel): a plain message with Try again, logged with Slack\'s code only; the preview entry is restored, and Try again posts exactly once', async () => {
  const ctx = setup({ channels: [] });
  const { id } = await toPreview(ctx, 'A private request text.');
  await click(ctx, br.ACTIONS.post, id);
  assert.deepEqual(ctx.app.posted, []);
  assert.deepEqual(ctx.app.refusedPosts.map((r) => r.error), ['not_in_channel']);
  const shown = lastUpdate(ctx.app);
  assert.equal(texts(shown.blocks)[0], WORDS.refused('<@UADA>'));
  assert.equal(shown.close.text, 'Back');
  assert.deepEqual(buttonsOf(shown).map((b) => [b.action_id, b.text.text, b.value]), [[br.ACTIONS.post, 'Try again', id]]);
  const line = ctx.log.lines.find((l) => l.msg === 'build request not posted');
  assert.deepEqual(line.fields, { module: 'blank-request', reason: 'not_in_channel' });
  assert.ok(!JSON.stringify(ctx.log.lines).includes('private request'));
  // The entry is back, so Try again finds it.
  assert.equal(ctx.store.get('session', id).need, 'A private request text.');
  ctx.app.memberOf.add(CHANNEL);
  await click(ctx, br.ACTIONS.post, id);
  await click(ctx, br.ACTIONS.post, id);
  assert.equal(ctx.app.posted.length, 1, 'posted exactly once');
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.alreadyPosted()]);
});

test('a double click on Post posts once: the second is told it is being posted, a later one that it was already posted', async () => {
  const ctx = setup();
  const { id } = await toPreview(ctx);
  let release;
  ctx.app.postGate = new Promise((r) => { release = r; });
  const first = click(ctx, br.ACTIONS.post, id);
  await settle();
  await click(ctx, br.ACTIONS.post, id);
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.posting()]);
  release();
  await first;
  assert.equal(ctx.app.posted.length, 1);
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.posted()]);
  await click(ctx, br.ACTIONS.post, id);
  assert.equal(ctx.app.posted.length, 1);
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.alreadyPosted()]);
});

test('way out, the preview expired (30 minutes): "this preview expired, start again"; nothing is posted', async () => {
  const ctx = setup();
  const { id } = await toPreview(ctx);
  ctx.clock.t += 30 * MIN;
  await click(ctx, br.ACTIONS.post, id);
  assert.deepEqual(ctx.app.posted, []);
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.expired(30)]);
  assert.match(WORDS.expired(30), /expired.*start again/);
  // A made-up id reads the same.
  await click(ctx, br.ACTIONS.post, 'f'.repeat(32));
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.expired(30)]);
});

test('a refusal near the end of the preview\'s life is restored only for what is left of its 30 minutes', async () => {
  const ctx = setup({ channels: [] });
  const { id } = await toPreview(ctx);
  ctx.clock.t += 29 * MIN;
  await click(ctx, br.ACTIONS.post, id);
  assert.ok(ctx.store.get('session', id));
  ctx.clock.t += 1 * MIN;
  ctx.app.memberOf.add(CHANNEL);
  await click(ctx, br.ACTIONS.post, id);
  assert.deepEqual(ctx.app.posted, []);
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.expired(30)]);
});

test('another person\'s click on a preview is refused; nothing is posted and the preview stays for its owner', async () => {
  const ctx = setup();
  const { id } = await toPreview(ctx);
  await click(ctx, br.ACTIONS.post, id, { user: { id: 'UOTHER', name: 'x' } });
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.notYours()]);
  assert.deepEqual(ctx.app.posted, []);
  await click(ctx, br.ACTIONS.post, id);
  assert.equal(ctx.app.posted.length, 1);
});

test('access is re-checked at Post: a person who lost the key between preview and Post is refused, and the preview is kept', async () => {
  const ctx = setup();
  const { id } = await toPreview(ctx);
  // Bo (a member) holding Ada's preview id is not its owner; make the entry Bo's.
  ctx.store.set('session', id, { ...ctx.store.get('session', id), person: 'UBO' });
  await click(ctx, br.ACTIONS.post, id, { user: MEMBER });
  assert.match(allText(lastUpdate(ctx.app).blocks), /access to Build request/);
  assert.deepEqual(ctx.app.posted, []);
  assert.ok(ctx.store.get('session', id));
});

// --- Edit, Cancel, Back and the X ---------------------------------------------------

test('way out, Edit: back to the form with the text kept; the old preview can no longer post', async () => {
  const ctx = setup();
  const { id } = await toPreview(ctx, 'Keep these words.');
  await click(ctx, br.ACTIONS.edit, id);
  const form = lastUpdate(ctx.app);
  assert.equal(form.callback_id, br.FORM_CALLBACK);
  assert.equal(form.submit.text, 'Preview');
  assert.equal(form.blocks[0].element.initial_value, 'Keep these words.');
  await click(ctx, br.ACTIONS.post, id);
  assert.deepEqual(ctx.app.posted, []);
  // Submitting the form again makes a new preview, which posts.
  await ctx.app.dispatchView(br.FORM_CALLBACK, { user: ADMIN, view: submitted(form, 'Keep these words, edited.') });
  const again = buttonsOf(lastUpdate(ctx.app)).find((b) => b.action_id === br.ACTIONS.post).value;
  assert.notEqual(again, id);
  await click(ctx, br.ACTIONS.post, again);
  assert.equal(ctx.app.posted.length, 1);
  assert.match(ctx.app.posted[0].text, /Keep these words, edited\./);
});

test('way out, Cancel: "Cancelled. Nothing was posted."; a later Post on it is told it was cancelled', async () => {
  const ctx = setup();
  const { id } = await toPreview(ctx);
  await click(ctx, br.ACTIONS.cancel, id);
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.cancelled()]);
  await click(ctx, br.ACTIONS.post, id);
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.wasCancelled()]);
  assert.deepEqual(ctx.app.posted, []);
});

test('way out, Back and the X on the form or the preview: nothing to close, nothing is posted', async () => {
  const ctx = setup();
  const form = await openForm(ctx.app);
  assert.equal(form.close.text, 'Back');
  assert.equal(form.notify_on_close, undefined);
  assert.equal(await ctx.app.dispatchViewClosed(form.callback_id, { user: ADMIN, view: { id: 'VFORM' }, is_cleared: true }), 0);
  const { preview } = await toPreview(ctx);
  assert.equal(preview.close.text, 'Back');
  assert.equal(await ctx.app.dispatchViewClosed(preview.callback_id, { user: ADMIN, view: { id: 'VFORM' } }), 0);
  assert.deepEqual(ctx.app.posted, []);
});

test('a preview click from outside a modal is told to use the hub window; nothing is posted', async () => {
  const ctx = setup();
  const { id } = await toPreview(ctx);
  await ctx.app.dispatchAction(br.ACTIONS.post, { user: ADMIN, value: id });
  assert.equal(ctx.app.responded.at(-1).text, FORM_NEEDS_WINDOW);
  assert.deepEqual(ctx.app.posted, []);
});

test('a scoped pull\'s session id is never touched by a build request click', async () => {
  const ctx = setup();
  const sid = 'a'.repeat(32);
  ctx.store.set('session', sid, { person: 'UADA', module: 'blank-request', values: null });
  await click(ctx, br.ACTIONS.post, sid);
  assert.deepEqual(ctx.app.posted, []);
  assert.deepEqual(texts(lastUpdate(ctx.app).blocks), [WORDS.expired(30)]);
  assert.ok(ctx.store.get('session', sid), 'not consumed');
});

test('way out, an error after the ack: the plain error replaces "Thinking…" in the view, with Back; nothing is posted', async () => {
  const ctx = setup();
  const set = ctx.store.set;
  ctx.store.set = (ns, ...rest) => {
    if (ns === 'session') throw new Error('store full');
    return set(ns, ...rest);
  };
  const form = await openForm(ctx.app);
  await ctx.app.dispatchView(br.FORM_CALLBACK, { user: ADMIN, view: submitted(form, 'Need a tool') });
  assert.deepEqual(texts(ctx.app.viewAcks.at(-1).view.blocks), ['Thinking…']);
  const shown = lastUpdate(ctx.app);
  assert.deepEqual(texts(shown.blocks), [PLAIN_ERROR]);
  assert.equal(shown.close.text, 'Back');
  assert.ok(ctx.log.lines.some((l) => l.msg === 'handler failed' && l.fields.handler === 'hub:build-request-submit'));
  assert.deepEqual(ctx.app.posted, []);
});

test('way out, an error on a Post click: the plain error in the view, with Back; nothing is posted', async () => {
  const ctx = setup();
  const { id } = await toPreview(ctx);
  ctx.store.consume = () => { throw new Error('store broken'); };
  await click(ctx, br.ACTIONS.post, id);
  const shown = lastUpdate(ctx.app);
  assert.deepEqual(texts(shown.blocks), [PLAIN_ERROR]);
  assert.equal(shown.close.text, 'Back');
  assert.deepEqual(ctx.app.posted, []);
});
