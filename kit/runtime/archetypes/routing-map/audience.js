'use strict';

// Who sees which crews on the routing map (Story 15.4, AD-R17). An engine
// floor: kit/lib/tier ENGINE_T3 lists this file, so any change to who sees a
// map is T3 under every profile.
//
// The profile's routing.audience (validated by kit/lib/profile, Story 15.2)
// names two resource keys and the crew leads:
//   all_crews    a resource key: whoever holds it sees every crew
//   own_crew     a resource key: whoever holds it AND has a crew_leads row
//                sees that one crew only
//   crew_leads[] { user, crew_id }: a profile user id and the crew they lead
// Each key is decided by kit/runtime/access (kit/lib/permissions: a user's
// deny beats every allow, and admin_grantable applies as for any key).
//
//   canOpen(profile, user)  'allowed' | 'denied' | 'error': whether the
//                           routing-map module shows on the menu and opens.
//                           Allowed for all_crews or own_crew (a crew lead
//                           with no crew_leads row still sees the entry and
//                           gets the configuration refusal on Open, so the
//                           fault is seen and logged, never hidden).
//   scopeFor(profile, user) the scope for one click, decided afresh every
//                           time: { scope: { all: true } } for all_crews,
//                           { scope: { crewId } } for own_crew with a row,
//                           else { refusal: 'denied' } or { refusal:
//                           'config', reason } (no audience, an undeclared
//                           key, own_crew with no crew_leads row).
//   checkScope(scope, crewIds)  'ok', or 'config' when a crew lead's crew_id
//                           names no crew in the day's data: the
//                           configuration refusal, never an empty map.
//   visible(scope, crewId)  true when this scope may see that crew.
//
// The scope always comes from here, never from anything a click carries: a
// lead's action naming another crew or a zone still yields their own crew.
// Nothing here reads data, logs or keeps state.

const access = require('../../access');

const ALL = Object.freeze({ all: true });

function audienceOf(profile) {
  const routing = profile && profile.routing;
  const audience = routing && routing.audience;
  if (!audience || typeof audience.all_crews !== 'string' || typeof audience.own_crew !== 'string') return null;
  return audience;
}

function decisions(profile, user) {
  const audience = audienceOf(profile);
  if (!audience) return null;
  return {
    audience,
    all: access.decide(profile, user, audience.all_crews),
    own: access.decide(profile, user, audience.own_crew),
  };
}

function canOpen(profile, user) {
  const d = decisions(profile, user);
  if (!d || d.all === 'error' || d.own === 'error') return 'error';
  return d.all === 'allowed' || d.own === 'allowed' ? 'allowed' : 'denied';
}

function scopeFor(profile, user) {
  const d = decisions(profile, user);
  if (!d) return { refusal: 'config', reason: 'no routing audience in the profile' };
  if (d.all === 'error' || d.own === 'error') return { refusal: 'config', reason: 'an audience key is not declared' };
  if (d.all === 'allowed') return { scope: ALL };
  if (d.own !== 'allowed') return { refusal: 'denied' };
  const userId = user && typeof user.id === 'string' ? user.id : null;
  const rows = (d.audience.crew_leads || []).filter((l) => l.user === userId);
  if (rows.length !== 1 || typeof rows[0].crew_id !== 'string' || !rows[0].crew_id) {
    return { refusal: 'config', reason: 'own_crew with no crew_leads row' };
  }
  return { scope: Object.freeze({ crewId: rows[0].crew_id }) };
}

function checkScope(scope, crewIds) {
  if (scope && scope.all === true) return 'ok';
  const ids = crewIds instanceof Set ? crewIds : new Set(crewIds);
  return scope && typeof scope.crewId === 'string' && ids.has(scope.crewId) ? 'ok' : 'config';
}

function visible(scope, crewId) {
  if (!scope) return false;
  if (scope.all === true) return true;
  return typeof crewId === 'string' && crewId === scope.crewId;
}

module.exports = {
  canOpen, scopeFor, checkScope, visible, audienceOf,
};
