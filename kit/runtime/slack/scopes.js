'use strict';

// The runtime Slack app's bot scopes and events (AD-5). Exactly these; adding
// one needs an Architect review. `npm run slack:manifest` writes these into
// the app manifest (<app>/slack-manifest.json); a test fails if it drifts.
//
// files:read came with plan brightside-v0 (D12, Story 16.2), whose architect
// review covers it: Add context reads a file an admin uploads through the
// modal's file input (Story 16.8, kit/runtime/slack/files.js).

const BOT_SCOPES = Object.freeze(['commands', 'chat:write', 'im:write', 'im:history', 'files:read', 'files:write', 'users:read']);

// message.im delivers direct messages to the bot (needs im:history);
// team_join tells it a person joined the workspace, for the join welcome
// (Story 6.4; needs users:read).
const BOT_EVENTS = Object.freeze(['message.im', 'team_join']);

module.exports = { BOT_SCOPES, BOT_EVENTS };
