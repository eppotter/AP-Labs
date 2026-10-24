'use strict';

// A direct message to the bot gets a short greeting back in the same DM, so a
// person can see the platform is live (Story 6.1). Only plain messages from
// people in a DM; edits, joins and other bots' messages are ignored (Bolt
// already ignores the bot's own).

const { handle } = require('./handle');
const { escapeText } = require('../messages');

function greetingText(profile, userId) {
  return `Hi <@${userId}>, I'm the ${escapeText(profile.client.name)} bot. I'm up and running.`;
}

function isPersonDm(message) {
  return Boolean(message && message.channel_type === 'im' && !message.subtype && !message.bot_id && message.user);
}

function registerGreeting(app, { profile, log, store }) {
  app.message(handle('greeting', async ({ message, say }) => {
    if (!isPersonDm(message)) return;
    await say({ text: greetingText(profile, message.user) });
  }, { log, store }));
}

module.exports = { registerGreeting, greetingText, isPersonDm };
