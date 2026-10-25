'use strict';

// The quiet escalation (Story 10.3, AD-14, plan epic-10 Q4): a failed push
// posts one note to the profile's slack.ops_channel, through the one
// channel-post function (kit/runtime/slack/channel.js), carrying the module
// id, a fixed reason and counts only, never row data.
//
// Escalated: PartialFailure, ConnectorFailed, ConnectorAuthFailed,
// IdempotencyConflict, and a kill switch flipped partway through a push
// (KillSwitchMidPush). Not escalated: a kill switch that refused before
// anything went, an invalid or expired preview (the caller never asks).
//
// The same module and reason within 15 minutes is suppressed (store
// namespace `escalation`). With no ops channel set, or when Slack refuses
// the post (the bot isn't in the channel, say), the escalation is logged
// only. It never throws: the person's reply never depends on it.

const { postToChannel, ESCALATION_REASONS } = require('../../slack/channel');

const NS = 'escalation';

// opsChannel: the profile's slack.ops_channel, or null.
function createEscalator({ store, log, opsChannel = null }) {
  // Returns what happened: 'posted' | 'logged' | 'suppressed' | 'refused'.
  async function escalate({
    client, module, reason, counts,
  }) {
    try {
      if (!Object.hasOwn(ESCALATION_REASONS, reason)) throw new Error(`unknown escalation reason "${reason}"`);
      const key = `${module}:${reason}`;
      if (store.get(NS, key) !== undefined) {
        log.info('push escalation suppressed', { module, reason });
        return 'suppressed';
      }
      store.set(NS, key, true);
      if (!opsChannel) {
        log.warn('push escalated (logged only: no slack.ops_channel set)', { module, reason, ...counts });
        return 'logged';
      }
      await postToChannel({
        client, exception: 'write-escalation', channel: opsChannel, fields: { module, reason, counts },
      });
      log.info('push escalated to the ops channel', { module, reason, ...counts });
      return 'posted';
    } catch (err) {
      // Slack's error code only (not_in_channel, channel_not_found, ...).
      const code = (err && err.data && typeof err.data.error === 'string' && err.data.error) || (err && err.name) || 'error';
      log.warn('push escalation not posted (logged only)', {
        module, reason, ...counts, error: code,
      });
      return 'refused';
    }
  }
  return { escalate };
}

module.exports = { createEscalator, NS };
