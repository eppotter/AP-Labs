'use strict';

// Sends a scoped pull's CSV to the person's DM with the bot, and nowhere else
// (Story 9.5). conversations.open with the person's Slack id (im:write)
// returns their DM, then files.uploadV2 (files:write) shares the file to that
// channel only. A channel id that is not a DM (D…) is refused before the
// upload, so the file can never land in a channel. The upload's message is
// the comment given (already Slack text, escaped by its builder).
//
// Returns { channel, permalink }: permalink is the file's link when Slack's
// answer carries one, else null (the view then names the DM instead). Throws
// on any failure; the runner tells the person the file did not arrive.

const DM_ID = /^D[A-Z0-9]+$/;

class DeliveryError extends Error {
  constructor(reason) {
    super(`CSV not delivered: ${reason}`);
    this.name = 'DeliveryError';
    this.reason = reason;
  }
}

// The first file permalink in a files.uploadV2 answer. The Slack client wraps
// each completed upload: { files: [{ files: [{ id, permalink }] }] }.
function permalinkOf(res) {
  const outer = res && Array.isArray(res.files) ? res.files : [];
  for (const entry of outer) {
    const inner = entry && Array.isArray(entry.files) ? entry.files : [entry];
    for (const f of inner) {
      if (f && typeof f.permalink === 'string' && /^https:\/\/[^\s<>|]+$/.test(f.permalink)) return f.permalink;
    }
  }
  return null;
}

async function deliverCsv({ client, person, filename, title, content, comment }) {
  if (!client || !client.conversations || typeof client.conversations.open !== 'function'
    || !client.files || typeof client.files.uploadV2 !== 'function') {
    throw new DeliveryError('no Slack files client');
  }
  if (typeof person !== 'string' || !person) throw new DeliveryError('no person to send it to');
  const opened = await client.conversations.open({ users: person });
  const channel = opened && opened.channel && opened.channel.id;
  if (typeof channel !== 'string' || !DM_ID.test(channel)) throw new DeliveryError('conversations.open did not return a DM');
  const res = await client.files.uploadV2({
    channel_id: channel, filename, title, content, initial_comment: comment,
  });
  return { channel, permalink: permalinkOf(res) };
}

module.exports = { deliverCsv, permalinkOf, DeliveryError, DM_ID };
