'use strict';

// Typed errors the engine raises when it refuses (AD-17). Each carries only
// what its message needs; kit/runtime/messages.js turns it into words. More
// kinds land with their stories (GuardrailBlocked, DataUnavailable, ...).

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

module.exports = { RuntimeRefusal, NotSetUp, AccessDenied, ConfigFault };
