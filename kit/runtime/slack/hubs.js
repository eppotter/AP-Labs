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
// Seam: canUse(person, module) returns 'allowed' | 'denied' | 'error' (true
// and false are read as allowed and denied); person is { id, user } with user
// the profile user or null. Tests may inject their own.
//
// Data (Story 7.5): a handler gets ctx.data.run(sql, params), the query runner
// (kit/runtime/data) with the manifest's declared parameter names, so a
// parameter the manifest does not declare is refused. When the data is
// unavailable the person is told so plainly and the app keeps running.

const access = require('../access');
const { NotSetUp, AccessDenied, ConfigFault } = require('../errors');
const { messageFor } = require('../messages');
const { handle } = require('./handle');
const { buildMenu, moduleIdFromAction, OPEN_ACTION } = require('../registry/menu');
const { isVisible } = require('../registry');
const { DATA_UNAVAILABLE, DataUnavailableError } = require('../data');

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

// The data a module's handler sees: run() with the manifest's parameters as
// the declared names. Without a data source, every run is unavailable.
function moduleData(data, mod) {
  const declared = (mod.parameters || []).map((p) => p.name);
  return Object.freeze({
    run: (sql, params) => {
      if (!data) return Promise.reject(new DataUnavailableError('no data source'));
      return data.run(sql, params, { declared });
    },
    describe: () => (data ? data.describe() : { available: false }),
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

  for (const hub of registry.hubs) {
    app.command(hub.command, handle(`hub:${hub.id}`, async ({ command, respond }) => {
      const person = personOf(command.user_id);
      const notice = person.user ? undefined : messageFor(new NotSetUp({ client: profile.client.name, admin }));
      await respond(ephemeral(buildMenu(hub, visibleEntries(hub.id, person), { notice })));
    }, { log, store }));
  }

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
      if (!err || err.code !== 'DATA_UNAVAILABLE') throw err;
      log.warn('data unavailable', { module: mod.id, reason: err.reason || err.message });
      await respond(ephemeral(DATA_UNAVAILABLE));
    }
  }, { log, store }));
}

module.exports = { registerHubs, personName, NOT_AVAILABLE };
