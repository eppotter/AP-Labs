'use strict';

// Resolves who may do what, with the profile as the only access source.
// Pure and synchronous: the caller passes a profile from kit/lib/profile.
//
// resolveAccess(profile, userId, key) returns 'allowed' | 'denied' | 'error' (PR-02):
//   - key not declared in resources  → 'error'  (a caller typo, never a revocation:
//       a caller that acts on 'denied' must not mistake a config bug for a denial)
//   - key in the user's `deny`        → 'denied' (deny wins over everything, PR-03)
//   - open_access resource            → 'allowed' (even for someone not in users)
//   - no userId, or not in users      → 'denied' (default deny)
//   - key in `grants`, or role admin
//     and the resource is admin_grantable → 'allowed'
//   - anything else                   → 'denied'
//   - a malformed profile argument    → 'error'
//
// Harvested from the archived repo's permissions/index.js. Changes: the catalog
// lives in the profile, users are keyed by kit id instead of Slack id, and a
// user's deny now also beats open_access.

// Map lookups, not object property reads, so 'constructor' / '__proto__' can
// never resolve as a real key or user. Cached per (frozen) profile object.
const indexes = new WeakMap();

function indexOf(profile) {
  let idx = indexes.get(profile);
  if (!idx) {
    idx = {
      resources: new Map(profile.resources.map((r) => [r.key, r])),
      users: new Map(profile.users.map((u) => [u.id, u])),
    };
    indexes.set(profile, idx);
  }
  return idx;
}

function decide(user, resource) {
  if (user && user.deny.includes(resource.key)) return false;
  if (resource.open_access) return true;
  if (!user) return false;
  if (user.grants.includes(resource.key)) return true;
  return user.role === 'admin' && resource.admin_grantable;
}

function resolveAccess(profile, userId, key) {
  try {
    const { resources, users } = indexOf(profile);
    const resource = typeof key === 'string' ? resources.get(key) : undefined;
    if (!resource) return 'error';
    const user = typeof userId === 'string' && userId ? users.get(userId) : undefined;
    return decide(user, resource) ? 'allowed' : 'denied';
  } catch (_) {
    return 'error';
  }
}

function hasAccess(profile, userId, key) {
  return resolveAccess(profile, userId, key) === 'allowed';
}

// Every declared resource resolved for one user, in profile order.
// Map<key, { allowed, label }>.
function accessMatrix(profile, userId) {
  const matrix = new Map();
  for (const r of profile.resources) {
    matrix.set(r.key, { allowed: resolveAccess(profile, userId, r.key) === 'allowed', label: r.label });
  }
  return matrix;
}

module.exports = { resolveAccess, hasAccess, accessMatrix };
