'use strict';

// Hub modals (Varsity-style). A hub command opens its menu as a modal; Open
// and Help push a view on top of it, so Slack's back arrow returns to the
// menu. A module's replies render into its pushed view: the view first shows
// "Loading…", the first reply replaces that, and each later reply is appended
// below the earlier ones (several replies all stay visible, as they did as
// separate ephemeral messages). Views carry the hub id as private_metadata and
// nothing else, never person data.
//
// Slack's limits: a modal title is at most 24 characters, a view at most 100
// blocks, a section's text at most 3000 characters. Titles are cut with "…",
// long text is split into several sections, and a view over 100 blocks keeps
// its first blocks plus a "more…" note (a menu keeps its Help at the end).
//
// Text passes through unchanged: it is already escaped by whoever built it
// (kit/runtime/messages, registry/menu, the module's own escapeText).

const MAX_BLOCKS = 100;
const MAX_TITLE = 24;
const MAX_SECTION_TEXT = 3000;
const LOADING = 'Loading…';

// A plain_text title Slack accepts: at most 24 characters (code points, so an
// emoji or accented letter is never cut in half), "…" when cut.
function modalTitle(s) {
  const chars = Array.from(String(s || '').replace(/\s+/g, ' ').trim());
  if (!chars.length) return 'Menu';
  if (chars.length <= MAX_TITLE) return chars.join('');
  return `${chars.slice(0, MAX_TITLE - 1).join('').trimEnd()}…`;
}

// Keeps a view within Slack's block limit: the first blocks, a "more…" note,
// then the last keepTail blocks (for a menu: the divider and Help).
function limitBlocks(blocks, { keepTail = 0, max = MAX_BLOCKS } = {}) {
  if (blocks.length <= max) return blocks;
  const tail = keepTail > 0 ? blocks.slice(-keepTail) : [];
  const head = blocks.slice(0, max - 1 - tail.length);
  const hidden = blocks.length - head.length - tail.length;
  const note = { type: 'context', elements: [{ type: 'mrkdwn', text: `_more… ${hidden} more not shown here._` }] };
  return [...head, note, ...tail];
}

// Splits mrkdwn into pieces Slack accepts in one section, preferring a line
// break, then a space, and never cutting an escape such as &amp; in half.
function splitText(text, max = MAX_SECTION_TEXT) {
  const parts = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) {
      cut = max;
      const amp = rest.lastIndexOf('&', cut);
      if (amp > 0 && cut - amp < 6 && !rest.slice(amp, cut).includes(';')) cut = amp;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, '');
  }
  if (rest.length || !parts.length) parts.push(rest);
  return parts;
}

const textBlocks = (text) => splitText(text).map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t || ' ' } }));

// The blocks a reply shows in a view: its own blocks, else its text.
function messageBlocks(message) {
  if (typeof message === 'string') return textBlocks(message);
  if (message && Array.isArray(message.blocks) && message.blocks.length) return message.blocks;
  return textBlocks((message && message.text) || '');
}

// A modal with a Close (or Back) button and no Submit.
function modalView({ title, blocks, hubId, close = 'Close', keepTail = 0, callbackId = 'hub:view' }) {
  return {
    type: 'modal',
    callback_id: callbackId,
    title: { type: 'plain_text', text: modalTitle(title), emoji: false },
    close: { type: 'plain_text', text: close, emoji: false },
    private_metadata: String(hubId || ''),
    blocks: limitBlocks(blocks, { keepTail }),
  };
}

// True when a block action came from inside a modal (a view), so a reply can
// push onto it; false for a click on a message (an old ephemeral menu).
function fromModal(body) {
  return Boolean(body && body.view && typeof body.trigger_id === 'string' && body.trigger_id
    && (!body.container || body.container.type === 'view'));
}

const hasViews = (client) => Boolean(client && client.views
  && typeof client.views.open === 'function' && typeof client.views.push === 'function' && typeof client.views.update === 'function');

// A short reason for a failed views call: Slack's error code, never the
// request or its payload.
function failureReason(err) {
  const code = err && ((err.data && err.data.error) || err.code);
  return typeof code === 'string' && /^[a-z0-9_.-]{1,60}$/i.test(code) ? code : 'views call failed';
}

// A pushed view a module (or Help, or a refusal) renders into. show(message)
// pushes the view with that message the first time; later calls append. With
// loading(), the view is pushed at once with "Loading…", and the first show()
// replaces it. Calls run one at a time so each update carries the latest hash.
function pushedView({ client, triggerId, title, hubId }) {
  let view = null; // { id, hash } once pushed
  const replies = [];
  let queue = Promise.resolve();
  const render = () => modalView({
    title, hubId, close: 'Back', callbackId: 'hub:module',
    blocks: replies.length ? replies.flatMap(messageBlocks) : textBlocks(LOADING),
  });
  const push = async () => {
    const res = await client.views.push({ trigger_id: triggerId, view: render() });
    view = { id: res && res.view && res.view.id, hash: res && res.view && res.view.hash };
  };
  const update = async () => {
    const res = await client.views.update({ view_id: view.id, ...(view.hash ? { hash: view.hash } : {}), view: render() });
    if (res && res.view && res.view.hash) view.hash = res.view.hash;
  };
  const step = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  return {
    get pushed() { return view !== null; },
    loading: () => step(async () => { if (!view) await push(); }),
    show: (message) => step(async () => {
      replies.push(message);
      try {
        await (view ? update() : push());
      } catch (err) {
        replies.pop();
        throw err;
      }
    }),
  };
}

module.exports = {
  modalTitle, limitBlocks, splitText, messageBlocks, modalView, fromModal, hasViews, failureReason, pushedView,
  MAX_BLOCKS, MAX_TITLE, MAX_SECTION_TEXT, LOADING,
};
