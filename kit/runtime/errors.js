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
// own (killSwitchEnv) or the global APLABS_WRITES_OFF. Raised before any I/O,
// so nothing was written (Story 8.1). details: { connector, system, env }
class KillSwitchOn extends RuntimeRefusal {
  constructor(details) {
    super(`writes to ${details.system} are switched off (${details.env})`, details);
    this.code = 'KILL_SWITCH_ON';
  }
}

// A connector call failed (Story 8.1). reason is already redacted and is for
// the log, never shown to the person. details: { connector, system, operation }
class ConnectorFailed extends RuntimeRefusal {
  constructor(reason, details) {
    super(`${details.system} ${details.operation} failed: ${reason}`, details);
    this.code = 'CONNECTOR_FAILED';
    this.reason = reason;
  }
}

// The system refused the connector's credentials, or a declared credential is
// not set. Reads and writes fail closed: no data comes back. Same details.
class ConnectorAuthFailed extends ConnectorFailed {
  constructor(reason, details) {
    super(reason, details);
    this.code = 'CONNECTOR_AUTH_FAILED';
  }
}

module.exports = {
  RuntimeRefusal, NotSetUp, AccessDenied, ConfigFault, DataUnavailable,
  KillSwitchOn, ConnectorFailed, ConnectorAuthFailed,
};
