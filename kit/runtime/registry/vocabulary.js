'use strict';

// The hub menu's vocabulary (plan hub-status-menu, D2 and D10, Story 17.1,
// and the 2026-10-31 decision "subtle health"): every status mark, status
// word, verb and strip line, in one place. Nothing else in the engine writes
// a menu mark (a test checks), so a mark that fails on a phone is a one-line
// swap here.
//
//   statusText({ key, detail })  ->  null (healthy: no line), "2 notes" (a
//                                    fact, no dot) or "🟡 no data yet" (a
//                                    tool that needs attention)
//   statusParts({ key, detail }) ->  the same, split: null, or { dot, words }
//                                    (dot null for a fact), for the menu's
//                                    inline status (it italicises the words)
//   needsAttention({ key })      ->  true for partly, waiting and not-started
//   setupProgress(d, o, n, m)    ->  "Setup 0 of 1 · 1 of 2 tools working"
//   toolsWorking(n, m, counts)   ->  "All 2 tools working", or
//                                    "1 of 3 tools working · 1 limited · 1 needs setup"
//   menuVerbOf(mod)              ->  "Ask" | "Run" | "View" | "Add" | "Review" | "Request"
//   SETUP_GROUP                  ->  "Setup · admins only"
//   CHECKING                     ->  "checking…"
//   WHY                          ->  "Why?" (a waiting row's button, Story 17.3)
//
// Subtle health: a healthy tool (ready, or a complete setup step) shows no
// status line at all. A setup row with a useful fact and no problem shows
// the fact with no dot ("2 notes"). A tool that needs attention shows a
// coloured dot and a few lower-case words, never a colour alone: 🟡 for a
// tool that works with limits, ⚪ for one that is waiting or not started.
// 🔴 is reserved for a failure (DEP-038's "data late"), unused for now. The
// menu shows the status inline in the row's section, after the label and a
// middle dot, with the words in italics ("*Ask* · 🟡 _no data yet_"): on a
// phone the button sits under the section text, so a line below it would
// read as the next row's (2026-10-31 live check).
// The strip has no dots.
//
// An unknown status key throws (the menu's guard catches it and shows the
// row with its verb only, D1).
//
// CHECKING (Story 17.2, D8) is not a status: it is the words every row shows
// while the menu's notes are still being read (the menu opened before its
// summary), so it has no dot and no key. statusText still refuses
// "checking", so no tool can claim it.
//
// Two statuses are deferred until the code has a source for them, so no
// screen can show a status the code can't back: "requested" (nothing
// records a request, DEP-039) and "data late" (no cheap data date,
// DEP-038). They are not in STATUSES.
//
// menuVerbOf is the button's text only: the button still sends
// <module id>:open. It is not verbOf, which the scoped-pull, approval-write
// and ask archetypes export for their own action ids. "Why?" is never a
// manifest's verb: it comes from a waiting status (Story 17.3: the row's
// button says WHY and sends <module id>:why). "Open" is not a verb.

// The dots. GLYPHS are the marks a status line shows or may show (🟢 is
// reserved, unused: a label holding it would pass for a healthy status), and
// SHORTCODES their Slack names, which Slack draws as the same dots in a
// label's mrkdwn. RESERVED_GLYPHS adds the marks the menu showed before
// subtle health, so a label still can't read as a status. The registry
// refuses a module label or group holding any of them (D5), so no manifest
// can fake a status or the Setup group.
const DOT = Object.freeze({
  working: '🟢', limited: '🟡', waiting: '⚪', failing: '🔴',
});
const GLYPHS = Object.freeze(Object.values(DOT));
const SHORTCODES = Object.freeze([':large_green_circle:', ':large_yellow_circle:', ':white_circle:', ':red_circle:']);
const OLD_MARKS = Object.freeze(['✓', '◐', '◌', '○', '🔒', '▰', '▱', '⏳', '⚠']);
const RESERVED_GLYPHS = Object.freeze([...GLYPHS, ...SHORTCODES, ...OLD_MARKS]);

// D2's table, worded the subtle-health way. kind:
//   healthy    no line; a detail, when there is one, as a plain fact
//   fact       the words, then the detail, with no dot
//   attention  a dot, then the detail (else the words); "fixed": the words only
const STATUSES = Object.freeze({
  ready: Object.freeze({ kind: 'healthy' }),
  // A setup tool whose step is complete: "2 notes", "no data on this hub".
  done: Object.freeze({ kind: 'healthy' }),
  // Data sources on a hub that doesn't connect to data but has notes.
  'context-only': Object.freeze({ kind: 'fact', words: 'notes only' }),
  partly: Object.freeze({ kind: 'attention', dot: DOT.limited, words: 'partly ready' }),
  waiting: Object.freeze({ kind: 'attention', dot: DOT.waiting, words: 'waiting' }),
  'not-started': Object.freeze({
    kind: 'attention', dot: DOT.waiting, words: 'not started', fixed: true,
  }),
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
const SETUP_GROUP = 'Setup · admins only';
// The name the ungrouped tools sit under (D5).
const UNGROUPED = 'Tools';

const SEP = ' · ';

// A row's words while the menu waits for its summary (D8): lower case, as
// they follow the label inline ("*Ask* · _checking…_").
const CHECKING = 'checking…';

function statusOf(status) {
  const { key, detail = null } = status || {};
  if (typeof key !== 'string' || !Object.hasOwn(STATUSES, key)) throw new TypeError(`unknown status key: ${String(key)}`);
  if (detail !== null && detail !== undefined && (typeof detail !== 'string' || !detail.trim())) throw new TypeError('a status detail is text');
  return { s: STATUSES[key], detail: detail ? detail.trim() : null };
}

// A status's dot (null for a fact) and words, or null when the tool is
// healthy with nothing to say. Throws for an unknown key or a detail that
// is not text.
function statusParts(status) {
  const { s, detail } = statusOf(status);
  if (s.kind === 'healthy') return detail ? { dot: null, words: detail } : null;
  if (s.kind === 'fact') return { dot: null, words: detail ? `${s.words}${SEP}${detail}` : s.words };
  return { dot: s.dot, words: s.fixed || !detail ? s.words : detail };
}

// A status's line, or null when the tool is healthy with nothing to say.
// Throws as statusParts does.
function statusText(status) {
  const parts = statusParts(status);
  if (!parts) return null;
  return parts.dot ? `${parts.dot} ${parts.words}` : parts.words;
}

// True when the status's line starts with a dot. Throws as statusText does.
function needsAttention(status) {
  return statusOf(status).s.kind === 'attention';
}

const count = (n, max = Infinity) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const tools = (m) => (m === 1 ? 'tool' : 'tools');

// "N of M tools working" (D4), once setup is complete or for a member. With
// every tool working: "All M tools working" ("1 tool working" for one).
// Otherwise the ones that aren't, by kind: limited (works with limits) and
// needs setup (waiting or not started). A hub with no tools: "No tools yet".
function toolsWorking(n, m, { limited = 0, needSetup = 0 } = {}) {
  if (!count(m) || !count(n, m) || !count(limited, m) || !count(needSetup, m) || n + limited + needSetup > m) {
    throw new RangeError('toolsWorking needs 0 <= n, and n + limited + needSetup <= m');
  }
  if (m === 0) return 'No tools yet';
  if (n === m) return m === 1 ? '1 tool working' : `All ${m} tools working`;
  const parts = [`${n} of ${m} ${tools(m)} working`];
  if (limited) parts.push(`${limited} limited`);
  if (needSetup) parts.push(`${needSetup} ${needSetup === 1 ? 'needs' : 'need'} setup`);
  return parts.join(SEP);
}

// An admin's progress line while setup is not complete (D4): the setup
// count, then how many tools are working (left off on a hub with no tools).
function setupProgress(done, of, n, m) {
  if (!count(of) || of < 1 || !count(done, of)) throw new RangeError('setupProgress needs 0 <= done <= of, and of >= 1');
  if (!count(m) || !count(n, m)) throw new RangeError('setupProgress needs 0 <= n <= m');
  const setup = `Setup ${done} of ${of}`;
  return m ? `${setup}${SEP}${n} of ${m} ${tools(m)} working` : setup;
}

// The button's text for a module: its manifest verb, else its archetype's.
function menuVerbOf(mod) {
  if (!mod || typeof mod !== 'object') throw new TypeError('menuVerbOf needs a module');
  if (VERBS.includes(mod.verb)) return mod.verb;
  if (Object.hasOwn(DEFAULT_VERBS, mod.archetype)) return DEFAULT_VERBS[mod.archetype];
  throw new TypeError(`no verb for archetype ${String(mod.archetype)}`);
}

module.exports = {
  statusText,
  statusParts,
  needsAttention,
  toolsWorking,
  setupProgress,
  menuVerbOf,
  STATUSES,
  VERBS,
  DEFAULT_VERBS,
  DOT,
  GLYPHS,
  SHORTCODES,
  OLD_MARKS,
  RESERVED_GLYPHS,
  SETUP_GROUP,
  UNGROUPED,
  SEP,
  CHECKING,
  WHY,
};
