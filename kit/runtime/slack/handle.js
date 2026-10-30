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

// The one exception to the empty ack: a view_submission listener (Story 9.3)
// answers Slack in its ack, with { response_action: 'errors', errors } or
// { response_action: 'update', view }. work(args) must be fast and do no slow
// I/O (Slack wants the ack within 3 s); it returns the ack payload. If it
// throws, the error is logged and the ack carries onError(args) (for example
// a view with the plain error), so the person never sees a silent failure.
// Every other listener keeps handle() and its empty ack.
//
// Slow work after the ack (plan brightside-v0, D13, Story 16.6): work may
// return afterAck(payload, later). The ack carries payload (for example
// "Thinking…" in the view) and later() runs only once Slack has it, so the
// ack is never held up by the slow part; later() updates the view itself. An
// error in later() is logged, never thrown. (Not named then: an object with
// a then method is awaited as a promise.)
class AfterAck {
  constructor(payload, later) {
    if (typeof later !== 'function') throw new TypeError('afterAck needs the work to run after the ack');
    this.payload = payload;
    this.later = later;
  }
}
const afterAck = (payload, later) => new AfterAck(payload, later);

function handleView(name, work, { log, onError }) {
  return async (args) => {
    let payload;
    let later = null;
    try {
      payload = await work(args);
      if (payload instanceof AfterAck) {
        later = payload.later;
        payload = payload.payload;
      }
    } catch (err) {
      log.error('handler failed', { handler: name, err });
      try {
        payload = onError(args);
      } catch (buildErr) {
        log.error('could not tell the person about a failure', { handler: name, err: buildErr });
        payload = undefined;
      }
    }
    try {
      await args.ack(payload);
    } catch (ackErr) {
      log.error('ack failed', { handler: name, err: ackErr });
      return;
    }
    if (!later) return;
    try {
      await later();
    } catch (err) {
      log.error('handler failed', { handler: name, err });
    }
  };
}

module.exports = {
  handle, handleView, afterAck, AfterAck, replyPrivately, isDuplicateEvent, PLAIN_ERROR,
};
