'use strict';

// The shared handler wrapper (AD-6): every command, action, view and message
// listener is registered through handle(). It acknowledges first (Slack wants
// an ack within 3 s; events and messages have none to send), then runs the
// work. Any error after the ack is logged and turned into a plain message to
// the same person: never silence, never the error's own text.
//
// Events are de-duplicated on event_id in the store's `event` namespace (10
// minutes), so a retried delivery (retry_attempt / x-slack-retry-num) is
// processed once. Commands and actions carry no event_id and are never skipped.

const PLAIN_ERROR = "Sorry, something went wrong on my side and I couldn't finish that. "
  + 'Please try again in a minute. If it keeps happening, tell your admin.';

// Replies privately to whoever triggered the listener: response_url for
// commands and actions, the DM itself for a direct message, else an ephemeral
// message in the channel it came from.
async function replyPrivately(args, text) {
  if (typeof args.respond === 'function') {
    return args.respond({ response_type: 'ephemeral', replace_original: false, text });
  }
  const ev = args.message || args.event || {};
  if (ev.channel_type === 'im' && typeof args.say === 'function') return args.say({ text });
  const user = ev.user || (args.body && args.body.user && args.body.user.id);
  const channel = ev.channel || (args.body && args.body.channel && args.body.channel.id);
  if (user && channel && args.client) return args.client.chat.postEphemeral({ channel, user, text });
  throw new Error('no private reply path for this listener');
}

// True when this event_id was already seen; otherwise records it. Synchronous:
// no await between the check and the set.
function isDuplicateEvent(args, store) {
  const id = args.body && args.body.event_id;
  if (!store || typeof id !== 'string' || !id) return false;
  if (store.get('event', id) !== undefined) return true;
  store.set('event', id, true);
  return false;
}

// name labels the listener in logs; work(args) does the job. store (optional)
// turns on event de-duplication.
function handle(name, work, { log, store }) {
  const tellPerson = async (args) => {
    try {
      await replyPrivately(args, PLAIN_ERROR);
    } catch (replyErr) {
      log.error('could not tell the person about a failure', { handler: name, err: replyErr });
    }
  };
  return async (args) => {
    if (typeof args.ack === 'function') {
      try {
        await args.ack();
      } catch (ackErr) {
        // Slack never got the ack, so the work is not run; the person still
        // hears that it failed.
        log.error('ack failed', { handler: name, err: ackErr });
        await tellPerson(args);
        return;
      }
    }
    if (isDuplicateEvent(args, store)) {
      const retry = args.context && args.context.retryNum;
      log.info('duplicate event skipped', { handler: name, event_id: args.body.event_id, retry: retry === undefined ? null : retry });
      return;
    }
    try {
      await work(args);
    } catch (err) {
      log.error('handler failed', { handler: name, err });
      await tellPerson(args);
    }
  };
}

module.exports = { handle, replyPrivately, isDuplicateEvent, PLAIN_ERROR };
