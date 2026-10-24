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

// Slack mrkdwn treats &, < and > as control characters.
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MESSAGES = [
  [NotSetUp, ({ client, admin }) => `You're not set up in ${escapeText(client)}'s bot yet, so you only see what's open to everyone. Ask ${admin} to add you.`],
  [AccessDenied, ({ label, admin }) => `You don't have access to ${escapeText(label)}; ask ${admin}.`],
  [ConfigFault, ({ admin }) => `That option isn't set up correctly, so I can't open it right now. I've logged the problem; please tell ${admin}.`],
  [DataUnavailable, () => "The data isn't available right now, so I can't answer that. The app is still running; please tell your admin."],
  [KillSwitchOn, ({ system }) => `Sending to ${escapeText(system)} is switched off right now, so nothing was sent. Please tell your admin.`],
  // Subclasses of ConnectorFailed come first: the first match wins.
  // A missing credential is a setup fault, worded like ConfigFault; a rejected
  // one says so. Neither reads as a passing outage (AD-17).
  [ConnectorAuthFailed, ({ system, setup }, { admin }) => (setup
    ? `${escapeText(system)} isn't set up correctly, so I can't reach it. I've logged the problem; please tell ${admin}.`
    : `${escapeText(system)} turned down my sign-in, so I couldn't reach it. Please tell ${admin}; trying again won't help until it's fixed.`)],
  [IdempotencyConflict, ({ system }, { admin }) => `That was already sent to ${escapeText(system)} with different contents, so I didn't send it again. Please tell ${admin}.`],
  // Counts only: the failed refs go to the log, never to the person.
  [PartialFailure, ({ system, succeeded, failed }, { admin }) => `Sent ${succeeded} of ${succeeded + failed} to ${escapeText(system)}; ${failed} failed. `
    + `Nothing was sent twice, so trying again is safe: it sends only the ${failed} that failed. If they keep failing, please tell ${admin}.`],
  [ConnectorFailed, ({ system }, { admin }) => `I couldn't reach ${escapeText(system)} just now. Please try again later, or tell ${admin} if it keeps happening.`],
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
