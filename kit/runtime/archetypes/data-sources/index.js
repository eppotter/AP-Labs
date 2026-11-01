'use strict';

// Data sources (plan brightside-v0, D9, Story 16.3): a template tool that
// shows what a hub has to work with, in three sections.
//
//   Connected data          the hub runner's source and label, available or
//                           not (describe()); never a table name or row count.
//   Known truths and rules  whether data.md and guardrails.md are signed off,
//                           how many columns are kept out of every query, and
//                           each known truth: id, statement, owner, sign-off
//                           and its last verify result on this machine ("not
//                           checked on this machine" without one). Never a
//                           truth's expect (the client's number) or run.
//   Added context           what admins added on this hub (titles, who, when),
//                           from the hub view's knowledge store (Story 16.4;
//                           entriesOf), else "None yet." Never an entry's text.
//                           On a hub that shares its notes (plan brightside-v1,
//                           D6, Story 19.1) the heading names the other hubs:
//                           "Added context (shared with <hub>)".
//
// A lead line says what the hub can answer from when it has no data:
//   added context, no data   "Answers from the added context below. No data
//                            is connected, so it can't answer questions
//                            about numbers yet."
//   nothing at all           "Nothing yet: no added context and no data
//                            connected."
// On a hub whose sees leaves out data (the v0 hub), "No data is connected"
// becomes "This hub doesn't connect to data" (and the lines drop "yet"), and
// there is no Connected data section. A hub whose sees leaves out rules has
// no Known truths and rules section: it never mentions them. A hub with a
// data source (available or not), or whose data couldn't be checked, gets no
// lead line.
//
// Everything comes from kit/runtime/knowledge/readiness, which reads only
// what the hub sees; this file only words it. Every value from a file or the
// runner is escaped, so a statement or owner can't mention, link or format
// beyond plain text. When something could not be read, the view says so
// plainly and names the admin; the cause stays in no message.
//
// The manifest names no handler, query or parameters (the registry refuses
// them). The hubs (kit/runtime/slack/hubs) render this in the module's pushed
// view, whose Back returns to the menu; who may open it is its resource key.

const { escapeText, escapeName } = require('../../messages');
const { textBlocks } = require('../../slack/format');

const CONTEXT_ONLY = 'Answers from the added context below. No data is connected, so it can\'t answer questions about numbers yet.';
const CONTEXT_ONLY_NO_DATA_HUB = 'Answers from the added context below. This hub doesn\'t connect to data, so it can\'t answer questions about numbers.';
const NOTHING_YET = 'Nothing yet: no added context and no data connected.';
const NOTHING_YET_NO_DATA_HUB = 'Nothing yet: no added context, and this hub doesn\'t connect to data.';
const NO_DATA = 'No data connected yet.';
const NO_DATA_HUB = 'This hub doesn\'t connect to data.';
const NO_TRUTHS = 'No known truths yet.';
const NO_CONTEXT = 'None yet.';
const NOT_CHECKED = 'Not checked on this machine';
const LAST_WORDS = Object.freeze({
  pass: 'Last check passed', fail: 'Last check failed', skip: 'Last check skipped', timeout: 'Last check timed out',
});
// Statements and titles are shown whole up to here, then cut with "…".
const MAX_SHOWN = 300;
const SLACK_USER = /^[UW][A-Z0-9]{2,}$/;

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const shown = (s) => {
  const chars = Array.from(oneLine(s));
  return escapeText(chars.length > MAX_SHOWN ? `${chars.slice(0, MAX_SHOWN - 1).join('')}…` : chars.join(''));
};
const heading = (s) => `*${s}*`;

function dataLines(data) {
  if (!data.seen) return [NO_DATA_HUB];
  if (!data.source && !data.label) return [data.problem ? 'The data could not be checked just now.' : NO_DATA];
  const name = [data.source, data.label].filter(Boolean).map(shown).join(': ');
  return [`• ${name}, ${data.connected ? 'available' : 'not available right now'}`];
}

function fileLine(f) {
  if (!f.present) return `• ${f.file}: missing`;
  if (!f.signed) return `• ${f.file}: awaiting sign-off`;
  return `• ${f.file}: signed off ${shown(f.signedOff)}${f.owner ? ` by ${shown(f.owner)}` : ''}`;
}

function truthLine(t, checkedAt) {
  const head = `• *${escapeName(oneLine(t.id))}*${t.statement ? `: ${shown(t.statement)}` : ''}`;
  if (!t.valid) return `${head}\n   Needs fixing in data.md before it can be used.`;
  const signed = t.signedOff && t.signedOff !== 'pending' ? `Signed off ${shown(t.signedOff)}` : 'Awaiting sign-off';
  const last = LAST_WORDS[t.last] ? `${LAST_WORDS[t.last]}${checkedAt ? ` (${shown(checkedAt.slice(0, 10))})` : ''}` : NOT_CHECKED;
  return `${head}\n   Owner: ${t.owner ? shown(t.owner) : 'none named'}. ${signed}. ${last}.`;
}

function rulesLines(rules, ready) {
  const cols = rules.forbiddenColumns;
  return [
    ...rules.files.map(fileLine),
    `• Columns kept out of every query: ${cols}`,
    '',
    ...(rules.truths.length ? rules.truths.map((t) => truthLine(t, rules.checkedAt)) : [NO_TRUTHS]),
    '',
    ready
      ? 'The rules are set up.'
      : 'The rules are not set up yet: data.md and guardrails.md signed off, and at least one known truth signed off.',
  ];
}

function contextLines(entries) {
  if (!Array.isArray(entries) || !entries.length) return [NO_CONTEXT];
  return entries.map((e) => {
    const who = typeof e.added_by === 'string' && SLACK_USER.test(e.added_by) ? ` by <@${e.added_by}>` : '';
    const when = typeof e.added_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e.added_at) ? ` on ${e.added_at.slice(0, 10)}` : '';
    return `• ${shown(e.title || 'Untitled')}${who}${when}`;
  });
}

// The Added context heading, naming the hubs that share the notes (D6).
function contextHeading(sharedWith) {
  if (!Array.isArray(sharedWith) || !sharedWith.length) return 'Added context';
  return `Added context (shared with ${sharedWith.map((n) => escapeText(oneLine(n))).join(', ')})`;
}

// The hub's added context: { entries, problem }. A hub view with no
// knowledge store has none; a list that fails is none, with problem set
// (logged with the hub only).
async function entriesOf(view, log) {
  const store = view && view.knowledge;
  if (!store || typeof store.list !== 'function') return { entries: [], problem: false };
  try {
    const entries = await store.list();
    return { entries: Array.isArray(entries) ? entries : [], problem: false };
  } catch (err) {
    if (log) log.warn('added context not listed', { hub: view.id || null, reason: (err && err.code) || 'error' });
    return { entries: [], problem: true };
  }
}

// The line above the sections when the hub has no data: null when it has a
// source (available or not) or its data couldn't be checked, or when the
// rules show something and there is no context (nothing to sum up). When
// the added context couldn't be listed, a hub that doesn't connect to data
// still says so, and any other hub gets no lead line.
function leadLine(data, rules, entries, contextProblem) {
  if (data.problem) return null;
  if (contextProblem) return data.seen ? null : NO_DATA_HUB;
  if (data.seen && (data.source || data.label)) return null;
  const hasContext = Array.isArray(entries) && entries.length > 0;
  if (hasContext) return data.seen ? CONTEXT_ONLY : CONTEXT_ONLY_NO_DATA_HUB;
  const hasRules = rules.seen && (rules.problem || rules.files.some((f) => f.present) || rules.truths.length > 0);
  if (hasRules) return null;
  return data.seen ? NOTHING_YET : NOTHING_YET_NO_DATA_HUB;
}

// The view's message: { text, blocks }. ready: readiness() for the hub.
// entries: the hub's added context (entriesOf). contextProblem: the list
// could not be read. admin: who to ask, as Slack mrkdwn (kit/runtime/access
// adminContact).
function render({
  ready, entries = [], contextProblem = false, admin = 'your admin', sharedWith = [],
}) {
  const { data, rules } = ready.detail;
  const sections = [];
  if (data.problem || rules.problem || contextProblem) {
    sections.push(`Some of this couldn't be read just now, so it may show less than is set up. Press Back and try again in a minute, or ask ${admin}.`);
  }
  const lead = leadLine(data, rules, entries, contextProblem);
  if (lead) sections.push(lead);
  if (data.seen) sections.push([heading('Connected data'), ...dataLines(data)].join('\n'));
  if (rules.seen) sections.push([heading('Known truths and rules'), ...rulesLines(rules, ready.rules)].join('\n'));
  sections.push([heading(contextHeading(sharedWith)), ...contextLines(entries)].join('\n'));
  return { text: sections[0], blocks: sections.flatMap(textBlocks) };
}

module.exports = {
  render,
  entriesOf,
  CONTEXT_ONLY,
  CONTEXT_ONLY_NO_DATA_HUB,
  NOTHING_YET,
  NOTHING_YET_NO_DATA_HUB,
  NO_DATA,
  NO_DATA_HUB,
  NO_CONTEXT,
  NOT_CHECKED,
};
