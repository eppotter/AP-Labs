'use strict';

// Story 19.1 (plan brightside-v1, D6): hubs can share notes. A hub file's
// optional "notes" names another hub; both hubs then use one knowledge store
// (one folder, one queue, one set of caps), read by both hubs' AI services,
// while sees alone still decides what each hub gets from the profile. Boot
// refuses a link to no hub, to itself, or to a hub that shares another hub's
// notes, and ask, add-context or data-sources modules on the sharing hubs
// with different keys, each naming the hub file and the field. Fixtures
// only: test/fixtures/runtime/shared-notes has a blank hub that keeps the
// notes (teach), a full hub sharing them (full) and a blank hub with its own
// (third); its context folder holds org.md and data.md with marker lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry, loadHubs, createRegistry } = require('../../kit/runtime/registry');
const {
  createHubViews, bootProblems, BLANK_VIEW, NOTES_FREE,
} = require('../../kit/runtime/slack/hub-view');
const { createSlackFiles } = require('../../kit/runtime/slack/files');
const { registerHubs } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { createKnowledgeStore, CAPS } = require('../../kit/runtime/knowledge/store');
const { ContextRefused } = require('../../kit/runtime/errors');
const { createLlm } = require('../../kit/runtime/llm');
const { systemPrompt } = require('../../kit/runtime/llm/context');
const { checkConfig } = require('../../kit/runtime/app');
const addContext = require('../../kit/runtime/archetypes/add-context');
const dataSources = require('../../kit/runtime/archetypes/data-sources');
const { FakeSlackApp, invalidView, fileState } = require('../fixtures/fake-slack');
const { png } = require('../fixtures/upload-files');
const { checkRequest } = require('../fixtures/fake-anthropic');

const FIX = path.join(__dirname, '../fixtures/runtime/shared-notes');
const PROFILE_PATH = path.join(FIX, 'profile.yml');
const profile = loadProfile(PROFILE_PATH);
const { registry, problems: loadProblems } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });
const ADA = { id: 'UADA', name: 'ada' };
const T0 = Date.parse('2026-10-31T09:15:00Z');
const KEY = 'sk-ant-api00-fake-shared-notes-test-key';
const BOT = 'xoxb-000-111-faketokenvalue';
const APP = 'xapp-1-A000-222-fakeappvalue';
const MENU = (hub) => ({ id: 'VMENU', type: 'modal', private_metadata: hub, hash: 'hmenu' });

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return {
    lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), registerSecret: () => {},
  };
}

function tmpDir(t, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aplabs-${name}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A knowledge store in a fresh var dir, its clock fixed at T0 (the only
// clock this file's code paths read: added_at; the AI service's rate limit
// and breaker get the same fixed now).
const makeKnowledge = (t) => createKnowledgeStore({
  clientId: 'tiny', varDir: tmpDir(t, 'shared'), log: quietLog(), now: () => T0,
});

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

function makeLlm(knowledge, { readFile } = {}) {
  const model = fakeModel();
  const llm = createLlm({
    apiKey: KEY,
    profile,
    profilePath: PROFILE_PATH,
    store: createStore({ now: () => T0 }),
    log: quietLog(),
    env: {},
    now: () => T0,
    knowledge,
    deps: { createClient: () => model, ...(readFile ? { readFile } : {}) },
  });
  return { llm, model };
}

function setup(t, { reg = registry } = {}) {
  const knowledge = makeKnowledge(t);
  const { llm, model } = makeLlm(knowledge);
  const views = createHubViews({ hubs: reg.hubs, llm, knowledge });
  const app = new FakeSlackApp({ views: true });
  const log = quietLog();
  registerHubs(app, {
    registry: reg, profile, env: 'dev', log, store: createStore({ now: () => T0 }), forHub: views.forHub, slackFiles: createSlackFiles({ token: app.botToken, fetch: app.fetch, log }),
  });
  return {
    app, knowledge, views, model,
  };
}

const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const allText = (blocks) => blocks.map((b) => (b.text && b.text.text) || (b.label && b.label.text) || b.type).join('\n');
const removeButtons = (view) => view.blocks.filter((b) => b.accessory && b.accessory.action_id === addContext.REMOVE_ACTION).map((b) => b.accessory);

async function openForm(app, hub) {
  await app.dispatchAction(`${hub}-add:open`, { user: ADA, view: MENU(hub) });
  return calls(app, 'push').at(-1).view;
}
async function openSources(app, hub) {
  await app.dispatchAction(`${hub}-sources:open`, { user: ADA, view: MENU(hub) });
  return calls(app, 'push').at(-1).view;
}
async function submit(app, form, { title, text }) {
  return app.dispatchView(addContext.SUBMIT_CALLBACK, {
    user: ADA,
    view: {
      ...form,
      id: 'VFORM',
      hash: 'hform',
      state: {
        values: {
          [addContext.TITLE_BLOCK]: { [addContext.VALUE_ACTION]: { type: 'plain_text_input', value: title } },
          [addContext.TEXT_BLOCK]: { [addContext.VALUE_ACTION]: { type: 'plain_text_input', value: text } },
        },
      },
    },
  });
}
// The system prompt a hub's AI service sends for one question.
async function promptOn(s, hub) {
  await s.views.forHub(hub).llm.ask({ person: ADA.id, resource: 'ASK', request: 'What do we charge?' });
  return s.model.calls.at(-1).system;
}

function appCopy(t, edit) {
  const dir = tmpDir(t, 'shared-app');
  fs.cpSync(path.join(FIX, 'app'), dir, { recursive: true });
  edit(dir);
  return dir;
}
const editJson = (file, change) => fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8')))));
const problemsOf = (dir) => {
  const { registry: r, problems } = loadRegistry({ appDir: dir, profile });
  assert.deepEqual(problems, []);
  return bootProblems({ hubs: r.hubs, modules: r.modules, env: 'dev' });
};

// --- The hub file and the boot refusals -------------------------------------------

test('the fixture loads with no problem: the full hub names the blank hub in "notes", the third hub keeps its own', () => {
  assert.deepEqual(loadProblems, []);
  assert.deepEqual(registry.hubs.map((h) => [h.id, h.notes]), [['full', 'teach'], ['teach', undefined], ['third', undefined]]);
  assert.deepEqual(bootProblems({ hubs: registry.hubs, modules: registry.modules, env: 'dev' }), []);
});

test('the hub schema: "notes" is optional, a hub id; anything else is refused naming the file and the field', (t) => {
  const dir = appCopy(t, (d) => {
    editJson(path.join(d, 'hubs/full.json'), (h) => ({ ...h, notes: 'Teach Tools' }));
    editJson(path.join(d, 'hubs/third.json'), (h) => ({ ...h, notes: ['teach'] }));
  });
  const { hubs, problems } = loadHubs(dir);
  assert.deepEqual(hubs.map((h) => h.id), ['teach']);
  assert.deepEqual(problems, [
    'hubs/full.json: field "notes" must match pattern "^[a-z][a-z0-9-]*$"',
    'hubs/third.json: field "notes" must be string',
  ]);
});

test('boot refuses a "notes" naming no hub, naming the hub file and the field', (t) => {
  const dir = appCopy(t, (d) => editJson(path.join(d, 'hubs/full.json'), (h) => ({ ...h, notes: 'gone' })));
  assert.deepEqual(problemsOf(dir), ['hubs/full.json: field "notes" names no hub ("gone" has no hubs/gone.json)']);
});

test('boot refuses a "notes" naming the hub itself', (t) => {
  const dir = appCopy(t, (d) => editJson(path.join(d, 'hubs/full.json'), (h) => ({ ...h, notes: 'full' })));
  assert.deepEqual(problemsOf(dir), ['hubs/full.json: field "notes" names the hub itself (leave "notes" out for the hub\'s own notes)']);
});

test('boot refuses a chain (a hub sharing the notes of a hub that shares another\'s) and a loop', (t) => {
  const chain = appCopy(t, (d) => editJson(path.join(d, 'hubs/third.json'), (h) => ({ ...h, notes: 'full' })));
  assert.deepEqual(problemsOf(chain), [
    'hubs/third.json: field "notes" names full, which shares another hub\'s notes itself (hubs/full.json field "notes"); name a hub that keeps its own notes (no chains)',
  ]);
  const loop = appCopy(t, (d) => editJson(path.join(d, 'hubs/teach.json'), (h) => ({ ...h, notes: 'full' })));
  assert.deepEqual(problemsOf(loop), [
    'hubs/full.json: field "notes" names teach, which shares another hub\'s notes itself (hubs/teach.json field "notes"); name a hub that keeps its own notes (no chains)',
    'hubs/teach.json: field "notes" names full, which shares another hub\'s notes itself (hubs/full.json field "notes"); name a hub that keeps its own notes (no chains)',
  ]);
});

test('boot refuses different keys on the sharing hubs: an ask, an add-context and a data-sources module, each naming the hub file, the field and every module', (t) => {
  // [the folder changed, its new key, the other module and its key, the verb]
  const cases = {
    ask: ['full-ask', 'OTHER_ASK', 'teach-ask', 'ASK', 'read'],
    'add-context': ['full-add', 'ASK', 'teach-add', 'ADD_CONTEXT', 'add and remove'],
    'data-sources': ['teach-sources', 'ASK', 'full-sources', 'DATA_SOURCES', 'list'],
  };
  for (const [archetype, [folder, key, other, otherKey, verb]] of Object.entries(cases)) {
    const dir = appCopy(t, (d) => editJson(path.join(d, `modules/${folder}/manifest.json`), (m) => ({ ...m, resource: key })));
    const problems = problemsOf(dir);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], new RegExp(`^hubs/full\\.json: field "notes" shares the notes of teach, but the ${archetype} modules on these hubs use different keys \\(`));
    assert.ok(problems[0].includes(`modules/${folder}/manifest.json "resource" ${key}`), problems[0]);
    assert.ok(problems[0].includes(`modules/${other}/manifest.json "resource" ${otherKey}`), problems[0]);
    assert.ok(problems[0].endsWith(`; give them one key, so the same people ${verb} the shared notes`), problems[0]);
  }
});

test('the same-keys check leaves alone a hub with none of a notes tool, and a third hub with its own notes and its own keys', (t) => {
  const dir = appCopy(t, (d) => {
    fs.rmSync(path.join(d, 'modules/full-sources'), { recursive: true });
    editJson(path.join(d, 'modules/third-ask/manifest.json'), (m) => ({ ...m, resource: 'OTHER_ASK' }));
  });
  assert.deepEqual(problemsOf(dir), []);
});

test('the booted app refuses a bad link too, naming it', (t) => {
  const dir = appCopy(t, (d) => editJson(path.join(d, 'hubs/full.json'), (h) => ({ ...h, notes: 'gone' })));
  const cfg = checkConfig({
    env: {
      APLABS_NO_KEYCHAIN: '1', SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP, APLABS_PROFILE: PROFILE_PATH, APLABS_APP_DIR: dir,
    },
    cwd: os.tmpdir(),
  });
  assert.ok(cfg.problems.includes('app: hubs/full.json: field "notes" names no hub ("gone" has no hubs/gone.json)'), cfg.problems.join('\n'));
});

test('createHubViews fails closed on a link boot would refuse', () => {
  const hubs = registry.hubs.map((h) => (h.id === 'third' ? { ...h, notes: 'full' } : h));
  assert.throws(() => createHubViews({ hubs }), /hubs\/third\.json: field "notes" names full, which shares another hub's notes itself/);
  assert.throws(() => createHubViews({ hubs: [{ id: 'a', sees: [], notes: 'a' }] }), /hubs\/a\.json: field "notes" names the hub itself/);
  assert.throws(() => createHubViews({ hubs: [{ id: 'a', sees: [], notes: 'b' }] }), /names no hub/);
});

// --- The views ----------------------------------------------------------------------

test('the views: both sharing hubs are bound to one store and name each other; the third hub keeps its own; sees is unchanged', (t) => {
  const knowledge = makeKnowledge(t);
  const bound = [];
  const stores = [];
  const { llm } = makeLlm(knowledge);
  const spyLlm = { ...llm, forHub: (h) => { bound.push(h); return llm.forHub(h); } };
  const spyStore = { ...knowledge, forHub: (id) => { stores.push(id); return knowledge.forHub(id); } };
  const views = createHubViews({ hubs: registry.hubs, llm: spyLlm, knowledge: spyStore });
  assert.deepEqual(bound, [
    { id: 'full', sees: ['context', 'data', 'rules'], notes: 'teach' },
    { id: 'teach', sees: [] },
    { id: 'third', sees: [] },
  ]);
  assert.deepEqual(stores, ['teach', 'teach', 'third']);
  const [full, teach, third] = ['full', 'teach', 'third'].map((id) => views.forHub(id));
  assert.deepEqual([full.notes, teach.notes, third.notes], ['teach', 'teach', 'third']);
  assert.deepEqual([[...full.sharedWith], [...teach.sharedWith], [...third.sharedWith]], [['Teach tools'], ['Full tools'], []]);
  assert.ok(Object.isFrozen(full.sharedWith));
  assert.deepEqual([[...teach.sees], teach.data, teach.rules], [[], null, false]);
  assert.deepEqual([...BLANK_VIEW.sharedWith], []);
  assert.throws(() => llm.forHub({ id: 'x', sees: [], notes: '../etc' }), /notes to be a hub id/);
  assert.throws(() => llm.forHub({ id: 'x', sees: [], notes: 7 }), /notes to be a hub id/);
});

// --- One set of notes, on both hubs -----------------------------------------------------

test('a note added on the full hub is listed on both hubs, in both prompts, and never on the third hub', async (t) => {
  const s = setup(t);
  const form = await openForm(s.app, 'full');
  await submit(s.app, form, { title: 'Saturday work', text: 'SHARED_NOTE_TEXT: we clean on Saturdays.' });
  assert.equal(calls(s.app, 'update').at(-1).view.blocks[0].text.text, addContext.ADDED);
  // Stored once, in the blank hub's folder.
  const [entry] = await s.knowledge.list('teach');
  assert.equal(entry.hub, 'teach');
  assert.deepEqual(await s.knowledge.list('full'), []);
  // Listed on both Add context screens and both Data sources screens.
  for (const hub of ['teach', 'full']) {
    assert.match(allText((await openForm(s.app, hub)).blocks), /• \*Saturday work\* by <@UADA> on 2026-10-31/);
    assert.match(allText((await openSources(s.app, hub)).blocks), /• Saturday work by <@UADA> on 2026-10-31/);
  }
  // In both prompts; never in the third hub's, whose form lists nothing.
  assert.match(await promptOn(s, 'teach'), /SHARED_NOTE_TEXT/);
  assert.match(await promptOn(s, 'full'), /SHARED_NOTE_TEXT/);
  assert.ok(!(await promptOn(s, 'third')).includes('SHARED_NOTE_TEXT'));
  assert.match(allText((await openForm(s.app, 'third')).blocks), /Nothing added here yet\./);
});

test('a note added on the blank hub is listed and prompted on the full hub; removed on the full hub, it is gone from both', async (t) => {
  const s = setup(t);
  await submit(s.app, await openForm(s.app, 'teach'), { title: 'Prices', text: 'TEACH_NOTE: a deep clean costs $240.' });
  assert.match(await promptOn(s, 'full'), /TEACH_NOTE/);
  const fullForm = await openForm(s.app, 'full');
  const [button] = removeButtons(fullForm);
  await s.app.dispatchAction(addContext.REMOVE_ACTION, { user: ADA, value: button.value, view: { ...fullForm, id: 'VFULL', hash: 'h1' } });
  assert.equal(calls(s.app, 'update').at(-1).view.blocks[0].text.text, addContext.REMOVED);
  assert.deepEqual(await s.knowledge.list('teach'), []);
  assert.ok(!(await promptOn(s, 'teach')).includes('TEACH_NOTE'));
  assert.ok(!(await promptOn(s, 'full')).includes('TEACH_NOTE'));
  assert.match(allText((await openForm(s.app, 'teach')).blocks), /Nothing added here yet\./);
});

test('way out, Remove on one hub of a note already removed on the other: "That entry was already removed."', async (t) => {
  const s = setup(t);
  await submit(s.app, await openForm(s.app, 'teach'), { title: 'Prices', text: 'A clean costs $120.' });
  const fullForm = await openForm(s.app, 'full');
  const teachForm = await openForm(s.app, 'teach');
  const [onTeach] = removeButtons(teachForm);
  const [onFull] = removeButtons(fullForm);
  await s.app.dispatchAction(addContext.REMOVE_ACTION, { user: ADA, value: onTeach.value, view: { ...teachForm, id: 'VT', hash: 'h1' } });
  await s.app.dispatchAction(addContext.REMOVE_ACTION, { user: ADA, value: onFull.value, view: { ...fullForm, id: 'VF', hash: 'h2' } });
  assert.equal(calls(s.app, 'update').at(-1).view.blocks[0].text.text, addContext.ALREADY_REMOVED);
});

test('the blank hub still gets no profile context: its prompt is the blank prompt plus the shared notes; the full hub\'s holds the context files', async (t) => {
  const s = setup(t);
  await s.knowledge.add({
    hub: 'teach', kind: 'text', title: 'Prices', text: 'NOTE_ON_BOTH', addedBy: 'UADA',
  });
  const blank = await promptOn(s, 'teach');
  const full = await promptOn(s, 'full');
  assert.ok(blank.startsWith(systemPrompt(profile.client.name, [])), 'the blank prompt, then the notes');
  for (const marker of ['ORG_PROSE_KEPT', 'DATA_PROSE_KEPT']) {
    assert.ok(!blank.includes(marker), marker);
    assert.ok(full.includes(marker), marker);
  }
  assert.ok(blank.includes('NOTE_ON_BOTH') && full.includes('NOTE_ON_BOTH'));
  // The full hub's view still has the runner slot and rules; the blank hub's never does.
  assert.deepEqual([s.views.forHub('teach').data, s.views.forHub('teach').rules, s.views.forHub('full').rules], [null, false, true]);
});

test('the 40,000-character limit is unchanged: shared notes that push the full hub\'s prompt over it refuse its call only', async (t) => {
  const knowledge = makeKnowledge(t);
  // data.md at about 32,000 characters: the context fits, and the notes push it over.
  const big = `Visits are appointments. ${'word '.repeat(6400)}`;
  const { llm, model } = makeLlm(knowledge, { readFile: (p) => (p.endsWith('data.md') ? big : '') });
  const views = createHubViews({ hubs: registry.hubs, llm, knowledge });
  const ask = (hub) => views.forHub(hub).llm.ask({ person: ADA.id, resource: 'ASK', request: 'hi' });
  await ask('full');
  for (let i = 0; i < 3; i += 1) {
    await knowledge.add({
      hub: 'teach', kind: 'text', title: `Note ${i}`, text: 'x'.repeat(CAPS.text), addedBy: 'UADA',
    });
  }
  await assert.rejects(ask('full'), (err) => err.name === 'LlmUnavailable' && err.reason === 'config');
  await ask('teach');
  assert.equal(model.calls.length, 2);
});

test('the caps count the shared set once: 20 entries across both hubs fill it, and either hub is then refused', async (t) => {
  const s = setup(t);
  const add = (hub, i) => s.views.forHub(hub).knowledge.add({
    kind: 'text', title: `Note ${i}`, text: `Text ${i}`, addedBy: 'UADA',
  });
  for (let i = 0; i < CAPS.hubEntries; i += 1) await add(i % 2 ? 'full' : 'teach', i);
  assert.equal((await s.views.forHub('full').knowledge.list()).length, CAPS.hubEntries);
  for (const hub of ['teach', 'full']) {
    await assert.rejects(add(hub, 99), (err) => err instanceof ContextRefused && err.reason === 'too_many');
  }
  // The third hub's own notes are untouched by the cap.
  await add('third', 1);
});

test('the character cap counts the shared set once: the blank hub fills most of it, and the full hub cannot add past it', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 4; i += 1) {
    await s.views.forHub('teach').knowledge.add({
      kind: 'text', title: `Note ${i}`, text: 'y'.repeat(CAPS.text), addedBy: 'UADA',
    });
  }
  await assert.rejects(s.views.forHub('full').knowledge.add({
    kind: 'text', title: 'One more', text: 'z'.repeat(CAPS.text), addedBy: 'UADA',
  }), (err) => err instanceof ContextRefused && err.reason === 'hub_full');
});

test('two adds at once from the two hubs run one at a time: with one place left, exactly one is stored', async (t) => {
  const s = setup(t);
  for (let i = 0; i < CAPS.hubEntries - 1; i += 1) {
    await s.knowledge.add({
      hub: 'teach', kind: 'text', title: `Note ${i}`, text: `Text ${i}`, addedBy: 'UADA',
    });
  }
  const results = await Promise.allSettled(['teach', 'full'].map((hub) => s.views.forHub(hub).knowledge.add({
    kind: 'text', title: `From ${hub}`, text: 'At once', addedBy: 'UADA',
  })));
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.reason, 'too_many');
  assert.equal((await s.knowledge.list('teach')).length, CAPS.hubEntries);
});

// --- The screens say so ------------------------------------------------------------------

test('both Add context screens say the notes are shared, naming the other hub; the third hub\'s does not', async (t) => {
  const s = setup(t);
  const line = (name) => `Shared with ${name}: a note added or removed here is added or removed there too.`;
  const fullForm = await openForm(s.app, 'full');
  const teachForm = await openForm(s.app, 'teach');
  assert.ok(allText(fullForm.blocks).includes(line('Teach tools')));
  assert.ok(allText(teachForm.blocks).includes(line('Full tools')));
  assert.ok(!allText((await openForm(s.app, 'third')).blocks).includes('Shared with'));
  for (const v of [fullForm, teachForm]) assert.equal(invalidView(v), null);
  // The "Added." result and a file's "Here's what I took" keep the line.
  await submit(s.app, fullForm, { title: 'Prices', text: 'A clean costs $120.' });
  assert.ok(allText(calls(s.app, 'update').at(-1).view.blocks).includes(line('Teach tools')));
  const [entry] = await s.knowledge.list('teach');
  const took = addContext.fileAdded({
    hubId: 'full', moduleId: 'full-add', entry, entries: [entry], admin: 'Ada', sharedWith: ['Teach tools'],
  });
  assert.ok(allText(took.blocks).includes(line('Teach tools')));
  // A hub name is shown as plain text.
  assert.equal(addContext.sharedLine(['<!channel> *v0*']).startsWith('Shared with &lt;!channel&gt; *v0*'), true);
});

test('Data sources heads the notes "Added context (shared with <hub>)" on both hubs; the plain heading elsewhere', async (t) => {
  const s = setup(t);
  assert.match(allText((await openSources(s.app, 'full')).blocks), /\*Added context \(shared with Teach tools\)\*\nNone yet\./);
  assert.match(allText((await openSources(s.app, 'teach')).blocks), /\*Added context \(shared with Full tools\)\*\nNone yet\./);
  const plain = dataSources.render({
    ready: { rules: false, detail: { data: { seen: false }, rules: { seen: false } } }, entries: [],
  });
  assert.match(allText(plain.blocks), /\*Added context\*\nNone yet\./);
});

// --- PR #307 review: every other way to the notes -----------------------------------------

// A module as the registry hands it to boot, for bootProblems.
const modOf = (id, hub, archetype, resource) => ({
  id, hub, archetype, resource, file: `modules/${id}/manifest.json`,
});
const withMods = (...mods) => bootProblems({ hubs: registry.hubs, modules: [...registry.modules, ...mods], env: 'dev' });

test('boot refuses a module on a sharing hub whose AI calls carry the notes (a scoped pull, an approval write, an archetype added later) unless it uses the Ask key', () => {
  for (const [archetype, hub] of [['scoped-pull', 'full'], ['approval-write', 'full'], ['some-new-archetype', 'teach']]) {
    const a = /^[aeiou]/.test(archetype) ? 'an' : 'a';
    assert.deepEqual(withMods(modOf('pull', hub, archetype, 'OTHER_ASK')), [
      `hubs/full.json: field "notes" shares the notes of teach, but modules/pull/manifest.json (${a} ${archetype} module on ${hub}) uses "resource" OTHER_ASK, and its AI calls carry the shared notes; use ASK, the key that reads them, or move it to a hub that keeps its own notes`,
    ]);
    assert.deepEqual(withMods(modOf('pull', hub, archetype, 'ASK')), [], `${archetype} with the Ask key`);
  }
  // On the third hub, with its own notes, any key is fine.
  assert.deepEqual(withMods(modOf('pull', 'third', 'some-new-archetype', 'OTHER_ASK')), []);
});

test('the modules whose AI calls never carry notes may use any key on a sharing hub: routing-map, handler, build-request', () => {
  assert.deepEqual([...NOTES_FREE], ['routing-map', 'handler', 'build-request']);
  const mods = NOTES_FREE.map((archetype, i) => modOf(`free-${i}`, 'full', archetype, 'OTHER_ASK'));
  assert.deepEqual(withMods(...mods), []);
});

test('with no Ask on the sharing hubs, the key that reads the notes is Add context\'s; with neither, a notes-reaching module is refused', () => {
  const noAsk = registry.modules.filter((m) => m.archetype !== 'ask');
  const run = (mods, extra) => bootProblems({ hubs: registry.hubs, modules: [...mods, extra], env: 'dev' });
  assert.deepEqual(run(noAsk, modOf('pull', 'full', 'scoped-pull', 'ADD_CONTEXT')), []);
  assert.match(run(noAsk, modOf('pull', 'full', 'scoped-pull', 'ASK'))[0], /uses "resource" ASK, and its AI calls carry the shared notes; use ADD_CONTEXT, the key that reads them,/);
  const none = registry.modules.filter((m) => !['ask', 'add-context'].includes(m.archetype));
  assert.match(run(none, modOf('pull', 'full', 'scoped-pull', 'ASK'))[0], /its AI calls carry the shared notes; give it the key the hubs' ask modules use or move it/);
});

test('a handler on the sharing hub is never handed an AI service or the notes: its ctx is person, client, module, data and reply', async (t) => {
  let seen = null;
  const handler = Object.freeze({
    id: 'peek', hub: 'full', label: 'Peek', description: 'Peek.', resource: 'OTHER_ASK', archetype: 'handler', environments: ['dev'], file: 'modules/peek/manifest.json',
    run: async (ctx) => { seen = ctx; await ctx.reply({ text: 'hi' }); },
  });
  const reg = createRegistry({ hubs: registry.hubs, modules: [...registry.modules, handler] });
  assert.deepEqual(bootProblems({ hubs: reg.hubs, modules: reg.modules, env: 'dev' }), []);
  const s = setup(t, { reg });
  await s.knowledge.add({
    hub: 'teach', kind: 'text', title: 'Secret', text: 'HANDLER_MUST_NOT_SEE', addedBy: 'UADA',
  });
  await s.app.dispatchAction('peek:open', { user: ADA, view: MENU('full') });
  assert.ok(seen, 'the handler ran');
  assert.deepEqual(Object.keys(seen).sort(), ['client', 'data', 'module', 'person', 'reply']);
  assert.ok(!JSON.stringify(seen).includes('HANDLER_MUST_NOT_SEE'));
});

test('a build request\'s summary call on the sharing hub sends no notes and no profile context (withContext: false)', async (t) => {
  const s = setup(t);
  await s.knowledge.add({
    hub: 'teach', kind: 'text', title: 'Secret', text: 'BUILD_MUST_NOT_SEE', addedBy: 'UADA',
  });
  const tool = { name: 'summarize_request', input_schema: { type: 'object' }, effects: 'none' };
  await s.views.forHub('full').llm.structured({
    person: ADA.id, resource: 'ASK', request: 'A tool for rotas', tool, withContext: false,
  });
  const { system } = s.model.calls.at(-1);
  assert.ok(!system.includes('BUILD_MUST_NOT_SEE'));
  assert.ok(!system.includes('ORG_PROSE_KEPT'));
});

// --- PR #307 review P2 #2: an upload on the sharing hub saves into the shared folder -----------

async function uploadOn(s, hub, { id, name, bytes, mimetype }) {
  s.app.addSlackFile({
    id, name, user: ADA.id, mimetype, bytes,
  });
  const form = await openForm(s.app, hub);
  await s.app.dispatchView(addContext.SUBMIT_CALLBACK, {
    user: ADA,
    view: {
      ...form,
      id: 'VFORM',
      hash: 'hform',
      state: {
        values: {
          [addContext.TITLE_BLOCK]: { [addContext.VALUE_ACTION]: { type: 'plain_text_input', value: name } },
          [addContext.TEXT_BLOCK]: { [addContext.VALUE_ACTION]: { type: 'plain_text_input', value: null } },
          [addContext.FILE_BLOCK]: { [addContext.VALUE_ACTION]: fileState({ id, name }) },
        },
      },
    },
  });
  return calls(s.app, 'update').at(-1).view;
}

test('a file uploaded on the sharing hub is saved into the shared folder, listed and prompted on both hubs; the photo is read with no notes in its prompt', async (t) => {
  const s = setup(t);
  await s.knowledge.add({
    hub: 'teach', kind: 'text', title: 'Earlier', text: 'EARLIER_NOTE', addedBy: 'UADA',
  });
  const csv = await uploadOn(s, 'full', {
    id: 'F0CSV', name: 'zones.csv', bytes: Buffer.from('zone,billed\nNorth,CSV_CELL_SHARED\n'), mimetype: 'text/csv',
  });
  assert.match(csv.blocks[0].text.text, /^Here's what I took from \*zones\.csv\*: 1 row, 2 columns/);
  assert.ok(allText(csv.blocks).includes('Shared with Teach tools'));
  const photo = await uploadOn(s, 'full', {
    id: 'F0PNG', name: 'board.png', bytes: png(), mimetype: 'image/png',
  });
  assert.match(photo.blocks[0].text.text, /^Here's what I took from \*board\.png\*/);
  // The photo's read call: a blank prompt, never the notes or the profile context.
  const read = s.model.calls.find((c) => Array.isArray(c.messages[0].content) && c.messages[0].content.some((b) => b.type === 'image'));
  assert.ok(read, 'the photo was read');
  assert.ok(!read.system.includes('EARLIER_NOTE') && !read.system.includes('ORG_PROSE_KEPT'));
  // Both saved in the blank hub's folder, nothing in the full hub's own.
  const stored = await s.knowledge.list('teach');
  // One fixed clock, so the order is by id: compare as a set.
  assert.deepEqual(stored.map((e) => [e.title, e.hub, e.kind]).sort(), [['Earlier', 'teach', 'text'], ['board.png', 'teach', 'file'], ['zones.csv', 'teach', 'file']]);
  assert.deepEqual(await s.knowledge.list('full'), []);
  const teachList = allText((await openForm(s.app, 'teach')).blocks);
  assert.ok(teachList.includes('zones.csv') && teachList.includes('board.png'));
  assert.match(await promptOn(s, 'teach'), /CSV_CELL_SHARED/);
});
