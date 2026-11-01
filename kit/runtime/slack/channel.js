'use strict';

// The one channel post (AD-14, Story 10.3, plan epic-10 N9). Everything else
// the runtime sends goes privately to one person (ephemeral, a view or their
// DM); test/unit/runtime-channel-posts.test.js fails any other send to a
// channel. This file posts only the exceptions declared below, and builds
// each message itself from its fields, so no caller hands it the text.
//
//   await postToChannel({ client, exception: 'write-escalation', channel, fields })
//
// Two exceptions:
//
//   write-escalation   a push that failed (Story 10.3) to the profile's
//                      slack.ops_channel. fields: { module, reason, counts }:
//                      module is the module's id, reason one of
//                      ESCALATION_REASONS, counts whole numbers named in
//                      COUNT_WORDS. Never a row value, a list name or a
//                      connector's error text: fixed words only.
//
//   build-request      a person's build request (plan brightside-v0, D11,
//                      Story 16.6; the AD-14 amendment) to the profile's
//                      slack.build_requests_channel, whose audience is the
//                      AP Labs build team and the client's admins. The one
//                      exception that carries free text: the person's own
//                      words and the AI's title and summary of them, both
//                      shown to the person first (the preview is this same
//                      text, buildRequestText). fields: { hub: { name, sees },
//                      requester, title, summary, need, summarised, at }.
//                      Any hub may post, including one that sees context or
//                      data (plan brightside-v1, D12, gate item 2): the
//                      summary call sends no business context (withContext:
//                      false, which the build-request archetype asserts at
//                      call time), so the summary can only restate the
//                      person's own previewed words. Until then a hub that
//                      saw context or data was refused. A hub whose sees is
//                      not a list of known values is still refused
//                      (mayPostBuildRequest, fail closed). Every free
//                      field is untrusted: escaped (&, < and >, so <!here>,
//                      <!channel>, <@U…> and <url|text> show as plain text),
//                      with a bare @here, @channel or @everyone broken by a
//                      zero-width joiner. The only mention is the requester,
//                      built as <@U…> from the verified Slack id, never from
//                      text. No data row ever (the tool reads no data).
//
// The channel must be a channel id (C… or G…, the profile schema's pattern),
// never a DM (D…) or a person (U…). Anything else throws before Slack is
// called. Slack refusing the post (for example the bot isn't in the channel:
// chat:write covers only channels it has been invited to) rejects; the caller
// logs it and the person's reply is unaffected.

const { escapeText, escapeName } = require('../messages');
const { HUB_SEES } = require('../sees');

const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;
const MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SLACK_USER = /^[UW][A-Z0-9]{2,}$/;

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

// Build requests (D11): the limits the archetype enforces, checked again here.
const BUILD_REQUEST_LIMITS = Object.freeze({
  need: 500, title: 80, summary: 600, hubName: 80,
});
const ZWJ = '\u200D';

// True when a hub with this sees list may post a build request: any list of
// known values (kit/runtime/sees), whatever the hub sees (plan brightside-v1,
// D12, gate item 2). Anything else (no list, an unknown value) is refused.
function mayPostBuildRequest(sees) {
  return Array.isArray(sees) && sees.every((s) => HUB_SEES.includes(s));
}

// Untrusted text as plain mrkdwn: &, < and > escaped, and a bare @here,
// @channel or @everyone broken with a zero-width joiner.
function untrusted(s) {
  return escapeText(s).replace(/@(here|channel|everyone)/gi, `@${ZWJ}$1`);
}
// The same inside bold: formatting marks swapped for look-alikes too.
function untrustedName(s) {
  return escapeName(s).replace(/@(here|channel|everyone)/gi, `@${ZWJ}$1`);
}
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const quoted = (s) => String(s).split('\n').map((line) => `> ${line}`).join('\n');

function freeText(field, value, max, { single = false } = {}) {
  if (typeof value !== 'string') throw new ChannelPostRefused(`build-request: ${field} must be text`);
  const text = single ? oneLine(value) : value.trim();
  if (!text) throw new ChannelPostRefused(`build-request: ${field} is empty`);
  if (Array.from(text).length > max) throw new ChannelPostRefused(`build-request: ${field} is over ${max} characters`);
  return text;
}

// "2026-10-30 14:05 UTC", shown to whoever's client can't render Slack's date.
function utcWords(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// The build request's message, the same text the preview shows.
function buildRequestText({
  hub, requester, title, summary, need, summarised, at,
} = {}) {
  if (!hub || typeof hub !== 'object') throw new ChannelPostRefused('build-request: hub must be the hub');
  if (!mayPostBuildRequest(hub.sees)) throw new ChannelPostRefused('build-request: the hub\'s sees must be a list of known values');
  const hubName = freeText('hub name', hub.name, BUILD_REQUEST_LIMITS.hubName, { single: true });
  if (typeof requester !== 'string' || !SLACK_USER.test(requester)) throw new ChannelPostRefused('build-request: requester must be a Slack user id');
  if (typeof summarised !== 'boolean') throw new ChannelPostRefused('build-request: summarised must be true or false');
  if (!Number.isSafeInteger(at) || at < 0) throw new ChannelPostRefused('build-request: at must be a time in ms');
  const words = freeText('need', need, BUILD_REQUEST_LIMITS.need);
  const head = freeText('title', title, BUILD_REQUEST_LIMITS.title, { single: true });
  const body = summarised ? freeText('summary', summary, BUILD_REQUEST_LIMITS.summary) : null;
  const seconds = Math.floor(at / 1000);
  const lines = [
    `*New build request:* ${untrustedName(head)}`,
    `From <@${requester}> on the ${untrustedName(hubName)} hub, <!date^${seconds}^{date_short_pretty} at {time}|${utcWords(at)}>`,
    '',
  ];
  if (summarised) lines.push(untrusted(body), '', '_In their words:_', quoted(untrusted(words)));
  else lines.push('_Not summarised: their own words._', quoted(untrusted(words)));
  return lines.join('\n');
}

// Exception name → the function that builds its text from its fields.
const EXCEPTIONS = Object.freeze({
  'write-escalation': escalationText,
  'build-request': buildRequestText,
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
  postToChannel, escalationText, buildRequestText, mayPostBuildRequest, untrusted, EXCEPTIONS, ESCALATION_REASONS, COUNT_WORDS, CHANNEL_ID,
  BUILD_REQUEST_LIMITS, ChannelPostRefused,
};
