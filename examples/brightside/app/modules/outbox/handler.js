'use strict';

// The Outbox module: shows the person, privately, what Brightside's mock email
// tool has received, so they can confirm a push landed: the latest lists,
// newest first, each with its contact count and a short sample. It reads the
// outbox file only (no query runner). The sample is email and first name only,
// escaped for Slack: never a phone or an address, whatever the file holds.
// Contacts are client data, so the reply is private (the hub replies
// ephemerally) and the resource is gated in the profile.

const { escapeText } = require('#sdk');
const { outboxPath, readRecords, summarise } = require('../../connectors/email/outbox');

const LISTS = 5;
const SAMPLE = 3;

// "2026-10-24 14:02 UTC", or null.
function when(at) {
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function contactLine({ email, first_name: name }) {
  return `• ${name ? `${escapeText(name)}, ` : ''}${escapeText(email)}`;
}

// file: the outbox to read (tests); the app uses var/outbox/email.jsonl.
// A torn or corrupt line is skipped here (a read-only view); writes refuse it.
module.exports = async function outbox({ reply }, { file = outboxPath() } = {}) {
  const { total, lists } = summarise(readRecords(file, { lenient: true }), { lists: LISTS, sample: SAMPLE });
  if (!total) {
    await reply('*Email outbox*\nNothing has been sent to the email tool yet.');
    return;
  }
  const lines = [
    '*Email outbox*',
    `What the email tool has received, newest first (latest ${lists.length} of ${total} ${total === 1 ? 'list' : 'lists'}):`,
  ];
  for (const l of lists) {
    const at = when(l.at);
    lines.push('', `*${escapeText(l.name)}* · ${l.count} ${l.count === 1 ? 'contact' : 'contacts'}${at ? ` · ${at}` : ''}`);
    lines.push(...l.sample.map(contactLine));
    if (l.count > l.sample.length) lines.push(`…and ${l.count - l.sample.length} more`);
  }
  await reply(lines.join('\n'));
};
