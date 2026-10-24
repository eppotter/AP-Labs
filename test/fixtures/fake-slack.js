'use strict';

// A fake Bolt App for runtime tests: records listeners and replies, never
// touches the network.
//
//   dispatchMessage(message, { body, context })  every message listener, the
//       way Bolt runs them for a message event (no ack; say posts to the same
//       channel). body carries event_id for de-duplication tests.
//   dispatchCommand(command, { user_id })        the listener for that slash
//       command, with ack and respond.
//   dispatchAction(action_id, { user })          every action listener whose
//       pattern matches, with ack and respond.
//   dispatchEvent(type, event, { body })         every listener for that event
//       type (no ack). body carries event_id for de-duplication tests.
//
// Replies land in this.said (say and postEphemeral), this.responded
// (respond) and this.posted (chat.postMessage); this.acks counts acks. users.info answers from this.users.

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
    const command = { command: name, user_id, text };
    await fn({ command, body: command, ack: this.ack(), respond: this.respond(), client: this.client });
  }

  // Returns how many listeners ran (0 = Bolt would find no listener).
  async dispatchAction(action_id, { user = { id: 'U1', name: 'u1' } } = {}) {
    const action = { type: 'button', action_id, value: action_id.split(':')[0] };
    const body = { type: 'block_actions', user, actions: [action] };
    const matching = this.actionListeners.filter(({ pattern }) => (
      pattern instanceof RegExp ? pattern.test(action_id) : pattern === action_id));
    for (const { fn } of matching) {
      await fn({ action, body, ack: this.ack(), respond: this.respond(), client: this.client });
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
