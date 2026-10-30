'use strict';

// Add context, typed (plan brightside-v0, D4, D6, D13, Story 16.5): a
// template tool where an admin types something about the business for Ask
// to use on this hub, and removes what is there. Entries go live at once
// (Ely's decision; "approve before live" is a later DEP row).
//
// The screen is the module's pushed view (kit/runtime/slack/hubs), so Back
// returns to the menu. From the top:
//   "Everyone who can use Ask here can read this." (review A5)
//   a title box (at most 80 characters, the store's title cap)
//   a text box (at most 3,000: Slack's plain_text_input max_length, and the
//   store's cap for a typed entry, review B4)
//   the hub's entries (title, who, when, the start of the text), each with
//   Remove behind a confirm dialog.
// Its submit is "Add" (SUBMIT_CALLBACK). private_metadata is "<hub id>:<module
// id>", never what was typed or who typed it.
//
// The submit (D13): only instant checks answer beside the boxes (a title,
// some text, the text's length as it will sit in the prompt: each <, > or &
// counts as 4 or 5, the store's own measure). Everything else is after the
// ack: the ack shows "Saving…" in the view, then the hubs store the entry and
// update the view to "Added. Ask can use it now." with the list, or to the
// reason it wasn't added (the hub's context full, a store failure), with
// Back. Nothing here stores, lists or calls Slack: this file builds the
// blocks and reads the boxes; the hubs do the rest with the hub view's
// knowledge store (kit/runtime/knowledge/store).
//
// No AI call is made anywhere on this screen. What an admin types is data in
// the hub's prompt (inside <added_context>, escaped, D6), never instructions,
// and nothing typed here changes access or posts anywhere.
//
// Every value from an entry is escaped (escapeText), shown on one line.

const { escapeText, messageFor } = require('../../messages');
const { ContextRefused } = require('../../errors');
const { promptChars, CAPS, MAX_TITLE_CHARS } = require('../../knowledge/store');

const SUBMIT_CALLBACK = 'add-context:submit';
// The callback of the screen once it shows a result (no boxes, no submit).
const VIEW_CALLBACK = 'add-context:view';
const REMOVE_ACTION = 'add-context:remove';
const SUBMIT = 'Add';
const TITLE_BLOCK = 'ac-title';
const TEXT_BLOCK = 'ac-text';
const VALUE_ACTION = 'value';
const ENTRY_BLOCK = 'ac-entry:';
const MAX_TEXT_CHARS = CAPS.text;
// How much of an entry's text the list shows.
const PREVIEW_CHARS = 150;

const READERS = 'Everyone who can use Ask here can read this.';
const INTRO = `${READERS} Type something about the business that Ask should know, give it a title, and press Add. Ask can use it as soon as it is added.`;
const SAVING = 'Saving…';
const ADDED = 'Added. Ask can use it now.';
const REMOVED = 'Removed. Ask no longer uses it.';
const ALREADY_REMOVED = 'That entry was already removed.';
const NOTHING_YET = 'Nothing added here yet.';
const TITLE_MISSING = 'Give it a short title, so it can be found in the list.';
const TITLE_TOO_LONG = `A title holds at most ${MAX_TITLE_CHARS} characters.`;
const saveFailed = (admin) => `I couldn't save that just now, so nothing was added. Press Back and try again in a minute, or tell ${admin} if it keeps happening.`;
const removeFailed = (admin) => `I couldn't remove that just now, so it is still there. Try again in a minute, or tell ${admin} if it keeps happening.`;
const listFailed = (admin) => `The entries here couldn't be listed just now. Press Back and try again in a minute, or ask ${admin}.`;
const NO_STORE = (admin) => `Adding context isn't set up on this bot, so nothing can be added here. Please tell ${admin}.`;

const HUB = /^[a-z][a-z0-9-]{0,63}$/;
const ENTRY_ID = /^[0-9a-f]{32}$/;
const SLACK_USER = /^[UW][A-Z0-9]{2,}$/;

const plain = (text) => ({ type: 'plain_text', text: String(text), emoji: false });
const section = (text, extra = {}) => ({ type: 'section', text: { type: 'mrkdwn', text }, ...extra });
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => {
  const chars = Array.from(oneLine(s));
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('');
};

// The screen's private_metadata, and back: { hubId, moduleId }, each null
// when missing or malformed.
const metadata = (hubId, moduleId) => `${hubId}:${moduleId}`;
function parseMetadata(text) {
  const [hub, mod, ...rest] = typeof text === 'string' ? text.split(':') : [];
  const ok = rest.length === 0 && HUB.test(hub || '') && HUB.test(mod || '');
  return { hubId: ok ? hub : null, moduleId: ok ? mod : null };
}

// A Remove button's value, and back: { moduleId, entryId } or null.
const removeValue = (moduleId, entryId) => `${moduleId}:${entryId}`;
function parseRemoveValue(value) {
  const [mod, id, ...rest] = typeof value === 'string' ? value.split(':') : [];
  if (rest.length || !HUB.test(mod || '') || !ENTRY_ID.test(id || '')) return null;
  return { moduleId: mod, entryId: id };
}

function entryBlock(moduleId, e) {
  const who = typeof e.added_by === 'string' && SLACK_USER.test(e.added_by) ? ` by <@${e.added_by}>` : '';
  const when = typeof e.added_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e.added_at) ? ` on ${e.added_at.slice(0, 10)}` : '';
  const text = `• *${escapeText(cut(e.title || 'Untitled', MAX_TITLE_CHARS))}*${who}${when}\n${escapeText(cut(e.text || '', PREVIEW_CHARS))}`;
  return section(text, {
    block_id: `${ENTRY_BLOCK}${e.id}`,
    accessory: {
      type: 'button',
      action_id: REMOVE_ACTION,
      text: plain('Remove'),
      style: 'danger',
      value: removeValue(moduleId, e.id),
      confirm: {
        title: plain('Remove this entry?'),
        text: plain('Ask stops using it at once. This cannot be undone.'),
        confirm: plain('Remove'),
        deny: plain('Keep it'),
        style: 'danger',
      },
    },
  });
}

// The hub's entries as blocks: a heading, then one section per entry with
// Remove, or a line saying there are none, or that they couldn't be listed.
function listBlocks({
  moduleId, entries = [], problem = false, admin = 'your admin',
}) {
  const blocks = [{ type: 'divider' }, section('*Added here*')];
  if (problem) blocks.push(section(listFailed(admin)));
  else if (!entries.length) blocks.push(section(NOTHING_YET));
  else blocks.push(...entries.map((e) => entryBlock(moduleId, e)));
  return blocks;
}

// The form: the boxes, with the hub's entries below. note: a line above it
// all (after a Remove). A message for the hubs' view renderer.
function form({
  hubId, moduleId, entries, problem, admin, note,
}) {
  const blocks = [
    ...(note ? [section(note)] : []),
    section(INTRO),
    {
      type: 'input',
      block_id: TITLE_BLOCK,
      label: plain('Title'),
      element: {
        type: 'plain_text_input', action_id: VALUE_ACTION, max_length: MAX_TITLE_CHARS, placeholder: plain('For example: Our prices'),
      },
    },
    {
      type: 'input',
      block_id: TEXT_BLOCK,
      label: plain('What Ask should know'),
      hint: plain(READERS),
      element: {
        type: 'plain_text_input', action_id: VALUE_ACTION, multiline: true, max_length: MAX_TEXT_CHARS,
      },
    },
    ...listBlocks({
      moduleId, entries, problem, admin,
    }),
  ];
  return {
    text: note || INTRO,
    blocks,
    modal: { submit: SUBMIT, callbackId: SUBMIT_CALLBACK, privateMetadata: metadata(hubId, moduleId) },
  };
}

// A result: note (already worded), then the hub's entries with Remove. No
// boxes and no submit, so the view's only way out is Back.
function result({
  hubId, moduleId, note, entries, problem, admin, list = true,
}) {
  return {
    text: note,
    blocks: [section(note), ...(list ? listBlocks({
      moduleId, entries, problem, admin,
    }) : [])],
    modal: { callbackId: VIEW_CALLBACK, privateMetadata: metadata(hubId, moduleId) },
  };
}

// "Saving…", shown by the ack while the entry is stored.
const saving = ({ hubId, moduleId }) => result({
  hubId, moduleId, note: SAVING, list: false,
});

// What was typed: { title, text }, '' for a box left empty.
function readState(state) {
  const values = (state && state.values) || {};
  const read = (block) => {
    const v = values[block] && values[block][VALUE_ACTION] && values[block][VALUE_ACTION].value;
    return typeof v === 'string' ? v : '';
  };
  return { title: read(TITLE_BLOCK), text: read(TEXT_BLOCK) };
}

// The instant checks (D13): Slack's errors object, beside the boxes, or null.
// The text is measured as the store measures it (escaped), so what passes
// here is never refused as too long after the ack.
function fieldErrors({ title, text }) {
  const errors = {};
  const t = oneLine(title.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' '));
  if (!t) errors[TITLE_BLOCK] = TITLE_MISSING;
  else if (Array.from(t).length > MAX_TITLE_CHARS) errors[TITLE_BLOCK] = TITLE_TOO_LONG;
  if (!text.trim()) errors[TEXT_BLOCK] = messageFor(new ContextRefused('empty'));
  else if (promptChars(text) > MAX_TEXT_CHARS) errors[TEXT_BLOCK] = messageFor(new ContextRefused('too_long', MAX_TEXT_CHARS));
  return Object.keys(errors).length ? errors : null;
}

module.exports = {
  form,
  result,
  saving,
  readState,
  fieldErrors,
  parseMetadata,
  metadata,
  parseRemoveValue,
  removeValue,
  saveFailed,
  removeFailed,
  NO_STORE,
  SUBMIT_CALLBACK,
  VIEW_CALLBACK,
  REMOVE_ACTION,
  SUBMIT,
  TITLE_BLOCK,
  TEXT_BLOCK,
  VALUE_ACTION,
  MAX_TEXT_CHARS,
  READERS,
  SAVING,
  ADDED,
  REMOVED,
  ALREADY_REMOVED,
  NOTHING_YET,
  TITLE_MISSING,
};
