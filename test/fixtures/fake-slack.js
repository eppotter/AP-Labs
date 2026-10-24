'use strict';

// A fake Bolt App for runtime tests: records listeners and replies, never
// touches the network. dispatchMessage() runs every message listener the way
// Bolt would for a message event (no ack; say posts to the same channel).

class FakeSlackApp {
  constructor(options) {
    this.options = options;
    this.messageListeners = [];
    this.errorHandler = null;
    this.started = false;
    this.said = [];
    this.client = {
      chat: {
        postEphemeral: async (args) => { this.said.push({ ephemeral: true, ...args }); return { ok: true }; },
      },
    };
  }

  message(fn) { this.messageListeners.push(fn); }

  error(fn) { this.errorHandler = fn; }

  async start() {
    if (this.options.failStart) throw this.options.failStart;
    this.started = true;
  }

  async stop() { this.started = false; }

  async dispatchMessage(message) {
    const say = async (arg) => {
      const text = typeof arg === 'string' ? arg : arg.text;
      this.said.push({ channel: message.channel, text });
      return { ok: true };
    };
    for (const fn of this.messageListeners) await fn({ message, say, client: this.client });
  }
}

module.exports = { FakeSlackApp };
