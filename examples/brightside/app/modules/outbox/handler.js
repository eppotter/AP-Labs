'use strict';

// The Outbox module: shows the person, privately, what Brightside's mock email
// tool has received, so they can confirm a push landed: the latest lists,
// newest first, each with its contact count and a short sample, and (Story
// 20.3, plan brightside-v1 D14) the latest appointment emails sent, newest
// first: when, which kind (a reminder or a change notice), the address and
// the subject, never the body. It reads the outbox file only (no query
// runner). The sample is email and first name only, escaped for Slack: never
// a phone or an address, whatever the file holds. Contacts are client data,
// so the reply is private (the hub replies ephemerally) and the resource is
// gated in the profile.

const { escapeText } = require('#sdk');
const {
  outboxPath, readRecords, summarise, latestEmails,
} = require('../../connectors/email/outbox');

const LISTS = 5;
const SAMPLE = 3;
const EMAILS = 10;
const KINDS = Object.freeze({ reminder: 'reminder', change: 'change notice' });

// "2026-10-24 14:02 UTC", or null.
function when(at) {
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function contactLine({ email, first_name: name }) {
  return `• ${name ? `${escapeText(name)}, ` : ''}${escapeText(email)}`;
}

// One email: "• 2026-11-01 15:00 UTC · change notice · ana@home.invalid · <subject>".
function emailLine(e) {
  const parts = [when(e.at), KINDS[e.kind] || 'email', typeof e.to === 'string' ? escapeText(e.to) : null, typeof e.subject === 'string' ? escapeText(e.subject) : null];
  return `• ${parts.filter(Boolean).join(' · ')}`;
}

// file: the outbox to read (tests); the app uses var/outbox/email.jsonl.
// A torn or corrupt line is skipped here (a read-only view); writes refuse it.
module.exports = async function outbox({ reply }, { file = outboxPath() } = {}) {
  const records = readRecords(file, { lenient: true });
  const { total, lists } = summarise(records, { lists: LISTS, sample: SAMPLE });
  const sent = latestEmails(records, { limit: EMAILS });
  if (!total && !sent.total) {
    await reply('*Email outbox*\nNothing has been sent to the email tool yet.');
    return;
  }
  const lines = ['*Email outbox*'];
  if (total) {
    lines.push(`What the email tool has received, newest first (latest ${lists.length} of ${total} ${total === 1 ? 'list' : 'lists'}):`);
    for (const l of lists) {
      const at = when(l.at);
      lines.push('', `*${escapeText(l.name)}* · ${l.count} ${l.count === 1 ? 'contact' : 'contacts'}${at ? ` · ${at}` : ''}`);
      lines.push(...l.sample.map(contactLine));
      if (l.count > l.sample.length) lines.push(`…and ${l.count - l.sample.length} more`);
    }
  }
  if (sent.total) {
    if (total) lines.push('');
    lines.push(`*Appointment emails sent*, newest first (latest ${sent.emails.length} of ${sent.total}):`);
    lines.push(...sent.emails.map(emailLine));
  }
  await reply(lines.join('\n'));
};
