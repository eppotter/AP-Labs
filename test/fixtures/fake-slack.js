'use strict';

// A fake Bolt App for runtime tests: records listeners and replies, never
// touches the network.
//
//   dispatchMessage(message, { body, context })  every message listener, the
//       way Bolt runs them for a message event (no ack; say posts to the same
//       channel). body carries event_id for de-duplication tests.
//   dispatchCommand(command, { user_id })        the listener for that slash
//       command, with ack, respond and a trigger_id.
//   dispatchAction(action_id, { user, view, value })  every action listener
//       whose pattern matches, with ack and respond. value is the button's
//       value (default: the action id's first part). With option (an
//       overflow's option object, Story 15.16) the action is an overflow
//       click as Slack sends it: { type: 'overflow', action_id,
//       selected_option: { text, value } }, with no value of its own. With view (a modal the click
//       came from), the body carries it, a container of type view and a
//       trigger_id, and there is no respond (Slack sends no response_url for a
//       click inside a modal).
//   dispatchEvent(type, event, { body })         every listener for that event
//       type (no ack). body carries event_id for de-duplication tests.
//
// Replies land in this.said (say and postEphemeral), this.responded
// (respond) and this.posted (chat.postMessage); this.acks counts acks. users.info answers from this.users.
//
// chat.postMessage (Story 16.6), refused as Slack refuses it: a channel id
// (C… or G…) the bot isn't a member of answers not_in_channel, and text over
// 40,000 characters msg_too_long; a refused post is not recorded in
// this.posted (it lands in this.refusedPosts). The bot is a member of the
// channels named in new FakeSlackApp({ channels: [...] }) and of any added to
// this.memberOf later. A DM (D…) or a person (U…, which opens their DM) is
// always accepted. Each post's args are recorded whole, unfurl_links and
// unfurl_media included. Set this.postGate to a promise and every post waits
// for it first (a slow Slack, for double clicks).
//
// Files (Story 9.5): conversations.open({ users }) opens the bot's DM with one
// person, recorded in this.dms as { user, channel } (channel "D" + the user
// id without its "U"). files.uploadV2(args) records args in this.uploads and
// answers the way the Slack client does ({ files: [{ files: [{ id, permalink
// }] }] }). Like Slack, it rejects an upload without a filename or without
// content (invalid_arguments), and, stricter than Slack, one using the
// retired channels / channel arguments. Like Slack (Story 15.1), it accepts
// an upload with no channel_id: the file is shared nowhere. The check that
// deliverCsv names the person's DM lives in deliverCsv's own test
// (scoped-pull-run.test.js), not here. Set this.filesFail (an error) to make
// the upload throw, or this.dmChannel(user) to answer conversations.open with
// another channel id.
//
// File not ready yet (Story 15.1 live check, 2026-10-26): set
// this.filesNotReadyFor = N and every file uploaded after that is refused in
// an image block's slack_file for its first N views calls, the way the real
// API answered views.update 0.5 s after the upload: a WebAPIPlatformError
// (code slack_webapi_platform_error) whose data is { ok: false, error:
// 'invalid_arguments', response_metadata: { messages: ['[ERROR] invalid
// slack file [json-pointer:view/blocks/<i>/slack_file.id/slack_file]'] } }.
// Infinity refuses it for good.
//
// files.delete({ file }) (Story 15.1) records the id in this.deleted. Like
// Slack, an id never uploaded is file_not_found and one already deleted is
// file_deleted. Set this.deleteFail (an error) to make every delete throw.
//
// Rate limits (Story 15.4, F10): add 'files.uploadV2' or 'files.delete' to
// this.rateLimited and that call answers Slack's ratelimited error (data {
// ok: false, error: 'ratelimited' }, retryAfter 30), recording nothing.
//
// Views (Story 15.4, F10), each refused as Slack refuses it: a title over 24
// characters, more than 100 blocks, private_metadata over 3000 characters,
// a section's text over 3000 characters, a static_select with more than 100
// options or an option's text over 75 characters (or an initial_option that
// is not one of its options), a datepicker initial_date not written
// YYYY-MM-DD, a select or date picker outside an actions, section or input
// block, an actions block with more than 25 elements, and an image block
// whose slack_file id this workspace never uploaded or has deleted (answered
// like a file not ready: invalid_arguments, "invalid slack file"). Story
// 15.14 adds: two blocks with the same block_id, two elements with the same
// action_id in one block, a button value over 2000 characters, a button's
// text over 75 characters, and an accessibility_label over 75 characters
// (invalid_blocks). A reused slack_file id that was deleted is refused like
// any deleted one. Story 15.16 adds the overflow menu, refused as Slack
// refuses it (invalid_blocks): fewer than 2 or more than 5 options, an
// option's text not plain_text of 1 to 75 characters, an option's value
// missing or over 150 characters, and an accessibility_label (an overflow
// has none). Story 15.17 adds the header block and a section's fields
// (invalid_blocks): a header's text not plain_text of 1 to 150 characters,
// more than 10 fields, a field's text over 2000 characters. Story 17.2 (the
// hub status menu) adds the context block (invalid_blocks): no elements or
// more than 10, and an element's text empty or over 3000 characters; and
// relies on views.open answering the view's id and hash, as Slack does, for
// the menu's late update. Story 17.3 (Why?) adds the view stack: Slack
// holds at most 3 views (the opened one and two pushed on it), and a
// views.push from a click in the third answers push_limit_reached. Each
// click's trigger_id remembers the view it came from; a view this fake
// never opened or pushed (a test's own) counts as the first. this.parentOf
// (view id) is the view a pushed one was pushed from (Slack's back arrow
// returns there), and this.depthOf(view id) its place in the stack. With
// this.checkHashes set, a views.update whose hash is not the view's current
// one (for a view this fake opened or pushed) answers hash_conflict, as
// Slack does; it is off by default because older tests replay a click's
// first hash.
//
// Story 16.5 (Add context) adds, each refused as Slack refuses it
// (invalid_blocks; docs.slack.dev/reference/block-kit/block-elements/
// plain-text-input-element, .../blocks/input-block, .../composition-objects/
// confirmation-dialog-object): a plain_text_input outside an input block; its
// max_length outside 1 to 3000, min_length outside 0 to 3000 or over
// max_length, a placeholder not plain_text of 1 to 150 characters, an
// initial_value longer than max_length; an input block with no element, a
// label not plain_text of 1 to 2000 characters, or a hint over 2000; a
// button style other than primary or danger; a confirm dialog whose title,
// confirm or deny is not plain_text (title at most 100, confirm and deny at
// most 30), whose text is over 300, or whose style is not primary or danger.
// A view_submission ack (dispatchView) is checked like a views call: an
// update's view as above, and an errors object whose keys are not block_ids
// of input blocks in the submitted view, or whose messages are not
// non-empty text, makes the ack throw (Slack shows the person its own
// error). closeView(id) marks a view the person closed: a views.update on it
// then answers not_found, as Slack does.
//
// Story 16.8 (Add context, upload a file) adds, each as Slack does it
// (docs.slack.dev/reference/block-kit/block-elements/file-input-element,
// .../methods/files.info):
//   - this.scopes, the bot's scopes (files:read among them by default).
//     files.info without files:read answers missing_scope, and so does a
//     views call whose view holds a file_input ("your app must have the
//     files:read scope").
//   - addSlackFile({ id, name, user, mimetype, bytes, size }) puts a file in
//     the workspace, as if the person uploaded it through a file_input; it
//     returns the file object Slack sends. fileState(file) is that file as
//     the view_submission carries it in state.values ({ type: 'file_input',
//     files: [file] }). files.delete({ file }) deletes it too.
//   - client.files.info({ file }): the file object, with
//     url_private_download on files.slack.com. An unknown id is
//     file_not_found, a deleted one file_deleted, no id invalid_arguments;
//     set this.filesInfoFail (an error) to make it throw.
//   - this.fetch(url, init): Slack's file server, for the download. Every
//     request is recorded in this.fetches ({ url, headers, redirect }),
//     whatever its host, so a test can prove none was made. Like Slack, a
//     request without the bot token (Authorization: Bearer this.botToken)
//     gets a 200 web page (text/html), not the file. Like fetch, a 3xx with
//     redirect 'error' rejects (TypeError, "fetch failed"), a 3xx with
//     'follow' (fetch's default) is followed, headers and all, and an aborted
//     signal rejects the call or errors the body (AbortError).
//     this.downloadAs[id] changes how one file is served: { redirect: url },
//     { status }, { html: true }, { noLength: true } (no Content-Length),
//     { slowMs } (the rest of the body after slowMs), { length } (a
//     Content-Length that lies), { contentType } (another Content-Type), and
//     { body, okStatus } (another body, sent with a 2xx status: what a
//     server error page in JSON looks like when it comes back with 200).
//   - a file_input element, refused as Slack refuses it (invalid_blocks):
//     outside an input block; max_files not an integer from 1 to 10;
//     filetypes not a non-empty list of file extensions (lowercase letters
//     and digits, no dot: Slack takes extensions, so "application/pdf" or
//     ".pdf" is unknown).
//
// Story 19.5 (Add a stop) adds the external_select and its options load
// (docs.slack.dev/reference/block-kit/block-elements/select-menu-element
// #external_select, .../interactivity/handling-user-interaction
// #block_suggestion), each refused as Slack refuses it:
//   - an external_select (invalid_blocks) holding options or option_groups
//     (Slack asks the app for them), a placeholder not plain_text of 1 to 150
//     characters, a min_query_length not a whole number of 0 or more, or an
//     initial_option whose text is not plain_text of 1 to 75 characters or
//     whose value is missing or over 150; outside an actions, section or
//     input block, like any select.
//   - options(constraint, fn) registers a block_suggestion listener, as in
//     Bolt: a string or RegExp is the action_id; an object may name
//     action_id and block_id. dispatchOptions(action_id, { user, view, value,
//     block_id }) runs every matching listener with Bolt's arguments (body
//     and payload: { type: 'block_suggestion', user, action_id, block_id,
//     value, view, container }) and an ack whose payload is recorded in
//     this.optionAcks. The ack throws (invalid_options) on a payload Slack
//     would refuse: not exactly one of options and option_groups, more than
//     100 options, an option whose text is not plain_text of 1 to 75
//     characters or whose value is missing or over 150; and on a second ack
//     for the same request. Returns how many listeners ran.
//
// new FakeSlackApp({ views: true }) adds client.views: open, push and update
// record { method, args } in this.views and answer with a view id and a fresh
// hash; set this.viewsFail[method] to an error to make that call throw.
// Like Slack, a modal view with an input block and no submit is rejected
// (invalid_arguments; docs.slack.dev/reference/views/modal-views), and so is
// an image block (docs.slack.dev/reference/block-kit/blocks/image-block) with
// both image_url and slack_file or neither, no alt_text, or alt_text over
// 2000 characters (invalid_blocks). Like Slack, views.open and views.push
// with a trigger_id more than 3 seconds old (by Date.now(), so node:test's
// mock.timers moves it) answer expired_trigger_id; expireTriggers() ages
// every trigger handed out so far.
//
//   dispatchViewClosed(callback_id, { user, view, is_cleared })  every
//       view_closed listener for that callback_id (registered with
//       app.view({ callback_id, type: 'view_closed' }, fn), as in Bolt), with
//       an ack. Returns how many ran.
//
//   dispatchView(callback_id, { user, view })    the view_submission listener
//       for that callback_id, with an ack that records its payload in
//       this.viewAcks (undefined for an empty ack). Returns how many ran.
//
// Connection events (Story 11.2): like a Bolt socketMode app, the fake has
// this.receiver.client, an EventEmitter standing in for the Socket Mode
// client. start() emits "connected" on it, the way Bolt's start() resolves on
// the first connected event; set this.connectOnStart = false (in a subclass
// constructor) for an app that starts but never connects.
//   connect()     emits "connected" (a reconnect succeeded)
//   disconnect()  emits "reconnecting" (the socket dropped; the client retries)
//   close()       emits "disconnected" (the client gave up or was stopped)

const { EventEmitter } = require('node:events');

class FakeSlackApp {
  constructor(options) {
    // What the app was made with (Bolt's App options). Not this.options:
    // that is Bolt's options() listener method (Story 19.5).
    this.appOptions = options;
    this.messageListeners = [];
    this.commandListeners = new Map();
    this.actionListeners = [];
    this.optionsListeners = [];
    this.optionAcks = [];
    this.viewListeners = [];
    this.viewAcks = [];
    this.eventListeners = new Map();
    this.errorHandler = null;
    this.started = false;
    this.receiver = { client: new EventEmitter() };
    this.connectOnStart = true;
    this.said = [];
    this.responded = [];
    this.posted = [];
    this.refusedPosts = [];
    this.memberOf = new Set((options && options.channels) || []);
    this.postGate = null;
    this.acks = 0;
    this.users = {};
    this.views = [];
    this.viewsFail = {};
    this.viewSeq = 0;
    this.dms = [];
    this.uploads = [];
    this.filesFail = null;
    this.deleted = [];
    this.files = new Set();
    this.deleteFail = null;
    this.filesNotReadyFor = 0;
    this.rateLimited = new Set();
    this.hashes = new Map(); // view id -> its current hash
    this.checkHashes = false;
    this.notReady = new Map(); // file id -> views calls still refused
    this.triggers = new Map();
    this.closed = new Set(); // view ids the person closed (closeView)
    this.triggerViews = new Map(); // trigger_id -> the view the click came from
    this.depths = new Map(); // view id -> its place in the stack (1 = opened)
    this.parents = new Map(); // pushed view id -> the view it was pushed from
    this.scopes = new Set(FAKE_BOT_SCOPES);
    this.botToken = FAKE_BOT_TOKEN;
    this.slackFiles = new Map(); // file id -> { file, bytes }
    this.filesInfoFail = null;
    this.fetches = [];
    this.downloadAs = {};
    this.fetch = (url, init) => this.serveFile(url, init);
    this.dmChannel = (user) => `D${String(user).replace(/^U/, '')}`;
    this.client = {
      conversations: {
        open: async ({ users } = {}) => {
          if (typeof users !== 'string' || !users || users.includes(',')) throw slackError('invalid_arguments', 'users must name one person');
          const channel = this.dmChannel(users);
          this.dms.push({ user: users, channel });
          return { ok: true, channel: { id: channel } };
        },
      },
      files: {
        uploadV2: async (args = {}) => {
          const bad = invalidUpload(args);
          if (bad) throw slackError('invalid_arguments', bad);
          if (this.rateLimited.has('files.uploadV2')) throw rateLimitedError();
          this.uploads.push(args);
          if (this.filesFail) throw this.filesFail;
          const id = `F${this.uploads.length}`;
          this.files.add(id);
          if (this.filesNotReadyFor > 0) this.notReady.set(id, this.filesNotReadyFor);
          return {
            ok: true,
            files: [{ ok: true, files: [{ id, name: args.filename, title: args.title || args.filename, permalink: `https://fake.slack.test/files/${id}` }] }],
          };
        },
        delete: async (args = {}) => {
          const { file } = args;
          if (typeof file !== 'string' || !file) throw slackError('invalid_arguments', 'file is required');
          if (this.deleteFail) throw this.deleteFail;
          if (this.rateLimited.has('files.delete')) throw rateLimitedError();
          if (this.deleted.includes(file)) throw slackError('file_deleted', 'already deleted');
          if (!this.files.has(file)) throw slackError('file_not_found', 'no such file');
          this.deleted.push(file);
          return { ok: true };
        },
        info: async (args = {}) => {
          if (!this.scopes.has('files:read')) throw slackError('missing_scope', 'files:read is needed');
          const { file } = args;
          if (typeof file !== 'string' || !file) throw slackError('invalid_arguments', 'file is required');
          if (this.filesInfoFail) throw this.filesInfoFail;
          if (this.deleted.includes(file)) throw slackError('file_deleted', 'the file has been deleted');
          const held = this.slackFiles.get(file);
          if (!held) throw slackError('file_not_found', 'no such file');
          return { ok: true, file: { ...held.file } };
        },
      },
      chat: {
        postEphemeral: async (args) => { this.said.push({ ephemeral: true, ...args }); return { ok: true }; },
        postMessage: async (args = {}) => {
          if (this.postGate) await this.postGate;
          const why = this.refusedPost(args);
          if (why) {
            this.refusedPosts.push({ args, error: why[0] });
            throw slackError(why[0], why[1]);
          }
          this.posted.push(args);
          return { ok: true, channel: args.channel, ts: `${Date.now() / 1000}` };
        },
      },
      users: {
        info: async ({ user }) => {
          if (!this.users[user]) throw new Error('user_not_found');
          return { ok: true, user: this.users[user] };
        },
      },
    };
    if (options && options.views) {
      const call = (method) => async (args) => {
        this.views.push({ method, args });
        if (this.viewsFail[method]) throw this.viewsFail[method];
        if (method === 'update' && this.closed.has(args.view_id)) throw slackError('not_found', 'the view is closed');
        if ((method === 'open' || method === 'push') && this.triggerExpired(args.trigger_id)) {
          throw slackError('expired_trigger_id', 'the trigger_id is more than 3 seconds old');
        }
        const parent = method === 'push' ? (this.triggerViews.get(args.trigger_id) || null) : null;
        const depth = method === 'push' ? (this.depths.get(parent) || 1) + 1 : 1;
        if (depth > MAX_VIEW_STACK) throw slackError('push_limit_reached', `a view stack holds at most ${MAX_VIEW_STACK} views`);
        if (viewHasFileInput(args.view) && !this.scopes.has('files:read')) throw slackError('missing_scope', 'a file_input needs files:read');
        const bad = invalidModal(args.view);
        if (bad) throw Object.assign(new Error(`An API error occurred: invalid_arguments (${bad})`), { data: { ok: false, error: 'invalid_arguments' } });
        const badView = invalidView(args.view);
        if (badView) throw slackError('invalid_arguments', badView);
        const badBlock = invalidImageBlocks(args.view) || invalidElements(args.view);
        if (badBlock) throw slackError('invalid_blocks', badBlock);
        if (this.checkHashes && method === 'update' && typeof args.hash === 'string' && this.hashes.has(args.view_id) && this.hashes.get(args.view_id) !== args.hash) {
          throw slackError('hash_conflict', 'the view changed since that hash');
        }
        const unknown = this.unknownFileBlock(args.view);
        if (unknown !== null) throw notReadyError(unknown);
        const unready = this.unreadyFileBlock(args.view);
        if (unready !== null) throw notReadyError(unready);
        this.viewSeq += 1;
        const id = method === 'update' ? args.view_id : `V${this.viewSeq}`;
        if (method !== 'update' || this.hashes.has(id)) this.hashes.set(id, `h${this.viewSeq}`);
        if (method !== 'update') this.depths.set(id, depth);
        if (method === 'push') this.parents.set(id, parent);
        return { ok: true, view: { id, hash: `h${this.viewSeq}`, ...args.view } };
      };
      this.client.views = { open: call('open'), push: call('push'), update: call('update') };
    }
  }

  // [Slack's error code, why] for a chat.postMessage Slack would refuse, or
  // null (see the top).
  refusedPost(args) {
    const { channel, text } = args;
    if (typeof channel !== 'string' || !channel) return ['channel_not_found', 'channel is required'];
    if (/^[CG]/.test(channel) && !this.memberOf.has(channel)) return ['not_in_channel', 'the bot is not a member of that channel'];
    if (typeof text === 'string' && text.length > MAX_POST_TEXT) return ['msg_too_long', `text is over ${MAX_POST_TEXT} characters`];
    if ((typeof text !== 'string' || !text) && !Array.isArray(args.blocks)) return ['no_text', 'text or blocks is required'];
    return null;
  }

  // The index of the first image block whose file is not ready yet (and
  // counts that call against it), or null.
  unreadyFileBlock(view) {
    const blocks = view && Array.isArray(view.blocks) ? view.blocks : [];
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      const id = b && b.type === 'image' && b.slack_file && b.slack_file.id;
      if (!id || !(this.notReady.get(id) > 0)) continue;
      this.notReady.set(id, this.notReady.get(id) - 1);
      return i;
    }
    return null;
  }

  // The index of the first image block naming a slack_file id this
  // workspace never uploaded or has deleted, or null.
  unknownFileBlock(view) {
    const blocks = view && Array.isArray(view.blocks) ? view.blocks : [];
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      const id = b && b.type === 'image' && b.slack_file && b.slack_file.id;
      if (id && (!this.files.has(id) || this.deleted.includes(id))) return i;
    }
    return null;
  }

  // A file the person uploaded (see the top). Returns Slack's file object.
  addSlackFile({
    id, name, user, mimetype = 'application/octet-stream', bytes, size,
  }) {
    const data = Buffer.from(bytes);
    const file = {
      id,
      created: 1761815700,
      timestamp: 1761815700,
      name,
      title: name,
      mimetype,
      filetype: String(name).split('.').pop().toLowerCase(),
      user,
      size: size === undefined ? data.length : size,
      mode: 'hosted',
      is_external: false,
      is_public: false,
      url_private: `https://files.slack.com/files-pri/T0FAKE-${id}/${encodeURIComponent(name)}`,
      url_private_download: `https://files.slack.com/files-pri/T0FAKE-${id}/download/${encodeURIComponent(name)}`,
      permalink: `https://fake.slack.test/files/${user}/${id}/${encodeURIComponent(name)}`,
    };
    this.slackFiles.set(id, { file, bytes: data });
    this.files.add(id);
    return { ...file };
  }

  // Slack's file server (see the top).
  async serveFile(url, init = {}) {
    const headers = { ...(init.headers || {}) };
    this.fetches.push({ url: String(url), headers, redirect: init.redirect });
    const { signal } = init;
    if (signal && signal.aborted) throw abortError();
    const u = new URL(url);
    const held = u.hostname === 'files.slack.com' ? [...this.slackFiles.values()].find((f) => f.file.url_private_download === u.href) : null;
    const how = (held && this.downloadAs[held.file.id]) || {};
    if (how.redirect) {
      if (init.redirect === 'error') throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
      if (init.redirect === 'manual') return new Response(null, { status: 302, headers: { location: how.redirect } });
      return this.serveFile(how.redirect, { ...init, headers });
    }
    if (!held || this.deleted.includes(held.file.id)) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (how.status) return new Response('error', { status: how.status, headers: { 'content-type': 'text/plain' } });
    if (how.html || headers.Authorization !== `Bearer ${this.botToken}`) {
      return new Response('<!DOCTYPE html><html><body>Sign in to Slack</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    const out = { 'content-type': how.contentType || held.file.mimetype };
    if (how.body !== undefined) {
      const body = Buffer.from(how.body);
      return new Response(bodyStream(body, { signal }), { status: how.okStatus || 200, headers: { ...out, 'content-length': String(body.length) } });
    }
    if (!how.noLength) out['content-length'] = String(how.length === undefined ? held.bytes.length : how.length);
    return new Response(bodyStream(held.bytes, { slowMs: how.slowMs, signal }), { status: 200, headers: out });
  }

  // A trigger handed out now (Slack's lasts 3 seconds).
  issueTrigger(id) {
    this.triggers.set(id, Date.now());
    return id;
  }

  triggerExpired(id) {
    if (!this.triggers.has(id)) return false;
    return Date.now() - this.triggers.get(id) > TRIGGER_MS;
  }

  // The view a pushed view was pushed from, and a view's place in the stack.
  parentOf(id) { return this.parents.has(id) ? this.parents.get(id) : null; }

  depthOf(id) { return this.depths.get(id) || null; }

  // The person closed this view (Back or the X): later updates are not_found.
  closeView(id) { this.closed.add(id); }

  expireTriggers() {
    for (const id of this.triggers.keys()) this.triggers.set(id, -Infinity);
  }

  message(fn) { this.messageListeners.push(fn); }

  command(name, fn) { this.commandListeners.set(name, fn); }

  action(pattern, fn) { this.actionListeners.push({ pattern, fn }); }

  view(callbackId, fn) { this.viewListeners.push({ callbackId, fn }); }

  options(constraint, fn) { this.optionsListeners.push({ constraint, fn }); }

  // A block_suggestion (Story 19.5): the person typed value into an
  // external_select in view. Returns how many listeners ran.
  async dispatchOptions(action_id, {
    user = { id: 'U1', name: 'u1' }, view, value = '', block_id = 'block',
  } = {}) {
    const body = {
      type: 'block_suggestion', user, action_id, block_id, value, ...(view ? { view, container: { type: 'view', view_id: view.id } } : { container: {} }),
    };
    const matching = this.optionsListeners.filter(({ constraint }) => matchesOptions(constraint, action_id, block_id));
    for (const { fn } of matching) {
      let acked = 0;
      const ack = async (payload) => {
        acked += 1;
        this.acks += 1;
        if (acked > 1) throw slackError('invalid_options', 'a request is acked once');
        this.optionAcks.push(payload);
        const bad = invalidOptionsAck(payload);
        if (bad) throw slackError('invalid_options', bad);
      };
      await fn({
        options: body, payload: body, body, ack, client: this.client,
      });
    }
    return matching.length;
  }

  // Returns how many listeners ran.
  async dispatchView(callback_id, { user = { id: 'U1', name: 'u1' }, view = {} } = {}) {
    const full = { type: 'modal', callback_id, ...view };
    const body = { type: 'view_submission', user, view: full };
    const matching = this.viewListeners.filter(({ callbackId }) => matchesView(callbackId, callback_id, 'view_submission'));
    for (const { fn } of matching) {
      const ack = async (payload) => {
        this.acks += 1;
        this.viewAcks.push(payload);
        const bad = invalidViewAck(payload, full);
        if (bad) throw slackError('invalid_response_action', bad);
      };
      await fn({ body, view: full, ack, client: this.client });
    }
    return matching.length;
  }

  // Returns how many listeners ran.
  async dispatchViewClosed(callback_id, { user = { id: 'U1', name: 'u1' }, view = {}, is_cleared = false } = {}) {
    const full = { type: 'modal', callback_id, ...view };
    const body = {
      type: 'view_closed', user, view: full, is_cleared,
    };
    const matching = this.viewListeners.filter(({ callbackId }) => matchesView(callbackId, callback_id, 'view_closed'));
    for (const { fn } of matching) {
      await fn({ body, view: full, ack: this.ack(), client: this.client });
    }
    return matching.length;
  }

  event(type, fn) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
    this.eventListeners.get(type).push(fn);
  }

  error(fn) { this.errorHandler = fn; }

  async start() {
    if (this.appOptions && this.appOptions.failStart) throw this.appOptions.failStart;
    this.started = true;
    if (this.connectOnStart) this.connect();
  }

  connect() { this.receiver.client.emit('connected'); }

  disconnect() { this.receiver.client.emit('reconnecting'); }

  close() { this.receiver.client.emit('disconnected'); }

  async stop() { this.started = false; }

  async dispatchMessage(message, { body = {}, context = {} } = {}) {
    const say = async (arg) => {
      const text = typeof arg === 'string' ? arg : arg.text;
      this.said.push({ channel: message.channel, text });
      return { ok: true };
    };
    for (const fn of this.messageListeners) await fn({ message, say, body, context, client: this.client });
  }

  ack() { return async () => { this.acks += 1; }; }

  respond() { return async (msg) => { this.responded.push(msg); return { ok: true }; }; }

  async dispatchCommand(name, { user_id = 'U1', text = '' } = {}) {
    const fn = this.commandListeners.get(name);
    if (!fn) throw new Error(`no listener for ${name}`);
    const command = { command: name, user_id, text, trigger_id: this.issueTrigger('T-command') };
    await fn({ command, body: command, ack: this.ack(), respond: this.respond(), client: this.client });
  }

  // Returns how many listeners ran (0 = Bolt would find no listener).
  // action: extra fields for a select or date click, for example { type:
  // 'static_select', selected_option: { value } } or { type: 'datepicker',
  // selected_date } (Story 15.4).
  async dispatchAction(action_id, {
    user = { id: 'U1', name: 'u1' }, view, value, action: extra, option,
  } = {}) {
    let action;
    if (option) action = { type: 'overflow', action_id, selected_option: { text: option.text, value: option.value } };
    else if (extra) action = { action_id, ...extra };
    else action = { type: 'button', action_id, value: value === undefined ? action_id.split(':')[0] : value };
    const body = { type: 'block_actions', user, actions: [action] };
    if (view) {
      Object.assign(body, { view, container: { type: 'view', view_id: view.id }, trigger_id: this.issueTrigger('T-action') });
      this.triggerViews.set(body.trigger_id, view.id);
    }
    const matching = this.actionListeners.filter(({ pattern }) => (
      pattern instanceof RegExp ? pattern.test(action_id) : pattern === action_id));
    for (const { fn } of matching) {
      const args = { action, body, ack: this.ack(), client: this.client };
      if (!view) args.respond = this.respond();
      await fn(args);
    }
    return matching.length;
  }

  // Returns how many listeners ran.
  async dispatchEvent(type, event, { body = {} } = {}) {
    const fns = this.eventListeners.get(type) || [];
    const ev = { type, ...event };
    for (const fn of fns) await fn({ event: ev, body: { type: 'event_callback', event: ev, ...body }, client: this.client });
    return fns.length;
  }
}

const TRIGGER_MS = 3000;
const MAX_POST_TEXT = 40000;
const MAX_ALT = 2000;
const MAX_TITLE = 24;
const MAX_VIEW_BLOCKS = 100;
const MAX_VIEW_STACK = 3;
const MAX_METADATA = 3000;
const MAX_SECTION_TEXT = 3000;
const MAX_OPTIONS = 100;
const MAX_OPTION_TEXT = 75;
const MAX_ACTIONS_ELEMENTS = 25;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BLOCK_ID = 255;
const MAX_BUTTON_TEXT = 75;
const MAX_BUTTON_VALUE = 2000;
const MAX_ACCESSIBILITY_LABEL = 75;
const SELECTS = new Set(['static_select', 'external_select', 'datepicker']);
const MIN_OVERFLOW_OPTIONS = 2;
const MAX_OVERFLOW_OPTIONS = 5;
const MAX_OPTION_VALUE = 150;
const MAX_HEADER_TEXT = 150;
const MAX_FIELDS = 10;
const MAX_FIELD_TEXT = 2000;
const MAX_CONTEXT_ELEMENTS = 10;
const MAX_CONTEXT_TEXT = 3000;

// Why Slack would reject this view's frame (title, blocks, metadata), or null.
function invalidView(view) {
  if (!view || view.type !== 'modal') return null;
  const title = view.title && view.title.text;
  if (typeof title === 'string' && Array.from(title).length > MAX_TITLE) return `title is over ${MAX_TITLE} characters`;
  if (Array.isArray(view.blocks) && view.blocks.length > MAX_VIEW_BLOCKS) return `a view holds at most ${MAX_VIEW_BLOCKS} blocks`;
  if (typeof view.private_metadata === 'string' && view.private_metadata.length > MAX_METADATA) return `private_metadata is over ${MAX_METADATA} characters`;
  return null;
}

// Why Slack would reject a select, date picker, actions block or section
// in this view, or null.
function invalidElements(view) {
  const blocks = view && Array.isArray(view.blocks) ? view.blocks : [];
  const blockIds = new Set();
  for (const b of blocks) {
    if (!b) continue;
    if (b.block_id !== undefined) {
      if (typeof b.block_id !== 'string' || !b.block_id || b.block_id.length > MAX_BLOCK_ID) return `a block_id is 1 to ${MAX_BLOCK_ID} characters`;
      if (blockIds.has(b.block_id)) return 'block_id must be unique in a view';
      blockIds.add(b.block_id);
    }
    if (b.type === 'section' && b.text && typeof b.text.text === 'string' && b.text.text.length > MAX_SECTION_TEXT) return `a section's text is over ${MAX_SECTION_TEXT} characters`;
    if (b.type === 'header') {
      const text = b.text && b.text.text;
      if (!b.text || b.text.type !== 'plain_text' || typeof text !== 'string' || !text || Array.from(text).length > MAX_HEADER_TEXT) return `a header's text is plain_text of 1 to ${MAX_HEADER_TEXT} characters`;
    }
    if (b.type === 'context') {
      if (!Array.isArray(b.elements) || b.elements.length === 0 || b.elements.length > MAX_CONTEXT_ELEMENTS) return `a context block holds 1 to ${MAX_CONTEXT_ELEMENTS} elements`;
      for (const e of b.elements) {
        if (e && (e.type === 'mrkdwn' || e.type === 'plain_text') && (typeof e.text !== 'string' || !e.text || e.text.length > MAX_CONTEXT_TEXT)) {
          return `a context element's text is 1 to ${MAX_CONTEXT_TEXT} characters`;
        }
      }
    }
    if (b.type === 'section' && b.fields !== undefined) {
      if (!Array.isArray(b.fields) || b.fields.length === 0 || b.fields.length > MAX_FIELDS) return `a section holds 1 to ${MAX_FIELDS} fields`;
      if (b.fields.some((f) => !f || typeof f.text !== 'string' || !f.text || f.text.length > MAX_FIELD_TEXT)) return `a field's text is 1 to ${MAX_FIELD_TEXT} characters`;
    }
    if (b.type === 'actions' && (!Array.isArray(b.elements) || b.elements.length > MAX_ACTIONS_ELEMENTS)) return `an actions block holds 1 to ${MAX_ACTIONS_ELEMENTS} elements`;
    if (b.type === 'input') {
      const bad = invalidInput(b);
      if (bad) return bad;
    } else if ([b.accessory, ...(Array.isArray(b.elements) ? b.elements : [])].some((e) => e && e.type === 'plain_text_input')) {
      return 'a plain_text_input belongs in an input block';
    } else if ([b.accessory, b.element, ...(Array.isArray(b.elements) ? b.elements : [])].some((e) => e && e.type === 'file_input')) {
      return 'a file_input belongs in an input block';
    }
    const elements = b.type === 'actions' ? b.elements : [b.accessory, b.element].filter(Boolean);
    const actionIds = new Set();
    for (const e of elements) {
      const actionId = e && e.action_id;
      if (actionId !== undefined) {
        if (actionIds.has(actionId)) return 'action_id must be unique in a block';
        actionIds.add(actionId);
      }
      const bad = invalidElement(e);
      if (bad) return bad;
    }
    if (!['actions', 'section', 'input'].includes(b.type) && Array.isArray(b.elements) && b.elements.some((e) => e && SELECTS.has(e.type))) {
      return `a ${b.type} block cannot hold a select or date picker`;
    }
  }
  return null;
}

function invalidElement(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.type === 'file_input') {
    if (e.max_files !== undefined && (!Number.isInteger(e.max_files) || e.max_files < 1 || e.max_files > MAX_FILES)) return `a file_input's max_files is 1 to ${MAX_FILES}`;
    if (e.filetypes !== undefined && (!Array.isArray(e.filetypes) || !e.filetypes.length || e.filetypes.some((t) => typeof t !== 'string' || !FILE_EXTENSION.test(t)))) {
      return "a file_input's filetypes are file extensions";
    }
  }
  if (e.type === 'overflow') {
    if (e.accessibility_label !== undefined) return 'an overflow has no accessibility_label';
    if (!Array.isArray(e.options) || e.options.length < MIN_OVERFLOW_OPTIONS || e.options.length > MAX_OVERFLOW_OPTIONS) {
      return `an overflow holds ${MIN_OVERFLOW_OPTIONS} to ${MAX_OVERFLOW_OPTIONS} options`;
    }
    for (const o of e.options) {
      const text = o && o.text && o.text.text;
      if (!o || !o.text || o.text.type !== 'plain_text' || typeof text !== 'string' || !text || Array.from(text).length > MAX_OPTION_TEXT) return `an option's text is plain_text of 1 to ${MAX_OPTION_TEXT} characters`;
      if (typeof o.value !== 'string' || !o.value || o.value.length > MAX_OPTION_VALUE) return `an option needs a value of at most ${MAX_OPTION_VALUE} characters`;
    }
  }
  if (e.type === 'button') {
    const text = e.text && e.text.text;
    if (!e.text || e.text.type !== 'plain_text' || typeof text !== 'string' || !text || Array.from(text).length > MAX_BUTTON_TEXT) return `a button's text is plain_text of 1 to ${MAX_BUTTON_TEXT} characters`;
    if (e.value !== undefined && (typeof e.value !== 'string' || e.value.length > MAX_BUTTON_VALUE)) return `a button's value is at most ${MAX_BUTTON_VALUE} characters`;
    if (e.style !== undefined && !BUTTON_STYLES.has(e.style)) return "a button's style is primary or danger";
  }
  if (e.confirm !== undefined) {
    const bad = invalidConfirm(e.confirm);
    if (bad) return bad;
  }
  if (e.accessibility_label !== undefined && (typeof e.accessibility_label !== 'string' || !e.accessibility_label || Array.from(e.accessibility_label).length > MAX_ACCESSIBILITY_LABEL)) {
    return `an accessibility_label is 1 to ${MAX_ACCESSIBILITY_LABEL} characters`;
  }
  if (e.type === 'static_select') {
    if (!Array.isArray(e.options) || e.options.length === 0 || e.options.length > MAX_OPTIONS) return `a static_select holds 1 to ${MAX_OPTIONS} options`;
    for (const o of e.options) {
      const text = o && o.text && o.text.text;
      if (typeof text !== 'string' || !text || Array.from(text).length > MAX_OPTION_TEXT) return `an option's text is 1 to ${MAX_OPTION_TEXT} characters`;
      if (typeof o.value !== 'string' || !o.value || o.value.length > 150) return 'an option needs a value of at most 150 characters';
    }
    if (e.initial_option !== undefined && !e.options.some((o) => o.value === e.initial_option.value && o.text.text === (e.initial_option.text && e.initial_option.text.text))) {
      return 'initial_option must be one of the options';
    }
  }
  if (e.type === 'external_select') {
    if (e.options !== undefined || e.option_groups !== undefined) return 'an external_select takes no options: Slack asks the app for them';
    if (e.placeholder !== undefined) {
      const text = e.placeholder && e.placeholder.text;
      if (e.placeholder.type !== 'plain_text' || typeof text !== 'string' || !text || Array.from(text).length > MAX_PLACEHOLDER) return `a placeholder is plain_text of 1 to ${MAX_PLACEHOLDER} characters`;
    }
    if (e.min_query_length !== undefined && (!Number.isInteger(e.min_query_length) || e.min_query_length < 0)) return 'min_query_length is a whole number of 0 or more';
    if (e.initial_option !== undefined) {
      const bad = invalidOption(e.initial_option);
      if (bad) return bad;
    }
  }
  if (e.type === 'datepicker' && e.initial_date !== undefined && (typeof e.initial_date !== 'string' || !ISO_DATE.test(e.initial_date))) {
    return 'initial_date must be written YYYY-MM-DD';
  }
  return null;
}

// Why Slack would refuse one option object, or null (Story 19.5).
function invalidOption(o) {
  const text = o && o.text && o.text.text;
  if (!o || !o.text || o.text.type !== 'plain_text' || typeof text !== 'string' || !text || Array.from(text).length > MAX_OPTION_TEXT) {
    return `an option's text is plain_text of 1 to ${MAX_OPTION_TEXT} characters`;
  }
  if (typeof o.value !== 'string' || !o.value || o.value.length > MAX_OPTION_VALUE) return `an option needs a value of at most ${MAX_OPTION_VALUE} characters`;
  return null;
}

// Why Slack would refuse a block_suggestion's ack payload, or null (Story 19.5).
function invalidOptionsAck(payload) {
  if (!payload || typeof payload !== 'object') return 'the ack carries options';
  const hasOptions = payload.options !== undefined;
  const hasGroups = payload.option_groups !== undefined;
  if (hasOptions === hasGroups) return 'the ack carries exactly one of options and option_groups';
  if (hasGroups) return 'option_groups are not used here';
  if (!Array.isArray(payload.options) || payload.options.length > MAX_OPTIONS) return `the ack carries at most ${MAX_OPTIONS} options`;
  for (const o of payload.options) {
    const bad = invalidOption(o);
    if (bad) return bad;
  }
  return null;
}

// Bolt's options constraints: a string or RegExp is the action_id; an
// object may name action_id and block_id.
function matchesOptions(constraint, actionId, blockId) {
  const c = constraint && typeof constraint === 'object' && !(constraint instanceof RegExp)
    ? constraint : { action_id: constraint };
  const test = (want, got) => want === undefined || (want instanceof RegExp ? want.test(got) : want === got);
  return test(c.action_id, actionId) && test(c.block_id, blockId);
}

// Why Slack would refuse a view_submission's ack payload, or null (Story 16.5).
function invalidViewAck(payload, submitted) {
  if (payload === undefined || payload === null) return null;
  if (payload.response_action === 'errors') {
    const inputs = new Set((submitted.blocks || []).filter((b) => b && b.type === 'input').map((b) => b.block_id));
    const errors = payload.errors;
    if (!errors || typeof errors !== 'object' || !Object.keys(errors).length) return 'errors needs at least one block_id';
    for (const [key, text] of Object.entries(errors)) {
      if (!inputs.has(key)) return `errors names "${key}", which is not an input block in the view`;
      if (typeof text !== 'string' || !text) return 'an error message is non-empty text';
    }
    return null;
  }
  if (payload.response_action === 'update' || payload.response_action === 'push') {
    const v = payload.view;
    return invalidModal(v) || invalidView(v) || invalidImageBlocks(v) || invalidElements(v);
  }
  return null;
}

const MAX_FILES = 10;
const FILE_EXTENSION = /^[a-z0-9]{1,10}$/;
// Not a real token: the fake file server's stand-in for the bot token.
const FAKE_BOT_TOKEN = 'fake-bot-token-for-tests';
const FAKE_BOT_SCOPES = Object.freeze(['commands', 'chat:write', 'im:write', 'files:read', 'files:write', 'users:read']);

// True when a view holds a file_input anywhere.
function viewHasFileInput(view) {
  const blocks = view && Array.isArray(view.blocks) ? view.blocks : [];
  return blocks.some((b) => b && [b.element, b.accessory, ...(Array.isArray(b.elements) ? b.elements : [])].some((e) => e && e.type === 'file_input'));
}

// A file as a view_submission carries it in state.values (Story 16.8).
const fileState = (...files) => ({ type: 'file_input', files: files.map((f) => ({ ...f })) });

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError');
}

// A body that sends the first half at once and, with slowMs, the rest after
// slowMs. An abort errors it, as fetch's body does.
function bodyStream(bytes, { slowMs = 0, signal } = {}) {
  const half = Math.ceil(bytes.length / 2);
  let step = 0;
  let timer = null;
  return new ReadableStream({
    start(controller) {
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          try { controller.error(abortError()); } catch { /* already closed */ }
        }, { once: true });
      }
    },
    pull(controller) {
      if (step === 0) {
        step = 1;
        if (half) controller.enqueue(new Uint8Array(bytes.subarray(0, half)));
        return undefined;
      }
      if (step === 1) {
        step = 2;
        const rest = () => {
          if (bytes.length > half) controller.enqueue(new Uint8Array(bytes.subarray(half)));
          controller.close();
        };
        if (!slowMs) {
          rest();
          return undefined;
        }
        return new Promise((resolve) => {
          timer = setTimeout(() => {
            try { rest(); } catch { /* errored by an abort */ }
            resolve();
          }, slowMs);
        });
      }
      return undefined;
    },
  });
}

const MAX_INPUT_LENGTH = 3000;
const MAX_PLACEHOLDER = 150;
const MAX_LABEL = 2000;
const MAX_HINT = 2000;
const BUTTON_STYLES = new Set(['primary', 'danger']);
const isPlain = (t, max) => Boolean(t && t.type === 'plain_text' && typeof t.text === 'string' && t.text && Array.from(t.text).length <= max);

// Why Slack would refuse an input block or its plain_text_input, or null.
function invalidInput(b) {
  if (!b.element || typeof b.element !== 'object') return 'an input block needs an element';
  if (!isPlain(b.label, MAX_LABEL)) return `an input block's label is plain_text of 1 to ${MAX_LABEL} characters`;
  if (b.hint !== undefined && !isPlain(b.hint, MAX_HINT)) return `an input block's hint is plain_text of 1 to ${MAX_HINT} characters`;
  const e = b.element;
  if (e.type !== 'plain_text_input') return null;
  const max = e.max_length;
  if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > MAX_INPUT_LENGTH)) return `a plain_text_input's max_length is 1 to ${MAX_INPUT_LENGTH}`;
  const min = e.min_length;
  if (min !== undefined && (!Number.isInteger(min) || min < 0 || min > MAX_INPUT_LENGTH || (max !== undefined && min > max))) return `a plain_text_input's min_length is 0 to ${MAX_INPUT_LENGTH}, and at most max_length`;
  if (e.placeholder !== undefined && !isPlain(e.placeholder, MAX_PLACEHOLDER)) return `a placeholder is plain_text of 1 to ${MAX_PLACEHOLDER} characters`;
  if (e.initial_value !== undefined && (typeof e.initial_value !== 'string' || (max !== undefined && e.initial_value.length > max))) return 'an initial_value is text no longer than max_length';
  return null;
}

// Why Slack would refuse a confirmation dialog, or null.
function invalidConfirm(c) {
  if (!c || typeof c !== 'object') return 'a confirm is an object';
  if (!isPlain(c.title, 100)) return "a confirm's title is plain_text of 1 to 100 characters";
  const text = c.text && c.text.text;
  if (!c.text || !['plain_text', 'mrkdwn'].includes(c.text.type) || typeof text !== 'string' || !text || Array.from(text).length > 300) return "a confirm's text is 1 to 300 characters";
  if (!isPlain(c.confirm, 30)) return "a confirm's confirm is plain_text of 1 to 30 characters";
  if (!isPlain(c.deny, 30)) return "a confirm's deny is plain_text of 1 to 30 characters";
  if (c.style !== undefined && !BUTTON_STYLES.has(c.style)) return "a confirm's style is primary or danger";
  return null;
}

// Slack's answer when a method is called too often.
function rateLimitedError() {
  return Object.assign(new Error('An API error occurred: ratelimited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 30, data: { ok: false, error: 'ratelimited' } });
}

// Bolt's view constraints: a callback id (string or RegExp) is a
// view_submission; an object names its type (view_submission by default).
function matchesView(constraint, callbackId, type) {
  const c = constraint && typeof constraint === 'object' && !(constraint instanceof RegExp)
    ? constraint : { callback_id: constraint };
  if ((c.type || 'view_submission') !== type) return false;
  if (c.callback_id === undefined) return true;
  return c.callback_id instanceof RegExp ? c.callback_id.test(callbackId) : c.callback_id === callbackId;
}

// Why Slack would reject an image block in this view, or null.
function invalidImageBlocks(view) {
  const blocks = view && Array.isArray(view.blocks) ? view.blocks : [];
  for (const b of blocks) {
    if (!b || b.type !== 'image') continue;
    const hasUrl = b.image_url !== undefined;
    const hasFile = b.slack_file !== undefined;
    if (hasUrl && hasFile) return 'an image block takes image_url or slack_file, not both';
    if (!hasUrl && !hasFile) return 'an image block needs image_url or slack_file';
    if (hasFile) {
      const f = b.slack_file;
      const ok = f && typeof f === 'object' && ((typeof f.id === 'string' && f.id) || (typeof f.url === 'string' && f.url));
      if (!ok) return 'slack_file needs an id or a url';
    }
    if (typeof b.alt_text !== 'string' || !b.alt_text) return 'an image block needs alt_text';
    if (b.alt_text.length > MAX_ALT) return `alt_text is over ${MAX_ALT} characters`;
  }
  return null;
}

// An error shaped like the Slack client's API errors.
function slackError(code, why) {
  return Object.assign(new Error(`An API error occurred: ${code} (${why})`), { data: { ok: false, error: code } });
}

// The real API's answer for a slack_file it does not accept (yet), as the
// Slack client throws it.
function notReadyError(index) {
  return Object.assign(new Error('An API error occurred: invalid_arguments'), {
    name: 'WebAPIPlatformError',
    code: 'slack_webapi_platform_error',
    data: {
      ok: false,
      error: 'invalid_arguments',
      response_metadata: { messages: [`[ERROR] invalid slack file [json-pointer:view/blocks/${index}/slack_file.id/slack_file]`] },
    },
  });
}

// Why files.uploadV2 would be rejected, or null (see the top).
function invalidUpload(args) {
  if (args.channels !== undefined || args.channel !== undefined) return 'channels and channel are retired; use channel_id';
  if (args.channel_id !== undefined && (typeof args.channel_id !== 'string' || !args.channel_id)) return 'channel_id, when given, must name a conversation';
  if (typeof args.filename !== 'string' || !args.filename) return 'filename is required';
  const hasContent = typeof args.content === 'string' && args.content.length > 0;
  const hasFile = args.file !== undefined;
  if (!hasContent && !hasFile) return 'content or file is required';
  if (hasContent && hasFile) return 'give content or file, not both';
  if (hasFile && !(Buffer.isBuffer(args.file) && args.file.length > 0) && !(typeof args.file === 'string' && args.file)) return 'file must be non-empty bytes';
  return null;
}

// Why Slack would reject this modal view, or null.
function invalidModal(view) {
  if (!view || view.type !== 'modal') return null;
  const hasInput = Array.isArray(view.blocks) && view.blocks.some((b) => b && b.type === 'input');
  if (hasInput && !view.submit) return 'submit is required when an input block is within the blocks array';
  return null;
}

module.exports = {
  fileState, FAKE_BOT_TOKEN, FAKE_BOT_SCOPES,
  FakeSlackApp, invalidModal, invalidUpload, invalidImageBlocks, invalidView, invalidElements, invalidViewAck, invalidOptionsAck, notReadyError, rateLimitedError, TRIGGER_MS,
};
