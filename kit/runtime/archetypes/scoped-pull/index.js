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
// Read my request (Story 9.4), offered only when the hub wiring gives a
// reader (./extract, which alone holds the AI service). The click shows
// "Reading your request…", makes one structured AI call with only the typed
// request and the declarations, then updates the view: the Confirm screen
// when every value passes its declaration, else one follow-up question (a
// text box in the same view, its submit answered in the ack), and a second
// miss opens the form. The AI being off, over a limit or failing shows its
// plain message above the form. Values the AI or a question fills are held
// apart from the checked values (session.pending), so no Confirm can run
// them unconfirmed. A second Read click while one is reading does nothing.
//
// The engine never logs the values a person typed: only the module and the
// action.

const {
  SessionExpired, SessionNotYours, AlreadyConfirmed, LlmUnavailable,
} = require('../../errors');
const { PLAIN_ERROR } = require('../../slack/handle');
const { messageFor, READ_WORDS } = require('../../messages');
const session = require('./session');
const { checkValues, checkDeclarations } = require('./params');
const {
  formMessage, formErrors, confirmMessage, readState, verbOf, parseMetadata,
  readingMessage, questionMessage, readRequest, readAnswer,
  ACTIONS, ACTION_PATTERN, FORM_CALLBACK, ANSWER_CALLBACK,
} = require('./form');
const { checkGiven, whyOf } = require('./extract');
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
// read({ mod, person, request }): fills values from plain English
// (./extract createReader), or null when the AI is not wired in.
function createScopedPull({ store, log, run, read = null }) {
  if (typeof run !== 'function') throw new TypeError('createScopedPull needs run (see ./run createRunner)');
  if (read !== null && typeof read !== 'function') throw new TypeError('createScopedPull: read must be a function or null');
  const ask = read !== null;
  const form = (mod, opts) => formMessage(mod, { ...opts, ask });

  // Opens a session on mod for person (a Slack id). Returns the form.
  function open(mod, person) {
    const sessionId = session.open(store, { person, module: mod.id });
    log.info('form opened', { module: mod.id });
    return form(mod, { sessionId });
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

  // The follow-up question's submit (Story 9.4). Synchronous, answered in the
  // ack like submit(): the answer is checked with the values already read;
  // all good gives the Confirm screen, a second miss the form.
  function answer({ sessionId, person, state, resolve }) {
    const c = check(sessionId, person, resolve, 'answer');
    if (!c.mod) return { message: c.message };
    const { mod, found } = c;
    const pending = found.session.pending;
    const cleared = { ...found.session, pending: null };
    if (!pending || !mod.parameters.some((p) => p.name === pending.ask)) {
      session.save(store, sessionId, cleared, null);
      return { message: form(mod, { sessionId }) };
    }
    const checked = checkGiven(mod.parameters, { ...pending.values, [pending.ask]: readAnswer(state) });
    if (checked.problems.length) {
      log.info('question missed; form shown', { module: mod.id });
      session.save(store, sessionId, cleared, null);
      return { message: form(mod, { sessionId, initial: checked.values, notice: READ_WORDS.secondMiss() }) };
    }
    session.save(store, sessionId, cleared, checked.values);
    return { message: confirmMessage(mod, { sessionId, values: checked.values }) };
  }

  // "Read my request". show(message) renders into the view.
  async function readRequestClick({ c, sessionId, person, resolve, show, state }) {
    const { mod, found } = c;
    if (!ask) return show(form(mod, { sessionId }));
    if (found.session.reading) {
      log.info('read click ignored', { module: mod.id, reason: 'already reading' });
      return undefined;
    }
    const request = readRequest(state);
    if (!request.trim()) return show(form(mod, { sessionId, notice: READ_WORDS.empty() }));
    // Marked before any await, so a second click finds it (AD-7).
    session.save(store, sessionId, { ...found.session, reading: true, pending: null }, null);
    let outcome;
    try {
      try {
        await show(readingMessage(mod));
      } catch (err) {
        log.warn('could not show reading notice', { module: mod.id, err });
      }
      outcome = { checked: await read({ mod, person, request }) };
    } catch (err) {
      outcome = { err };
    }
    // The session may have expired or changed hands while the AI answered.
    const now = check(sessionId, person, resolve, 'read');
    if (!now.mod) return show(now.message);
    const base = { ...now.found.session, reading: false, pending: null };
    if (outcome.err) {
      session.save(store, sessionId, base, null);
      const { err } = outcome;
      const refused = !(err instanceof LlmUnavailable) && messageFor(err);
      if (refused) return show(refused);
      if (!(err instanceof LlmUnavailable)) log.error('reading a request failed', { module: mod.id, err });
      const notice = messageFor(err instanceof LlmUnavailable ? err : new LlmUnavailable('failed'));
      return show(form(mod, { sessionId, notice }));
    }
    const { values, problems } = outcome.checked;
    if (problems.length === 0) {
      session.save(store, sessionId, base, values);
      return show(confirmMessage(mod, { sessionId, values }));
    }
    const first = problems[0];
    const param = mod.parameters.find((p) => p.name === first.name);
    session.save(store, sessionId, { ...base, pending: { values, ask: first.name } }, null);
    return show(questionMessage(mod, { sessionId, param, why: whyOf(first) }));
  }

  // A button. verb: confirm | change | read. show(message, { force })
  // renders into the view. client: the Slack client the run delivers with.
  // state: the view's state when clicked (read takes the request from it).
  async function click({ verb, sessionId, person, resolve, show, client, state }) {
    const c = check(sessionId, person, resolve, verb);
    if (!c.mod) return show(c.message);
    const { found, mod } = c;

    if (verb === 'read') return readRequestClick({ c, sessionId, person, resolve, show, state });

    if (verb === 'change') {
      const held = found.session.pending ? found.session.pending.values : null;
      const initial = found.session.values || held || {};
      session.save(store, sessionId, { ...found.session, pending: null }, null);
      return show(form(mod, { sessionId, initial }));
    }

    // confirm. No await between the lookup above and this consume (AD-7).
    const consumed = session.consume(store, sessionId, person);
    if (!consumed.consumed) {
      if (consumed.status !== session.STATUS.OK) return show(refusalFor(consumed.status));
      // Nothing checked yet (a stale Confirm after Change): back to the form.
      return show(form(mod, { sessionId }));
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

  return { open, submit, answer, click };
}

module.exports = {
  createScopedPull, createRunner, checkQuery, ROW_CAP, checkDeclarations, verbOf, parseMetadata, ACTIONS, ACTION_PATTERN, FORM_CALLBACK,
  ANSWER_CALLBACK,
};
