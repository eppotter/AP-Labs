'use strict';

// Builds a hub's private Block Kit menu from its entries: one section per
// entry (label and one-line description) with an Open button whose action id
// is `<module-id>:open`. No hub-specific code: the hub file and the module
// manifests are the only inputs.

const OPEN_VERB = 'open';
const OPEN_ACTION = /^([a-z][a-z0-9-]*):open$/;

function openActionId(moduleId) {
  return `${moduleId}:${OPEN_VERB}`;
}

// Returns the module id an Open click names, or null.
function moduleIdFromAction(actionId) {
  const m = typeof actionId === 'string' ? OPEN_ACTION.exec(actionId) : null;
  return m ? m[1] : null;
}

// Slack mrkdwn treats &, < and > as control characters.
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// hub: a hub file; entries: the modules this person may see, in menu order.
// Returns { text, blocks } for an ephemeral reply.
function buildMenu(hub, entries) {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: hub.name, emoji: false } }];
  if (!entries.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'Nothing is available to you here yet.' } });
  }
  for (const e of entries) {
    blocks.push({
      type: 'section',
      block_id: `entry:${e.id}`,
      text: { type: 'mrkdwn', text: `*${escapeText(e.label)}*\n${escapeText(e.description)}` },
      accessory: {
        type: 'button',
        action_id: openActionId(e.id),
        value: e.id,
        text: { type: 'plain_text', text: 'Open', emoji: false },
      },
    });
  }
  const text = entries.length
    ? `${hub.name}: ${entries.map((e) => e.label).join(', ')}`
    : `${hub.name}: nothing is available to you here yet.`;
  return { text, blocks };
}

module.exports = { buildMenu, openActionId, moduleIdFromAction, OPEN_ACTION };
