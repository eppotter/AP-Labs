'use strict';

// The one place that turns a typed refusal into words (AD-17). Each message is
// plain and names a next step. Handlers never build refusal text themselves.
// Returns Slack mrkdwn text, or null for an error that is not a refusal (the
// caller then uses the generic plain error).

const { NotSetUp, AccessDenied, ConfigFault } = require('./errors');

// Slack mrkdwn treats &, < and > as control characters.
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MESSAGES = [
  [NotSetUp, ({ client, admin }) => `You're not set up in ${escapeText(client)}'s bot yet, so you only see what's open to everyone. Ask ${admin} to add you.`],
  [AccessDenied, ({ label, admin }) => `You don't have access to ${escapeText(label)}; ask ${admin}.`],
  [ConfigFault, ({ admin }) => `That option isn't set up correctly, so I can't open it right now. I've logged the problem; please tell ${admin}.`],
];

function messageFor(err) {
  for (const [Kind, words] of MESSAGES) {
    if (err instanceof Kind) return words(err.details);
  }
  return null;
}

module.exports = { messageFor, escapeText };
