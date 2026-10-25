'use strict';

// Builds a hub's private Block Kit menu from its entries: one section per
// entry (label and one-line description) with an Open button whose action id
// is `<module-id>:open`. The menu always ends with a Help entry whose button
// (`<hub-id>:help`) opens the hub's help: the entries this person can use and
// how to give feedback (Story 6.4). No hub-specific code: the hub file and the
// module manifests are the only inputs.

const OPEN_VERB = 'open';
const OPEN_ACTION = /^([a-z][a-z0-9-]*):open$/;
const HELP_ACTION = /^([a-z][a-z0-9-]*):help$/;

function openActionId(moduleId) {
  return `${moduleId}:${OPEN_VERB}`;
}

// Returns the module id an Open click names, or null.
function moduleIdFromAction(actionId) {
  const m = typeof actionId === 'string' ? OPEN_ACTION.exec(actionId) : null;
  return m ? m[1] : null;
}

function helpActionId(hubId) {
  return `${hubId}:help`;
}

// Returns the hub id a Help click names, or null.
function hubIdFromHelpAction(actionId) {
  const m = typeof actionId === 'string' ? HELP_ACTION.exec(actionId) : null;
  return m ? m[1] : null;
}

// Slack mrkdwn treats &, < and > as control characters.
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// hub: a hub file; entries: the modules this person may see, in menu order;
// notice (optional): mrkdwn shown under the header, for example "you're not
// set up yet"; welcome (optional): the hub's one-paragraph first-visit welcome
// (mrkdwn), shown above the entries. Returns { text, blocks }: the blocks are
// the hub modal's (kit/runtime/slack/modal), the whole is the ephemeral
// fallback reply.
function buildMenu(hub, entries, { notice, welcome } = {}) {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: hub.name, emoji: false } }];
  if (welcome) blocks.push({ type: 'section', block_id: 'welcome', text: { type: 'mrkdwn', text: welcome } });
  if (notice) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notice }] });
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
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    block_id: 'help',
    text: { type: 'mrkdwn', text: '*Help*\nWhat you can use here, and how to give feedback.' },
    accessory: {
      type: 'button',
      action_id: helpActionId(hub.id),
      value: hub.id,
      text: { type: 'plain_text', text: 'Help', emoji: false },
    },
  });
  const list = entries.length
    ? `${hub.name}: ${entries.map((e) => e.label).join(', ')}`
    : `${hub.name}: nothing is available to you here yet.`;
  const text = [welcome, list, notice].filter(Boolean).join('\n');
  return { text, blocks };
}

// A hub's help for one person. entries: the modules this person may use, from
// the same access decision as the menu; feedback: how to give feedback
// (mrkdwn); notice (optional) as for buildMenu.
function buildHelp(hub, entries, { feedback, notice } = {}) {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: `Help: ${hub.name}`, emoji: false } }];
  if (notice) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notice }] });
  const usable = entries.length
    ? entries.map((e) => `• *${escapeText(e.label)}*: ${escapeText(e.description)}`).join('\n')
    : 'Nothing is available to you here yet.';
  blocks.push({ type: 'section', block_id: 'help:modules', text: { type: 'mrkdwn', text: `*What you can use here*\n${usable}` } });
  blocks.push({ type: 'section', block_id: 'help:feedback', text: { type: 'mrkdwn', text: `*Feedback*\n${feedback}` } });
  const list = entries.length
    ? `you can use ${entries.map((e) => e.label).join(', ')}.`
    : 'nothing is available to you here yet.';
  const text = [`Help for ${hub.name}: ${list}`, notice, feedback].filter(Boolean).join('\n');
  return { text, blocks };
}

module.exports = {
  buildMenu, buildHelp, openActionId, moduleIdFromAction, helpActionId, hubIdFromHelpAction, OPEN_ACTION, HELP_ACTION,
};
