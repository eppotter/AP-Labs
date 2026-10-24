'use strict';

// The runtime Slack app's bot scopes and events (AD-5). Exactly these; adding
// one needs an Architect review. `npm run slack:manifest` writes these into
// the app manifest (<app>/slack-manifest.json); a test fails if it drifts.

const BOT_SCOPES = Object.freeze(['commands', 'chat:write', 'im:write', 'im:history', 'files:write', 'users:read']);

// message.im delivers direct messages to the bot (needs im:history).
const BOT_EVENTS = Object.freeze(['message.im']);

module.exports = { BOT_SCOPES, BOT_EVENTS };
