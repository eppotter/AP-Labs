'use strict';

// One strict date check for every sign-off: the client files' frontmatter
// (kit/lib/onboard) and known truths (kit/lib/truths). A date is YYYY-MM-DD
// and a real calendar day: 2026-02-30 and 2026-13-01 are rejected, where
// Date.parse would roll them over or accept them (issue #43).

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isIsoDate(v) {
  if (typeof v !== 'string') return false;
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

module.exports = { isIsoDate };
