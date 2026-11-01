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
//
// Upload a file (plan brightside-v0, D5, D6, D7, D13, Story 16.8): the form
// also has an optional file_input (FILE_BLOCK, max_files 1, filetypes from
// kit/runtime/slack/files FILETYPES: pdf, png, jpg, jpeg, gif, webp, txt,
// md, csv), with "Everyone who can use Ask here can read what this file says."
// and "The file stays in your Slack files; you can delete it there." beside
// it. A submit holds exactly one of typed text or a file. The instant checks
// beside the fields (fieldErrors): the title; neither or both; more than one
// file; and the file's type by its name (an office file: "save it as a PDF
// first"). Everything else is after the ack: "Reading…" in the view, then
// the hubs fetch the file (kit/runtime/slack/files), read a PDF or image
// through the hub's AI (llm readFile) or a .txt or .md file as UTF-8, store
// the text, and update the view to "Here's what I took from <title>:" with
// the first 1,500 characters of what was stored and Remove (fileAdded), or
// to why nothing was added, with Back. The file itself is never stored.
//
// A .csv file (plan brightside-v1, D3, Story 18.2): filetypes gains csv, the
// hint names it with its caps and adds NO_PERSONAL ("Don't upload personal
// details …"). The hubs read it as text (kit/runtime/slack/files readCsv: no
// AI call, never summarised), and "Here's what I took from <title>:" adds
// "<N> rows, <M> columns" (fileAdded's table).

const { escapeText, messageFor } = require('../../messages');
const { ContextRefused, FileRefused } = require('../../errors');
const { promptChars, CAPS, MAX_TITLE_CHARS } = require('../../knowledge/store');
const {
  FILETYPES, typeOf, MAX_CSV_ROWS, MAX_CSV_COLUMNS,
} = require('../../slack/files');
const { MAX_PDF_PAGES } = require('../../llm/file-check');

const SUBMIT_CALLBACK = 'add-context:submit';
// The callback of the screen once it shows a result (no boxes, no submit).
const VIEW_CALLBACK = 'add-context:view';
const REMOVE_ACTION = 'add-context:remove';
const SUBMIT = 'Add';
const TITLE_BLOCK = 'ac-title';
const TEXT_BLOCK = 'ac-text';
const FILE_BLOCK = 'ac-file';
// The block of "Here's what I took from …", which carries its own Remove.
const TOOK_BLOCK = 'ac-took:';
const VALUE_ACTION = 'value';
const ENTRY_BLOCK = 'ac-entry:';
const MAX_TEXT_CHARS = CAPS.text;
// How much of an entry's text the list shows.
const PREVIEW_CHARS = 150;
// How much of a file's stored text "Here's what I took" shows (Story 16.8).
const TOOK_CHARS = 1500;
// A section holds at most 3,000 characters; escaping can grow the text.
const SECTION_CHARS = 2900;

const READERS = 'Everyone who can use Ask here can read this.';
const INTRO = `${READERS} Type something about the business that Ask should know, or upload a file (a PDF, a photo, a .csv, or a .txt or .md file), give it a title, and press Add. Ask can use it as soon as it is added.`;
const FILE_READERS = 'Everyone who can use Ask here can read what this file says.';
// Beside the file field (plan brightside-v1, D3).
const NO_PERSONAL = "Don't upload personal details (emails, phones, addresses): everyone who can use Ask here can read them, and they are sent to the AI.";
const FILE_STAYS = 'The file stays in your Slack files; you can delete it there.';
const SAVING = 'Saving…';
const READING = 'Reading…';
const NEED_ONE = 'Type some text, or choose a file to upload.';
const BOTH = 'Add typed text or a file, not both. Clear one of them, then press Add.';
const ONE_FILE = 'Choose one file at a time.';
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

function removeButton(moduleId, id) {
  return {
    type: 'button',
    action_id: REMOVE_ACTION,
    text: plain('Remove'),
    style: 'danger',
    value: removeValue(moduleId, id),
    confirm: {
      title: plain('Remove this entry?'),
      text: plain('Ask stops using it at once. This cannot be undone.'),
      confirm: plain('Remove'),
      deny: plain('Keep it'),
      style: 'danger',
    },
  };
}

function entryBlock(moduleId, e) {
  const who = typeof e.added_by === 'string' && SLACK_USER.test(e.added_by) ? ` by <@${e.added_by}>` : '';
  const when = typeof e.added_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e.added_at) ? ` on ${e.added_at.slice(0, 10)}` : '';
  const text = `• *${escapeText(cut(e.title || 'Untitled', MAX_TITLE_CHARS))}*${who}${when}\n${escapeText(cut(e.text || '', PREVIEW_CHARS))}`;
  return section(text, { block_id: `${ENTRY_BLOCK}${e.id}`, accessory: removeButton(moduleId, e.id) });
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
      optional: true,
      element: {
        type: 'plain_text_input', action_id: VALUE_ACTION, multiline: true, max_length: MAX_TEXT_CHARS,
      },
    },
    {
      type: 'input',
      block_id: FILE_BLOCK,
      label: plain('Or upload a file'),
      hint: plain(`${FILE_READERS} ${FILE_STAYS} PDF (at most ${MAX_PDF_PAGES} pages), PNG, JPEG, GIF, WebP, .csv (at most ${MAX_CSV_ROWS} rows and ${MAX_CSV_COLUMNS} columns), .txt or .md, at most 5 MB. ${NO_PERSONAL}`),
      optional: true,
      element: {
        type: 'file_input', action_id: VALUE_ACTION, max_files: 1, filetypes: [...FILETYPES],
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

// "Reading…", shown by the ack while a file is fetched and read (Story 16.8).
const reading = ({ hubId, moduleId }) => result({
  hubId, moduleId, note: READING, list: false,
});

// Text in sections of at most SECTION_CHARS once escaped, never cutting an
// escape in two.
function textSections(text) {
  const out = [];
  let part = '';
  for (const ch of Array.from(text)) {
    const e = escapeText(ch);
    if (part.length + e.length > SECTION_CHARS) {
      out.push(section(part));
      part = '';
    }
    part += e;
  }
  if (part) out.push(section(part));
  return out;
}

// After an upload (Story 16.8): "Here's what I took from <title>:" with
// Remove for this entry, the first TOOK_CHARS characters of the stored text,
// then the hub's entries. A result: no boxes, no submit. table: a CSV's
// { rows, columns } (Story 18.2), shown after the title as "<N> rows, <M>
// columns"; null for any other file.
const count = (n, one) => `${Number(n).toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;
function fileAdded({
  hubId, moduleId, entry, entries, problem, admin, table = null,
}) {
  const title = escapeText(cut(entry.title || 'Untitled', MAX_TITLE_CHARS));
  const chars = Array.from(String(entry.text || ''));
  const shown = chars.slice(0, TOOK_CHARS).join('');
  const more = chars.length > TOOK_CHARS ? `_…and ${(chars.length - TOOK_CHARS).toLocaleString('en-US')} more characters._\n` : '';
  const shape = table ? ` ${count(table.rows, 'row')}, ${count(table.columns, 'column')}` : '';
  const note = `Here's what I took from *${title}*:${shape}`;
  return {
    text: `Here's what I took from ${cut(entry.title || 'Untitled', MAX_TITLE_CHARS)}${shape ? `:${shape}` : ''}.`,
    blocks: [
      section(note, { block_id: `${TOOK_BLOCK}${entry.id}`, accessory: removeButton(moduleId, entry.id) }),
      ...textSections(shown),
      section(`${more}${ADDED} ${FILE_STAYS}`),
      ...listBlocks({
        moduleId, entries, problem, admin,
      }),
    ],
    modal: { callbackId: VIEW_CALLBACK, privateMetadata: metadata(hubId, moduleId) },
  };
}

// What was submitted: { title, text, files }, '' for a box left empty, and
// files: [{ id, name }] from the file_input (none: []).
function readState(state) {
  const values = (state && state.values) || {};
  const read = (block) => {
    const v = values[block] && values[block][VALUE_ACTION] && values[block][VALUE_ACTION].value;
    return typeof v === 'string' ? v : '';
  };
  const picked = values[FILE_BLOCK] && values[FILE_BLOCK][VALUE_ACTION] && values[FILE_BLOCK][VALUE_ACTION].files;
  const files = (Array.isArray(picked) ? picked : [])
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({ id: typeof f.id === 'string' ? f.id : '', name: typeof f.name === 'string' ? f.name : '' }));
  return { title: read(TITLE_BLOCK), text: read(TEXT_BLOCK), files };
}

// The instant checks (D13): Slack's errors object, beside the boxes, or null.
// The text is measured as the store measures it (escaped), so what passes
// here is never refused as too long after the ack.
// Exactly one of text or a file (Story 16.8); a file's type is checked by
// its name only (D13: its size and contents are checked after the ack).
function fieldErrors({ title, text, files = [] }) {
  const errors = {};
  const t = oneLine(title.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' '));
  if (!t) errors[TITLE_BLOCK] = TITLE_MISSING;
  else if (Array.from(t).length > MAX_TITLE_CHARS) errors[TITLE_BLOCK] = TITLE_TOO_LONG;
  const hasText = Boolean(text.trim());
  if (files.length && hasText) {
    errors[FILE_BLOCK] = BOTH;
  } else if (files.length > 1) {
    errors[FILE_BLOCK] = ONE_FILE;
  } else if (files.length === 1) {
    const type = typeOf(files[0].name);
    if (type instanceof FileRefused) errors[FILE_BLOCK] = messageFor(type);
  } else if (!hasText) {
    errors[TEXT_BLOCK] = NEED_ONE;
  } else if (promptChars(text) > MAX_TEXT_CHARS) {
    errors[TEXT_BLOCK] = messageFor(new ContextRefused('too_long', MAX_TEXT_CHARS));
  }
  return Object.keys(errors).length ? errors : null;
}

module.exports = {
  form,
  result,
  saving,
  reading,
  fileAdded,
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
  FILE_BLOCK,
  TOOK_BLOCK,
  TOOK_CHARS,
  VALUE_ACTION,
  MAX_TEXT_CHARS,
  READERS,
  SAVING,
  READING,
  NEED_ONE,
  BOTH,
  ONE_FILE,
  FILE_READERS,
  FILE_STAYS,
  NO_PERSONAL,
  ADDED,
  REMOVED,
  ALREADY_REMOVED,
  NOTHING_YET,
  TITLE_MISSING,
};
