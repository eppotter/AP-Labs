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
//   Added context           what admins added on this hub (titles, who, when):
//                           "None yet." until the knowledge store (Story 16.4)
//                           is handed in.
//
// A hub that sees neither data nor rules (the v0 hub) reads: "No data
// connected yet. No known truths or rules yet." then its added context.
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

const NOTHING_YET = 'No data connected yet. No known truths or rules yet.';
const NO_DATA = 'No data connected yet.';
const NO_RULES = 'No known truths or rules yet.';
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
  if (!data.seen) return [NO_DATA];
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
  if (!rules.seen) return [NO_RULES];
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

// The view's message: { text, blocks }. ready: readiness() for the hub.
// entries: the hub's added context ([] until Story 16.4). admin: who to
// ask, as Slack mrkdwn (kit/runtime/access adminContact).
function render({ ready, entries = [], admin = 'your admin' }) {
  const { data, rules } = ready.detail;
  const sections = [];
  if (data.problem || rules.problem) {
    sections.push(`Some of this couldn't be read just now, so it may show less than is set up. Press Back and try again in a minute, or ask ${admin}.`);
  }
  if (!data.seen && !rules.seen) {
    sections.push(NOTHING_YET);
  } else {
    sections.push([heading('Connected data'), ...dataLines(data)].join('\n'));
    sections.push([heading('Known truths and rules'), ...rulesLines(rules, ready.rules)].join('\n'));
  }
  sections.push([heading('Added context'), ...contextLines(entries)].join('\n'));
  return { text: sections[0], blocks: sections.flatMap(textBlocks) };
}

module.exports = {
  render, NOTHING_YET, NO_DATA, NO_RULES, NO_CONTEXT, NOT_CHECKED,
};
