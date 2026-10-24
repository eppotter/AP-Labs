'use strict';

// Who a Slack user is and what they may open (Story 6.3, CAP-4). The profile
// is the only access source: a Slack id maps to the profile user whose
// identities.slack matches (unique, checked by kit/lib/profile), and each
// module's resource key is decided by kit/lib/permissions, deny beating allow.
//
//   personFor(profile, slackId)  → the profile user, or null (not set up)
//   decide(profile, user, key)   → 'allowed' | 'denied' | 'error'
//   adminContact(profile)        → who to ask, as Slack mrkdwn
//
// An unknown person resolves with no user, so only open_access resources are
// allowed. 'error' (a key the profile does not declare) is a configuration
// fault: the caller treats it as deny, logs it and never words it as a denial.

const { resolveAccess } = require('../../lib/permissions');
const { escapeText } = require('../messages');

// Map lookups so '__proto__' or 'constructor' never match. Cached per (frozen)
// profile object.
const bySlack = new WeakMap();

function slackIndex(profile) {
  let idx = bySlack.get(profile);
  if (!idx) {
    idx = new Map();
    for (const u of profile.users) {
      const id = u.identities && u.identities.slack;
      if (typeof id === 'string' && id) idx.set(id, u);
    }
    bySlack.set(profile, idx);
  }
  return idx;
}

function personFor(profile, slackId) {
  if (typeof slackId !== 'string' || !slackId) return null;
  return slackIndex(profile).get(slackId) || null;
}

function decide(profile, user, key) {
  return resolveAccess(profile, user ? user.id : undefined, key);
}

// A Slack user id, safe to put inside a mention. Anything else in the profile
// falls back to the person's name.
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

// The profile's admins, as a Slack mention when their Slack id is known (Slack
// renders it as their name), else their name: "A", "A or B", "A, B or C".
function adminContact(profile) {
  const names = profile.users
    .filter((u) => u.role === 'admin')
    .map((u) => {
      const id = u.identities && u.identities.slack;
      return SLACK_USER_ID.test(id || '') ? `<@${id}>` : escapeText(u.name);
    });
  if (names.length <= 1) return names[0] || 'your admin';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

module.exports = { personFor, decide, adminContact };
