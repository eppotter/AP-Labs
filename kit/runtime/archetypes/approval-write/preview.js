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
// sample of 5 rows, and Approve and Cancel. Everything from data or a
// connector is escaped (kit/runtime/messages escapeText, the scoped-pull
// preview table).

const provenance = require('../../slack/provenance');
const { escapeText, messageFor } = require('../../messages');
const { PushRefused, PreviewInvalid } = require('../../errors');
const { previewText } = require('../scoped-pull/results');

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

// The preview: list name, counts, skips, a sample, Approve and Cancel.
function previewMessage({ mod, listName, rows, skipped, token }) {
  const destination = escapeText(mod.write.destination);
  const sending = rows.length - skipped.length;
  const lines = [
    `*List name:* ${escapeText(listName)}`,
    `*Rows to send:* ${count(sending)} of ${rowsWord(rows.length)}`,
    `*Skipped:* ${skipped.length ? `${count(skipped.length)}: ${skipWords(skipped)}` : 'none'}`,
  ];
  const sample = rows.slice(0, SAMPLE_ROWS);
  return {
    text: `Push ${mod.label} to ${mod.write.destination}: preview.`,
    blocks: [
      section(`*Push ${escapeText(mod.label)} to ${destination}?* Check it before you approve.`),
      section(lines.join('\n')),
      section(`*${sample.length === rows.length ? 'The rows' : `A sample of ${count(sample.length)}`}:*\n${previewText(sampleColumns(mod, rows), sample)}`),
      context(`Nothing is sent until you press Approve. Skipped rows are never sent. This preview expires in 30 minutes.`),
      { type: 'actions', block_id: 'approval-write', elements: [button(ACTIONS.approve, 'Approve', token, 'primary'), button(ACTIONS.cancel, 'Cancel', token)] },
    ],
  };
}

// Every row would be skipped: nothing to approve, so no token was made.
function nothingToSendMessage({ mod, listName, rows, skipped }) {
  return {
    text: `${mod.label}: nothing to push.`,
    blocks: [
      section(`*Nothing to push to ${escapeText(mod.write.destination)}.* All ${rowsWord(rows.length)} would be skipped: ${skipWords(skipped)}.`),
      context(`List name: ${escapeText(listName)}. Nothing was sent.`),
    ],
  };
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
  pushButtonBlock, verbOf, skipWords, ACTIONS, ACTION_PATTERN, SAMPLE_ROWS, RUN_DATE,
};
