'use strict';

// The synthetic-data and integrity rules the fixture must keep
// (fixture-tables.md, Validation). The generator refuses to write output that
// breaks one; the tests run the same function on deliberately broken rows.
// Story 7.6 checks the same rules again in SQL against the built database.

const { TABLES, pkOf } = require('./tables');
const { toDay } = require('./days');

const PHONE = /^555-01\d\d$/;
const FREQUENCIES = new Set(['weekly', 'biweekly', 'monthly']);
const METHODS = new Set(['card', 'ach']);

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
    // Unique columns other than the key, single (email is checked below) or combined.
    const uniques = table.columns.filter((c) => c.unique && c.name !== 'email').map((c) => [c.name]).concat(table.unique || []);
    for (const cols of uniques) {
      const seen = new Set();
      for (const row of rows) {
        const k = cols.map((c) => row[c]).join('|');
        if (seen.has(k)) fail(`${table.name} ${row[pk]}: (${cols.join(', ')}) ${k} is not unique`);
        seen.add(k);
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

  if (tables.plans) checkActivity(tables, { asOf, fail });
  return problems;
}

const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
};

// The activity tables (Story 7.2). A row whose foreign key does not resolve is
// reported once, above, and skipped here.
function checkActivity(tables, { asOf, fail }) {
  const last = toDay(asOf);
  const clients = new Map(tables.clients.map((c) => [c.client_id, c]));
  const properties = new Map(tables.properties.map((p) => [p.property_id, p]));
  const crews = new Map(tables.crews.map((c) => [c.crew_id, c]));
  const addOns = new Map(tables.add_ons.map((a) => [a.add_on_id, a]));
  const plans = new Map(tables.plans.map((p) => [p.plan_id, p]));
  const clientOf = (propertyId) => clients.get((properties.get(propertyId) || {}).client_id);

  // Plans: status agrees with end_date, nothing after as_of, the price is the
  // latest change's new price, and each change follows on from the one before.
  const changesOf = groupBy(tables.plan_price_changes, 'plan_id');
  for (const p of tables.plans) {
    const where = `plans ${p.plan_id}`;
    if (!FREQUENCIES.has(p.frequency)) fail(`${where}: frequency ${p.frequency} is not weekly, biweekly or monthly`);
    if (p.status !== (p.end_date === null ? 'active' : 'cancelled')) fail(`${where}: status ${p.status} disagrees with end_date ${p.end_date}`);
    const start = toDay(p.start_date);
    const end = p.end_date === null ? last : toDay(p.end_date);
    if (start > last) fail(`${where}: starts after as_of ${asOf}`);
    if (p.end_date !== null && end > last) fail(`${where}: end_date ${p.end_date} is after as_of ${asOf}`);
    if (end < start) fail(`${where}: ends before it starts`);
    const client = clientOf(p.property_id);
    if (client && p.start_date < client.created_on) fail(`${where}: starts before client ${client.client_id} was created`);
    const chain = (changesOf.get(p.plan_id) || []).slice()
      .sort((a, b) => (a.effective_date < b.effective_date ? -1 : a.effective_date > b.effective_date ? 1 : a.change_id - b.change_id));
    let price = p.start_price_cents;
    for (const ch of chain) {
      const day = toDay(ch.effective_date);
      if (day <= start || day > end) fail(`plan_price_changes ${ch.change_id}: effective ${ch.effective_date} is outside plan ${p.plan_id}'s active period`);
      if (ch.old_price_cents !== price) fail(`plan_price_changes ${ch.change_id}: old price ${ch.old_price_cents} is not the price before it, ${price}`);
      if (ch.new_price_cents === ch.old_price_cents) fail(`plan_price_changes ${ch.change_id}: the price does not change`);
      price = ch.new_price_cents;
    }
    if (p.price_cents !== price) fail(`${where}: price_cents ${p.price_cents} is not the latest price ${price}`);
  }

  // Visits: a plan visit is on the plan's property and package, inside its
  // active period; the crew works in the property's zone.
  for (const v of tables.visits) {
    const where = `visits ${v.visit_id}`;
    if (v.status !== 'completed' && v.status !== 'cancelled') fail(`${where}: status ${v.status} is not completed or cancelled`);
    const client = clientOf(v.property_id);
    const crew = crews.get(v.crew_id);
    if (client && crew && crew.zone_id !== client.zone_id) fail(`${where}: crew ${v.crew_id} is not in the property's zone`);
    if (client && v.visit_date < client.created_on) fail(`${where}: before client ${client.client_id} was created`);
    if (toDay(v.visit_date) > last) fail(`${where}: visit_date ${v.visit_date} is after as_of ${asOf}`);
    const plan = plans.get(v.plan_id);
    if (!plan) continue;
    if (plan.property_id !== v.property_id) fail(`${where}: not on plan ${plan.plan_id}'s property`);
    if (plan.package_id !== v.package_id) fail(`${where}: not plan ${plan.plan_id}'s package`);
    if (v.visit_date < plan.start_date || (plan.end_date !== null && v.visit_date > plan.end_date)) {
      fail(`${where}: ${v.visit_date} is outside plan ${plan.plan_id}'s active period`);
    }
  }

  // Invoices: one per completed visit, none for a cancelled one; the total is
  // the sum of the lines; the package line matches the visit.
  const visits = new Map(tables.visits.map((v) => [v.visit_id, v]));
  const invoiceOfVisit = new Map(tables.invoices.map((i) => [i.visit_id, i]));
  for (const v of tables.visits) {
    if (v.status === 'completed' && !invoiceOfVisit.has(v.visit_id)) fail(`visits ${v.visit_id}: completed but not invoiced`);
    if (v.status === 'cancelled' && invoiceOfVisit.has(v.visit_id)) fail(`visits ${v.visit_id}: cancelled but invoiced`);
  }
  const linesOf = groupBy(tables.invoice_lines, 'invoice_id');
  for (const l of tables.invoice_lines) {
    const where = `invoice_lines ${l.line_id}`;
    if ((l.package_id === null) === (l.add_on_id === null)) fail(`${where}: needs exactly one of package_id and add_on_id`);
    if (!(Number.isSafeInteger(l.quantity) && l.quantity >= 1)) fail(`${where}: quantity ${l.quantity} is not a positive whole number`);
    const addOn = addOns.get(l.add_on_id);
    if (addOn && l.amount_cents !== addOn.price_cents * l.quantity) fail(`${where}: amount is not the add-on price times the quantity`);
  }
  for (const inv of tables.invoices) {
    const where = `invoices ${inv.invoice_id}`;
    const lines = linesOf.get(inv.invoice_id) || [];
    const sum = lines.reduce((s, l) => s + l.amount_cents, 0);
    if (lines.length === 0) fail(`${where}: has no lines`);
    else if (sum !== inv.total_cents) fail(`${where}: total ${inv.total_cents} is not the sum of its lines, ${sum}`);
    if (inv.due_on < inv.issued_on) fail(`${where}: due before it is issued`);
    if (toDay(inv.issued_on) > last) fail(`${where}: issued after as_of ${asOf}`);
    const visit = visits.get(inv.visit_id);
    if (!visit) continue;
    const client = clientOf(visit.property_id);
    if (client && client.client_id !== inv.client_id) fail(`${where}: client ${inv.client_id} is not visit ${visit.visit_id}'s client`);
    if (inv.issued_on < visit.visit_date) fail(`${where}: issued before visit ${visit.visit_id}`);
    const pkgLines = lines.filter((l) => l.package_id !== null);
    if (lines.length > 0 && (pkgLines.length !== 1 || pkgLines[0].package_id !== visit.package_id)) {
      fail(`${where}: needs one package line for visit ${visit.visit_id}'s package`);
    }
  }

  // Payments: inside the invoice's life, never more than the invoice in total.
  const invoices = new Map(tables.invoices.map((i) => [i.invoice_id, i]));
  for (const [invoiceId, pays] of groupBy(tables.payments, 'invoice_id')) {
    const inv = invoices.get(invoiceId);
    for (const pay of pays) {
      const where = `payments ${pay.payment_id}`;
      if (!METHODS.has(pay.method)) fail(`${where}: method ${pay.method} is not card or ach`);
      if (pay.amount_cents <= 0) fail(`${where}: pays nothing`);
      if (toDay(pay.paid_on) > last) fail(`${where}: paid after as_of ${asOf}`);
      if (inv && pay.paid_on < inv.issued_on) fail(`${where}: paid before invoice ${invoiceId} was issued`);
    }
    const paid = pays.reduce((s, p) => s + p.amount_cents, 0);
    if (inv && paid > inv.total_cents) fail(`invoices ${invoiceId}: payments ${paid} exceed the total ${inv.total_cents}`);
  }

  // fixture_meta records every other table's row count.
  if (tables.fixture_meta) {
    const meta = new Map(tables.fixture_meta.map((m) => [m.key, m.value]));
    for (const name of Object.keys(tables)) {
      if (name === 'fixture_meta') continue;
      if (meta.get(`rows_${name}`) !== String(tables[name].length)) fail(`fixture_meta: rows_${name} is not ${tables[name].length}`);
    }
    if (meta.get('as_of') !== asOf) fail(`fixture_meta: as_of is not ${asOf}`);
  }
}

module.exports = { checkRules };
