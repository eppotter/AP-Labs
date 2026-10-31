'use strict';

// Plan hub-status-menu, Story 17.1 (D5, D10, architect P3-11): a module
// manifest's optional "verb" and "group" (kit/runtime/schema/
// module.schema.json), and the registry's refusal of a label or group that
// could pass for the Setup group or a status (kit/runtime/registry). Each
// problem names the module file and the field. Fixture apps only; bad cases
// are built in a temp copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry } = require('../../kit/runtime/registry');
const { menuVerbOf } = require('../../kit/runtime/registry/vocabulary');

const RUNTIME = path.join(__dirname, '../fixtures/runtime');
const STATUS = path.join(RUNTIME, 'status-menu');
const ADD = path.join(RUNTIME, 'add-context');

// Copies a fixture app to a temp dir, lets edit(dir) change it, loads it.
function loadEdited(fixture, edit) {
  const profile = loadProfile(path.join(fixture, 'profile.yml'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-menu-reg-'));
  try {
    fs.cpSync(path.join(fixture, 'app'), dir, { recursive: true });
    edit(dir);
    return loadRegistry({ appDir: dir, profile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function editJson(dir, rel, fn) {
  const file = path.join(dir, rel);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(data);
  fs.writeFileSync(file, JSON.stringify(data));
}

const editModule = (id, fn) => loadEdited(STATUS, (d) => editJson(d, `modules/${id}/manifest.json`, fn));

test('the status-menu fixture loads with its verbs and groups', () => {
  const { registry, problems } = loadEdited(STATUS, () => {});
  assert.deepEqual(problems, []);
  const full = registry.entries('full');
  assert.equal(full.length, 12);
  assert.deepEqual(full.map((m) => [m.id, m.group || null, menuVerbOf(m)]), [
    ['full-add', null, 'Add'],
    ['full-ask', null, 'Ask'],
    ['full-list-a', 'Lists', 'Run'],
    ['full-list-b', 'Lists', 'Review'],
    ['full-list-c', 'Lists', 'Run'],
    ['full-report-a', 'Reports', 'View'],
    ['full-report-b', 'Reports', 'View'],
    ['full-report-c', 'Reports', 'Run'],
    ['full-sources', null, 'View'],
    ['full-tool-a', null, 'Run'],
    ['full-tool-b', null, 'View'],
    ['full-tool-c', 'Tools', 'Run'],
  ]);
});

test('a verb outside the menu\'s list, or "Why?", is refused naming the file and field', () => {
  for (const verb of ['Open', 'Why?', 'run', '', 3]) {
    const { registry, problems } = editModule('full-tool-a', (m) => { m.verb = verb; });
    assert.equal(registry, null, String(verb));
    assert.equal(problems.length, 1, String(verb));
    assert.match(problems[0], /^modules\/full-tool-a\/manifest\.json: field "verb" /, String(verb));
  }
});

test('a group on either setup archetype is refused: the engine places them in the Setup group', () => {
  for (const id of ['blank-add', 'blank-sources']) {
    const { registry, problems } = editModule(id, (m) => { m.group = 'Lists'; });
    assert.equal(registry, null);
    const archetype = id === 'blank-add' ? 'an add-context' : 'a data-sources';
    assert.deepEqual(problems, [`modules/${id}/manifest.json: field "group" is not used by ${archetype} module (the engine puts it in the admins' Setup group)`]);
  }
  // The add-context fixture's own setup modules, too.
  const { problems } = loadEdited(ADD, (d) => editJson(d, 'modules/blank-add/manifest.json', (m) => { m.group = 'Tools'; }));
  assert.deepEqual(problems, ['modules/blank-add/manifest.json: field "group" is not used by an add-context module (the engine puts it in the admins\' Setup group)']);
});

test('a group or label saying "Setup" or "Set up", in any case, is refused naming the file and field', () => {
  const cases = [
    ['group', 'Setup'], ['group', 'Admin setup'], ['group', 'SET UP'], ['group', 'set-up tools'],
    ['label', 'Set up the bot'], ['label', 'setup'], ['label', 'Quick SETUP'],
  ];
  for (const [field, value] of cases) {
    const { registry, problems } = editModule('full-tool-a', (m) => { m[field] = value; });
    assert.equal(registry, null, value);
    assert.deepEqual(problems, [`modules/full-tool-a/manifest.json: field "${field}" must not say "Setup" or "Set up" (the menu's Setup group is the engine's, for admins only)`], value);
  }
  // Words that only contain the letters are fine.
  for (const value of ['Reset uploads', 'Upset clients', 'Settings']) {
    const { problems } = editModule('full-tool-a', (m) => { m.label = value; m.group = value; });
    assert.deepEqual(problems, [], value);
  }
});

test('a group or label holding a menu status mark is refused naming the file, the field and the mark', () => {
  for (const glyph of ['✓', '◐', '◌', '○', '🔒', '▰', '▱', '⏳', '⚠']) {
    for (const field of ['group', 'label']) {
      const { registry, problems } = editModule('full-tool-a', (m) => { m[field] = `${glyph} Ready`; });
      assert.equal(registry, null);
      assert.deepEqual(problems, [`modules/full-tool-a/manifest.json: field "${field}" must not hold "${glyph}" (the menu's status marks are the engine's)`], `${field} ${glyph}`);
    }
  }
});

test('a group over 40 characters, with a line break, or blank is refused naming the file and field', () => {
  for (const group of ['x'.repeat(41), 'Lists\nMore', 'Lists\r', 'a b', '   ', '']) {
    const { registry, problems } = editModule('full-tool-a', (m) => { m.group = group; });
    assert.equal(registry, null, JSON.stringify(group));
    assert.ok(problems.length >= 1);
    for (const p of problems) assert.match(p, /^modules\/full-tool-a\/manifest\.json: field "group" /, JSON.stringify(group));
  }
  const { problems } = editModule('full-tool-a', (m) => { m.group = 'x'.repeat(40); });
  assert.deepEqual(problems, []);
});

test('Tools as a group joins the ungrouped tools and is accepted', () => {
  const { problems, registry } = editModule('full-tool-a', (m) => { m.group = 'Tools'; });
  assert.deepEqual(problems, []);
  assert.equal(registry.module('full-tool-a').group, 'Tools');
});

test('every fixture app\'s labels and groups pass the Setup and status-mark refusal', () => {
  for (const name of fs.readdirSync(RUNTIME)) {
    const dir = path.join(RUNTIME, name);
    if (!fs.existsSync(path.join(dir, 'app', 'modules')) || !fs.existsSync(path.join(dir, 'profile.yml'))) continue;
    const { problems } = loadRegistry({ appDir: path.join(dir, 'app'), profile: loadProfile(path.join(dir, 'profile.yml')) });
    assert.ok(!problems.some((p) => /Set up|status marks/.test(p)), `${name}: ${problems.join('; ')}`);
  }
});
