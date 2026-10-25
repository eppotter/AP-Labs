'use strict';

// The one place that turns a typed refusal into words (AD-17). Each message is
// plain and names a next step. Handlers never build refusal text themselves.
// Returns Slack mrkdwn text, or null for an error that is not a refusal (the
// caller then uses the generic plain error). context.admin, when the caller
// knows it, is who to tell in a connector message; else "your admin".

const {
  NotSetUp, AccessDenied, ConfigFault, DataUnavailable, LlmUnavailable, KillSwitchOn,
  ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict, PartialFailure,
} = require('./errors');
const {
  SessionExpired, SessionNotYours, AlreadyConfirmed, QueryBlocked, QueryFailed, CsvNotDelivered,
} = require('./errors');
const { ProvenanceGone, ProvenanceNotYours } = require('./errors');

// Slack mrkdwn treats &, < and > as control characters.
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sentWords = ({ items }) => `${items} ${items === 1 ? 'item was' : 'items were'} sent`;
// When what went could not be recorded (sent.recorded false), a retry may send
// it again, so the next step is always a check first, never a retry (#89).
const checkFirst = (admin, { start = true } = {}) => `${start ? admin.charAt(0).toUpperCase() + admin.slice(1) : admin} should check what arrived before anyone tries again.`;

// The AI service's refusals (Story 9.1). Each points to the typed form, which
// always works; the module shows it alongside.
const LLM_WORDS = Object.freeze({
  off: () => "The AI helper is switched off right now, so I can't read your request. Please use the form instead.",
  no_key: () => "The AI helper isn't available here, so I can't read your request. Please use the form instead.",
  config: (admin) => `The AI helper isn't set up correctly, so I can't read your request. I've logged the problem; please tell ${admin}. You can use the form instead.`,
  too_long: (admin, { maxChars = 500 }) => `That request is too long for me to read (${maxChars} characters at most). Please shorten it, or use the form instead.`,
  rate_limited: (admin, { perHour = 20 }) => `You've reached the limit of ${perHour} AI requests an hour. Please use the form instead, or try again later.`,
  over_budget: () => 'The AI helper has reached its spending limit for this hour. Please use the form instead, or try again later.',
  failed: () => "I couldn't read your request just now. Please use the form instead, or try again in a moment.",
});

const MESSAGES = [
  [NotSetUp, ({ client, admin }) => `You're not set up in ${escapeText(client)}'s bot yet, so you only see what's open to everyone. Ask ${admin} to add you.`],
  [AccessDenied, ({ label, admin }) => `You don't have access to ${escapeText(label)}; ask ${admin}.`],
  [ConfigFault, ({ admin }) => `That option isn't set up correctly, so I can't open it right now. I've logged the problem; please tell ${admin}.`],
  [DataUnavailable, () => "The data isn't available right now, so I can't answer that. The app is still running; please tell your admin."],
  [LlmUnavailable, (details, { admin }) => LLM_WORDS[details.reason](admin, details)],
  // A write stopped partway (details.sent: { batches, items, recorded }) says what
  // already went, never "nothing was sent" (#89).
  [KillSwitchOn, ({ system, sent }, { admin }) => (sent
    ? `Sending to ${escapeText(system)} was switched off partway through: ${sentWords(sent)} before it stopped, and the rest weren't. `
      + (sent.recorded === false ? `I couldn't record that, so please tell ${admin}. ${checkFirst(admin)}` : `Please tell ${admin}.`)
    : `Sending to ${escapeText(system)} is switched off right now, so nothing was sent. Please tell your admin.`)],
  // Subclasses of ConnectorFailed come first: the first match wins.
  // A missing credential is a setup fault, worded like ConfigFault; a rejected
  // one says so. Neither reads as a passing outage (AD-17).
  [ConnectorAuthFailed, ({ system, setup, sent }, { admin }) => (sent
    ? `${escapeText(system)} turned down my sign-in partway through: ${sentWords(sent)} before it stopped, and the rest weren't. Please tell ${admin}; trying again won't help until it's fixed.`
      + (sent.recorded === false ? ` I couldn't record what went, so ${checkFirst(admin, { start: false })}` : '')
    : setup
      ? `${escapeText(system)} isn't set up correctly, so I can't reach it. I've logged the problem; please tell ${admin}.`
      : `${escapeText(system)} turned down my sign-in, so I couldn't reach it. Please tell ${admin}; trying again won't help until it's fixed.`)],
  [IdempotencyConflict, ({ system }, { admin }) => `That was already sent to ${escapeText(system)} with different contents, so I didn't send it again. Please tell ${admin}.`],
  // Counts only: the failed refs go to the log, never to the person. A retry
  // is called safe only when the write declares per-item idempotency
  // (details.retrySafe); otherwise the engine can't promise it, so it doesn't.
  [PartialFailure, ({ system, succeeded, failed, retrySafe }, { admin }) => `Sent ${succeeded} of ${succeeded + failed} to ${escapeText(system)}; ${failed} failed. `
    + (retrySafe === true
      ? `Nothing was sent twice, so trying again is safe: it sends only the ${failed} that failed. If they keep failing, please tell ${admin}.`
      : `Please tell ${admin} before trying again.`)],
  [ConnectorFailed, ({ system, sent }, { admin }) => (sent
    ? `I couldn't finish sending to ${escapeText(system)}: ${sentWords(sent)} before it stopped, and the rest weren't. `
      + (sent.recorded === false ? `I couldn't record that, so please tell ${admin}. ${checkFirst(admin)}` : `Please tell ${admin} before trying again.`)
    : `I couldn't reach ${escapeText(system)} just now. Please try again later, or tell ${admin} if it keeps happening.`)],
  // Scoped-pull form sessions (Story 9.3).
  [SessionExpired, () => 'This form has expired (forms close after 30 minutes without use). Go back to the menu and open it again.'],
  [SessionNotYours, () => "This form belongs to someone else, so I can't act on it. Open your own from the menu."],
  [AlreadyConfirmed, ({ done, failed }) => {
    if (!done) return 'You already confirmed this request and it\'s still running, so I won\'t run it twice.';
    if (failed) return 'You already confirmed this request and it didn\'t finish, so I won\'t run it again from here. Open it again from the menu to try again.';
    return 'You already confirmed this request, so it ran once and I won\'t run it again. Open it again from the menu for a new one.';
  }],
  // Scoped-pull runs (Story 9.5). Each says nothing partial was passed off.
  [QueryBlocked, (details, { admin }) => `The safety check refused this list's query, so nothing ran and there are no results. I've logged the problem; please tell ${admin}.`],
  [QueryFailed, (details, { admin }) => `This list's query failed, so there are no results (nothing partial was kept). I've logged the problem; please tell ${admin} if it keeps happening.`],
  [CsvNotDelivered, (details, { admin }) => `*The CSV didn't arrive.* I couldn't send the file to your DM, so you have only the first rows shown here, not the whole list. Open it again from the menu to try again, or tell ${admin} if it keeps happening.`],
  // "How was this made?" (Story 9.6). Neither says anything about the run.
  [ProvenanceGone, () => "The details of this run are no longer available (they're kept for 24 hours). Run the list again from the menu to see how a new one is made."],
  [ProvenanceNotYours, () => "These details belong to someone else's run, so I can't show them. Run the list yourself from the menu to see how yours is made."],
];

// Hub wording (Story 6.4). A hub file may set its own welcome and feedback
// lines; these defaults keep a hub without them working.
function welcomeText(hub) {
  if (hub.welcome) return escapeText(hub.welcome);
  return `Welcome to ${escapeText(hub.name)}. Each option below opens one tool. `
    + 'Press Help at the bottom any time to see what you can use here and how to give feedback.';
}

function feedbackText(hub, admin) {
  if (hub.feedback) return escapeText(hub.feedback);
  return `To give feedback or ask for something new, tell ${admin}.`;
}

// The private welcome for a person who just joined the workspace. hubs: the
// hubs with at least one entry they can use; notice: the not-set-up line, if
// they have no profile user yet.
function joinWelcomeText({ client, hubs, notice, admin }) {
  const lines = [`Welcome to ${escapeText(client)}! I'm the ${escapeText(client)} bot.`];
  if (hubs.length) {
    const list = hubs.map((h) => `\`${h.command}\` (${escapeText(h.name)})`).join(', ');
    lines.push(`You can use ${list}. Type a command to see its menu, and press Help there for more.`);
  } else if (!notice) {
    lines.push(`There's nothing here for you to use yet; ask ${admin} if you need something.`);
  }
  if (notice) lines.push(notice);
  return lines.join('\n');
}

function messageFor(err, { admin = 'your admin' } = {}) {
  for (const [Kind, words] of MESSAGES) {
    if (err instanceof Kind) return words(err.details, { admin });
  }
  return null;
}

module.exports = { messageFor, escapeText, welcomeText, feedbackText, joinWelcomeText };
