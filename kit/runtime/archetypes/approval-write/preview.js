'use strict';

// The push preview (Story 10.2, AD-15): what a Push click shows in the
// module's view before anything is sent, and the one approval-write file that
// reads a run record (kit/runtime/slack/provenance). The push itself (10.3,
// ./push) never does: it reads only the approval entry's own copy of the rows
// (./entry). This file also builds the push's reply (pushResultMessage).
//
// The preview names the destination list (its name carries the pull's UTC
// run date), the rows to send, the rows skipped and why (the write's dry-run
// plan says which rows the tool would refuse, for example no email), a
// sample of 5 rows, and Approve and Cancel. A module with write.preview
// (Story 20.2) lists every row that will be sent, with those fields, in
// place of the sample; one with write.hold lists its held rows and their
// reasons (plan brightside-v1 D14: a reminder on a crew-day with an absence),
// which are counted as skipped ("held") and never sent. Everything from data or a
// connector is escaped (kit/runtime/messages escapeText, the scoped-pull
// preview table).

const provenance = require('../../slack/provenance');
const { escapeText, messageFor } = require('../../messages');
const { PushRefused, PreviewInvalid } = require('../../errors');
const { previewText, previewCell, PREVIEW_LIMIT } = require('../scoped-pull/results');

const ACTIONS = Object.freeze({
  push: 'approval-write:push',
  approve: 'approval-write:approve',
  cancel: 'approval-write:cancel',
  retry: 'approval-write:retry',
});
const ACTION_PATTERN = /^approval-write:(push|approve|cancel|retry)$/;
const SAMPLE_ROWS = 5;
// A skip reason comes from the connector's plan: shown cut to this length.
const REASON_MAX = 60;
// {run_date} or {<input>} in a list name.
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;
const RUN_DATE = 'run_date';
// A held row's skip reason in the entry and the push's reply (Story 20.2);
// the preview shows the row's own reason.
const HELD = 'held';
// A hold reason's line is cut to this many characters.
const REASON_LINE = 150;
// A list section stays under Slack's 3,000-character limit, with room for
// its heading and the reason lines.
const LIST_LIMIT = PREVIEW_LIMIT - 600;

const plain = (text) => ({ type: 'plain_text', text: String(text), emoji: false });
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
const button = (actionId, text, value, style) => ({
  type: 'button', action_id: actionId, text: plain(text), value, ...(style ? { style } : {}),
});
const count = (n) => Number(n).toLocaleString('en-US');
const rowsWord = (n) => `${count(n)} ${n === 1 ? 'row' : 'rows'}`;

function verbOf(actionId) {
  const m = typeof actionId === 'string' ? ACTION_PATTERN.exec(actionId) : null;
  return m ? m[1] : null;
}

// The run a Push click names, for the person who ran it: { record } or
// { refusal } (a message). An expired or unknown run says the results
// expired; a malformed id or another person's run gets the generic "no
// longer valid", which says nothing about that run.
function readRun(store, runId, person) {
  if (typeof runId !== 'string' || !provenance.RUN_ID.test(runId)) return { refusal: messageFor(new PreviewInvalid()) };
  const found = provenance.lookup(store, runId, person);
  if (found.status === provenance.STATUS.GONE) return { refusal: messageFor(new PushRefused('expired')) };
  if (found.status !== provenance.STATUS.OK) return { refusal: messageFor(new PreviewInvalid()) };
  return { record: found.record };
}

// The pull's run date: the UTC date of its ranAt (never the data's as_of,
// never the click time).
function runDate(ranAt) {
  const t = Date.parse(ranAt);
  if (Number.isNaN(t)) throw new Error('the run record has no valid time');
  return new Date(t).toISOString().slice(0, 10);
}

// The placeholders a list name uses, in order, once each.
function placeholders(listName) {
  return [...new Set([...String(listName).matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

// The destination list's name for a run: write.list_name with {run_date} and
// each {<input>} filled from the run's confirmed values.
function listNameOf(mod, record) {
  return mod.write.list_name.replace(PLACEHOLDER, (_, name) => (name === RUN_DATE ? runDate(record.ranAt) : String(record.parameters[name])));
}

// "no email (2), refused (1)": the skip reasons with their counts, escaped.
function skipWords(skipped) {
  const by = new Map();
  for (const s of skipped) {
    const raw = s && typeof s.reason === 'string' && s.reason.trim() ? s.reason.trim() : 'refused by the tool';
    const reason = Array.from(raw.replace(/[\r\n\t]+/g, ' ')).slice(0, REASON_MAX).join('');
    by.set(reason, (by.get(reason) || 0) + 1);
  }
  return [...by].map(([reason, n]) => `${escapeText(reason)} (${count(n)})`).join(', ');
}

// The sample table's columns: the score first, when there is one, then the
// push fields in the manifest's order.
function sampleColumns(mod, rows) {
  const fields = mod.write.fields.slice();
  return rows.length && Object.hasOwn(rows[0], 'score') ? ['score', ...fields] : fields;
}

// Whether a row is held (write.hold, Story 20.2): its hold field is a
// non-empty string (the reason). Null, undefined and an empty string are not
// held; any other value holds the row (fail closed), with the reason "held".
function isHeld(mod, row) {
  const field = mod && mod.write ? mod.write.hold : undefined;
  if (!field) return false;
  const v = row[field];
  if (v === null || v === undefined || v === false) return false;
  return typeof v === 'string' ? v.trim() !== '' : true;
}

// A held row's reason: its hold field's text, or HELD.
function holdReason(mod, row) {
  const v = row[mod.write.hold];
  return typeof v === 'string' && v.trim() ? v.trim() : HELD;
}

// An aligned table of every row in a code block, escaped, each cell cut as
// the scoped-pull preview cuts it; rows dropped from the end until it fits a
// section. Returns { text, shown }.
function tableFit(columns, rows) {
  const table = (n) => {
    const lines = [columns, ...rows.slice(0, n).map((r) => columns.map((c) => r[c]))].map((line) => line.map((v) => previewCell(v)));
    const widths = columns.map((_, i) => Math.max(...lines.map((line) => Array.from(line[i]).length)));
    const text = lines.map((line) => line.map((c, i) => c + ' '.repeat(widths[i] - Array.from(c).length)).join('  ').trimEnd()).join('\n');
    return `\`\`\`\n${escapeText(text)}\n\`\`\``;
  };
  let shown = rows.length;
  let text = table(shown);
  while (shown > 1 && text.length > LIST_LIMIT) {
    shown -= 1;
    text = table(shown);
  }
  return { text, shown };
}

// The held rows' section: each reason with its count, then the rows (the
// write.preview fields, else the row id).
function heldSection(mod, held) {
  const by = new Map();
  for (const r of held) {
    const reason = holdReason(mod, r);
    by.set(reason, (by.get(reason) || 0) + 1);
  }
  const reasons = [...by].map(([reason, n]) => `• ${escapeText(previewCell(reason, REASON_LINE))} (${count(n)})`).join('\n');
  const { text, shown } = tableFit(mod.write.preview || [mod.row_id], held);
  const more = shown < held.length ? `\nAnd ${count(held.length - shown)} more, in the CSV in your DM with me.` : '';
  return section(`*Held, not sent: ${count(held.length)}.*\n${reasons}\n${text}${more}`);
}

// The rows that will be sent, every one (write.preview's fields): what the
// person approves is this list.
function sendingSection(mod, sending) {
  const { text, shown } = tableFit(mod.write.preview, sending);
  const head = shown === sending.length ? `*What will be sent (${count(sending.length)}):*` : `*What will be sent: the first ${count(shown)} of ${count(sending.length)}* (all ${count(sending.length)} are in the CSV in your DM with me):`;
  return section(`${head}\n${text}`);
}

// The preview: list name, counts, skips, the held rows, the rows (every row
// to send with write.preview, else a sample), Approve and Cancel. held and
// sending: the held rows and the rows that will be sent (Story 20.2).
function previewMessage({
  mod, listName, rows, skipped, token, held = [], sending = null,
}) {
  const destination = escapeText(mod.write.destination);
  const toSend = rows.length - skipped.length;
  const lines = [
    `*List name:* ${escapeText(listName)}`,
    `*Rows to send:* ${count(toSend)} of ${rowsWord(rows.length)}`,
    `*Skipped:* ${skipped.length ? `${count(skipped.length)}: ${skipWords(skipped)}` : 'none'}`,
  ];
  const blocks = [
    section(`*Push ${escapeText(mod.label)} to ${destination}?* Check it before you approve.`),
    section(lines.join('\n')),
  ];
  if (held.length) blocks.push(heldSection(mod, held));
  if (mod.write.preview && Array.isArray(sending)) {
    blocks.push(sendingSection(mod, sending));
  } else {
    const sample = rows.slice(0, SAMPLE_ROWS);
    blocks.push(section(`*${sample.length === rows.length ? 'The rows' : `A sample of ${count(sample.length)}`}:*\n${previewText(sampleColumns(mod, rows), sample)}`));
  }
  blocks.push(
    context(`Nothing is sent until you press Approve. Skipped${held.length ? ' and held' : ''} rows are never sent. This preview expires in 30 minutes.`),
    { type: 'actions', block_id: 'approval-write', elements: [button(ACTIONS.approve, 'Approve', token, 'primary'), button(ACTIONS.cancel, 'Cancel', token)] },
  );
  return { text: `Push ${mod.label} to ${mod.write.destination}: preview.`, blocks };
}

// Every row would be skipped or is held: nothing to approve, so no token was
// made. The held rows are listed.
function nothingToSendMessage({
  mod, listName, rows, skipped, held = [],
}) {
  const blocks = [section(`*Nothing to push to ${escapeText(mod.write.destination)}.* All ${rowsWord(rows.length)} would be skipped: ${skipWords(skipped)}.`)];
  if (held.length) blocks.push(heldSection(mod, held));
  blocks.push(context(`List name: ${escapeText(listName)}. Nothing was sent.`));
  return { text: `${mod.label}: nothing to push.`, blocks };
}

function cancelledMessage(mod) {
  return {
    text: `${mod.label}: push cancelled.`,
    blocks: [section(`*Push cancelled.* Nothing was sent to ${escapeText(mod.write.destination)}. Run the list again from the menu to start a new one.`)],
  };
}

// A push's reply (Story 10.3): the outcome text (kit/runtime/messages), the
// skip reasons when rows were skipped, and "Retry the failed ones" carrying
// the re-stored entry's token when a retry is safe.
function pushResultMessage({ mod, text, skipped = [], retryToken = null }) {
  const blocks = [section(text)];
  if (skipped.length) blocks.push(context(`Skipped rows were never sent: ${skipWords(skipped.map((reason) => ({ reason })))}.`));
  if (retryToken) {
    blocks.push(context('The retry sends the same list under the same key, so only the ones that failed go. It expires in 30 minutes.'));
    blocks.push({ type: 'actions', block_id: 'approval-write:retry', elements: [button(ACTIONS.retry, 'Retry the failed ones', retryToken, 'primary')] });
  }
  return { text: `${mod.label}: ${text.replace(/\*/g, '')}`.slice(0, 300), blocks };
}

// The result's Push button, beside the "How was this made?" button: it
// carries the run's random id (the run record's), never a guessable one.
function pushButtonBlock(mod, runId) {
  return { type: 'actions', block_id: 'approval-write:push', elements: [button(ACTIONS.push, `Push to ${mod.write.destination}`, runId, 'primary')] };
}

module.exports = {
  readRun, runDate, placeholders, listNameOf, previewMessage, nothingToSendMessage, cancelledMessage, pushResultMessage,
  pushButtonBlock, verbOf, skipWords, isHeld, holdReason, ACTIONS, ACTION_PATTERN, SAMPLE_ROWS, RUN_DATE, HELD,
};
