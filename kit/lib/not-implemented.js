'use strict';

// Stubs throw this so a caller can never mistake an unbuilt component for a
// passing one (PR-04: an unrunnable check is skipped, never passed).
class NotImplementedError extends Error {
  constructor(what) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
    this.code = 'NOT_IMPLEMENTED';
  }
}

function notImplemented(what) {
  return () => {
    throw new NotImplementedError(what);
  };
}

module.exports = { NotImplementedError, notImplemented };
