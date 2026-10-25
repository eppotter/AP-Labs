'use strict';

// Wires the registry to Slack (Story 6.2). Each hub's slash command replies
// privately with its menu; one action listener dispatches every Open click to
// the module's handler. Both go through handle(), so the ack comes first and
// any failure becomes a plain private message.
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

const access = require('../access');
const {
  NotSetUp, AccessDenied, ConfigFault, DataUnavailable,
} = require('../errors');
const { messageFor, welcomeText, feedbackText, joinWelcomeText } = require('../messages');
const { handle } = require('./handle');
const {
  buildMenu, buildHelp, moduleIdFromAction, hubIdFromHelpAction, OPEN_ACTION, HELP_ACTION,
} = require('../registry/menu');
const { isVisible } = require('../registry');

const NOT_AVAILABLE = "That option isn't available here any more. Type the hub's command to see the current menu.";

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

  for (const hub of registry.hubs) {
    app.command(hub.command, handle(`hub:${hub.id}`, async ({ command, respond }) => {
      const person = personOf(command.user_id);
      const welcome = firstVisit(store, command.user_id, hub.id) ? welcomeText(hub) : undefined;
      await respond(ephemeral(buildMenu(hub, visibleEntries(hub.id, person), { notice: notSetUp(person), welcome })));
    }, { log, store }));
  }

  app.action(HELP_ACTION, handle('hub:help', async ({ action, body, respond }) => {
    const actionId = action && action.action_id;
    const hubId = hubIdFromHelpAction(actionId);
    const hub = registry.hubs.find((h) => h.id === hubId);
    if (!hub) {
      log.warn('hub action refused', { action_id: actionId, reason: 'unknown hub', env });
      await respond(ephemeral(NOT_AVAILABLE));
      return;
    }
    const person = personOf((body.user || {}).id);
    await respond(ephemeral(buildHelp(hub, visibleEntries(hub.id, person), {
      notice: notSetUp(person),
      feedback: feedbackText(hub, admin),
    })));
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

  app.action(OPEN_ACTION, handle('hub:dispatch', async ({ action, body, respond, client }) => {
    const user = body.user || {};
    const actionId = action && action.action_id;
    const mod = registry.module(moduleIdFromAction(actionId));
    if (!mod || !isVisible(mod, env)) {
      log.warn('hub action refused', { action_id: actionId, reason: !mod ? 'unknown module' : 'hidden in this environment', env });
      await respond(ephemeral(NOT_AVAILABLE));
      return;
    }
    const person = personOf(user.id);
    const decision = decide(person, mod);
    if (decision !== 'allowed') {
      let refusal;
      if (decision === 'error') refusal = new ConfigFault({ admin });
      else if (!person.user) refusal = new NotSetUp({ client: profile.client.name, admin });
      else refusal = new AccessDenied({ label: mod.label, admin });
      log.warn('hub action refused', { action_id: actionId, reason: refusal.name, user: person.user ? person.user.id : null, env });
      await respond(ephemeral(messageFor(refusal)));
      return;
    }
    const name = await personName(client, user, log);
    log.info('module dispatched', { module: mod.id, hub: mod.hub });
    try {
      await mod.run({
        person: { id: user.id, name },
        client: { id: profile.client.id, name: profile.client.name },
        module: { id: mod.id, label: mod.label },
        data: moduleData(data, mod),
        reply: (message) => respond(ephemeral(message)),
      });
    } catch (err) {
      if (!(err instanceof DataUnavailable)) throw err;
      log.warn('data unavailable', { module: mod.id, reason: err.reason });
      await respond(ephemeral(messageFor(err)));
    }
  }, { log, store }));
}

module.exports = { registerHubs, personName, firstVisit, NOT_AVAILABLE };
