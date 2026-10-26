'use strict';

// Hub modals (as on the reference platform). A hub command opens its menu as a modal; Open
// and Help push a view on top of it, so Slack's back arrow returns to the
// menu. A module's replies render into its pushed view: the view first shows
// "Loading…", the first reply replaces that, and each later reply is appended
// below the earlier ones (several replies all stay visible, as they did as
// separate ephemeral messages). Views carry the hub id as private_metadata and
// nothing else, never person data. A scoped pull's form clicks (Story 9.3)
// re-render the module view in place (updatedView), never pushing a third.
// A message may carry modal options (message.modal: { submit, callbackId,
// privateMetadata }) for the view it renders in: a form has input blocks, and
// Slack rejects a modal with an input block and no submit.
//
// Slack's limits: a modal title is at most 24 characters, a view at most 100
// blocks, a section's text at most 3000 characters. Titles are cut with "…",
// long text is split into several sections by the shared splitter
// (kit/runtime/slack/format), and a view over 100 blocks keeps its first
// blocks plus a "more…" note (a menu keeps its Help at the end).
//
// Text passes through unchanged: it is already escaped by whoever built it
// (kit/runtime/messages, registry/menu, the module's own escapeText).

const { textBlocks } = require('./format');

const MAX_BLOCKS = 100;
const MAX_TITLE = 24;
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

// The blocks a reply shows in a view: its own blocks, else its text.
function messageBlocks(message) {
  if (typeof message === 'string') return textBlocks(message);
  if (message && Array.isArray(message.blocks) && message.blocks.length) return message.blocks;
  return textBlocks((message && message.text) || '');
}

// A modal with a Close (or Back) button, and a Submit only when asked (a form:
// Slack requires one on any view with an input block). private_metadata is
// the hub id unless privateMetadata says otherwise; never person data.
function modalView({
  title, blocks, hubId, close = 'Close', keepTail = 0, callbackId = 'hub:view', submit, privateMetadata,
}) {
  return {
    type: 'modal',
    callback_id: callbackId,
    title: { type: 'plain_text', text: modalTitle(title), emoji: false },
    close: { type: 'plain_text', text: close, emoji: false },
    ...(submit ? { submit: { type: 'plain_text', text: modalTitle(submit), emoji: false } } : {}),
    private_metadata: String(privateMetadata !== undefined ? privateMetadata : (hubId || '')),
    blocks: limitBlocks(blocks, { keepTail }),
  };
}

// The view a module message renders in: Back, callback hub:module, unless the
// message carries its own modal options (a form's submit, callback and
// metadata).
function moduleView({ title, hubId, blocks, message }) {
  const opts = (message && typeof message === 'object' && message.modal) || {};
  return modalView({
    title, hubId, blocks, close: 'Back',
    callbackId: opts.callbackId || 'hub:module',
    submit: opts.submit,
    privateMetadata: opts.privateMetadata,
  });
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
  const render = () => moduleView({
    title, hubId,
    blocks: replies.length ? replies.flatMap(messageBlocks) : textBlocks(LOADING),
    message: replies.at(-1),
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

// The view a click came from, updated in place and never pushed (Story 9.3).
// A form's buttons live in a module view, which is already the second view
// on the stack (menu, module), so every click re-renders that same view:
// views.update on its id, with the hash Slack sent in the click. show(message)
// resolves 'updated', or 'dropped' when Slack answered hash_conflict (the view
// changed since the click) and the out-of-date result was not shown. With
// { force: true } a conflict is retried once without the hash and resolves
// 'forced': only for a result that must not be lost (a consumed Confirm's
// outcome, which a "still running" notice from a double click may have beaten
// to the view). Any other failure throws. Calls run one at a time, each with
// the latest hash. The caller logs a dropped or forced result.
function updatedView({ client, view, title, hubId }) {
  let hash = view && typeof view.hash === 'string' ? view.hash : null;
  const viewId = view && view.id;
  let queue = Promise.resolve();
  const send = async (message, withHash) => {
    const res = await client.views.update({
      view_id: viewId,
      ...(withHash && hash ? { hash } : {}),
      view: moduleView({ title, hubId, blocks: messageBlocks(message), message }),
    });
    if (res && res.view && typeof res.view.hash === 'string') hash = res.view.hash;
  };
  const show = (message, { force = false } = {}) => {
    const next = queue.then(async () => {
      try {
        await send(message, true);
        return 'updated';
      } catch (err) {
        if (failureReason(err) !== HASH_CONFLICT) throw err;
        if (!force) return 'dropped';
        await send(message, false);
        return 'forced';
      }
    });
    queue = next.catch(() => {});
    return next;
  };
  return { show };
}

const HASH_CONFLICT = 'hash_conflict';

module.exports = {
  modalTitle, limitBlocks, messageBlocks, modalView, moduleView, fromModal, hasViews, failureReason, pushedView,
  updatedView, MAX_BLOCKS, MAX_TITLE, LOADING, HASH_CONFLICT,
};
