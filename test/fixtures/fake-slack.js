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
// new FakeSlackApp({ views: true }) adds client.views: open, push and update
// record { method, args } in this.views and answer with a view id and a fresh
// hash; set this.viewsFail[method] to an error to make that call throw.

class FakeSlackApp {
  constructor(options) {
    this.options = options;
    this.messageListeners = [];
    this.commandListeners = new Map();
    this.actionListeners = [];
    this.eventListeners = new Map();
    this.errorHandler = null;
    this.started = false;
    this.said = [];
    this.responded = [];
    this.posted = [];
    this.acks = 0;
    this.users = {};
    this.views = [];
    this.viewsFail = {};
    this.viewSeq = 0;
    this.client = {
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
        this.viewSeq += 1;
        const id = method === 'update' ? args.view_id : `V${this.viewSeq}`;
        return { ok: true, view: { id, hash: `h${this.viewSeq}`, ...args.view } };
      };
      this.client.views = { open: call('open'), push: call('push'), update: call('update') };
    }
  }

  message(fn) { this.messageListeners.push(fn); }

  command(name, fn) { this.commandListeners.set(name, fn); }

  action(pattern, fn) { this.actionListeners.push({ pattern, fn }); }

  event(type, fn) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
    this.eventListeners.get(type).push(fn);
  }

  error(fn) { this.errorHandler = fn; }

  async start() {
    if (this.options.failStart) throw this.options.failStart;
    this.started = true;
  }

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
    const command = { command: name, user_id, text, trigger_id: 'T-command' };
    await fn({ command, body: command, ack: this.ack(), respond: this.respond(), client: this.client });
  }

  // Returns how many listeners ran (0 = Bolt would find no listener).
  async dispatchAction(action_id, { user = { id: 'U1', name: 'u1' }, view, value } = {}) {
    const action = { type: 'button', action_id, value: value === undefined ? action_id.split(':')[0] : value };
    const body = { type: 'block_actions', user, actions: [action] };
    if (view) Object.assign(body, { view, container: { type: 'view', view_id: view.id }, trigger_id: 'T-action' });
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

module.exports = { FakeSlackApp };
