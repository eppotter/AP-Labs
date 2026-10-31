'use strict';

// Builds a hub's private Block Kit menu (plan hub-status-menu, D1 to D11,
// Stories 17.2 and 17.3) and its help (Story 6.4). No hub-specific code: the hub file,
// the module manifests and the facts the slash command gathers
// (kit/runtime/slack/hubs) are the only inputs. Every glyph and status word
// comes from ./vocabulary; this file writes none.
//
// The menu, top to bottom (D1):
//   header           the hub's name
//   not set up       a context line, for a person the profile doesn't name
//   strip:knows      "Knows: 2 notes · 0 sources · 0 truths · 0 rules", or
//                    "Knows: checking…" (the notes are still being read, D8),
//                    or "Knows: couldn't check just now"
//   strip:progress   an admin: the setup bar and how many tools are ready
//                    while setup is not done, else "N of M tools ready" with
//                    the tick; a member: "Your admin is setting this up." on
//                    a blank hub (plus " You can still ask questions." with
//                    an Ask row), else "N of M tools ready" (D4)
//   welcome          first visit only, one sentence (D9)
//   group:<n>        a header per group with a row this person sees (D5):
//                    the manifests' groups in order of their first module,
//                    then the ungrouped tools under "Tools", then the Setup
//                    group (add-context and data-sources, for an admin only)
//   entry:<id>       "*<label>*" and the status line under it; the verb as
//                    the button (D2, D10). The button still sends
//                    <module-id>:open, so the dispatcher and its re-check
//                    are unchanged. The description lives in Help.
//                    A row whose status is waiting shows "Why?" instead
//                    (D7, Story 17.3), sending <module-id>:why: Slack has no
//                    disabled button. Its listener (kit/runtime/slack/hubs)
//                    re-checks the click and pushes the Why? screen
//                    (./why).
//   divider, help    as before (modalView keepTail: 2)
//
// "Tools ready" counts the rows outside the Setup group whose status is
// ready; M is the number of those rows.
//
// The strip shows only when the caller says the person may see it (in the
// profile, architect P1-1) and they have at least one row. Counts are
// numbers only. A person with no rows sees "Nothing is available to you
// here yet." and Help, with no strip.
//
// Never blocks the menu (D1, architect P2-5): a status the vocabulary can't
// word gives that row its verb and no status line, logged with the module id
// and the function's name only. Over Slack's 100 blocks (P3-10) whole groups
// are dropped from the end, never half a group; the first group, the Setup
// group, a "More tools than fit here: see Help." line, the divider and Help
// are kept. A first group too big on its own is left to modalView's generic
// cut ("more… N more not shown here."), the backstop.
//
// The plain-text fallback (text: the ephemeral reply when the modal can't
// open) carries the welcome, the tool list, the strip's two lines and the
// notice.

const {
  statusText, toolsReady, setupProgress, menuVerbOf, SETUP_GROUP, UNGROUPED, SEP, CHECKING, WHY,
} = require('./vocabulary');

const OPEN_VERB = 'open';
const OPEN_ACTION = /^([a-z][a-z0-9-]*):open$/;
// A waiting row's Why? click (D7, Story 17.3).
const WHY_ACTION = /^([a-z][a-z0-9-]*):why$/;
const HELP_ACTION = /^([a-z][a-z0-9-]*):help$/;
// The archetypes the engine places in the Setup group (D5).
const SETUP_ARCHETYPES = Object.freeze(['add-context', 'data-sources']);
const MAX_BLOCKS = 100;
const NOTHING_HERE = 'Nothing is available to you here yet.';
const MORE_TOOLS = 'More tools than fit here: see Help.';
const KNOWS_CHECKING = 'Knows: checking…';
const KNOWS_UNCHECKED = "Knows: couldn't check just now";
const SETTING_UP = 'Your admin is setting this up.';
const STILL_ASK = ' You can still ask questions.';

function openActionId(moduleId) {
  return `${moduleId}:${OPEN_VERB}`;
}

// Returns the module id an Open click names, or null.
function moduleIdFromAction(actionId) {
  const m = typeof actionId === 'string' ? OPEN_ACTION.exec(actionId) : null;
  return m ? m[1] : null;
}

function whyActionId(moduleId) {
  return `${moduleId}:why`;
}

// Returns the module id a Why? click names, or null.
function moduleIdFromWhy(actionId) {
  const m = typeof actionId === 'string' ? WHY_ACTION.exec(actionId) : null;
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

const isSetup = (entry) => SETUP_ARCHETYPES.includes(entry && entry.archetype);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const NO_LOG = Object.freeze({ warn: () => {} });

// The menu verb for a module (D10), or "Run" when it has none (logged): the
// registry loads only archetypes the vocabulary knows, so this is a backstop.
function verbFor(entry, log = NO_LOG) {
  try {
    return menuVerbOf(entry);
  } catch {
    log.warn('menu fact skipped', { module: (entry && entry.id) || null, fn: 'menuVerbOf' });
    return 'Run';
  }
}

// "Knows: 2 notes · 0 sources · 0 truths · 0 rules" (D3), or "couldn't
// check just now" when something could not be read: never a 0 that hides it.
function knowsLine(summary) {
  const c = summary && summary.counts;
  if (!c || summary.problem || !Number.isSafeInteger(c.notes)) return KNOWS_UNCHECKED;
  return `Knows: ${[
    plural(c.notes, 'note', 'notes'), plural(c.sources, 'source', 'sources'),
    plural(c.truths, 'truth', 'truths'), plural(c.rules, 'rule', 'rules'),
  ].join(SEP)}`;
}

const stepDone = (summary, name) => summary.steps.some((s) => s.step === name && s.counted && s.done);

// The progress line (D4), or null. rows: the rows shown, with their status.
function progressLine(summary, rows, admin) {
  if (!summary || summary.problem || !Array.isArray(summary.steps)) return null;
  const tools = rows.filter((r) => !isSetup(r.entry));
  const ready = tools.filter((r) => r.status && r.status.key === 'ready').length;
  if (admin) {
    if (summary.of > 0 && summary.done < summary.of) return setupProgress(summary.done, summary.of, ready, tools.length);
    return toolsReady(ready, tools.length);
  }
  if (!stepDone(summary, 'taught') && !stepDone(summary, 'data')) {
    return rows.some((r) => r.entry.archetype === 'ask') ? `${SETTING_UP}${STILL_ASK}` : SETTING_UP;
  }
  return toolsReady(ready, tools.length);
}

// The row's status line, or null (no status, or one the vocabulary refuses:
// logged with the module id and the function's name only).
function statusLine(row, { checking, log }) {
  if (checking) return CHECKING;
  if (!row.status) return null;
  try {
    return statusText(row.status);
  } catch {
    log.warn('menu fact skipped', { module: row.entry.id, fn: 'statusText' });
    return null;
  }
}

// A waiting row (D7): its button is Why?, never its verb. Only once its
// status is worded: a row with no status line, or "Checking…", keeps its verb.
const isWaiting = (row, line, { checking }) => !checking && Boolean(line) && row.status.key === 'waiting';

function rowBlock(row, opts) {
  const { entry } = row;
  const line = statusLine(row, opts);
  const why = isWaiting(row, line, opts);
  return {
    type: 'section',
    block_id: `entry:${entry.id}`,
    text: { type: 'mrkdwn', text: `*${escapeText(entry.label)}*${line ? `\n${line}` : ''}` },
    accessory: {
      type: 'button',
      action_id: why ? whyActionId(entry.id) : openActionId(entry.id),
      value: entry.id,
      text: { type: 'plain_text', text: why ? WHY : (row.verb || verbFor(entry, opts.log)), emoji: false },
    },
  };
}

// The rows in groups (D5): the manifests' groups in order of first
// appearance, then "Tools", then the Setup group (admins only).
function groupsOf(rows, admin) {
  const named = new Map();
  const tools = [];
  const setup = [];
  for (const row of rows) {
    if (isSetup(row.entry)) {
      if (admin) setup.push(row);
    } else {
      const g = typeof row.entry.group === 'string' && row.entry.group.trim() ? row.entry.group.trim() : null;
      if (!g || g === UNGROUPED) tools.push(row);
      else {
        if (!named.has(g)) named.set(g, []);
        named.get(g).push(row);
      }
    }
  }
  const groups = [...named].map(([name, list]) => ({ name, rows: list, setup: false }));
  if (tools.length) groups.push({ name: UNGROUPED, rows: tools, setup: false });
  if (setup.length) groups.push({ name: SETUP_GROUP, rows: setup, setup: true });
  return groups;
}

const moreLine = () => ({ type: 'context', block_id: 'more', elements: [{ type: 'mrkdwn', text: MORE_TOOLS }] });

// hub: a hub file. rows: the tools this person may open, in menu order,
// each { entry, status, verb } (entry the module; status { key, detail } or
// null; verb the button's text, else the module's menu verb). Options:
//   notice    mrkdwn under the header ("you're not set up yet")
//   welcome   the first-visit welcome (mrkdwn)
//   admin     the person's profile role is admin: the Setup group shows
//   strip     the person may see the strip (in the profile, P1-1)
//   summary   summarize() for the hub, or null ("couldn't check just now")
//   checking  the notes are still being read (D8): "Knows: checking…", no
//             progress line, and each row says "Checking…"
//   log       for the guard's lines
// Returns { text, blocks }: the blocks are the hub modal's
// (kit/runtime/slack/modal), the whole is the ephemeral fallback reply.
function buildMenu(hub, rows, {
  notice, welcome, admin = false, strip = false, summary = null, checking = false, log = NO_LOG,
} = {}) {
  const shown = rows.filter((r) => admin || !isSetup(r.entry));
  const opts = { checking, log };
  const head = [{ type: 'header', text: { type: 'plain_text', text: hub.name, emoji: false } }];
  if (notice) head.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notice }] });
  let knows = null;
  let progress = null;
  if (strip && shown.length) {
    knows = checking ? KNOWS_CHECKING : knowsLine(summary);
    progress = checking ? null : progressLine(summary, shown, admin);
    head.push({ type: 'section', block_id: 'strip:knows', text: { type: 'mrkdwn', text: knows } });
    if (progress) head.push({ type: 'context', block_id: 'strip:progress', elements: [{ type: 'mrkdwn', text: progress }] });
  }
  if (welcome) head.push({ type: 'section', block_id: 'welcome', text: { type: 'mrkdwn', text: welcome } });
  if (!shown.length) head.push({ type: 'section', text: { type: 'mrkdwn', text: NOTHING_HERE } });
  const tail = [
    { type: 'divider' },
    {
      type: 'section',
      block_id: 'help',
      text: { type: 'mrkdwn', text: '*Help*\nWhat you can use here, and how to give feedback.' },
      accessory: {
        type: 'button',
        action_id: helpActionId(hub.id),
        value: hub.id,
        text: { type: 'plain_text', text: 'Help', emoji: false },
      },
    },
  ];
  // Whole groups only (P3-10): drop the last tool group until the menu fits.
  let groups = groupsOf(shown, admin);
  let cut = false;
  const size = () => head.length + tail.length + (cut ? 1 : 0) + groups.reduce((n, g) => n + 1 + g.rows.length, 0);
  // The first tool group is always kept: one group too big on its own is
  // left to modalView's generic cut, the backstop.
  while (size() > MAX_BLOCKS && groups.filter((g) => !g.setup).length > 1) {
    const last = groups.map((g) => g.setup).lastIndexOf(false);
    groups = groups.filter((_, i) => i !== last);
    cut = true;
  }
  const body = [];
  groups.forEach((g, i) => {
    if (g.setup && cut) body.push(moreLine());
    body.push({ type: 'header', block_id: `group:${i}`, text: { type: 'plain_text', text: g.name, emoji: false } });
    for (const row of g.rows) body.push(rowBlock(row, opts));
  });
  if (cut && !groups.some((g) => g.setup)) body.push(moreLine());
  const blocks = [...head, ...body, ...tail];
  const list = shown.length
    ? `${hub.name}: ${shown.map((r) => r.entry.label).join(', ')}`
    : `${hub.name}: nothing is available to you here yet.`;
  const text = [welcome, list, knows, progress, notice].filter(Boolean).join('\n');
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
  buildMenu, buildHelp, openActionId, moduleIdFromAction, whyActionId, moduleIdFromWhy, helpActionId, hubIdFromHelpAction, verbFor, isSetup,
  OPEN_ACTION, WHY_ACTION, HELP_ACTION, SETUP_ARCHETYPES, NOTHING_HERE, MORE_TOOLS, KNOWS_CHECKING, KNOWS_UNCHECKED, SETTING_UP, STILL_ASK,
};
