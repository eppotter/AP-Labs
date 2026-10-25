'use strict';

// The one description of every fixture table: column order, types and keys.
// The generator writes schema.sql (DuckDB DDL) and each seed CSV's header from
// it, so the two cannot drift. Tables are listed in load order: a table comes
// after every table it references. Story 7.1 wrote the reference tables
// (zones to properties); Story 7.2 the activity tables and fixture_meta.
// The labour, home-detail and scheduling build (lib/operations.js) added
// staff, pay_rates and timesheets, and appended columns to crew_memberships,
// properties and visits. Appended columns always go last, so every earlier
// column keeps its place and its values.

const TABLES = [
  {
    name: 'zones',
    columns: [
      { name: 'zone_id', type: 'VARCHAR', pk: true },
      { name: 'name', type: 'VARCHAR', notNull: true },
    ],
  },
  {
    name: 'packages',
    columns: [
      { name: 'package_id', type: 'VARCHAR', pk: true },
      { name: 'name', type: 'VARCHAR', notNull: true },
      { name: 'base_price_cents', type: 'BIGINT', notNull: true },
    ],
  },
  {
    name: 'add_ons',
    columns: [
      { name: 'add_on_id', type: 'VARCHAR', pk: true },
      { name: 'name', type: 'VARCHAR', notNull: true },
      { name: 'price_cents', type: 'BIGINT', notNull: true },
    ],
  },
  {
    name: 'crews',
    columns: [
      { name: 'crew_id', type: 'INTEGER', pk: true },
      { name: 'zone_id', type: 'VARCHAR', notNull: true, references: 'zones' },
      { name: 'name', type: 'VARCHAR', notNull: true },
    ],
  },
  {
    // One row per person who has worked on a crew. role and hourly_rate_cents
    // are the latest pay_rates row's: on end_date, or at as_of while employed.
    name: 'staff',
    columns: [
      { name: 'staff_id', type: 'INTEGER', pk: true },
      // The same text as crew_memberships.staff_name.
      { name: 'name', type: 'VARCHAR', notNull: true, unique: true },
      // cleaner or crew_lead.
      { name: 'role', type: 'VARCHAR', notNull: true },
      { name: 'hire_date', type: 'DATE', notNull: true },
      // Last day employed, inclusive; NULL while employed.
      { name: 'end_date', type: 'DATE' },
      { name: 'hourly_rate_cents', type: 'BIGINT', notNull: true },
    ],
  },
  {
    // One row per pay period: a staff member's role and hourly rate from
    // start_date to end_date (inclusive; NULL = current). Periods are
    // contiguous from hire_date and never overlap, so a rate on day d is the
    // one row with start_date <= d AND (end_date IS NULL OR end_date >= d).
    name: 'pay_rates',
    columns: [
      { name: 'rate_id', type: 'INTEGER', pk: true },
      { name: 'staff_id', type: 'INTEGER', notNull: true, references: 'staff' },
      { name: 'start_date', type: 'DATE', notNull: true },
      { name: 'end_date', type: 'DATE' },
      // cleaner or crew_lead.
      { name: 'role', type: 'VARCHAR', notNull: true },
      { name: 'hourly_rate_cents', type: 'BIGINT', notNull: true },
    ],
    unique: [['staff_id', 'start_date']],
  },
  {
    name: 'crew_memberships',
    columns: [
      { name: 'membership_id', type: 'INTEGER', pk: true },
      { name: 'crew_id', type: 'INTEGER', notNull: true, references: 'crews' },
      { name: 'staff_name', type: 'VARCHAR', notNull: true },
      { name: 'start_date', type: 'DATE', notNull: true },
      // Inclusive; NULL while the membership is current.
      { name: 'end_date', type: 'DATE' },
      // The staff row for staff_name (appended).
      { name: 'staff_id', type: 'INTEGER', notNull: true, references: 'staff' },
    ],
  },
  {
    name: 'clients',
    columns: [
      { name: 'client_id', type: 'INTEGER', pk: true },
      { name: 'zone_id', type: 'VARCHAR', notNull: true, references: 'zones' },
      { name: 'first_name', type: 'VARCHAR', notNull: true },
      { name: 'last_name', type: 'VARCHAR', notNull: true },
      { name: 'email', type: 'VARCHAR', notNull: true, unique: true },
      // Forbidden column (profile sql.forbidden_columns).
      { name: 'phone', type: 'VARCHAR', notNull: true },
      { name: 'created_on', type: 'DATE', notNull: true },
    ],
  },
  {
    name: 'properties',
    columns: [
      { name: 'property_id', type: 'INTEGER', pk: true },
      { name: 'client_id', type: 'INTEGER', notNull: true, references: 'clients' },
      // Forbidden column.
      { name: 'street_address', type: 'VARCHAR', notNull: true },
      { name: 'city', type: 'VARCHAR', notNull: true },
      // Forbidden column.
      { name: 'postal_code', type: 'VARCHAR', notNull: true },
      // Home details (appended). house, townhouse, condo or apartment.
      { name: 'home_type', type: 'VARCHAR', notNull: true },
      { name: 'square_feet', type: 'INTEGER', notNull: true },
      { name: 'bedrooms', type: 'INTEGER', notNull: true },
      // Halves allowed: 2.5 is two full bathrooms and a half bathroom.
      { name: 'bathrooms', type: 'DECIMAL(3,1)', notNull: true },
      { name: 'has_pets', type: 'BOOLEAN', notNull: true },
      // How the crew gets in: key, lockbox, client_home or door_code_on_file.
      // Never the code or key itself.
      { name: 'access_method', type: 'VARCHAR', notNull: true },
    ],
  },
  {
    name: 'plans',
    columns: [
      { name: 'plan_id', type: 'INTEGER', pk: true },
      { name: 'property_id', type: 'INTEGER', notNull: true, references: 'properties' },
      { name: 'package_id', type: 'VARCHAR', notNull: true, references: 'packages' },
      // weekly, biweekly or monthly.
      { name: 'frequency', type: 'VARCHAR', notNull: true },
      { name: 'start_date', type: 'DATE', notNull: true },
      // Last active day, inclusive; NULL while active.
      { name: 'end_date', type: 'DATE' },
      // active iff end_date IS NULL, else cancelled.
      { name: 'status', type: 'VARCHAR', notNull: true },
      { name: 'start_price_cents', type: 'BIGINT', notNull: true },
      // Price on end_date, or at as_of while active.
      { name: 'price_cents', type: 'BIGINT', notNull: true },
    ],
  },
  {
    name: 'plan_price_changes',
    columns: [
      { name: 'change_id', type: 'INTEGER', pk: true },
      { name: 'plan_id', type: 'INTEGER', notNull: true, references: 'plans' },
      { name: 'effective_date', type: 'DATE', notNull: true },
      { name: 'old_price_cents', type: 'BIGINT', notNull: true },
      { name: 'new_price_cents', type: 'BIGINT', notNull: true },
    ],
    unique: [['plan_id', 'effective_date']],
  },
  {
    name: 'visits',
    columns: [
      { name: 'visit_id', type: 'INTEGER', pk: true },
      { name: 'property_id', type: 'INTEGER', notNull: true, references: 'properties' },
      // NULL for a one-off visit.
      { name: 'plan_id', type: 'INTEGER', references: 'plans' },
      { name: 'crew_id', type: 'INTEGER', notNull: true, references: 'crews' },
      { name: 'package_id', type: 'VARCHAR', notNull: true, references: 'packages' },
      { name: 'visit_date', type: 'DATE', notNull: true },
      // completed or cancelled.
      { name: 'status', type: 'VARCHAR', notNull: true },
      // The schedule (appended). Every visit has one, cancelled ones too: the
      // route is planned before a cancellation. morning (scheduled_start
      // before 12:00) or afternoon.
      { name: 'arrival_window', type: 'VARCHAR', notNull: true },
      { name: 'scheduled_start', type: 'TIME', notNull: true },
      // The crew's planned time on site, from the package, the home's size and
      // details, and the add-ons.
      { name: 'scheduled_minutes', type: 'INTEGER', notNull: true },
      // 1..n within the crew's day (crew_id, visit_date). Unique per crew-day:
      // checked by integrity-route-order and the generator's rules, not by a
      // schema constraint (a composite index slows every build).
      { name: 'route_order', type: 'INTEGER', notNull: true },
      // From the previous stop, or from the crew's base for route_order 1.
      { name: 'travel_minutes_from_previous', type: 'INTEGER', notNull: true },
    ],
  },
  {
    name: 'invoices',
    columns: [
      { name: 'invoice_id', type: 'INTEGER', pk: true },
      { name: 'client_id', type: 'INTEGER', notNull: true, references: 'clients' },
      // One invoice per completed visit.
      { name: 'visit_id', type: 'INTEGER', notNull: true, unique: true, references: 'visits' },
      { name: 'issued_on', type: 'DATE', notNull: true },
      { name: 'due_on', type: 'DATE', notNull: true },
      // Equals the sum of the invoice's lines.
      { name: 'total_cents', type: 'BIGINT', notNull: true },
    ],
  },
  {
    name: 'invoice_lines',
    columns: [
      { name: 'line_id', type: 'INTEGER', pk: true },
      { name: 'invoice_id', type: 'INTEGER', notNull: true, references: 'invoices' },
      // Exactly one of package_id and add_on_id is set.
      { name: 'package_id', type: 'VARCHAR', references: 'packages' },
      { name: 'add_on_id', type: 'VARCHAR', references: 'add_ons' },
      { name: 'quantity', type: 'INTEGER', notNull: true },
      { name: 'amount_cents', type: 'BIGINT', notNull: true },
    ],
  },
  {
    name: 'payments',
    columns: [
      { name: 'payment_id', type: 'INTEGER', pk: true },
      { name: 'invoice_id', type: 'INTEGER', notNull: true, references: 'invoices' },
      { name: 'paid_on', type: 'DATE', notNull: true },
      { name: 'amount_cents', type: 'BIGINT', notNull: true },
      // card or ach.
      { name: 'method', type: 'VARCHAR', notNull: true },
    ],
  },
  {
    // One row per staff member per completed visit: the crew's members on the
    // visit date. Times are local business time; minutes = clock_out - clock_in.
    // Labour cost: minutes / 60 * the pay_rates rate on visit_date. One row per
    // (visit_id, staff_id): a repeat would overlap itself, so
    // integrity-timesheet-overlap and the generator's rules catch it (no
    // composite index, for build speed).
    name: 'timesheets',
    columns: [
      { name: 'timesheet_id', type: 'INTEGER', pk: true },
      { name: 'visit_id', type: 'INTEGER', notNull: true, references: 'visits' },
      { name: 'staff_id', type: 'INTEGER', notNull: true, references: 'staff' },
      { name: 'clock_in', type: 'TIMESTAMP', notNull: true },
      { name: 'clock_out', type: 'TIMESTAMP', notNull: true },
      { name: 'minutes', type: 'INTEGER', notNull: true },
    ],
  },
  {
    name: 'fixture_meta',
    columns: [
      { name: 'key', type: 'VARCHAR', pk: true },
      { name: 'value', type: 'VARCHAR', notNull: true },
    ],
  },
];

function pkOf(table) {
  return table.columns.find((c) => c.pk).name;
}

function columnDdl(table, col) {
  let line = `  ${col.name} ${col.type}`;
  if (col.pk) line += ' PRIMARY KEY';
  else if (col.notNull) line += ' NOT NULL';
  if (col.unique) line += ' UNIQUE';
  if (col.references) {
    const target = TABLES.find((t) => t.name === col.references);
    line += ` REFERENCES ${target.name} (${pkOf(target)})`;
  }
  return line;
}

function schemaSql(tables = TABLES) {
  const parts = [
    '-- Brightside fixture schema (DuckDB). Generated by generate.js from',
    '-- lib/tables.js: edit that file, then run npm run fixture:generate.',
    '-- Money is integer cents; dates are ISO DATE in the local business calendar.',
  ];
  for (const table of tables) {
    const lines = table.columns.map((c) => columnDdl(table, c));
    for (const cols of table.unique || []) lines.push(`  UNIQUE (${cols.join(', ')})`);
    parts.push('', `CREATE TABLE ${table.name} (`, lines.join(',\n'), ');');
  }
  return `${parts.join('\n')}\n`;
}

module.exports = { TABLES, pkOf, schemaSql };
