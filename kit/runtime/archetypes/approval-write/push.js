'use strict';

// The push (Story 10.3, AD-15): Approve, and "Retry the failed ones", send
// the approval entry's own rows through the connector once, report honest
// counts and escalate a failure quietly.
//
// Approve order (no await from the first check to the consume, AD-7):
//   1. get the token's entry. Gone: read its done marker. Only the person who
//      approved it hears "already running" or "already done" with the counts
//      (decision 5); anyone else, and a cancelled or unknown token, gets the
//      generic "no longer valid" (PreviewInvalid).
//   2. the person must match, else the same generic reply.
//   3. re-check the grant and the environment the way dispatch does
//      (resolve, N12), and that the connector is loaded.
//   4. the connector's and the global kill switch (BRIGHTSIDE_EMAIL_OFF,
//      APLABS_WRITES_OFF for Brightside): refuse without consuming.
//   5. consume the token, marked with the person (store.consume's marker),
//      then push and finish with the outcome.
//
// What is sent: only the entry's rows (never the run record, never the
// button) that the preview did not skip (the entry's skippedIds, review
// R1-1: a connector whose apply doesn't re-check still never gets a row the
// person saw as skipped), mapped through write.send, under the entry's
// idempotency key:
// the rows the person saw, never more than the 5,000-row cap (Q10). The
// connector keys each contact under it, so a double click, a replay or a
// concurrent click never sends twice, and a key already used (the same list
// sent earlier today) is "already sent today; nothing new sent" (N6).
//
// Retry (decision 6, DEP-013, review R2-1): a PartialFailure with
// details.retrySafe === true stores a retry entry behind "Retry the failed
// ones": the same person and list, ONLY the failed rows (its failedRefs
// matched to rows by row id, exactly one row each), under a key derived from
// the first push's (entry.retryKey). The retry runs this same flow, so it can
// never re-send a row that went, even through a connector that declares
// perItemIdempotency but ignores its keys; its reply describes the retry
// ("Retried 1 that failed: sent 1, failed 0"), never the whole list. A
// failed ref that can't be matched, or retrySafe not true: the AD-17 admin
// message and no button. A sign-in failure is never offered a retry (a setup
// fault for the admin).
//
// Escalated (./escalate, Q4): PartialFailure, ConnectorFailed,
// ConnectorAuthFailed, IdempotencyConflict, and a kill switch flipped partway
// (details.sent set). The person's reply goes first and never depends on it.

const { messageFor, pushResultText } = require('../../messages');
const {
  PreviewInvalid, ConfigFault, KillSwitchOn, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict, PartialFailure,
  AlreadyPushed, RuntimeRefusal,
} = require('../../errors');
const { ROW_CAP } = require('../scoped-pull/run');
const entry = require('./entry');
const preview = require('./preview');

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

// What the connector is sent for each row: write.send's field names, each
// from its declared field.
function sendItems(mod, rows) {
  const pairs = Object.entries(mod.write.send);
  return rows.map((r) => Object.fromEntries(pairs.map(([target, source]) => [target, r[source] === undefined ? null : r[source]])));
}

// The escalation reason for a failed push, or null when it isn't escalated.
function escalationReason(err) {
  if (err instanceof PartialFailure) return 'PartialFailure';
  if (err instanceof IdempotencyConflict) return 'IdempotencyConflict';
  if (err instanceof ConnectorAuthFailed) return 'ConnectorAuthFailed';
  if (err instanceof ConnectorFailed) return 'ConnectorFailed';
  if (err instanceof KillSwitchOn) return err.details && err.details.sent ? 'KillSwitchMidPush' : null;
  return null;
}

// store, log, connectors, admin as createApprovalWrite's; escalate: the
// escalator's function (./escalate).
function createPush({
  store, log, connectors, admin, escalate,
}) {
  // A click's reply for a token with no live entry.
  function gone(token, person) {
    const marker = store.done(entry.NS, token);
    if (!marker || marker.person !== person || marker.action !== entry.ACTION.approve) {
      log.info('approval click refused', { action: 'approve', reason: 'invalid' });
      return { message: messageFor(new PreviewInvalid()) };
    }
    if (marker.state === 'running') return { message: messageFor(new AlreadyPushed({ running: true }), { admin }) };
    const { result } = marker;
    const message = messageFor(new AlreadyPushed({ running: false, result }), { admin });
    // A safe retry that is still live is offered again: this click replaced
    // the view that showed it.
    const retryToken = result && result.retryToken && store.get(entry.NS, result.retryToken) ? result.retryToken : null;
    return { message, retryToken };
  }

  // Approve (or Retry, the same flow on the re-stored entry).
  function approve({
    token, person, resolve, show, client, action = 'approve',
  }) {
    if (typeof token !== 'string' || !entry.TOKEN.test(token)) {
      log.info('approval click refused', { action, reason: 'invalid' });
      return show(messageFor(new PreviewInvalid()));
    }
    const found = store.get(entry.NS, token);
    if (found === undefined) {
      const g = gone(token, person);
      if (!g.retryToken) return show(g.message);
      return show(preview.pushResultMessage({
        mod: { label: 'Push' }, text: g.message, retryToken: g.retryToken,
      }));
    }
    if (found.person !== person) {
      log.info('approval click refused', { action, reason: 'invalid' });
      return show(messageFor(new PreviewInvalid()));
    }
    const allowed = resolve(found.module);
    if (!allowed.mod) return show(allowed.refusal);
    const { mod } = allowed;
    const connector = connectors && connectors.get(mod.write.connector);
    if (!connector) {
      log.error('push connector not loaded', { module: mod.id, connector: mod.write.connector });
      return show(messageFor(new ConfigFault({ admin })));
    }
    if (!Array.isArray(found.rows) || found.rows.length > ROW_CAP) {
      log.error('push refused: the approval entry is over the row cap', { module: mod.id, rows: Array.isArray(found.rows) ? found.rows.length : null, cap: ROW_CAP });
      return show(messageFor(new ConfigFault({ admin })));
    }
    const switched = connector.killSwitch();
    if (switched) {
      log.info('push refused: kill switch on', { module: mod.id, env: switched });
      return show(messageFor(new KillSwitchOn({ connector: connector.id, system: connector.system, env: switched }), { admin }));
    }
    // Consumed with no await since the get: exactly one click gets past here.
    store.consume(entry.NS, token, { person, action: entry.ACTION.approve });
    return send({
      token, stored: found, mod, connector, show, client, action,
    });
  }

  async function send({
    token, stored, mod, connector, show, client, action,
  }) {
    const total = stored.rows.length;
    // The skipped count is the preview's; the rows sent are exactly the
    // ones it said will send.
    const skipped = stored.skipped.length;
    const skippedIds = new Set(stored.skippedIds);
    const sendRows = stored.rows.filter((r) => !skippedIds.has(String(r[mod.row_id])));
    const toSend = sendRows.length;
    const base = { destination: mod.write.destination, listName: stored.listName, skippedReasons: stored.skipped };
    // listKey: the first push's key, the same on every retry, so a connector
    // keeps a retry's rows on the list the first push made (review R2-1).
    const input = {
      name: stored.listName, contacts: sendItems(mod, sendRows), idempotencyKey: stored.idempotencyKey, listKey: stored.originalKey,
    };
    let result;
    let text;
    let retryToken = null;
    let reason = null;
    try {
      const done = await connector.write[mod.write.operation]({ ...input, dryRun: false }, { report: true });
      const r = done.result && typeof done.result === 'object' ? done.result : {};
      if (done.replayed) {
        result = { ...base, outcome: 'replayed', counts: { total, sent: 0, already: toSend, skipped, failed: 0 } };
      } else {
        const sent = isCount(r.added) ? r.added : toSend;
        const already = isCount(r.alreadyAdded) ? r.alreadyAdded : 0;
        result = { ...base, outcome: stored.retry ? 'retried' : 'sent', counts: { total, sent, already, skipped, failed: 0 } };
      }
      text = pushResultText(result, { admin });
      log.info('push finished', { module: mod.id, action, outcome: result.outcome, ...result.counts });
    } catch (err) {
      if (!(err instanceof RuntimeRefusal) || !messageFor(err)) {
        store.finish(entry.NS, token, { ...base, outcome: 'stopped', counts: { total, sent: 0, already: 0, skipped, failed: toSend } });
        throw err;
      }
      reason = escalationReason(err);
      const d = err.details || {};
      let partialText = null;
      if (err instanceof PartialFailure) {
        const sent = isCount(d.succeeded) ? d.succeeded : 0;
        const failed = isCount(d.failed) ? d.failed : toSend - sent;
        if (d.retrySafe === true) {
          // Only the failed rows, matched by row id among the rows sent.
          const failedIds = entry.rowIdsForRefs(mod, sendRows, Array.isArray(d.failedRefs) ? d.failedRefs : []);
          if (failedIds && failedIds.length && failedIds.length === failed) retryToken = entry.retryEntry(store, stored, mod, failedIds);
          else log.warn('push retry not offered: the failed refs could not be matched to one row each', { module: mod.id, failed });
        }
        result = {
          ...base, outcome: 'partial', retried: stored.retry, retry: Boolean(retryToken), counts: { total, sent, already: 0, skipped, failed },
        };
        if (!retryToken && d.retrySafe === true) {
          // No button, so never "trying again is safe": the admin message.
          partialText = messageFor(new PartialFailure('', { ...d, retrySafe: false }), { admin });
        }
        if (stored.retry) partialText = pushResultText(result, { admin });
      } else if (err instanceof KillSwitchOn && !d.sent) {
        result = { ...base, outcome: 'refused', counts: { total, sent: 0, already: 0, skipped, failed: toSend } };
      } else {
        const sent = d.sent && isCount(d.sent.items) ? d.sent.items : 0;
        result = { ...base, outcome: 'stopped', counts: { total, sent, already: 0, skipped, failed: Math.max(0, toSend - sent) } };
      }
      // The AD-17 words for the error (a retry's own counts), then the skipped.
      text = partialText && stored.retry ? partialText : `${partialText || messageFor(err, { admin })} Skipped ${skipped}.`;
      log.warn('push did not finish', {
        module: mod.id, action, outcome: result.outcome, reason: err.code || err.name, retry_offered: Boolean(retryToken), ...result.counts,
      });
    }
    store.finish(entry.NS, token, { ...result, retryToken });
    await show(preview.pushResultMessage({
      mod, text, skipped: stored.skipped, retryToken,
    }));
    if (reason) {
      await escalate({
        client, module: mod.id, reason, counts: result.counts,
      });
    }
  }

  return { approve };
}

module.exports = { createPush, sendItems, escalationReason };
