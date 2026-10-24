'use strict';

// Wires the registry to Slack (Story 6.2). Each hub's slash command replies
// privately with its menu; one action listener dispatches every Open click to
// the module's handler. Both go through handle(), so the ack comes first and
// any failure becomes a plain private message.
//
// A click is re-checked at dispatch: an unknown module, an entry hidden in
// this environment, or one the person may not use is refused (a replayed or
// stale payload never runs a handler the menu would not show).
//
// Access seam: canUse(person, module) decides both the menu and dispatch. The
// default asks kit/lib/permissions with no profile user (every registered
// module is open_access until Story 6.3 maps Slack ids to profile users).
//
// Data (Story 7.5): a handler gets ctx.data.run(sql, params), the query runner
// (kit/runtime/data) with the manifest's declared parameter names, so a
// parameter the manifest does not declare is refused. When the data is
// unavailable the person is told so plainly and the app keeps running.

const { hasAccess } = require('../../lib/permissions');
const { handle } = require('./handle');
const { buildMenu, moduleIdFromAction, OPEN_ACTION } = require('../registry/menu');
const { isVisible } = require('../registry');
const { DATA_UNAVAILABLE, DataUnavailableError } = require('../data');

const NOT_AVAILABLE = "That option isn't available here any more. Type the hub's command to see the current menu.";

function defaultCanUse(profile) {
  return (_person, mod) => hasAccess(profile, undefined, mod.resource);
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
  const visibleEntries = (hubId, person) => registry.entries(hubId)
    .filter((m) => isVisible(m, env) && canUse(person, m));

  for (const hub of registry.hubs) {
    app.command(hub.command, handle(`hub:${hub.id}`, async ({ command, respond }) => {
      const person = { id: command.user_id };
      await respond(ephemeral(buildMenu(hub, visibleEntries(hub.id, person))));
    }, { log, store }));
  }

  app.action(OPEN_ACTION, handle('hub:dispatch', async ({ action, body, respond, client }) => {
    const user = body.user || {};
    const id = moduleIdFromAction(action && action.action_id);
    const mod = registry.module(id);
    const person = { id: user.id };
    if (!mod || !isVisible(mod, env) || !canUse(person, mod)) {
      const reason = !mod ? 'unknown module' : !isVisible(mod, env) ? 'hidden in this environment' : 'not allowed';
      log.warn('hub action refused', { action_id: action && action.action_id, reason, env });
      await respond(ephemeral(NOT_AVAILABLE));
      return;
    }
    person.name = await personName(client, user, log);
    log.info('module dispatched', { module: mod.id, hub: mod.hub });
    try {
      await mod.run({
        person,
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
