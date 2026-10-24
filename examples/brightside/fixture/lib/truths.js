'use strict';

// The seven known truths (fixture-tables.md), computed from the generated rows
// with the spec's definitions. The generator runs this after planting and
// refuses to write if any figure misses its target. Story 7.6 computes the
// same figures in SQL; the tests compute them a third way from the CSVs.

const { toDay } = require('./days');

const TRUTH_IDS = [
  'clients-total',
  'active-plans-at-as-of',
  'winback-north-90d',
  'winback-north-90d-price-rise',
  'paid-revenue-2026-09',
  'billed-revenue-2026-09',
  'outstanding-at-as-of',
];

function computeTruths(tables, { asOf, zone = 'north', month = '2026-09' }) {
  const asOfDay = toDay(asOf);
  const clientOfProperty = new Map(tables.properties.map((p) => [p.property_id, p.client_id]));
  const activeAt = (p, d) => toDay(p.start_date) <= d && (p.end_date === null || toDay(p.end_date) >= d);
  // Lapsed in the last 90 days: 90 dates, as_of included.
  const lapsed = (p) => p.status === 'cancelled' && toDay(p.end_date) > asOfDay - 90 && toDay(p.end_date) <= asOfDay;

  const plansOf = new Map();
  for (const p of tables.plans) {
    const c = clientOfProperty.get(p.property_id);
    if (!plansOf.has(c)) plansOf.set(c, []);
    plansOf.get(c).push(p);
  }
  const changesOf = new Map();
  for (const ch of tables.plan_price_changes) {
    if (!changesOf.has(ch.plan_id)) changesOf.set(ch.plan_id, []);
    changesOf.get(ch.plan_id).push(ch);
  }
  // A rise effective in the 60 days up to the lapse (end_date - 59 .. end_date).
  const riseBeforeLapse = (p) => (changesOf.get(p.plan_id) || []).some((ch) => ch.new_price_cents > ch.old_price_cents
    && toDay(ch.effective_date) >= toDay(p.end_date) - 59 && toDay(ch.effective_date) <= toDay(p.end_date));

  const candidates = tables.clients.filter((c) => {
    const own = plansOf.get(c.client_id) || [];
    return c.zone_id === zone && own.some(lapsed) && !own.some((p) => activeAt(p, asOfDay));
  });

  const inMonth = (iso) => iso.slice(0, 7) === month;
  const paidByInvoice = new Map();
  for (const pay of tables.payments) {
    if (toDay(pay.paid_on) <= asOfDay) paidByInvoice.set(pay.invoice_id, (paidByInvoice.get(pay.invoice_id) || 0) + pay.amount_cents);
  }

  return {
    'clients-total': tables.clients.filter((c) => toDay(c.created_on) <= asOfDay).length,
    'active-plans-at-as-of': tables.plans.filter((p) => activeAt(p, asOfDay)).length,
    'winback-north-90d': candidates.length,
    'winback-north-90d-price-rise': candidates.filter((c) => plansOf.get(c.client_id).filter(lapsed).some(riseBeforeLapse)).length,
    'paid-revenue-2026-09': tables.payments.filter((p) => inMonth(p.paid_on)).reduce((s, p) => s + p.amount_cents, 0),
    'billed-revenue-2026-09': tables.invoices.filter((i) => inMonth(i.issued_on)).reduce((s, i) => s + i.total_cents, 0),
    'outstanding-at-as-of': tables.invoices.reduce((s, i) => s + Math.max(0, i.total_cents - (paidByInvoice.get(i.invoice_id) || 0)), 0),
  };
}

module.exports = { TRUTH_IDS, computeTruths };
