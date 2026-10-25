'use strict';

// Typed errors the engine raises when it refuses (AD-17). Each carries only
// what its message needs; kit/runtime/messages.js turns it into words. More
// kinds land with their stories (GuardrailBlocked, ...).

class RuntimeRefusal extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

// The Slack id matches no profile user. details: { client, admin }
class NotSetUp extends RuntimeRefusal {
  constructor(details) { super('person is not set up in the profile', details); }
}

// A known person the profile does not allow. details: { label, admin }
class AccessDenied extends RuntimeRefusal {
  constructor(details) { super('access denied by the profile', details); }
}

// The setup is wrong (for example a resource key the profile does not
// declare). Never shown as a denial. details: { admin }
class ConfigFault extends RuntimeRefusal {
  constructor(details) { super('configuration fault', details); }
}

// The data source is missing or cannot be opened (Story 7.5). reason is for
// the log, never shown to the person. kit/runtime/data raises it (and exports
// it as DataUnavailableError); code stays 'DATA_UNAVAILABLE'.
class DataUnavailable extends RuntimeRefusal {
  constructor(reason) {
    super(`data unavailable: ${reason}`, { reason });
    this.code = 'DATA_UNAVAILABLE';
    this.reason = reason;
  }
}

// A connector write was refused because a kill switch is on: the connector's
// own (killSwitchEnv) or the global APLABS_WRITES_OFF (Story 8.1). Raised
// before any I/O, so nothing was written, unless the switch flipped partway
// through a write: then details.sent ({ batches, items }) says what had gone
// (#89). details: { connector, system, env, sent? }
class KillSwitchOn extends RuntimeRefusal {
  constructor(details) {
    super(`writes to ${details.system} are switched off (${details.env})`, details);
    this.code = 'KILL_SWITCH_ON';
  }
}

// A connector call failed (Story 8.1). reason is already redacted and is for
// the log, never shown to the person. details: { connector, system, operation },
// plus sent ({ batches, items }) when a write failed after some requests went.
class ConnectorFailed extends RuntimeRefusal {
  constructor(reason, details) {
    super(`${details.system} ${details.operation} failed: ${reason}`, details);
    this.code = 'CONNECTOR_FAILED';
    this.reason = reason;
  }
}

// The system refused the connector's credentials, or a declared credential is
// not set (then details.setup is true: a setup fault, worded apart from a
// rejected key). Reads and writes fail closed: no data comes back. Same details.
class ConnectorAuthFailed extends ConnectorFailed {
  constructor(reason, details) {
    super(reason, details);
    this.code = 'CONNECTOR_AUTH_FAILED';
  }
}

// A write reused an idempotency key with a different input. Nothing was sent:
// answering with the first result would hide rows the caller meant to send.
// Same details; reason is for the log.
class IdempotencyConflict extends ConnectorFailed {
  constructor(reason, details) {
    super(reason, details);
    this.code = 'IDEMPOTENCY_CONFLICT';
  }
}

// A batch write partly applied (#90). The items that succeeded were recorded
// with their keys and the failed ones were not, so a retry with the same input
// sends only the failed ones: nothing is sent twice. An adapter throws it from
// a write's apply with { succeeded, failed, failedRefs }; the contract rebuilds
// it with the connector's details, checks the counts and masks any ref that
// is not id-shaped. failedRefs are the failed items' external ids (never
// contact data), for the log only: the person sees the counts.
// details: { connector, system, operation, succeeded, failed, failedRefs }
class PartialFailure extends ConnectorFailed {
  constructor(reason, details = {}) {
    super(reason, details);
    this.code = 'PARTIAL_FAILURE';
  }
}

// A scoped-pull form click whose session is gone: idle 30 minutes, or never
// known (Story 9.3). details: {}
class SessionExpired extends RuntimeRefusal {
  constructor() { super('form session expired', {}); }
}

// A form click on a session another person opened (Story 9.3). details: {}
class SessionNotYours extends RuntimeRefusal {
  constructor() { super('form session belongs to another person', {}); }
}

// A second Confirm (a double click or a replay) on a request already confirmed
// (Story 9.3). details: { done } (false while it is still running)
class AlreadyConfirmed extends RuntimeRefusal {
  constructor(details) { super(`request already ${details.done ? 'done' : 'running'}`, details); }
}

// The AI service refused or failed (Story 9.1), so the module falls back to its
// typed form. Raised before anything is sent, except 'failed'. reason is one
// of LLM_REASONS; details.log, when set, is for the log only and never shown.
// details: { reason, log? }
const LLM_REASONS = Object.freeze(['off', 'no_key', 'config', 'too_long', 'rate_limited', 'over_budget', 'failed']);
class LlmUnavailable extends RuntimeRefusal {
  constructor(reason, details = {}) {
    if (!LLM_REASONS.includes(reason)) throw new TypeError(`unknown LlmUnavailable reason "${reason}"`);
    super(`AI unavailable: ${reason}`, { ...details, reason });
    this.code = 'LLM_UNAVAILABLE';
    this.reason = reason;
  }
}

module.exports = {
  RuntimeRefusal, NotSetUp, AccessDenied, ConfigFault, DataUnavailable, LlmUnavailable, LLM_REASONS,
  KillSwitchOn, ConnectorFailed, ConnectorAuthFailed, IdempotencyConflict, PartialFailure,
  SessionExpired, SessionNotYours, AlreadyConfirmed,
};
