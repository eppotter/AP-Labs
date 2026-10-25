'use strict';

// The scoped-pull archetype (Story 9.3): a list module that declares its
// inputs in its manifest and gets a typed form, a Confirm screen and a
// one-shot Confirm from the engine, with no module code.
//
//   Open      a session is opened for the person and the form renders in the
//             module's view (pushed onto the hub menu by the dispatcher).
//   Check     the typed values are read from the view's state and checked
//             against the declarations: problems re-render the form, good
//             values render the Confirm screen.
//   Change    back to the form, prefilled with the checked values.
//   Confirm   consumes the session, synchronously, before anything runs, so a
//             double click or a replay runs once; the second click is told it
//             is running or done. Story 9.5 runs the query here.
//   Read      (Story 9.4: plain English fills the form.) Until then it says so
//             and shows the form.
//
// Each click's result is handed to show(message, opts), which the hub wiring
// turns into a views.update of the view the click came from. A click from
// anyone but the session's person is refused, and every click re-checks that
// the person may still open the module (resolve), before any state changes.
//
// The engine never logs the values a person typed: only the module and the
// action.

const { SessionExpired, SessionNotYours, AlreadyConfirmed } = require('../../errors');
const { messageFor } = require('../../messages');
const session = require('./session');
const { checkValues, checkDeclarations } = require('./params');
const {
  formMessage, confirmMessage, confirmedMessage, readState, verbOf, ACTIONS, ACTION_PATTERN,
} = require('./form');

const READ_NOT_YET = "Reading a request in plain English isn't switched on yet. Fill in the form instead.";

// The message for a session lookup that found nothing usable.
function refusalFor(status) {
  switch (status) {
    case session.STATUS.NOT_YOURS: return messageFor(new SessionNotYours());
    case session.STATUS.RUNNING: return messageFor(new AlreadyConfirmed({ done: false }));
    case session.STATUS.DONE: return messageFor(new AlreadyConfirmed({ done: true }));
    default: return messageFor(new SessionExpired());
  }
}

// store: the runtime store (AD-7). log: the app logger. run(mod, values,
// person): what a consumed Confirm does; it resolves the message to show.
// Defaults to the confirmed-values screen until Story 9.5.
function createScopedPull({ store, log, run = async (mod, values) => confirmedMessage(mod, values) }) {
  // Opens a session on mod for person (a Slack id). Returns the form.
  function open(mod, person) {
    const sessionId = session.open(store, { person, module: mod.id });
    log.info('form opened', { module: mod.id });
    return formMessage(mod, { sessionId });
  }

  // One form click. verb: check | read | confirm | change. resolve(moduleId)
  // is synchronous and returns { mod } when the person may still use it, or
  // { refusal } (a message). show(message, { force }) renders into the view.
  async function click({ verb, sessionId, person, state, resolve, show }) {
    const found = session.lookup(store, sessionId, person);
    if (found.status !== session.STATUS.OK) {
      log.info('form click refused', { action: verb, reason: found.status });
      return show(refusalFor(found.status));
    }
    const allowed = resolve(found.session.module);
    if (!allowed.mod) return show(allowed.refusal);
    const { mod } = allowed;
    log.info('form click', { module: mod.id, action: verb });

    if (verb === 'confirm') {
      // No await between the lookup above and this consume (AD-7).
      const c = session.consume(store, sessionId, person);
      if (!c.consumed) {
        if (c.status !== session.STATUS.OK) return show(refusalFor(c.status));
        // Nothing checked yet (a stale Confirm after Change): back to the form.
        return show(formMessage(mod, { sessionId }));
      }
      let result;
      try {
        result = await run(mod, c.session.values, person);
      } finally {
        session.finish(store, sessionId, person);
      }
      return show(result, { force: true });
    }

    if (verb === 'change') {
      const initial = found.session.values || {};
      session.save(store, sessionId, found.session, null);
      return show(formMessage(mod, { sessionId, initial }));
    }

    if (verb === 'read') {
      session.save(store, sessionId, found.session, null);
      return show(formMessage(mod, { sessionId, note: READ_NOT_YET }));
    }

    // check
    const { values, problems } = checkValues(mod.parameters, readState(mod.parameters, state));
    if (problems.length) {
      session.save(store, sessionId, found.session, null);
      return show(formMessage(mod, { sessionId, initial: values, problems }));
    }
    session.save(store, sessionId, found.session, values);
    return show(confirmMessage(mod, { sessionId, values }));
  }

  return { open, click };
}

module.exports = {
  createScopedPull, checkDeclarations, verbOf, ACTIONS, ACTION_PATTERN, READ_NOT_YET,
};
