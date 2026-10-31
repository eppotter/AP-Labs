'use strict';

// The hub menu's vocabulary (plan hub-status-menu, D2 and D10, Story 17.1):
// every status mark, status word, verb and the setup bar, in one place.
// Nothing else in the engine writes a menu glyph (a test checks), so a glyph
// that fails on a phone is a one-line swap here.
//
//   statusText({ key, detail })  ->  "✓ Done · 3 notes"
//   setupBar(done, of)           ->  "▰▰▱▱ Setup 2 of 4"
//   toolsReady(n, m)             ->  "✓ 1 of 2 tools ready"
//   setupProgress(d, o, n, m)    ->  "▱ Setup 0 of 1 · 1 of 2 tools ready"
//   menuVerbOf(mod)              ->  "Ask" | "Run" | "View" | "Add" | "Review" | "Request"
//   SETUP_GROUP                  ->  "🔒 Setup · admins"
//   CHECKING                     ->  "Checking…"
//   WHY                          ->  "Why?" (a waiting row's button, Story 17.3)
//
// Every status carries a word: a glyph never stands alone. A status may add
// a short detail after a middle dot. An unknown status key throws (the
// menu's guard catches it and shows the row with its verb only, D1).
//
// CHECKING (Story 17.2, D8) is not a status: it is the line every row shows
// while the menu's notes are still being read (the menu opened before its
// summary), so it has no glyph and no key. statusText still refuses
// "checking", so no tool can claim it.
//
// Two statuses are deferred until the code has a source for them, so no
// screen can show a status the code can't back: "Requested · in build"
// (nothing records a request) and "Data late · as of <date>" (no cheap data
// date). They are not in STATUSES.
//
// menuVerbOf is the button's text only: the button still sends
// <module id>:open. It is not verbOf, which the scoped-pull, approval-write
// and ask archetypes export for their own action ids. "Why?" is never a
// manifest's verb: it comes from a waiting status (Story 17.3: the row's
// button says WHY and sends <module id>:why). "Open" is not a verb.

// The marks. GLYPHS are the ones a status or the bar shows; RESERVED_GLYPHS
// adds the two the deferred statuses will use. The registry refuses a
// module label or group holding any of them (D5), so no manifest can fake a
// status or the Setup group.
const MARK = Object.freeze({
  done: '✓', partly: '◐', waiting: '◌', notStarted: '○', admin: '🔒', filled: '▰', empty: '▱',
});
const GLYPHS = Object.freeze(Object.values(MARK));
const RESERVED_GLYPHS = Object.freeze([...GLYPHS, '⏳', '⚠']);

// D2's table, less the two deferred rows.
const STATUSES = Object.freeze({
  ready: Object.freeze({ glyph: MARK.done, word: 'Ready' }),
  done: Object.freeze({ glyph: MARK.done, word: 'Done' }),
  partly: Object.freeze({ glyph: MARK.partly, word: 'Partly ready' }),
  waiting: Object.freeze({ glyph: MARK.waiting, word: 'Waiting' }),
  'not-started': Object.freeze({ glyph: MARK.notStarted, word: 'Not started' }),
  admin: Object.freeze({ glyph: MARK.admin, word: 'Admin only' }),
});

// The menu's verbs (D10). The manifest's optional "verb" is one of these.
const VERBS = Object.freeze(['Ask', 'Run', 'View', 'Add', 'Review', 'Request']);
// A waiting row's button (D7): never a manifest's verb.
const WHY = 'Why?';
// Each archetype's default verb (D10's table).
const DEFAULT_VERBS = Object.freeze({
  ask: 'Ask',
  'add-context': 'Add',
  'data-sources': 'View',
  'build-request': 'Request',
  'scoped-pull': 'Run',
  'approval-write': 'Run',
  handler: 'Run',
  'routing-map': 'View',
});

// The Setup group's header (D5): admins only.
const SETUP_GROUP = `${MARK.admin} Setup · admins`;
// The name the ungrouped tools sit under (D5).
const UNGROUPED = 'Tools';

const SEP = ' · ';

// A row's line while the menu waits for its summary (D8).
const CHECKING = 'Checking…';

// One line for a status: its glyph, its word and an optional detail.
// Throws for an unknown key or a detail that is not text.
function statusText({ key, detail = null } = {}) {
  if (typeof key !== 'string' || !Object.hasOwn(STATUSES, key)) throw new TypeError(`unknown status key: ${String(key)}`);
  if (detail !== null && detail !== undefined && (typeof detail !== 'string' || !detail.trim())) throw new TypeError('a status detail is text');
  const s = STATUSES[key];
  return `${s.glyph} ${s.word}${detail ? `${SEP}${detail.trim()}` : ''}`;
}

const count = (n, max = Infinity) => Number.isSafeInteger(n) && n >= 0 && n <= max;

// The setup bar (D4): one cell per counted step, done first, then the words.
function setupBar(done, of) {
  if (!count(of) || of < 1 || !count(done, of)) throw new RangeError('setupBar needs 0 <= done <= of, and of >= 1');
  return `${MARK.filled.repeat(done)}${MARK.empty.repeat(of - done)} Setup ${done} of ${of}`;
}

// "✓ N of M tools ready" (D4), once setup is complete or for a member.
function toolsReady(n, m) {
  if (!count(m) || !count(n, m)) throw new RangeError('toolsReady needs 0 <= n <= m');
  return `${MARK.done} ${n} of ${m} tools ready`;
}

// An admin's progress line while setup is not complete (D4): the bar, then
// how many tools are ready, with no tick (the tick means "all set").
function setupProgress(done, of, n, m) {
  if (!count(m) || !count(n, m)) throw new RangeError('setupProgress needs 0 <= n <= m');
  return `${setupBar(done, of)}${SEP}${n} of ${m} tools ready`;
}

// The button's text for a module: its manifest verb, else its archetype's.
function menuVerbOf(mod) {
  if (!mod || typeof mod !== 'object') throw new TypeError('menuVerbOf needs a module');
  if (VERBS.includes(mod.verb)) return mod.verb;
  if (Object.hasOwn(DEFAULT_VERBS, mod.archetype)) return DEFAULT_VERBS[mod.archetype];
  throw new TypeError(`no verb for archetype ${String(mod.archetype)}`);
}

module.exports = {
  statusText, setupBar, toolsReady, setupProgress, menuVerbOf, STATUSES, VERBS, DEFAULT_VERBS, GLYPHS, RESERVED_GLYPHS, SETUP_GROUP, UNGROUPED, SEP, CHECKING, WHY,
};
