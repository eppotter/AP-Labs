'use strict';

// The one place that turns a typed refusal into words (AD-17). Each message is
// plain and names a next step. Handlers never build refusal text themselves.
// Returns Slack mrkdwn text, or null for an error that is not a refusal (the
// caller then uses the generic plain error). context.admin, when the caller
// knows it, is who to tell in a connector message; else "your admin".

const {
  NotSetUp, AccessDenied, ConfigFault, DataUnavailable, KillSwitchOn,
  ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict, PartialFailure,
} = require('./errors');
const { SessionExpired, SessionNotYours, AlreadyConfirmed } = require('./errors');

// Slack mrkdwn treats &, < and > as control characters.
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sentWords = ({ items }) => `${items} ${items === 1 ? 'item was' : 'items were'} sent`;
// When what went could not be recorded (sent.recorded false), a retry may send
// it again, so the next step is always a check first, never a retry (#89).
const checkFirst = (admin, { start = true } = {}) => `${start ? admin.charAt(0).toUpperCase() + admin.slice(1) : admin} should check what arrived before anyone tries again.`;

const MESSAGES = [
  [NotSetUp, ({ client, admin }) => `You're not set up in ${escapeText(client)}'s bot yet, so you only see what's open to everyone. Ask ${admin} to add you.`],
  [AccessDenied, ({ label, admin }) => `You don't have access to ${escapeText(label)}; ask ${admin}.`],
  [ConfigFault, ({ admin }) => `That option isn't set up correctly, so I can't open it right now. I've logged the problem; please tell ${admin}.`],
  [DataUnavailable, () => "The data isn't available right now, so I can't answer that. The app is still running; please tell your admin."],
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
  [AlreadyConfirmed, ({ done }) => (done
    ? 'You already confirmed this request, so it ran once and I won\'t run it again. Open it again from the menu for a new one.'
    : 'You already confirmed this request and it\'s still running, so I won\'t run it twice.')],
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
