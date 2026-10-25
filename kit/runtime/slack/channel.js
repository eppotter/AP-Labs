'use strict';

// The one channel post (AD-14, Story 10.3, plan epic-10 N9). Everything else
// the runtime sends goes privately to one person (ephemeral, a view or their
// DM); test/unit/runtime-channel-posts.test.js fails any other send to a
// channel. This file posts only the exceptions declared below, and builds
// each message itself from fixed words, a module id and counts, so nothing a
// caller passes as free text (and no row of client data) can reach a channel.
//
//   await postToChannel({ client, exception: 'write-escalation', channel, fields })
//
// V1 has one exception:
//
//   write-escalation   a push that failed (Story 10.3) to the profile's
//                      slack.ops_channel. fields: { module, reason, counts }:
//                      module is the module's id, reason one of
//                      ESCALATION_REASONS, counts whole numbers named in
//                      COUNT_WORDS. Never a row value, a list name or a
//                      connector's error text.
//
// The channel must be a channel id (C… or G…, the profile schema's pattern),
// never a DM (D…) or a person (U…). Anything else throws before Slack is
// called. Slack refusing the post (for example the bot isn't in the channel:
// chat:write covers only channels it has been invited to) rejects; the caller
// logs it and the person's reply is unaffected.

const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;
const MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/;

// Why a push was escalated: the engine's fixed words, never connector text.
const ESCALATION_REASONS = Object.freeze({
  PartialFailure: 'some contacts failed',
  ConnectorFailed: 'the push failed',
  ConnectorAuthFailed: 'the tool turned down the sign-in',
  IdempotencyConflict: 'the same list key was already used with different rows',
  KillSwitchMidPush: 'sending was switched off partway through',
});

// The counts a message may carry, in the order shown.
const COUNT_WORDS = Object.freeze([
  ['total', 'rows approved'],
  ['sent', 'sent'],
  ['already', 'already there'],
  ['skipped', 'skipped'],
  ['failed', 'failed or not sent'],
]);

class ChannelPostRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChannelPostRefused';
  }
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

function escalationText({ module, reason, counts } = {}) {
  if (typeof module !== 'string' || !MODULE_ID.test(module)) throw new ChannelPostRefused('write-escalation: module must be a module id');
  if (!Object.hasOwn(ESCALATION_REASONS, reason)) throw new ChannelPostRefused('write-escalation: reason is not a declared escalation reason');
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new ChannelPostRefused('write-escalation: counts must be an object');
  const known = new Set(COUNT_WORDS.map(([k]) => k));
  for (const [k, v] of Object.entries(counts)) {
    if (!known.has(k)) throw new ChannelPostRefused(`write-escalation: "${k}" is not a declared count`);
    if (!isCount(v)) throw new ChannelPostRefused(`write-escalation: count "${k}" must be a whole number`);
  }
  const parts = COUNT_WORDS.filter(([k]) => Object.hasOwn(counts, k)).map(([k, word]) => `${counts[k]} ${word}`);
  return `Push needs a look: module ${module}, ${ESCALATION_REASONS[reason]}.`
    + `${parts.length ? ` Counts: ${parts.join(', ')}.` : ''}`
    + ' No client data is in this message; the bot\'s log has the details.';
}

// Exception name → the function that builds its text from its fields.
const EXCEPTIONS = Object.freeze({
  'write-escalation': escalationText,
});

// Posts one declared exception to a channel. Returns Slack's answer.
async function postToChannel({
  client, exception, channel, fields,
} = {}) {
  if (!Object.hasOwn(EXCEPTIONS, exception)) throw new ChannelPostRefused(`"${exception}" is not a declared channel exception`);
  if (typeof channel !== 'string' || !CHANNEL_ID.test(channel)) throw new ChannelPostRefused('a channel post needs a channel id (C… or G…), never a DM or a person');
  const text = EXCEPTIONS[exception](fields);
  if (!client || !client.chat || typeof client.chat.postMessage !== 'function') throw new ChannelPostRefused('no Slack client to post with');
  return client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
}

module.exports = {
  postToChannel, escalationText, EXCEPTIONS, ESCALATION_REASONS, COUNT_WORDS, CHANNEL_ID, ChannelPostRefused,
};
