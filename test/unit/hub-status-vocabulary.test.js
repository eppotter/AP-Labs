'use strict';

// Plan hub-status-menu, Story 17.1 (D2, D10) and the 2026-10-31 decision
// "subtle health": the menu's vocabulary (kit/runtime/registry/vocabulary).
// A healthy tool has no status line, a setup fact has no dot, a tool that
// needs attention has a dot and words (never a colour alone), the strip's
// lines have no dots, the two deferred statuses are absent, an unknown key
// throws, and no other runtime file writes a menu mark (architect P1-2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  statusText, statusParts, needsAttention, toolsWorking, setupProgress, menuVerbOf, STATUSES, VERBS, DEFAULT_VERBS, GLYPHS, SHORTCODES, RESERVED_GLYPHS, SETUP_GROUP,
} = require('../../kit/runtime/registry/vocabulary');

const DOTS = ['🟢', '🟡', '⚪', '🔴'];
const DOT_CODES = [':large_green_circle:', ':large_yellow_circle:', ':white_circle:', ':red_circle:'];
const OLD_MARKS = ['✓', '◐', '◌', '○', '🔒', '▰', '▱'];
const RUNTIME = path.join(__dirname, '../../kit/runtime');
const VOCABULARY = path.join(RUNTIME, 'registry/vocabulary.js');

test('the statuses are D2\'s, less the deferred two and the old admin mark', () => {
  assert.deepEqual(Object.keys(STATUSES).sort(), ['context-only', 'done', 'not-started', 'partly', 'ready', 'waiting']);
});

test('a healthy tool has no status line: ready, and done with nothing to add', () => {
  assert.equal(statusText({ key: 'ready' }), null);
  assert.equal(statusText({ key: 'ready', detail: null }), null);
  assert.equal(statusText({ key: 'done' }), null);
  assert.equal(needsAttention({ key: 'ready' }), false);
  assert.equal(needsAttention({ key: 'done' }), false);
});

test('a setup fact with no problem is plain text with no dot', () => {
  assert.equal(statusText({ key: 'done', detail: '2 notes' }), '2 notes');
  assert.equal(statusText({ key: 'done', detail: 'no data on this hub' }), 'no data on this hub');
  assert.equal(statusText({ key: 'context-only', detail: 'no data on this hub' }), 'notes only · no data on this hub');
  assert.equal(needsAttention({ key: 'context-only', detail: 'no data on this hub' }), false);
  for (const line of ['2 notes', 'notes only · no data on this hub']) {
    for (const dot of [...DOTS, ...OLD_MARKS]) assert.ok(!line.includes(dot), line);
  }
});

test('statusParts splits the line into its dot (null for a fact) and its words, for the menu\'s inline status; statusText joins them', () => {
  assert.equal(statusParts({ key: 'ready' }), null);
  assert.equal(statusParts({ key: 'done' }), null);
  assert.deepEqual(statusParts({ key: 'done', detail: '2 notes' }), { dot: null, words: '2 notes' });
  assert.deepEqual(statusParts({ key: 'context-only', detail: 'no data on this hub' }), { dot: null, words: 'notes only · no data on this hub' });
  assert.deepEqual(statusParts({ key: 'partly', detail: 'no data yet' }), { dot: '🟡', words: 'no data yet' });
  assert.deepEqual(statusParts({ key: 'waiting', detail: 'needs map setup' }), { dot: '⚪', words: 'needs map setup' });
  assert.deepEqual(statusParts({ key: 'not-started', detail: 'no notes yet' }), { dot: '⚪', words: 'not started' });
  assert.throws(() => statusParts({ key: 'checking' }), TypeError);
  assert.throws(() => statusParts({ key: 'waiting', detail: 42 }), TypeError);
});

test('each attention state is a dot then a few lower-case words, never a colour alone', () => {
  assert.equal(statusText({ key: 'partly', detail: 'no data yet' }), '🟡 no data yet');
  assert.equal(statusText({ key: 'partly', detail: 'nothing taught yet' }), '🟡 nothing taught yet');
  assert.equal(statusText({ key: 'partly' }), '🟡 partly ready');
  assert.equal(statusText({ key: 'waiting', detail: 'needs data' }), '⚪ needs data');
  assert.equal(statusText({ key: 'waiting', detail: 'needs the AI' }), '⚪ needs the AI');
  assert.equal(statusText({ key: 'waiting' }), '⚪ waiting');
  assert.equal(statusText({ key: 'not-started' }), '⚪ not started');
  assert.equal(statusText({ key: 'not-started', detail: 'no notes yet' }), '⚪ not started');
  for (const key of ['partly', 'waiting', 'not-started']) {
    assert.equal(needsAttention({ key }), true, key);
    for (const detail of [null, 'needs x']) {
      const line = statusText({ key, detail });
      const [dot, ...rest] = line.split(' ');
      assert.ok(['🟡', '⚪'].includes(dot), line);
      const words = rest.join(' ');
      assert.ok(words.trim().length > 0, `${line}: words follow the dot`);
      assert.equal(words[0], words[0].toLowerCase(), `${line}: lower case after the dot`);
    }
  }
  // 🔴 is reserved for a failure, unused for now; 🟢 is never shown.
  for (const key of Object.keys(STATUSES)) {
    for (const detail of [null, 'x']) {
      const line = statusText({ key, detail }) || '';
      assert.ok(!line.includes('🔴') && !line.includes('🟢'), line);
      for (const mark of OLD_MARKS) assert.ok(!line.includes(mark), line);
    }
  }
});

test('the deferred statuses (requested, late) are not in the table, and an unknown key throws', () => {
  for (const key of ['requested', 'late', 'checking', 'open', 'admin', '', undefined, 'toString', '__proto__']) {
    assert.throws(() => statusText({ key }), TypeError, String(key));
    assert.throws(() => needsAttention({ key }), TypeError, String(key));
  }
  assert.throws(() => statusText(), TypeError);
  assert.throws(() => statusText({ key: 'ready', detail: '  ' }), TypeError);
  assert.throws(() => statusText({ key: 'ready', detail: 3 }), TypeError);
  const words = Object.values(STATUSES).map((s) => s.words || '').join(' ');
  assert.ok(!/requested|late/i.test(words));
});

test('setup progress is "Setup N of M · X of Y tools working", no bar and no dot', () => {
  assert.equal(setupProgress(0, 1, 1, 2), 'Setup 0 of 1 · 1 of 2 tools working');
  assert.equal(setupProgress(2, 4, 3, 3), 'Setup 2 of 4 · 3 of 3 tools working');
  assert.equal(setupProgress(1, 2, 1, 1), 'Setup 1 of 2 · 1 of 1 tool working');
  // A hub with no tools: the setup count only.
  assert.equal(setupProgress(2, 4, 0, 0), 'Setup 2 of 4');
  for (const [d, o] of [[0, 0], [2, 1], [-1, 2], [1.5, 2], ['1', 2], [1, null]]) assert.throws(() => setupProgress(d, o, 0, 0), RangeError);
  assert.throws(() => setupProgress(0, 1, 3, 2), RangeError);
});

test('tools working: "All Y tools working" when every tool works, else the counts that are not, honestly', () => {
  assert.equal(toolsWorking(2, 2), 'All 2 tools working');
  assert.equal(toolsWorking(10, 10), 'All 10 tools working');
  assert.equal(toolsWorking(1, 1), '1 tool working');
  assert.equal(toolsWorking(0, 0), 'No tools yet');
  assert.equal(toolsWorking(1, 2, { limited: 1 }), '1 of 2 tools working · 1 limited');
  assert.equal(toolsWorking(1, 2, { needSetup: 1 }), '1 of 2 tools working · 1 needs setup');
  assert.equal(toolsWorking(1, 4, { limited: 1, needSetup: 2 }), '1 of 4 tools working · 1 limited · 2 need setup');
  assert.equal(toolsWorking(0, 1, { limited: 1 }), '0 of 1 tool working · 1 limited');
  // A row with no status line (a guard caught it) is in neither count.
  assert.equal(toolsWorking(1, 2), '1 of 2 tools working');
  assert.throws(() => toolsWorking(3, 2), RangeError);
  assert.throws(() => toolsWorking(1, 2, { limited: 1, needSetup: 1 }), RangeError, 'never more than Y in all');
  assert.throws(() => toolsWorking(1, 2, { limited: -1 }), RangeError);
});

test('the strip lines and the Setup group header hold no dot and no old mark; the header is "Setup · admins only"', () => {
  assert.equal(SETUP_GROUP, 'Setup · admins only');
  const lines = [SETUP_GROUP, setupProgress(1, 4, 1, 3), toolsWorking(1, 3, { limited: 1, needSetup: 1 }), toolsWorking(3, 3)];
  for (const line of lines) {
    for (const mark of [...DOTS, ...DOT_CODES, ...OLD_MARKS]) assert.ok(!line.includes(mark), `${line}: ${mark}`);
  }
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

test('the reserved marks: the four dots, their Slack shortcodes, and the menu\'s old marks', () => {
  assert.deepEqual([...GLYPHS].sort(), [...DOTS].sort());
  assert.deepEqual([...SHORTCODES].sort(), [...DOT_CODES].sort());
  assert.deepEqual([...RESERVED_GLYPHS].sort(), [...DOTS, ...DOT_CODES, ...OLD_MARKS, '⏳', '⚠'].sort());
});

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return filesUnder(p);
    return d.isFile() ? [p] : [];
  });
}

// 🔴 is excluded: the routing-map editor already uses it for a hard rule
// break (as ⚠ was excluded before), and this change does not touch it.
test('no runtime file but vocabulary.js writes a menu mark (🟢 🟡 ⚪, their shortcodes, and ✓ ◐ ◌ ○ 🔒 ▰ ▱)', () => {
  const marks = [...DOTS.filter((d) => d !== '🔴'), ...DOT_CODES.filter((c) => c !== ':red_circle:'), ...OLD_MARKS];
  const offenders = [];
  for (const file of filesUnder(RUNTIME)) {
    if (file === VOCABULARY) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const g of marks) if (text.includes(g)) offenders.push(`${path.relative(RUNTIME, file)}: ${g}`);
  }
  assert.deepEqual(offenders, []);
  const own = fs.readFileSync(VOCABULARY, 'utf8');
  for (const g of [...DOTS, ...DOT_CODES]) assert.ok(own.includes(g), g);
});
