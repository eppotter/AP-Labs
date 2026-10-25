'use strict';

// The scoped-pull archetype (Story 9.3): a list module that declares its
// inputs in its manifest and gets a typed form, a Confirm screen and a
// one-shot Confirm from the engine, with no module code.
//
//   Open      a session is opened for the person and the form renders in the
//             module's view (pushed onto the hub menu by the dispatcher). The
//             form's submit is "Check values" (Slack requires a submit on a
//             view with inputs).
//   Check     submit(): the typed values are read from the submitted view's
//             state and checked against the declarations, synchronously, so
//             the hub can answer in the ack: problems go beside the inputs,
//             good values replace the form with the Confirm screen.
//   Change    back to the form, prefilled with the checked values.
//   Confirm   consumes the session, synchronously, before anything runs, so a
//             double click or a replay runs once; the second click is told it
//             is running or done. Then (Story 9.5) the view shows "Running…",
//             run() binds the declared inputs into the module's fixed SQL,
//             runs it through the query runner and sends the CSV to the
//             person's DM (./run), and the result replaces the view. A run
//             that did not deliver the list (blocked, failed, data
//             unavailable, CSV not sent) still uses the session up: a replay
//             is told it did not finish and to open the module again.
//
// Change and Confirm are buttons; their result goes to show(message, opts),
// which the hub wiring turns into a views.update of the view the click came
// from. A submit or click from anyone but the session's person is refused,
// and each one re-checks that the person may still open the module
// (resolve), before any state changes.
//
// The engine never logs the values a person typed: only the module and the
// action.

const { SessionExpired, SessionNotYours, AlreadyConfirmed } = require('../../errors');
const { PLAIN_ERROR } = require('../../slack/handle');
const { messageFor } = require('../../messages');
const session = require('./session');
const { checkValues, checkDeclarations } = require('./params');
const {
  formMessage, formErrors, confirmMessage, readState, verbOf, parseMetadata,
  ACTIONS, ACTION_PATTERN, FORM_CALLBACK,
} = require('./form');
const { createRunner, checkQuery, ROW_CAP } = require('./run');
const { runningMessage } = require('./results');

// The message for a session lookup that found nothing usable.
function refusalFor(status) {
  switch (status) {
    case session.STATUS.NOT_YOURS: return messageFor(new SessionNotYours());
    case session.STATUS.RUNNING: return messageFor(new AlreadyConfirmed({ done: false }));
    case session.STATUS.DONE: return messageFor(new AlreadyConfirmed({ done: true }));
    case session.STATUS.FAILED: return messageFor(new AlreadyConfirmed({ done: true, failed: true }));
    default: return messageFor(new SessionExpired());
  }
}

// store: the runtime store (AD-7). log: the app logger. run(mod, values,
// person, { client }): what a consumed Confirm does (./run createRunner); it
// resolves { message, failed }, or a bare message for a run that finished.
function createScopedPull({ store, log, run }) {
  if (typeof run !== 'function') throw new TypeError('createScopedPull needs run (see ./run createRunner)');
  // Opens a session on mod for person (a Slack id). Returns the form.
  function open(mod, person) {
    const sessionId = session.open(store, { person, module: mod.id });
    log.info('form opened', { module: mod.id });
    return formMessage(mod, { sessionId });
  }

  // The session a submit or click names, checked: { found, mod } or
  // { message } (a refusal to show). resolve(moduleId) is synchronous and
  // returns { mod } when the person may still use it, or { refusal }.
  function check(sessionId, person, resolve, action) {
    const found = session.lookup(store, sessionId, person);
    if (found.status !== session.STATUS.OK) {
      log.info('form click refused', { action, reason: found.status });
      return { message: refusalFor(found.status) };
    }
    const allowed = resolve(found.session.module);
    if (!allowed.mod) return { message: allowed.refusal };
    log.info('form click', { module: allowed.mod.id, action });
    return { found, mod: allowed.mod };
  }

  // The form's submit ("Check values"). Synchronous: the hub answers in the
  // ack. Returns { errors } (block id → message, shown beside the inputs) or
  // { message } (the Confirm screen, or a refusal) to replace the form with.
  function submit({ sessionId, person, state, resolve }) {
    const c = check(sessionId, person, resolve, 'check');
    if (!c.mod) return { message: c.message };
    const { values, problems } = checkValues(c.mod.parameters, readState(c.mod.parameters, state));
    if (problems.length) {
      session.save(store, sessionId, c.found.session, null);
      return { errors: formErrors(problems) };
    }
    session.save(store, sessionId, c.found.session, values);
    return { message: confirmMessage(c.mod, { sessionId, values }) };
  }

  // A Confirm screen button. verb: confirm | change. show(message, { force })
  // renders into the view. client: the Slack client the run delivers with.
  async function click({ verb, sessionId, person, resolve, show, client }) {
    const c = check(sessionId, person, resolve, verb);
    if (!c.mod) return show(c.message);
    const { found, mod } = c;

    if (verb === 'change') {
      const initial = found.session.values || {};
      session.save(store, sessionId, found.session, null);
      return show(formMessage(mod, { sessionId, initial }));
    }

    // confirm. No await between the lookup above and this consume (AD-7).
    const consumed = session.consume(store, sessionId, person);
    if (!consumed.consumed) {
      if (consumed.status !== session.STATUS.OK) return show(refusalFor(consumed.status));
      // Nothing checked yet (a stale Confirm after Change): back to the form.
      return show(formMessage(mod, { sessionId }));
    }
    const values = consumed.session.values;
    let result = { message: PLAIN_ERROR, failed: true };
    try {
      try {
        await show(runningMessage(mod, values));
      } catch (err) {
        log.warn('could not show running notice', { module: mod.id, err });
      }
      const ran = await run(mod, values, person, { client });
      result = ran && typeof ran === 'object' && Object.hasOwn(ran, 'message') ? ran : { message: ran, failed: false };
    } catch (err) {
      log.error('list run failed', { module: mod.id, err });
    } finally {
      session.finish(store, sessionId, person, { failed: result.failed });
    }
    return show(result.message, { force: true });
  }

  return { open, submit, click };
}

module.exports = {
  createScopedPull, createRunner, checkQuery, ROW_CAP, checkDeclarations, verbOf, parseMetadata, ACTIONS, ACTION_PATTERN, FORM_CALLBACK,
};
