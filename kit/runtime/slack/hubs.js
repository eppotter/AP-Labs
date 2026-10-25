'use strict';

// Wires the registry to Slack (Story 6.2). Each hub's slash command opens its
// menu as a modal (kit/runtime/slack/modal); one action listener dispatches
// every Open click to the module's handler. Both go through handle(), so the
// ack comes first and any failure becomes a plain private message.
//
// Modals: an Open or Help click inside the hub modal pushes a view onto it
// (Slack's back arrow returns to the menu). A module's view shows "Loading…"
// until its first ctx.reply, and each later reply is appended below. Refusals,
// "not available", data-unavailable and the plain error render in the pushed
// view too. Fallback to the earlier private (ephemeral) replies, exactly as
// before: when views.open fails (an expired trigger, an API error) or there is
// no views client, and when a click comes from a message rather than a modal
// (an old menu still in a channel), or the first push fails and Slack gave a
// response_url. Each fallback is logged once at info, with the hub and Slack's
// error code only, never person data.
//
// Access (Story 6.3): the Slack id is mapped to a profile user
// (kit/runtime/access) and each entry's resource key is decided by
// kit/lib/permissions. The menu shows only what the person may use; an unknown
// person sees only open-access entries and is told who to ask. A click is
// re-checked at dispatch: an unknown module or one hidden in this environment
// gets the generic "not available"; a module the person may not use is refused
// by kit/runtime/messages (not set up, or no access to <label>); a resource
// key the profile does not declare is logged and reported as a configuration
// fault, never as a denial. A replayed or stale payload never runs a handler
// the menu would not show.
//
// Welcome and help (Story 6.4): the first time a person opens a hub (per
// person per hub, in the store's `welcome` namespace, so again after a restart
// or the 7-day TTL) the hub's welcome sits above the entries. Every menu ends
// with Help; a Help click re-reads the same access decision as the menu, so it
// never lists a module the person cannot open. A person joining the workspace
// (team_join) gets a private DM naming the hubs with at least one entry they
// can use.
//
// Seam: canUse(person, module) returns 'allowed' | 'denied' | 'error' (true
// and false are read as allowed and denied); person is { id, user } with user
// the profile user or null. Tests may inject their own.
//
// Data (Story 7.5): a handler gets ctx.data.run(sql, params), the query runner
// (kit/runtime/data) with the manifest's declared parameter names, so a
// parameter the manifest does not declare is refused. When the data is
// unavailable (a DataUnavailable error) the person is told so plainly, worded
// by kit/runtime/messages, and the app keeps running.
//
// Scoped pulls (Story 9.3): Open on a scoped-pull module pushes its typed form
// as the module's view (kit/runtime/archetypes/scoped-pull), so menu and
// module stay the only two views. The form has input blocks, so its view has
// a submit, "Check values" (Slack rejects an input view without one). Its
// view_submission is handled with handleView, which answers in the ack:
// { response_action: 'errors' } beside the inputs, or { response_action:
// 'update' } to the Confirm screen (or a refusal) in the same view. Confirm
// and Change are buttons on that screen; one listener re-checks access and
// updates the view the click came from in place (modal.updatedView:
// views.update with that view's id and hash), never pushing a third view. A
// hash_conflict means the view changed since the click: the out-of-date
// result is dropped and logged. A form needs the hub modal; opened from an
// old message menu, the person is told to open it from the hub window.

const access = require('../access');
const {
  NotSetUp, AccessDenied, ConfigFault, DataUnavailable,
} = require('../errors');
const { messageFor, welcomeText, feedbackText, joinWelcomeText } = require('../messages');
const { handle, handleView, PLAIN_ERROR } = require('./handle');
const {
  buildMenu, buildHelp, moduleIdFromAction, hubIdFromHelpAction, OPEN_ACTION, HELP_ACTION,
} = require('../registry/menu');
const { isVisible } = require('../registry');
const {
  modalView, moduleView, messageBlocks, pushedView, fromModal, hasViews, failureReason, updatedView,
} = require('./modal');
const { messageParts } = require('./format');
const {
  createScopedPull, verbOf, parseMetadata, ACTION_PATTERN: FORM_ACTION, FORM_CALLBACK,
} = require('../archetypes/scoped-pull');

const NOT_AVAILABLE = "That option isn't available here any more. Type the hub's command to see the current menu.";
const FORM_NEEDS_WINDOW = "This option's form opens in the hub's window. Type the hub's command and press Open on it there.";

function defaultCanUse(profile) {
  return (person, mod) => access.decide(profile, person.user, mod.resource);
}

function asDecision(v) {
  if (v === true || v === 'allowed') return 'allowed';
  if (v === false || v === 'denied') return 'denied';
  return 'error';
}

// The person's display name from users.info (users:read), else the name Slack
// sent with the payload, else a mention Slack renders as their name.
async function personName(client, user, log) {
  try {
    const res = client && client.users && await client.users.info({ user: user.id });
    const u = res && res.user;
    const name = u && ((u.profile && (u.profile.display_name || u.profile.real_name)) || u.real_name);
    if (name) return name;
  } catch (err) {
    log.warn('users.info failed; using the payload name', { err });
  }
  return user.name || `<@${user.id}>`;
}

function ephemeral(message) {
  const m = typeof message === 'string' ? { text: message } : message;
  return { response_type: 'ephemeral', replace_original: false, ...m };
}

// True the first time this person opens this hub; records the visit.
// Synchronous: no await between the check and the set (AD-7).
function firstVisit(store, slackId, hubId) {
  if (!store || typeof slackId !== 'string' || !slackId) return false;
  const key = `${slackId}:${hubId}`;
  if (store.get('welcome', key) !== undefined) return false;
  store.set('welcome', key, true);
  return true;
}

// team_join sends the user object; tolerate a bare id.
function joinedUser(event) {
  const u = event && event.user;
  if (typeof u === 'string') return { id: u };
  return u && typeof u === 'object' ? u : null;
}

// The data a module's handler sees: run() with the manifest's parameters as
// the declared names. Without a data source, every run is unavailable.
function moduleData(data, mod) {
  const declared = (mod.parameters || []).map((p) => p.name);
  return Object.freeze({
    run: (sql, params) => {
      if (!data) return Promise.reject(new DataUnavailable('no data source'));
      return data.run(sql, params, { declared });
    },
    describe: () => (data ? data.describe() : { source: null, label: null, available: false, problem: 'no data source' }),
  });
}

function registerHubs(app, { registry, profile, env, log, store, data = null, canUse = defaultCanUse(profile) }) {
  const admin = access.adminContact(profile);
  const personOf = (slackId) => ({ id: slackId, user: access.personFor(profile, slackId) });
  const decide = (person, mod) => {
    const d = asDecision(canUse(person, mod));
    if (d === 'error') log.error('access configuration fault', { module: mod.id, resource: mod.resource });
    return d;
  };
  const visibleEntries = (hubId, person) => registry.entries(hubId)
    .filter((m) => isVisible(m, env) && decide(person, m) === 'allowed');
  const notSetUp = (person) => (person.user ? undefined : messageFor(new NotSetUp({ client: profile.client.name, admin })));
  const fellBack = (where, reason, hub) => log.info('hub modal fallback', { where, reason, hub: hub || null });
  const scopedPull = createScopedPull({ store, log });

  // Why this person may not open mod (a message), or null when they may.
  // The refusal is logged with the click's action id.
  const refusalFor = (person, mod, actionId) => {
    const decision = decide(person, mod);
    if (decision === 'allowed') return null;
    let refusal;
    if (decision === 'error') refusal = new ConfigFault({ admin });
    else if (!person.user) refusal = new NotSetUp({ client: profile.client.name, admin });
    else refusal = new AccessDenied({ label: mod.label, admin });
    log.warn('hub action refused', { action_id: actionId, reason: refusal.name, user: person.user ? person.user.id : null, env });
    return messageFor(refusal);
  };

  // The scoped-pull module a form session names, if this person may still
  // open it: { mod } or { refusal }. Synchronous, so Confirm can consume with
  // no await after the check.
  const resolveForm = (person, actionId) => (moduleId) => {
    const mod = registry.module(moduleId);
    if (!mod || mod.archetype !== 'scoped-pull' || !isVisible(mod, env)) {
      log.warn('hub action refused', {
        action_id: actionId, reason: !mod ? 'unknown module' : 'not available', user: person.user ? person.user.id : null, env,
      });
      return { refusal: NOT_AVAILABLE };
    }
    const refused = refusalFor(person, mod, actionId);
    return refused ? { refusal: refused } : { mod };
  };

  // Where a click's replies go. From a hub modal: a view pushed onto it
  // (reply() pushes, then appends; loading() pushes "Loading…" first). From a
  // message: the ephemeral reply, as before. If the first push fails and Slack
  // gave a response_url, this click falls back to ephemeral replies.
  const replyTarget = ({ body, respond, client }, { where, title, hubId }) => {
    // A long text reply goes as section blocks, in more than one message if
    // it needs over 50 blocks (kit/runtime/slack/format).
    // A message that works only in a view (a form) names what to send instead.
    const viaEphemeral = async (message) => {
      const m = message && typeof message === 'object' && message.ephemeralFallback !== undefined ? message.ephemeralFallback : message;
      for (const part of messageParts(m)) await respond(ephemeral(part));
    };
    if (!fromModal(body) || !hasViews(client)) {
      fellBack(where, fromModal(body) ? 'no views client' : 'not from a modal', hubId);
      return { modal: false, loading: async () => {}, reply: viaEphemeral };
    }
    const view = pushedView({ client, triggerId: body.trigger_id, title, hubId });
    let ephemeralNow = false;
    const guarded = (fn) => async (message) => {
      if (ephemeralNow) return message === undefined ? undefined : viaEphemeral(message);
      try {
        return await fn(message);
      } catch (err) {
        if (view.pushed || typeof respond !== 'function') throw err;
        ephemeralNow = true;
        fellBack(where, failureReason(err), hubId);
        return message === undefined ? undefined : viaEphemeral(message);
      }
    };
    return { modal: true, loading: guarded(() => view.loading()), reply: guarded((m) => view.show(m)) };
  };

  // In a modal there is no response_url for handle() to answer through, so a
  // failure is logged and the plain error is shown in the pushed view.
  const failInView = async (name, target, err) => {
    log.error('handler failed', { handler: name, err });
    try {
      await target.reply(PLAIN_ERROR);
    } catch (replyErr) {
      log.error('could not tell the person about a failure', { handler: name, err: replyErr });
    }
  };

  for (const hub of registry.hubs) {
    app.command(hub.command, handle(`hub:${hub.id}`, async ({ command, respond, client }) => {
      const person = personOf(command.user_id);
      const welcome = firstVisit(store, command.user_id, hub.id) ? welcomeText(hub) : undefined;
      const menu = buildMenu(hub, visibleEntries(hub.id, person), { notice: notSetUp(person), welcome });
      if (!hasViews(client) || typeof command.trigger_id !== 'string' || !command.trigger_id) {
        fellBack('command', hasViews(client) ? 'no trigger_id' : 'no views client', hub.id);
      } else {
        try {
          // The divider and Help stay at the end of a menu cut to Slack's limit.
          const view = modalView({ title: hub.name, blocks: menu.blocks, hubId: hub.id, keepTail: 2, callbackId: 'hub:menu' });
          await client.views.open({ trigger_id: command.trigger_id, view });
          return;
        } catch (err) {
          fellBack('command', failureReason(err), hub.id);
        }
      }
      await respond(ephemeral(menu));
    }, { log, store }));
  }

  app.action(HELP_ACTION, handle('hub:help', async (args) => {
    const { action, body } = args;
    const actionId = action && action.action_id;
    const hubId = hubIdFromHelpAction(actionId);
    const hub = registry.hubs.find((h) => h.id === hubId);
    const target = replyTarget(args, { where: 'help', title: hub ? `Help: ${hub.name}` : 'Help', hubId: hub ? hub.id : null });
    try {
      if (!hub) {
        log.warn('hub action refused', { action_id: actionId, reason: 'unknown hub', env });
        await target.reply(NOT_AVAILABLE);
        return;
      }
      const person = personOf((body.user || {}).id);
      await target.reply(buildHelp(hub, visibleEntries(hub.id, person), {
        notice: notSetUp(person),
        feedback: feedbackText(hub, admin),
      }));
    } catch (err) {
      if (!target.modal) throw err;
      await failInView('hub:help', target, err);
    }
  }, { log, store }));

  app.event('team_join', handle('team-join', async ({ event, client }) => {
    const user = joinedUser(event);
    if (!user || typeof user.id !== 'string' || !user.id || user.is_bot || user.deleted) return;
    const person = personOf(user.id);
    const hubs = registry.hubs.filter((h) => visibleEntries(h.id, person).length > 0);
    const text = joinWelcomeText({ client: profile.client.name, hubs, notice: notSetUp(person), admin });
    await client.chat.postMessage({ channel: user.id, text });
    log.info('join welcome sent', { hubs: hubs.map((h) => h.command), set_up: Boolean(person.user) });
  }, { log, store }));

  app.action(OPEN_ACTION, handle('hub:dispatch', async (args) => {
    const { action, body, client } = args;
    const user = body.user || {};
    const actionId = action && action.action_id;
    const mod = registry.module(moduleIdFromAction(actionId));
    const shown = mod && isVisible(mod, env);
    const target = replyTarget(args, { where: 'open', title: shown ? mod.label : 'Not available', hubId: shown ? mod.hub : null });
    try {
      if (!shown) {
        log.warn('hub action refused', { action_id: actionId, reason: !mod ? 'unknown module' : 'hidden in this environment', env });
        await target.reply(NOT_AVAILABLE);
        return;
      }
      const person = personOf(user.id);
      const refused = refusalFor(person, mod, actionId);
      if (refused) {
        await target.reply(refused);
        return;
      }
      if (mod.archetype === 'scoped-pull') {
        log.info('module dispatched', { module: mod.id, hub: mod.hub });
        await target.reply(target.modal ? { ...scopedPull.open(mod, user.id), ephemeralFallback: FORM_NEEDS_WINDOW } : FORM_NEEDS_WINDOW);
        return;
      }
      // Push "Loading…" before anything slow: the trigger_id lasts 3 seconds.
      await target.loading();
      const name = await personName(client, user, log);
      log.info('module dispatched', { module: mod.id, hub: mod.hub });
      try {
        await mod.run({
          person: { id: user.id, name },
          client: { id: profile.client.id, name: profile.client.name },
          module: { id: mod.id, label: mod.label },
          data: moduleData(data, mod),
          reply: (message) => target.reply(message),
        });
      } catch (err) {
        if (!(err instanceof DataUnavailable)) throw err;
        log.warn('data unavailable', { module: mod.id, reason: err.reason });
        await target.reply(messageFor(err));
      }
    } catch (err) {
      if (!target.modal) throw err;
      await failInView('hub:dispatch', target, err);
    }
  }, { log, store }));

  // A scoped-pull form's submit ("Check values"). The answer goes in the ack:
  // errors beside the inputs, or the Confirm screen (or a refusal) in place.
  const submittedView = (view, message) => moduleView({
    title: view && view.title && view.title.text,
    hubId: parseMetadata(view && view.private_metadata).hubId,
    blocks: messageBlocks(message),
    message,
  });
  app.view(FORM_CALLBACK, handleView('hub:form-submit', ({ body }) => {
    const view = body.view || {};
    const person = personOf((body.user || {}).id);
    const { sessionId } = parseMetadata(view.private_metadata);
    const res = scopedPull.submit({ sessionId, person: person.id, state: view.state, resolve: resolveForm(person, FORM_CALLBACK) });
    if (res.errors) return { response_action: 'errors', errors: res.errors };
    return { response_action: 'update', view: submittedView(view, res.message) };
  }, { log, onError: ({ body }) => ({ response_action: 'update', view: submittedView(body && body.view, PLAIN_ERROR) }) }));

  // The Confirm screen's buttons. Each click updates the view it came from.
  app.action(FORM_ACTION, handle('hub:form', async ({ action, body, client, respond }) => {
    const verb = verbOf(action && action.action_id);
    const from = body.view;
    if (!from || typeof from.id !== 'string' || !from.id || !hasViews(client)) {
      fellBack('form', from ? 'no views client' : 'not from a modal', null);
      if (typeof respond === 'function') await respond(ephemeral(FORM_NEEDS_WINDOW));
      return;
    }
    const { hubId } = parseMetadata(from.private_metadata);
    const view = updatedView({ client, view: from, title: from.title && from.title.text, hubId });
    const show = async (message, opts) => {
      const status = await view.show(message, opts);
      if (status === 'dropped') log.info('stale view result dropped', { action: verb, reason: 'hash_conflict' });
      if (status === 'forced') log.info('stale view replaced by a confirmed result', { action: verb, reason: 'hash_conflict' });
      return status;
    };
    const person = personOf((body.user || {}).id);
    try {
      await scopedPull.click({ verb, sessionId: action.value, person: person.id, resolve: resolveForm(person, action.action_id), show });
    } catch (err) {
      log.error('handler failed', { handler: 'hub:form', err });
      try {
        await view.show(PLAIN_ERROR);
      } catch (showErr) {
        log.error('could not tell the person about a failure', { handler: 'hub:form', err: showErr });
      }
    }
  }, { log, store }));
}

module.exports = { registerHubs, personName, firstVisit, NOT_AVAILABLE, FORM_NEEDS_WINDOW };
