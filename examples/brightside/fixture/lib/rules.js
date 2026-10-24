'use strict';

// The synthetic-data and integrity rules the reference tables must keep
// (fixture-tables.md). The generator refuses to write output that breaks one;
// the tests run the same function on deliberately broken rows.

const { TABLES, pkOf } = require('./tables');
const { toDay } = require('./days');

const PHONE = /^555-01\d\d$/;

function checkRules(tables, { zones, historyStart, asOf }) {
  const problems = [];
  const fail = (msg) => problems.push(msg);

  // Keys: every primary key unique, every foreign key resolves.
  const keys = {};
  for (const table of TABLES) {
    const rows = tables[table.name];
    if (!rows) continue;
    const pk = pkOf(table);
    keys[table.name] = new Set();
    for (const row of rows) {
      if (keys[table.name].has(row[pk])) fail(`${table.name}: duplicate ${pk} ${row[pk]}`);
      keys[table.name].add(row[pk]);
    }
    for (const col of table.columns) {
      for (const row of rows) {
        const v = row[col.name];
        if (v === null || v === undefined) {
          if (col.pk || col.notNull) fail(`${table.name} ${row[pk]}: ${col.name} is empty`);
          continue;
        }
        if (col.references && !keys[col.references].has(v)) {
          fail(`${table.name} ${row[pk]}: ${col.name} ${v} has no ${col.references} row`);
        }
        if (col.name.endsWith('_cents') && !(Number.isSafeInteger(v) && v >= 0)) {
          fail(`${table.name} ${row[pk]}: ${col.name} ${v} is not whole cents`);
        }
      }
    }
  }

  // Contact details are synthetic: unique .invalid emails, 555-01xx phones.
  const emails = new Set();
  for (const c of tables.clients || []) {
    if (!String(c.email).endsWith('.invalid')) fail(`clients ${c.client_id}: email ${c.email} does not end in .invalid`);
    if (emails.has(c.email)) fail(`clients ${c.client_id}: email ${c.email} is not unique`);
    emails.add(c.email);
    if (!PHONE.test(c.phone)) fail(`clients ${c.client_id}: phone ${c.phone} is not 555-0100 to 555-0199`);
    if (c.created_on < historyStart || c.created_on > asOf) {
      fail(`clients ${c.client_id}: created_on ${c.created_on} is outside ${historyStart} to ${asOf}`);
    }
  }

  // A property is in its client's zone: its city and postal code say which.
  const clientZone = new Map((tables.clients || []).map((c) => [c.client_id, c.zone_id]));
  const zoneById = new Map(zones.map((z) => [z.zone_id, z]));
  for (const p of tables.properties || []) {
    const zone = zoneById.get(clientZone.get(p.client_id));
    if (!zone) continue; // reported above as a missing foreign key
    if (!zone.cities.includes(p.city)) fail(`properties ${p.property_id}: city ${p.city} is not in zone ${zone.zone_id}`);
    if (!String(p.postal_code).startsWith(`00${zone.index}`)) {
      fail(`properties ${p.property_id}: postal code ${p.postal_code} is not in zone ${zone.zone_id}`);
    }
  }

  // Crew memberships: inside the history window, and never overlapping per
  // staff member (end_date inclusive, NULL = current).
  const first = toDay(historyStart);
  const last = toDay(asOf);
  const byStaff = new Map();
  for (const m of tables.crew_memberships || []) {
    const start = toDay(m.start_date);
    const end = m.end_date === null ? Infinity : toDay(m.end_date);
    if (start < first) fail(`crew_memberships ${m.membership_id}: starts before ${historyStart}`);
    if (end < start) fail(`crew_memberships ${m.membership_id}: ends before it starts`);
    if (end !== Infinity && end > last) fail(`crew_memberships ${m.membership_id}: ends after as_of ${asOf}`);
    if (!byStaff.has(m.staff_name)) byStaff.set(m.staff_name, []);
    byStaff.get(m.staff_name).push({ id: m.membership_id, start, end });
  }
  for (const [name, periods] of byStaff) {
    periods.sort((a, b) => a.start - b.start || a.id - b.id);
    for (let i = 1; i < periods.length; i++) {
      if (periods[i].start <= periods[i - 1].end) {
        fail(`crew_memberships ${periods[i - 1].id} and ${periods[i].id}: ${name}'s periods overlap`);
      }
    }
  }

  return problems;
}

module.exports = { checkRules };
