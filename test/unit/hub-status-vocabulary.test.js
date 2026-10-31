'use strict';

// Plan hub-status-menu, Story 17.1 (D2, D10): the menu's vocabulary
// (kit/runtime/registry/vocabulary). Every status has a word, a glyph never
// stands alone, the bar is one cell per counted step, the two deferred
// statuses are absent, an unknown key throws, and no other runtime file
// writes a menu glyph (architect P1-2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  statusText, setupBar, toolsReady, menuVerbOf, STATUSES, VERBS, DEFAULT_VERBS, GLYPHS, RESERVED_GLYPHS, SETUP_GROUP,
} = require('../../kit/runtime/registry/vocabulary');

const MENU_GLYPHS = ['✓', '◐', '◌', '○', '🔒', '▰', '▱'];
const RUNTIME = path.join(__dirname, '../../kit/runtime');
const VOCABULARY = path.join(RUNTIME, 'registry/vocabulary.js');

test('every status has a glyph and a non-empty word', () => {
  assert.deepEqual(Object.keys(STATUSES).sort(), ['admin', 'context-only', 'done', 'not-started', 'partly', 'ready', 'waiting']);
  for (const [key, s] of Object.entries(STATUSES)) {
    assert.ok(MENU_GLYPHS.includes(s.glyph), key);
    assert.ok(typeof s.word === 'string' && s.word.trim().length > 0, key);
  }
});

test('statusText never returns a glyph without its word, with or without a detail', () => {
  assert.equal(statusText({ key: 'ready' }), '✓ Ready');
  assert.equal(statusText({ key: 'done', detail: '3 notes' }), '✓ Done · 3 notes');
  assert.equal(statusText({ key: 'partly', detail: 'nothing taught yet' }), '◐ Partly ready · nothing taught yet');
  assert.equal(statusText({ key: 'waiting', detail: 'needs data' }), '◌ Waiting · needs data');
  assert.equal(statusText({ key: 'not-started', detail: 'no notes yet' }), '○ Not started · no notes yet');
  assert.equal(statusText({ key: 'admin' }), '🔒 Admin only');
  assert.equal(statusText({ key: 'context-only', detail: '1 note' }), '✓ Context only · 1 note');
  for (const key of Object.keys(STATUSES)) {
    for (const detail of [null, 'x']) {
      const line = statusText({ key, detail });
      const [glyph, ...rest] = line.split(' ');
      assert.ok(MENU_GLYPHS.includes(glyph), line);
      assert.ok(rest.join(' ').startsWith(STATUSES[key].word), `${line}: the word follows the glyph`);
    }
  }
});

test('the deferred statuses (requested, late) are not in the table, and an unknown key throws', () => {
  for (const key of ['requested', 'late', 'checking', 'open', '', undefined, 'toString', '__proto__']) {
    assert.throws(() => statusText({ key }), TypeError, String(key));
  }
  assert.throws(() => statusText(), TypeError);
  assert.throws(() => statusText({ key: 'ready', detail: '  ' }), TypeError);
  assert.throws(() => statusText({ key: 'ready', detail: 3 }), TypeError);
  const words = Object.values(STATUSES).map((s) => s.word).join(' ');
  assert.ok(!/Requested|late/i.test(words));
  assert.ok(!Object.values(STATUSES).some((s) => s.glyph === '⏳' || s.glyph === '⚠'));
});

test('the bar is one cell per counted step, ▰ done and ▱ not done, then "Setup N of M"', () => {
  assert.equal(setupBar(0, 1), '▱ Setup 0 of 1');
  assert.equal(setupBar(1, 1), '▰ Setup 1 of 1');
  assert.equal(setupBar(1, 2), '▰▱ Setup 1 of 2');
  assert.equal(setupBar(2, 4), '▰▰▱▱ Setup 2 of 4');
  assert.equal(setupBar(1, 4), '▰▱▱▱ Setup 1 of 4');
  for (let of = 1; of <= 4; of += 1) {
    for (let done = 0; done <= of; done += 1) {
      const cells = setupBar(done, of).split(' ')[0];
      assert.equal([...cells].length, of);
      assert.equal([...cells].filter((c) => c === '▰').length, done);
    }
  }
  for (const [d, o] of [[0, 0], [2, 1], [-1, 2], [1.5, 2], ['1', 2], [1, null]]) assert.throws(() => setupBar(d, o), RangeError);
});

test('tools ready reads "✓ N of M tools ready"; the Setup group header is "🔒 Setup · admins"', () => {
  assert.equal(toolsReady(1, 2), '✓ 1 of 2 tools ready');
  assert.equal(toolsReady(0, 0), '✓ 0 of 0 tools ready');
  assert.throws(() => toolsReady(3, 2), RangeError);
  assert.equal(SETUP_GROUP, '🔒 Setup · admins');
});

test('menuVerbOf: each archetype\'s default (D10), a manifest verb overrides it, "Open" and "Why?" are never verbs', () => {
  const want = {
    ask: 'Ask',
    'add-context': 'Add',
    'data-sources': 'View',
    'build-request': 'Request',
    'scoped-pull': 'Run',
    'approval-write': 'Run',
    handler: 'Run',
    'routing-map': 'View',
  };
  assert.deepEqual({ ...DEFAULT_VERBS }, want);
  for (const [archetype, verb] of Object.entries(want)) assert.equal(menuVerbOf({ archetype }), verb);
  assert.equal(menuVerbOf({ archetype: 'handler', verb: 'View' }), 'View');
  assert.equal(menuVerbOf({ archetype: 'approval-write', verb: 'Review' }), 'Review');
  assert.deepEqual([...VERBS], ['Ask', 'Run', 'View', 'Add', 'Review', 'Request']);
  assert.ok(!VERBS.includes('Open') && !VERBS.includes('Why?'));
  // A verb that is not one of the menu's falls back to the archetype's.
  assert.equal(menuVerbOf({ archetype: 'handler', verb: 'Why?' }), 'Run');
  assert.equal(menuVerbOf({ archetype: 'handler', verb: 'Open' }), 'Run');
  assert.throws(() => menuVerbOf({ archetype: 'mystery' }), TypeError);
  assert.throws(() => menuVerbOf(null), TypeError);
});

test('the reserved glyphs are the menu glyphs plus the two deferred statuses\' marks', () => {
  assert.deepEqual([...GLYPHS].sort(), [...MENU_GLYPHS].sort());
  assert.deepEqual([...RESERVED_GLYPHS].sort(), [...MENU_GLYPHS, '⏳', '⚠'].sort());
});

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return filesUnder(p);
    return d.isFile() ? [p] : [];
  });
}

test('no runtime file but vocabulary.js writes a menu glyph (✓ ◐ ◌ ○ 🔒 ▰ ▱)', () => {
  const offenders = [];
  for (const file of filesUnder(RUNTIME)) {
    if (file === VOCABULARY) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const g of MENU_GLYPHS) if (text.includes(g)) offenders.push(`${path.relative(RUNTIME, file)}: ${g}`);
  }
  assert.deepEqual(offenders, []);
  const own = fs.readFileSync(VOCABULARY, 'utf8');
  for (const g of MENU_GLYPHS) assert.ok(own.includes(g), g);
});
