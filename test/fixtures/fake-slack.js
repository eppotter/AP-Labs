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
//       value (default: the action id's first part). With view (a modal the click
//       came from), the body carries it, a container of type view and a
//       trigger_id, and there is no respond (Slack sends no response_url for a
//       click inside a modal).
//   dispatchEvent(type, event, { body })         every listener for that event
//       type (no ack). body carries event_id for de-duplication tests.
//
// Replies land in this.said (say and postEphemeral), this.responded
// (respond) and this.posted (chat.postMessage); this.acks counts acks. users.info answers from this.users.
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
    this.options = options;
    this.messageListeners = [];
    this.commandListeners = new Map();
    this.actionListeners = [];
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
    this.notReady = new Map(); // file id -> views calls still refused
    this.triggers = new Map();
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
          if (this.deleted.includes(file)) throw slackError('file_deleted', 'already deleted');
          if (!this.files.has(file)) throw slackError('file_not_found', 'no such file');
          this.deleted.push(file);
          return { ok: true };
        },
      },
      chat: {
        postEphemeral: async (args) => { this.said.push({ ephemeral: true, ...args }); return { ok: true }; },
        postMessage: async (args) => { this.posted.push(args); return { ok: true }; },
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
        if ((method === 'open' || method === 'push') && this.triggerExpired(args.trigger_id)) {
          throw slackError('expired_trigger_id', 'the trigger_id is more than 3 seconds old');
        }
        const bad = invalidModal(args.view);
        if (bad) throw Object.assign(new Error(`An API error occurred: invalid_arguments (${bad})`), { data: { ok: false, error: 'invalid_arguments' } });
        const badBlock = invalidImageBlocks(args.view);
        if (badBlock) throw slackError('invalid_blocks', badBlock);
        const unready = this.unreadyFileBlock(args.view);
        if (unready !== null) throw notReadyError(unready);
        this.viewSeq += 1;
        const id = method === 'update' ? args.view_id : `V${this.viewSeq}`;
        return { ok: true, view: { id, hash: `h${this.viewSeq}`, ...args.view } };
      };
      this.client.views = { open: call('open'), push: call('push'), update: call('update') };
    }
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

  // A trigger handed out now (Slack's lasts 3 seconds).
  issueTrigger(id) {
    this.triggers.set(id, Date.now());
    return id;
  }

  triggerExpired(id) {
    if (!this.triggers.has(id)) return false;
    return Date.now() - this.triggers.get(id) > TRIGGER_MS;
  }

  expireTriggers() {
    for (const id of this.triggers.keys()) this.triggers.set(id, -Infinity);
  }

  message(fn) { this.messageListeners.push(fn); }

  command(name, fn) { this.commandListeners.set(name, fn); }

  action(pattern, fn) { this.actionListeners.push({ pattern, fn }); }

  view(callbackId, fn) { this.viewListeners.push({ callbackId, fn }); }

  // Returns how many listeners ran.
  async dispatchView(callback_id, { user = { id: 'U1', name: 'u1' }, view = {} } = {}) {
    const full = { type: 'modal', callback_id, ...view };
    const body = { type: 'view_submission', user, view: full };
    const matching = this.viewListeners.filter(({ callbackId }) => matchesView(callbackId, callback_id, 'view_submission'));
    for (const { fn } of matching) {
      const ack = async (payload) => { this.acks += 1; this.viewAcks.push(payload); };
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
    if (this.options.failStart) throw this.options.failStart;
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
  async dispatchAction(action_id, { user = { id: 'U1', name: 'u1' }, view, value } = {}) {
    const action = { type: 'button', action_id, value: value === undefined ? action_id.split(':')[0] : value };
    const body = { type: 'block_actions', user, actions: [action] };
    if (view) Object.assign(body, { view, container: { type: 'view', view_id: view.id }, trigger_id: this.issueTrigger('T-action') });
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
const MAX_ALT = 2000;

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
  FakeSlackApp, invalidModal, invalidUpload, invalidImageBlocks, notReadyError, TRIGGER_MS,
};
