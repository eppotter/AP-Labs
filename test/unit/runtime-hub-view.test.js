'use strict';

// Story 16.1 (plan brightside-v0, D1, D2): each hub says what it sees. The
// hub file's required sees list; the hub views (kit/runtime/slack/hub-view)
// that registerHubs gets instead of the app-wide runner and AI service; the
// AI service bound per hub (llm.forHub); the boot refusals for data
// archetypes and engine jobs on a hub that may not have them; and the
// fork-job context. Fixtures only: test/fixtures/runtime/app has a full hub
// (alpha) and a blank one (beta); test/fixtures/llm has context files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const {
  loadRegistry, loadHubs, createRegistry, HUB_SEES,
} = require('../../kit/runtime/registry');
const {
  createHubViews, everyHubSeesAll, bootProblems, seesOf, BLANK_VIEW,
} = require('../../kit/runtime/slack/hub-view');
const { registerHubs } = require('../../kit/runtime/slack/hubs');
const { createLlm } = require('../../kit/runtime/llm');
const { loadContext, systemPrompt } = require('../../kit/runtime/llm/context');
const { jobContext } = require('../../kit/runtime/jobs');
const { createStore } = require('../../kit/runtime/store');
const { main, checkConfig } = require('../../kit/runtime/app');
const { ACTIONS } = require('../../kit/runtime/archetypes/scoped-pull');
const { REQUEST_BLOCK, VALUE_ACTION } = require('../../kit/runtime/archetypes/scoped-pull/form');
const { FakeSlackApp } = require('../fixtures/fake-slack');
const { checkRequest } = require('../fixtures/fake-anthropic');

const ROOT = path.resolve(__dirname, '../..');
const RT = path.join(__dirname, '../fixtures/runtime');
const RT_PROFILE = loadProfile(path.join(RT, 'profile.yml'));
const { registry: base } = loadRegistry({ appDir: path.join(RT, 'app'), profile: RT_PROFILE });
const LLM_PROFILE_PATH = path.join(__dirname, '../fixtures/llm/profile.yml');
const LLM_PROFILE = loadProfile(LLM_PROFILE_PATH);
// Fake values, shaped like the real ones; nothing here is a credential.
const KEY = 'sk-ant-api00-fake-hub-view-test-key';
const BOT = 'xoxb-000-111-faketokenvalue';
const APP = 'xapp-1-A000-222-fakeappvalue';
const MEM = 'U0MEM';
const FULL = ['context', 'data', 'rules'];

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), registerSecret: () => {} };
}

function fakeData() {
  const runs = [];
  return {
    runs,
    run: async (sql, params, opts) => { runs.push({ sql, params, opts }); return [{ one: 1 }]; },
    describe: () => ({ source: 'local fixture', label: 'fake.duckdb', available: true, problem: null }),
  };
}

function fakeModel() {
  const calls = [];
  return {
    calls,
    messages: {
      create(params) {
        calls.push(params);
        try { checkRequest(params); } catch (err) { return Promise.reject(err); }
        return Promise.resolve({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } });
      },
    },
  };
}

function makeLlm({ model = fakeModel(), readFile } = {}) {
  const store = createStore({ now: () => 1_000_000 });
  const llm = createLlm({
    apiKey: KEY, profile: LLM_PROFILE, profilePath: LLM_PROFILE_PATH, store, log: quietLog(), env: {}, now: () => 1_000_000,
    deps: { createClient: () => model, ...(readFile ? { readFile } : {}) },
  });
  return { llm, model, store };
}

function tmpDir(t, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aplabs-${name}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- The hub file -------------------------------------------------------------

test('sees is required: a hub file without it stops boot with "add "sees" to <hub>"; other values and repeats are refused naming the value', (t) => {
  const dir = tmpDir(t, 'sees');
  fs.mkdirSync(path.join(dir, 'hubs'));
  const write = (id, extra) => fs.writeFileSync(path.join(dir, 'hubs', `${id}.json`),
    JSON.stringify({ id, command: `/${id}`, name: id, description: id, ...extra }));
  write('none', {});
  write('odd', { sees: ['data', 'secrets'] });
  write('twice', { sees: ['data', 'data'] });
  write('text', { sees: 'data' });
  write('blank', { sees: [] });
  write('full', { sees: FULL });
  const { hubs, problems } = loadHubs(dir);
  assert.deepEqual(hubs.map((h) => [h.id, h.sees]), [['blank', []], ['full', FULL]]);
  assert.ok(Object.isFrozen(hubs[1].sees));
  assert.deepEqual(problems, [
    'hubs/none.json: add "sees" to none (what the hub sees: any of context, data, rules, or [] for none)',
    'hubs/odd.json: field "sees[1]" "secrets" is not one of context, data, rules',
    'hubs/text.json: field "sees" must be array',
    'hubs/twice.json: field "sees" lists "data" twice',
  ]);
});

test('boot refuses a hub file without sees, naming it', async (t) => {
  const dir = tmpDir(t, 'boot-sees');
  fs.cpSync(path.join(RT, 'app'), dir, { recursive: true });
  const beta = JSON.parse(fs.readFileSync(path.join(dir, 'hubs/beta.json'), 'utf8'));
  delete beta.sees;
  fs.writeFileSync(path.join(dir, 'hubs/beta.json'), JSON.stringify(beta));
  const cfg = checkConfig({ env: appEnv(dir), cwd: os.tmpdir() });
  assert.ok(cfg.problems.includes('app: hubs/beta.json: add "sees" to beta (what the hub sees: any of context, data, rules, or [] for none)'), cfg.problems.join('\n'));
});

// The example client (examples/brightside) is removed by clean-bones and in
// a client fork; tests about it run only where it exists.
const BRIGHTSIDE_HUB = path.join(ROOT, 'examples/brightside/app/hubs/brightside.json');
const NO_EXAMPLE = fs.existsSync(path.join(ROOT, 'examples/brightside')) ? false : 'no example client in this tree (clean bones or a fork)';

test('every hub file in the repo writes sees out', () => {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules' || d.name === '.git' || d.name === '.claude') continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) walk(abs);
      else if (d.name.endsWith('.json') && path.basename(dir) === 'hubs') files.push(abs);
    }
  };
  walk(path.join(ROOT, 'examples'));
  walk(path.join(ROOT, 'test/fixtures'));
  // The fixture hubs alone are five; the example adds its own when present.
  assert.ok(files.length >= 5, files.join('\n'));
  for (const f of files) {
    const hub = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(Array.isArray(hub.sees), `${path.relative(ROOT, f)} has no sees`);
  }
  assert.equal(files.includes(BRIGHTSIDE_HUB), !NO_EXAMPLE);
  assert.deepEqual(base.hubs.map((h) => [h.id, h.sees]), [['alpha', FULL], ['beta', []]]);
});

test('the Brightside hub sees context, data and rules', { skip: NO_EXAMPLE }, () => {
  const brightside = JSON.parse(fs.readFileSync(BRIGHTSIDE_HUB, 'utf8'));
  assert.deepEqual(brightside.sees, FULL);
});

test('the list of what a hub may see is the same in the registry, the AI service and the schema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit/runtime/schema/hub.schema.json'), 'utf8'));
  assert.deepEqual(schema.properties.sees.items.enum, [...HUB_SEES]);
  assert.ok(schema.required.includes('sees'));
  const { llm } = makeLlm();
  assert.throws(() => llm.forHub({ id: 'x', sees: ['data', 'secrets'] }), /needs the hub's sees/);
  assert.throws(() => llm.forHub({ id: 'x' }), /needs the hub's sees/);
  assert.throws(() => llm.forHub({ sees: [] }), /needs the hub id/);
});

// --- The views ------------------------------------------------------------------

test('each view is built once: a blank hub gets no runner, a bound AI service and no rules; a full hub gets the runner', () => {
  const data = fakeData();
  const bound = [];
  const { llm } = makeLlm();
  const spy = { ...llm, forHub: (h) => { bound.push(h); return llm.forHub(h); } };
  const views = createHubViews({ hubs: base.hubs, data, llm: spy });
  const alpha = views.forHub('alpha');
  const beta = views.forHub('beta');
  assert.equal(views.forHub('alpha'), alpha, 'built once');
  assert.deepEqual(bound, [{ id: 'alpha', sees: FULL }, { id: 'beta', sees: [] }]);
  assert.deepEqual([alpha.data, alpha.rules, alpha.knowledge, [...alpha.sees]], [data, true, null, FULL]);
  assert.deepEqual([beta.data, beta.rules, beta.knowledge, [...beta.sees]], [null, false, null, []]);
  for (const v of [alpha, beta]) {
    assert.ok(Object.isFrozen(v));
    assert.notEqual(v.llm, llm);
    assert.deepEqual(Object.keys(v.llm).sort(), ['ask', 'structured']);
  }
  assert.throws(() => views.forHub('gamma'), /no view for hub "gamma"/);
  assert.throws(() => createHubViews({ hubs: [{ id: 'x', file: 'hubs/x.json' }] }), /add "sees" to hubs\/x\.json/);
  assert.throws(() => seesOf({ id: 'x', sees: ['data', 'more'] }), /"more" is not one of context, data, rules/);
  assert.deepEqual([BLANK_VIEW.data, BLANK_VIEW.llm, BLANK_VIEW.rules, [...BLANK_VIEW.sees]], [null, null, false, []]);
  const none = createHubViews({ hubs: base.hubs });
  assert.equal(none.forHub('alpha').llm, null);
});

// Handler modules that report what they were given.
function peekModule(id, hub, seen) {
  return Object.freeze({
    id,
    hub,
    label: `Peek ${hub}`,
    description: 'What this hub sees.',
    resource: 'OPEN_THING',
    archetype: 'handler',
    environments: ['dev'],
    handler: 'peek.js',
    file: `modules/${id}/manifest.json`,
    run: async (ctx) => {
      seen[id] = { keys: Object.keys(ctx).sort(), describe: ctx.data.describe() };
      await ctx.data.run('SELECT 1 AS one', {});
      await ctx.reply('ran');
    },
  });
}

test('registerHubs with only forHub (no runner, no AI service): a blank hub\'s handler gets "no data source", a full hub\'s the runner', async () => {
  const data = fakeData();
  const seen = {};
  const registry = createRegistry({ hubs: base.hubs, modules: [...base.modules, peekModule('peek-a', 'alpha', seen), peekModule('peek-b', 'beta', seen)] });
  const app = new FakeSlackApp({});
  const log = quietLog();
  const views = createHubViews({ hubs: registry.hubs, data, llm: makeLlm().llm });
  registerHubs(app, {
    registry, profile: RT_PROFILE, env: 'dev', log, store: createStore(), forHub: views.forHub,
  });
  await app.dispatchAction('peek-b:open', { user: { id: 'U1', name: 'u' } });
  assert.deepEqual(seen['peek-b'].describe, { source: null, label: null, available: false, problem: 'no data source' });
  assert.deepEqual(seen['peek-b'].keys, ['client', 'data', 'module', 'person', 'reply'], 'no AI service or knowledge on ctx');
  assert.equal(data.runs.length, 0);
  assert.ok(log.lines.some((l) => l.msg === 'data unavailable' && l.fields.module === 'peek-b' && l.fields.reason === 'no data source'));
  assert.ok(!app.responded.some((r) => /ran/.test(JSON.stringify(r))));
  await app.dispatchAction('peek-a:open', { user: { id: 'U1', name: 'u' } });
  assert.equal(seen['peek-a'].describe.available, true);
  assert.equal(data.runs.length, 1);
  assert.deepEqual(data.runs[0].opts, { declared: [] });
  assert.ok(app.responded.some((r) => /ran/.test(JSON.stringify(r))));
  // Never both: the factory, or (a test seam) a runner and a service.
  assert.throws(() => registerHubs(new FakeSlackApp({}), {
    registry, profile: RT_PROFILE, env: 'dev', log, store: createStore(), forHub: views.forHub, data,
  }), /never both/);
  // A hub with no view stops setup.
  assert.throws(() => registerHubs(new FakeSlackApp({}), {
    registry, profile: RT_PROFILE, env: 'dev', log, store: createStore(), forHub: (id) => { throw new Error(`no view for ${id}`); },
  }), /no view for alpha/);
});

test('the test seam (data and llm handed straight to registerHubs) sees everything and binds the service per hub, only when called', () => {
  const called = [];
  const llm = new Proxy({}, { get: (_, k) => { called.push(k); return () => { throw new Error('touched'); }; } });
  const views = everyHubSeesAll({ data: fakeData(), llm });
  const v = views.forHub('alpha');
  assert.deepEqual([...v.sees], FULL);
  assert.deepEqual(called, []);
  assert.throws(() => v.llm.ask({}), /touched/);
  assert.deepEqual(called, ['forHub']);
});

test('the boot wiring hands registerHubs only forHub; the scheduler keeps the runner and gets no AI service', () => {
  const src = fs.readFileSync(path.join(ROOT, 'kit/runtime/app/index.js'), 'utf8');
  assert.match(src, /registerHubs\(app, \{ registry, profile, env, log, store, forHub, connectors, mapFiles \}\)/);
  assert.match(src, /createHubViews\(\{ hubs: cfg\.registry\.hubs, data, llm: ai \}\)/);
  const scheduler = /jobs\.createScheduler\(\{([\s\S]*?)\n  \}\);/.exec(src)[1];
  assert.ok(!/llm|ai\b|knowledge/.test(scheduler), scheduler);
});

// --- The AI service per hub -----------------------------------------------------

test('a blank hub\'s prompt holds the fixed instructions and the client name only; a full hub\'s is today\'s prompt exactly', async () => {
  const { llm, model } = makeLlm();
  const views = createHubViews({ hubs: base.hubs, llm });
  await views.forHub('beta').llm.ask({ person: MEM, resource: 'ASK', request: 'hi' });
  await views.forHub('alpha').llm.ask({ person: MEM, resource: 'ASK', request: 'hi' });
  const [blank, full] = model.calls.map((c) => c.system);
  const today = loadContext({ clientName: LLM_PROFILE.client.name, profilePath: LLM_PROFILE_PATH }).prompt;
  assert.equal(full, today);
  assert.ok(blank.includes('<client_name>Acme Tidy</client_name>'));
  assert.equal(blank, systemPrompt(LLM_PROFILE.client.name, []));
  assert.ok(!blank.includes('<client_context file='));
  const contextText = ['org.md', 'data.md'].flatMap((f) => fs.readFileSync(path.join(path.dirname(LLM_PROFILE_PATH), 'context', f), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l.length > 12 && !l.startsWith('---')));
  for (const line of contextText) assert.ok(!blank.includes(line), `a context line reached the blank hub: ${line}`);
  for (const kept of ['ORG_PROSE_KEPT', 'DATA_PROSE_KEPT']) {
    assert.ok(full.includes(kept), kept);
    assert.ok(!blank.includes(kept), kept);
  }
  // structured() too.
  const tool = { name: 'pick', input_schema: { type: 'object' }, effects: 'none' };
  await views.forHub('beta').llm.structured({ person: MEM, resource: 'ASK', request: 'hi', tool });
  assert.ok(!model.calls.at(-1).system.includes('ORG_PROSE_KEPT'));
  assert.ok(model.calls.at(-1).system.startsWith(blank));
});

test('over the 40,000-character limit: a call on the hub that sees context is refused with the configuration fault; the blank hub keeps working', async () => {
  const big = 'word '.repeat(9000);
  const { llm, model } = makeLlm({ readFile: (p) => (p.endsWith('data.md') ? big : '') });
  const views = createHubViews({ hubs: base.hubs, llm });
  await assert.rejects(views.forHub('alpha').llm.ask({ person: MEM, resource: 'ASK', request: 'hi' }), (err) => err.name === 'LlmUnavailable' && err.reason === 'config');
  await views.forHub('beta').llm.ask({ person: MEM, resource: 'ASK', request: 'hi' });
  assert.equal(model.calls.length, 1);
  assert.equal(llm.status().on, true);
});

test('the hubs never hand out the unbound service: the scoped-pull reader works through its hub\'s bound one', async () => {
  const PULL = Object.freeze({
    id: 'lapsed', hub: 'alpha', label: 'Lapsed list', description: 'People who left.', resource: 'ASK', archetype: 'scoped-pull', environments: ['dev'],
    parameters: [{ name: 'zone', label: 'Zone', type: 'string', enum: ['north', 'south'], required: true }],
    query: 'lapsed.sql', sql: 'SELECT 1 AS one', file: 'modules/lapsed/manifest.json',
  });
  const model = fakeModel();
  model.messages.create = (params) => {
    model.calls.push(params);
    checkRequest(params);
    return Promise.resolve({ content: [{ type: 'tool_use', id: 't1', name: 'fill_parameters', input: { zone: 'north' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } });
  };
  const { llm } = makeLlm({ model });
  const unboundUsed = [];
  const guarded = {
    ...llm,
    ask: () => { unboundUsed.push('ask'); throw new Error('the unbound service was used'); },
    structured: () => { unboundUsed.push('structured'); throw new Error('the unbound service was used'); },
  };
  const registry = createRegistry({ hubs: base.hubs, modules: [PULL] });
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  const views = createHubViews({ hubs: registry.hubs, data: fakeData(), llm: guarded });
  registerHubs(app, {
    registry, profile: LLM_PROFILE, env: 'dev', log, store: createStore({ now: () => 1_000_000 }), forHub: views.forHub,
  });
  const menu = { id: 'VMENU', type: 'modal', private_metadata: 'alpha', title: { type: 'plain_text', text: 'Alpha tools' } };
  await app.dispatchAction('lapsed:open', { user: { id: MEM }, view: menu });
  const form = app.views.at(-1).args.view;
  const read = form.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements).find((b) => b.action_id === ACTIONS.read);
  assert.ok(read, 'the full hub\'s form offers "Read my request"');
  await app.dispatchAction(ACTIONS.read, {
    user: { id: MEM },
    view: {
      id: `V${app.viewSeq}`, hash: 'h1', type: 'modal', private_metadata: form.private_metadata, title: form.title, state: { values: { [REQUEST_BLOCK]: { [VALUE_ACTION]: { type: 'plain_text_input', value: 'north please' } } } },
    },
    value: read.value,
  });
  assert.deepEqual(unboundUsed, []);
  assert.equal(model.calls.length, 1);
  assert.ok(model.calls[0].system.includes('ORG_PROSE_KEPT'), 'alpha sees context');
  assert.ok(!log.lines.some((l) => l.msg === 'handler failed'));
});

// --- Boot refusals --------------------------------------------------------------

const mod = (over) => Object.freeze({
  id: 'm', hub: 'beta', label: 'M', description: 'm', resource: 'OPEN_THING', archetype: 'handler', environments: ['dev'], file: 'modules/m/manifest.json', ...over,
});
const HUBS = [
  { id: 'blank', sees: [], file: 'hubs/blank.json' },
  { id: 'data-only', sees: ['data'], file: 'hubs/data-only.json' },
  { id: 'full', sees: FULL, file: 'hubs/full.json' },
];

test('boot refuses a scoped-pull, approval-write or routing-map module on a hub that does not see data, naming the module file and the hub', () => {
  const modules = ['scoped-pull', 'approval-write', 'routing-map', 'handler'].map((archetype) => mod({
    id: archetype, hub: 'blank', archetype, file: `modules/${archetype}/manifest.json`, environments: ['prod'],
  }));
  assert.deepEqual(bootProblems({ hubs: HUBS, modules, env: 'dev' }), [
    'modules/scoped-pull/manifest.json: a scoped-pull module reads data, but its hub hubs/blank.json does not see data (add "data" to the hub\'s sees, or move the module)',
    'modules/approval-write/manifest.json: an approval-write module reads data, but its hub hubs/blank.json does not see data (add "data" to the hub\'s sees, or move the module)',
    'modules/routing-map/manifest.json: a routing-map module reads data, but its hub hubs/blank.json does not see data (add "data" to the hub\'s sees, or move the module)',
  ]);
  // On a hub that sees data, none is refused.
  assert.deepEqual(bootProblems({ hubs: HUBS, modules: modules.map((m) => ({ ...m, hub: 'full' })), env: 'dev' }), []);
});

test('boot refuses an engine job a module brings when its hub lacks data or context: a routing map\'s sweep on a blank hub', () => {
  const routing = mod({ id: 'routing', hub: 'blank', archetype: 'routing-map', file: 'modules/routing/manifest.json' });
  assert.deepEqual(bootProblems({ hubs: HUBS, modules: [routing], env: 'dev' }), [
    'modules/routing/manifest.json: a routing-map module reads data, but its hub hubs/blank.json does not see data (add "data" to the hub\'s sees, or move the module)',
    'modules/routing/manifest.json: module routing brings the engine job "sweep-map-files", but its hub hubs/blank.json does not see data or context',
  ]);
  // The dev-only map check (a handler) on a hub that sees data but not context.
  const mapCheck = mod({ id: 'map-check', hub: 'data-only', file: 'modules/map-check/manifest.json' });
  assert.deepEqual(bootProblems({ hubs: HUBS, modules: [mapCheck], env: 'dev' }), [
    'modules/map-check/manifest.json: module map-check brings the engine job "sweep-map-files", but its hub hubs/data-only.json does not see context',
  ]);
  // Not shown in this environment: it brings no job here.
  assert.deepEqual(bootProblems({ hubs: HUBS, modules: [mapCheck], env: 'prod' }), []);
  assert.deepEqual(bootProblems({ hubs: HUBS, modules: [{ ...routing, hub: 'full' }, { ...mapCheck, hub: 'full' }], env: 'dev' }), []);
});

function appEnv(appDir) {
  return {
    APLABS_NO_KEYCHAIN: '1', SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP, APLABS_PROFILE: path.join(RT, 'profile.yml'), APLABS_APP_DIR: appDir,
  };
}

test('boot refuses a scoped pull on the fixture\'s blank hub, naming the module file and the hub', (t) => {
  const dir = tmpDir(t, 'boot-refuse');
  fs.cpSync(path.join(RT, 'app'), dir, { recursive: true });
  fs.cpSync(path.join(RT, 'scored'), path.join(dir, 'modules/ranked'), { recursive: true });
  const manifest = path.join(dir, 'modules/ranked/manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), hub: 'beta' }));
  const cfg = checkConfig({ env: appEnv(dir), cwd: os.tmpdir() });
  assert.deepEqual(cfg.problems, [
    'app: modules/ranked/manifest.json: a scoped-pull module reads data, but its hub hubs/beta.json does not see data (add "data" to the hub\'s sees, or move the module)',
  ]);
  // On the full hub it boots.
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), hub: 'alpha' }));
  assert.deepEqual(checkConfig({ env: appEnv(dir), cwd: os.tmpdir() }).problems, []);
});

test('end to end: the booted app gives a handler on the blank hub no data, and one on the full hub the runner', async (t) => {
  const dir = tmpDir(t, 'boot-views');
  fs.cpSync(path.join(RT, 'app'), dir, { recursive: true });
  for (const [id, hub] of [['peek-a', 'alpha'], ['peek-b', 'beta']]) {
    fs.mkdirSync(path.join(dir, 'modules', id));
    fs.writeFileSync(path.join(dir, 'modules', id, 'manifest.json'), JSON.stringify({
      id, hub, label: `Peek ${hub}`, description: 'What this hub sees.', resource: 'OPEN_THING', archetype: 'handler', environments: ['dev'], handler: 'peek.js',
    }));
    fs.writeFileSync(path.join(dir, 'modules', id, 'peek.js'),
      "module.exports = async ({ data, reply }) => { await reply(`available=${data.describe().available}`); };\n");
  }
  const lines = [];
  const data = { ...fakeData(), open: async () => {}, close: () => {} };
  const res = await main({
    env: appEnv(dir), cwd: os.tmpdir(), deps: { App: FakeSlackApp, write: (l) => lines.push(l), data },
  });
  t.after(() => res.app && res.app.stop && res.app.stop());
  assert.equal(res.code, 0, lines.join('\n'));
  await res.app.dispatchAction('peek-b:open', { user: { id: 'U1', name: 'u' } });
  await res.app.dispatchAction('peek-a:open', { user: { id: 'U1', name: 'u' } });
  const said = res.app.responded.map((r) => JSON.stringify(r)).join('\n');
  assert.match(said, /available=false/);
  assert.match(said, /available=true/);
});

// --- No unbound AI call (PR #262 review) ----------------------------------------

test('the AI service has no unbound ask or structured: boot code can reach an AI call only through a hub\'s view', async (t) => {
  const { llm } = makeLlm();
  assert.deepEqual(Object.keys(llm).sort(), ['forHub', 'registerTool', 'status']);
  // The booted app's service, with the AI on.
  const dir = tmpDir(t, 'boot-unbound');
  fs.cpSync(path.join(RT, 'app'), dir, { recursive: true });
  const lines = [];
  const res = await main({
    env: { ...appEnv(dir), ANTHROPIC_API_KEY: KEY },
    cwd: os.tmpdir(),
    deps: {
      App: FakeSlackApp, write: (l) => lines.push(l), data: { ...fakeData(), open: async () => {}, close: () => {} }, llm: { createClient: () => fakeModel() },
    },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  assert.equal(res.llm.status().on, true);
  assert.equal(res.llm.ask, undefined);
  assert.equal(res.llm.structured, undefined);
  // No engine file calls ask or structured on the service itself.
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.js') && /\b(llm|ai)\.(ask|structured)\s*\(/.test(fs.readFileSync(abs, 'utf8').replace(/\/\/[^\n]*/g, ''))) offenders.push(path.relative(ROOT, abs));
    }
  };
  walk(path.join(ROOT, 'kit/runtime'));
  // extract.js calls the bound service the hub hands it, named llm there.
  assert.deepEqual(offenders, ['kit/runtime/archetypes/scoped-pull/extract.js']);
});

test('a context that can\'t be used: the startup line says the AI is on with a context fault, never plainly on', async (t) => {
  const { aiWords, AI_CONTEXT_FAULT } = require('../../kit/runtime/app');
  assert.equal(aiWords({ on: true, contextProblem: null }), 'on');
  assert.equal(aiWords({ on: true, contextProblem: 'context is 45000 characters, over the 40000 limit' }), AI_CONTEXT_FAULT);
  assert.equal(AI_CONTEXT_FAULT, 'on (context fault: hubs that see context are refused)');
  assert.equal(aiWords({ on: false, reason: 'no_key' }), 'off (ANTHROPIC_API_KEY not set)');
  const dir = tmpDir(t, 'boot-context-fault');
  fs.cpSync(path.join(RT, 'app'), dir, { recursive: true });
  // The AI profile declares none of the fixture modules' resources: hubs only.
  fs.rmSync(path.join(dir, 'modules'), { recursive: true });
  const lines = [];
  const res = await main({
    env: { ...appEnv(dir), ANTHROPIC_API_KEY: KEY, APLABS_PROFILE: LLM_PROFILE_PATH },
    cwd: os.tmpdir(),
    deps: {
      App: FakeSlackApp,
      write: (l) => lines.push(l),
      data: { ...fakeData(), open: async () => {}, close: () => {} },
      llm: { createClient: () => fakeModel(), readFile: (p) => (p.endsWith('data.md') ? 'word '.repeat(9000) : '') },
    },
  });
  assert.equal(res.code, 0, lines.join('\n'));
  const started = lines.map((l) => JSON.parse(l)).find((e) => /bot started/.test(e.msg));
  assert.equal(started.ai, AI_CONTEXT_FAULT);
  assert.ok(lines.some((l) => l.includes('AI context unusable')));
});

test('the list of what a hub may see comes from one module, read from the hub schema', () => {
  const { HUB_SEES: shared } = require('../../kit/runtime/sees');
  assert.equal(HUB_SEES, shared);
  assert.ok(Object.isFrozen(shared));
  for (const f of ['kit/runtime/registry/index.js', 'kit/runtime/llm/index.js', 'kit/runtime/slack/hub-view.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/\[\s*'context',\s*'data',\s*'rules'\s*\]/.test(src), `${f} copies the list`);
  }
});

// --- Fork jobs ------------------------------------------------------------------

test('a fork job (jobs.json) belongs to no hub: its ctx is name, now, log and data, never an AI service or a knowledge store', () => {
  const ctx = jobContext({ job: { name: 'nightly' }, log: quietLog(), data: fakeData(), now: () => new Date(0) });
  assert.deepEqual(Object.keys(ctx).sort(), ['data', 'log', 'name', 'now']);
});
