'use strict';

// Calendar days as integers (days since 1970-01-01), so date arithmetic is
// plain integer math and never reads the clock or a time zone.

const MS_PER_DAY = 86400000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDay(iso) {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new RangeError(`not an ISO date: ${iso}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (toIso(ms / MS_PER_DAY) !== iso) throw new RangeError(`not a calendar day: ${iso}`);
  return ms / MS_PER_DAY;
}

function toIso(day) {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

module.exports = { toDay, toIso };
