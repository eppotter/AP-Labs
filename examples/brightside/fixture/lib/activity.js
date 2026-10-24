'use strict';

// Story 7.2: Brightside's activity tables (fixture-tables.md): plans and their
// price changes, visits, invoices and lines, payments. 24 months of history to
// as_of. Every draw comes from the seeded rng passed in, after the reference
// tables' draws, in a fixed order, so one seed gives the same rows every time.
//
// Two passes. Simulate: plans churn day by day (more often in the 60 days after
// a price rise), visits follow each plan's schedule, every completed visit is
// invoiced, most invoices are paid. Plant: when targets are given, nudge the
// simulated data until each known truth equals its planted figure exactly:
// win-back candidates and price rises in North, plans active at as_of, then the
// September billed, paid and outstanding cents. Each nudge is one a real
// business could produce (a plan lapsing or resuming, a quoted one-off price, a
// short or late payment), and every integrity rule still holds afterwards.

const { toDay, toIso } = require('./days');

const WINBACK_ZONE = 'north';
const LAPSE_WINDOW_DAYS = 90;
const RISE_WINDOW_DAYS = 60;
const REVENUE_MONTH = '2026-09';

const PLAN_CLIENT_CHANCE = 0.72; // clients who ever take a recurring plan
const FIRST_PLAN_DELAY_DAYS = 21;
const SECOND_PROPERTY_PLAN_CHANCE = 0.3;
const FREQUENCIES = [['weekly', 2], ['biweekly', 5], ['monthly', 3]];
const PLAN_PACKAGES = [['standard', 8], ['deep', 2]];
// Home size as a percentage of the package's base price.
const SIZE_FACTORS = [[90, 2], [100, 4], [110, 3], [125, 2], [150, 1]];
const FREQUENCY_DISCOUNT = { weekly: 90, biweekly: 95, monthly: 100 };

const DAILY_LAPSE = 0.0012; // about 35% of plans a year
const RISE_LAPSE_BOOST = 4; // a price rise makes a lapse more likely ...
const ANNUAL_RISE_CHANCE = 0.7; // ... at the plan's yearly price review
const ADHOC_CHANGE_DAILY = 0.0003; // scope changes, retention discounts
// A company-wide price review in summer 2026: the rise behind the win-back demo.
const PRICE_REVIEW = '2026-07-01';
const PRICE_REVIEW_CHANCE = 0.5;
const RESUBSCRIBE_CHANCE = 0.25;

const VISIT_CANCEL_CHANCE = 0.06;
const ONE_OFF_COUNTS = [[0, 55], [1, 30], [2, 12], [3, 3]];
const ONE_OFF_PACKAGES = [['deep', 6], ['move_out', 2], ['standard', 2]];
const ONE_OFF_CANCEL_CHANCE = 0.08;
// A one-off is quoted per job; planting keeps every quote inside this band.
const QUOTE_MIN_PCT = 70;
const QUOTE_MAX_PCT = 160;
const ADD_ON_CHANCE = 0.18;
const SECOND_ADD_ON_CHANCE = 0.25;
const MULTI_QUANTITY_ADD_ONS = new Set(['laundry', 'windows']);

const DUE_DAYS = 14;
const PAYMENT_HABITS = [['on_time', 85], ['late', 8], ['split', 6], ['unpaid', 1]];
const METHODS = [['card', 7], ['ach', 3]];
const MIN_PAYMENT_CENTS = 100;

function roundTo(cents, step) {
  return Math.round(cents / step) * step;
}

function monthDay(day, months, dom) {
  const [y, m] = toIso(day).split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return toDay(`${year}-${String(month).padStart(2, '0')}-${String(Math.min(dom, 28)).padStart(2, '0')}`);
}

// n distinct items from list, in draw order.
function takeRandom(rng, list, n) {
  const pool = list.slice();
  const out = [];
  while (out.length < n && pool.length > 0) out.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
  return out;
}

function shuffled(rng, list) {
  return takeRandom(rng, list, list.length);
}

// Spread `delta` cents over knobs ({ room, apply(cents) }) in the given order;
// room is how far a knob can move in delta's direction. Returns what is left.
function distribute(delta, knobs) {
  let left = Math.abs(delta);
  const sign = Math.sign(delta);
  for (const knob of knobs) {
    if (left === 0) break;
    const take = Math.min(left, knob.room);
    if (take <= 0) continue;
    knob.apply(sign * take);
    left -= take;
  }
  return sign * left;
}

// ---- plans ----------------------------------------------------------------

// The price chain: [{ day, old, new }] in date order, from start_price.
function priceChain(plan) {
  let price = plan.startPrice;
  return plan.changes
    .slice()
    .sort((a, b) => a.day - b.day)
    .map((c) => {
      const next = roundTo((price * (100 + c.pct)) / 100, 100);
      const row = { day: c.day, old: price, new: next };
      price = next;
      return row;
    });
}

function priceAt(plan, day) {
  let price = plan.startPrice;
  for (const c of priceChain(plan)) if (c.day <= day) price = c.new;
  return price;
}

function newPlan(rng, ctx, client, start) {
  const props = ctx.propertiesOf.get(client.client_id);
  const property = props.length > 1 && rng.chance(SECOND_PROPERTY_PLAN_CHANCE) ? props[1] : props[0];
  const packageId = rng.weighted(PLAN_PACKAGES);
  const frequency = rng.weighted(FREQUENCIES);
  const size = rng.weighted(SIZE_FACTORS);
  const base = ctx.packages.get(packageId).base_price_cents;
  return {
    seq: ctx.planSeq++,
    client_id: client.client_id,
    zone_id: client.zone_id,
    property_id: property.property_id,
    package_id: packageId,
    frequency,
    crew_id: rng.pick(ctx.crewsByZone.get(client.zone_id)).crew_id,
    start,
    end: null,
    startPrice: roundTo((base * size * FREQUENCY_DISCOUNT[frequency]) / 10000, 100),
    changes: [],
  };
}

// Run one plan forward from its start: a yearly price review on its
// anniversary, the company-wide review, the odd ad-hoc change, and a daily
// chance to lapse that rises for 60 days after a rise.
function simulatePlan(rng, plan, asOf) {
  const priceReview = toDay(PRICE_REVIEW);
  let boostUntil = -1;
  let review = plan.start + 365;
  for (let d = plan.start + 1; d <= asOf; d++) {
    let pct = 0;
    if (d === review) {
      review += 365;
      if (rng.chance(ANNUAL_RISE_CHANCE)) pct = rng.int(4, 9);
    } else if (d === priceReview) {
      if (rng.chance(PRICE_REVIEW_CHANCE)) pct = rng.int(6, 10);
    } else if (rng.chance(ADHOC_CHANGE_DAILY)) {
      pct = rng.chance(0.6) ? rng.int(5, 15) : -rng.int(5, 10);
    }
    if (pct !== 0) {
      plan.changes.push({ day: d, pct });
      if (pct > 0) boostUntil = d + RISE_WINDOW_DAYS - 1;
    }
    if (rng.chance(d <= boostUntil ? DAILY_LAPSE * RISE_LAPSE_BOOST : DAILY_LAPSE)) {
      plan.end = d;
      return;
    }
  }
}

// A client's plans run one after another: after a lapse some come back later.
function simulatePlans(rng, ctx) {
  const plans = [];
  for (const client of ctx.clients) {
    if (!rng.chance(PLAN_CLIENT_CHANCE)) continue;
    let begin = toDay(client.created_on) + rng.int(0, FIRST_PLAN_DELAY_DAYS);
    while (begin <= ctx.asOf) {
      const plan = newPlan(rng, ctx, client, begin);
      simulatePlan(rng, plan, ctx.asOf);
      plans.push(plan);
      if (plan.end === null || !rng.chance(RESUBSCRIBE_CHANCE)) break;
      begin = plan.end + rng.int(30, 270);
    }
  }
  return plans;
}

// ---- planting: plans ------------------------------------------------------

function planView(ctx, plans) {
  const { asOf } = ctx;
  const lapsed = (p) => p.end !== null && p.end > asOf - LAPSE_WINDOW_DAYS && p.end <= asOf;
  const active = (p) => p.start <= asOf && (p.end === null || p.end >= asOf);
  const byClient = new Map();
  for (const p of plans) {
    if (!byClient.has(p.client_id)) byClient.set(p.client_id, []);
    byClient.get(p.client_id).push(p);
  }
  const plansOf = (id) => byClient.get(id) || [];
  const candidates = (zone) => ctx.clients.filter((c) => c.zone_id === zone
    && plansOf(c.client_id).some(lapsed) && !plansOf(c.client_id).some(active));
  return { lapsed, active, plansOf, candidates };
}

function hasRiseBeforeLapse(plan) {
  return plan.changes.some((c) => c.pct > 0 && c.day >= plan.end - (RISE_WINDOW_DAYS - 1) && c.day <= plan.end);
}

function lastChangeDay(plan) {
  return plan.changes.reduce((max, c) => Math.max(max, c.day), plan.start);
}

function fail(id, why) {
  throw new Error(`cannot plant ${id}: ${why}`);
}

// One lapse per client in the 90-day window, so "the lapsed plan" of a
// win-back candidate is never ambiguous: drop any earlier plan in the window.
function oneLapsePerClient(ctx, plans) {
  const v = planView(ctx, plans);
  const drop = new Set();
  for (const client of ctx.clients) {
    const inWindow = v.plansOf(client.client_id).filter(v.lapsed).sort((a, b) => b.end - a.end);
    for (const p of inWindow.slice(1)) drop.add(p);
  }
  return plans.filter((p) => !drop.has(p));
}

function plantWinback(rng, ctx, plans, target) {
  const { asOf } = ctx;
  let v = planView(ctx, plans);
  const current = v.candidates(WINBACK_ZONE);
  if (current.length > target) {
    // Some came back: their lapsed plan resumes and is active at as_of.
    for (const c of takeRandom(rng, current, current.length - target)) {
      v.plansOf(c.client_id).find(v.lapsed).end = null;
    }
  } else if (current.length < target) {
    // More lapse: a long-running active plan ends inside the window.
    const eligible = ctx.clients.filter((c) => {
      if (c.zone_id !== WINBACK_ZONE) return false;
      const own = v.plansOf(c.client_id);
      const open = own.filter(v.active);
      return open.length === 1 && open[0].end === null && open[0].start <= asOf - 120
        && lastChangeDay(open[0]) < asOf && !own.some(v.lapsed);
    });
    const need = target - current.length;
    if (eligible.length < need) fail('winback-north-90d', `needs ${need} more lapses, only ${eligible.length} plans can lapse`);
    for (const c of takeRandom(rng, eligible, need)) {
      const p = v.plansOf(c.client_id).find(v.active);
      p.end = rng.int(Math.max(asOf - LAPSE_WINDOW_DAYS + 1, lastChangeDay(p), p.start + 1), asOf - 1);
    }
  }
  v = planView(ctx, plans);
  return v.candidates(WINBACK_ZONE).map((c) => v.plansOf(c.client_id).find(v.lapsed));
}

function plantRises(rng, lapsedPlans, target) {
  const withRise = lapsedPlans.filter(hasRiseBeforeLapse);
  if (withRise.length > target) {
    // The rise never happened: drop the rises in the 60 days before the lapse.
    for (const p of takeRandom(rng, withRise, withRise.length - target)) {
      p.changes = p.changes.filter((c) => !(c.pct > 0 && c.day >= p.end - (RISE_WINDOW_DAYS - 1)));
    }
    return;
  }
  const freeDays = (p) => {
    const taken = new Set(p.changes.map((c) => c.day));
    const days = [];
    for (let d = Math.max(p.start + 1, p.end - (RISE_WINDOW_DAYS - 1)); d <= p.end; d++) if (!taken.has(d)) days.push(d);
    return days;
  };
  const eligible = lapsedPlans.filter((p) => !hasRiseBeforeLapse(p) && freeDays(p).length > 0);
  const need = target - withRise.length;
  if (eligible.length < need) fail('winback-north-90d-price-rise', `needs ${need} more rises, only ${eligible.length} plans can take one`);
  for (const p of takeRandom(rng, eligible, need)) {
    p.changes.push({ day: rng.pick(freeDays(p)), pct: rng.int(4, 9) });
  }
}

// Plans active at as_of, moved outside the win-back zone so the win-back
// figures stay put.
function plantActive(rng, ctx, plans, target) {
  const { asOf } = ctx;
  const v = planView(ctx, plans);
  const current = plans.filter(v.active).length;
  const others = ctx.clients.filter((c) => c.zone_id !== WINBACK_ZONE);
  if (current > target) {
    const eligible = others.flatMap((c) => {
      const own = v.plansOf(c.client_id);
      const open = own.filter(v.active);
      return open.length === 1 && open[0].end === null && open[0].start <= asOf - 120
        && lastChangeDay(open[0]) < asOf && !own.some(v.lapsed) ? [open[0]] : [];
    });
    const need = current - target;
    if (eligible.length < need) fail('active-plans-at-as-of', `needs ${need} fewer active plans, only ${eligible.length} can end`);
    for (const p of takeRandom(rng, eligible, need)) {
      p.end = rng.int(Math.max(p.start + 1, lastChangeDay(p), asOf - 180), asOf - 1);
    }
  } else if (current < target) {
    const eligible = others.filter((c) => {
      const own = v.plansOf(c.client_id);
      const lastEnd = own.reduce((max, p) => Math.max(max, p.end ?? Infinity), -Infinity);
      return !own.some(v.active) && toDay(c.created_on) <= asOf && lastEnd + 30 <= asOf;
    });
    const need = target - current;
    if (eligible.length < need) fail('active-plans-at-as-of', `needs ${need} more active plans, only ${eligible.length} clients can start one`);
    for (const c of takeRandom(rng, eligible, need)) {
      const lastEnd = v.plansOf(c.client_id).reduce((max, p) => Math.max(max, p.end), -Infinity);
      const start = rng.int(Math.max(toDay(c.created_on), lastEnd + 30, asOf - 365), asOf);
      plans.push(newPlan(rng, ctx, c, start));
    }
  }
}

// ---- visits, invoices, payments -------------------------------------------

function scheduleDays(plan, last) {
  const days = [];
  if (plan.frequency === 'monthly') {
    const dom = Number(toIso(plan.start).slice(8, 10));
    for (let n = 0, d = plan.start; d <= last; d = monthDay(plan.start, ++n, dom)) days.push(d);
  } else {
    const step = plan.frequency === 'weekly' ? 7 : 14;
    for (let d = plan.start; d <= last; d += step) days.push(d);
  }
  return days;
}

function buildVisits(rng, ctx, plans) {
  const visits = [];
  let seq = 0;
  for (const plan of plans) {
    for (const day of scheduleDays(plan, plan.end ?? ctx.asOf)) {
      visits.push({
        seq: seq++, day, plan, property_id: plan.property_id, client_id: plan.client_id, crew_id: plan.crew_id,
        package_id: plan.package_id, completed: !rng.chance(VISIT_CANCEL_CHANCE),
      });
    }
  }
  for (const client of ctx.clients) {
    const props = ctx.propertiesOf.get(client.client_id);
    const count = rng.weighted(ONE_OFF_COUNTS);
    for (let i = 0; i < count; i++) {
      const packageId = rng.weighted(ONE_OFF_PACKAGES);
      const base = ctx.packages.get(packageId).base_price_cents;
      visits.push({
        seq: seq++,
        day: rng.int(toDay(client.created_on), ctx.asOf),
        plan: null,
        property_id: rng.pick(props).property_id,
        client_id: client.client_id,
        crew_id: rng.pick(ctx.crewsByZone.get(client.zone_id)).crew_id,
        package_id: packageId,
        completed: !rng.chance(ONE_OFF_CANCEL_CHANCE),
        quote: roundTo((base * rng.int(85, 135)) / 100, 500),
      });
    }
  }
  visits.sort((a, b) => a.day - b.day || a.property_id - b.property_id || a.seq - b.seq);
  return visits;
}

function buildInvoices(rng, ctx, visits) {
  const invoices = [];
  for (const visit of visits) {
    if (!visit.completed) continue;
    const pkg = ctx.packages.get(visit.package_id);
    const lines = [{
      package_id: pkg.package_id, add_on_id: null, quantity: 1,
      amount: visit.plan ? priceAt(visit.plan, visit.day) : visit.quote, base: pkg.base_price_cents, quoted: !visit.plan,
    }];
    if (rng.chance(ADD_ON_CHANCE)) {
      const picks = takeRandom(rng, ctx.addOns, rng.chance(SECOND_ADD_ON_CHANCE) ? 2 : 1).sort((a, b) => (a.add_on_id < b.add_on_id ? -1 : 1));
      for (const a of picks) {
        const quantity = MULTI_QUANTITY_ADD_ONS.has(a.add_on_id) ? rng.int(1, 2) : 1;
        lines.push({ package_id: null, add_on_id: a.add_on_id, quantity, amount: a.price_cents * quantity });
      }
    }
    invoices.push({ visit, client_id: visit.client_id, issued: visit.day, lines, payments: [] });
  }
  return invoices;
}

const totalOf = (inv) => inv.lines.reduce((sum, l) => sum + l.amount, 0);
const paidOf = (inv) => inv.payments.reduce((sum, p) => sum + p.amount, 0);

function buildPayments(rng, ctx, invoices) {
  const pay = (inv, day, amount) => {
    if (day <= ctx.asOf && amount > 0) inv.payments.push({ day, amount, method: rng.weighted(METHODS) });
  };
  for (const inv of invoices) {
    const total = totalOf(inv);
    const habit = rng.weighted(PAYMENT_HABITS);
    if (habit === 'on_time') pay(inv, inv.issued + rng.int(0, DUE_DAYS), total);
    else if (habit === 'late') pay(inv, inv.issued + rng.int(DUE_DAYS + 1, 60), total);
    else if (habit === 'split') {
      const first = roundTo((total * rng.int(30, 70)) / 100, 100);
      const firstDay = inv.issued + rng.int(0, 10);
      pay(inv, firstDay, first);
      pay(inv, firstDay + rng.int(14, 45), total - first);
    }
  }
}

// ---- planting: money ------------------------------------------------------

function monthRange(month) {
  const first = toDay(`${month}-01`);
  return { first, last: monthDay(first, 1, 1) - 1 };
}

function plantBilled(rng, ctx, invoices, target) {
  const { first, last } = monthRange(REVENUE_MONTH);
  const inMonth = invoices.filter((inv) => inv.issued >= first && inv.issued <= last);
  const billed = inMonth.reduce((sum, inv) => sum + totalOf(inv), 0);
  const delta = target - billed;
  // Re-quote September one-offs, inside the quote band.
  const quoted = shuffled(rng, inMonth.map((inv) => inv.lines[0]).filter((l) => l.quoted));
  const left = distribute(delta, quoted.map((l) => ({
    room: delta > 0 ? Math.floor((l.base * QUOTE_MAX_PCT) / 100) - l.amount : l.amount - Math.ceil((l.base * QUOTE_MIN_PCT) / 100),
    apply: (cents) => { l.amount += cents; },
  })));
  if (left !== 0) fail('billed-revenue-2026-09', `${left} cents left after re-quoting ${quoted.length} one-offs`);
}

function plantPaid(rng, ctx, invoices, target) {
  const { first, last } = monthRange(REVENUE_MONTH);
  const sepPayments = invoices.flatMap((inv) => inv.payments.filter((p) => p.day >= first && p.day <= last).map((p) => ({ inv, p })));
  const paid = sepPayments.reduce((sum, { p }) => sum + p.amount, 0);
  const delta = target - paid;
  let knobs;
  if (delta < 0) {
    // Short payments: a September payment covers less of its invoice.
    knobs = shuffled(rng, sepPayments).map(({ p }) => ({
      room: Math.floor(p.amount / 2) - MIN_PAYMENT_CENTS, apply: (cents) => { p.amount += cents; },
    }));
  } else {
    // Catch-up payments in September on invoices with a balance.
    const open = shuffled(rng, invoices.filter((inv) => inv.issued <= last && totalOf(inv) - paidOf(inv) >= MIN_PAYMENT_CENTS));
    knobs = open.map((inv) => ({
      room: totalOf(inv) - paidOf(inv),
      apply: (cents) => {
        const existing = inv.payments.find((p) => p.day >= first && p.day <= last);
        if (existing) existing.amount += cents;
        else inv.payments.push({ day: rng.int(Math.max(inv.issued, first), last), amount: cents, method: rng.weighted(METHODS) });
      },
    }));
  }
  const left = distribute(delta, knobs);
  if (left !== 0) fail('paid-revenue-2026-09', `${left} cents left after adjusting September payments`);
}

// Outstanding moves through payments before the revenue month, so the paid
// figure for the month stays put.
function plantOutstanding(rng, ctx, invoices, target) {
  const { first } = monthRange(REVENUE_MONTH);
  const outstanding = invoices.reduce((sum, inv) => sum + Math.max(0, totalOf(inv) - paidOf(inv)), 0);
  const delta = outstanding - target; // > 0: collect more before the month
  const before = (p) => p.day < first;
  let knobs;
  if (delta > 0) {
    const open = shuffled(rng, invoices.filter((inv) => inv.issued < first && totalOf(inv) - paidOf(inv) >= MIN_PAYMENT_CENTS));
    knobs = open.map((inv) => ({
      room: totalOf(inv) - paidOf(inv),
      apply: (cents) => {
        const existing = inv.payments.find(before);
        if (existing) existing.amount += cents;
        else inv.payments.push({ day: rng.int(inv.issued, first - 1), amount: cents, method: rng.weighted(METHODS) });
      },
    }));
  } else {
    const earlier = shuffled(rng, invoices.flatMap((inv) => inv.payments.filter(before)));
    // Short payments before the month leave more owing.
    knobs = earlier.map((p) => ({ room: Math.floor(p.amount / 2) - MIN_PAYMENT_CENTS, apply: (cents) => { p.amount += cents; } }));
  }
  const left = distribute(delta, knobs);
  if (left !== 0) fail('outstanding-at-as-of', `${left} cents left after adjusting earlier payments`);
}

// ---- rows -----------------------------------------------------------------

function toRows(ctx, plans, visits, invoices) {
  plans.sort((a, b) => a.start - b.start || a.property_id - b.property_id || a.seq - b.seq);
  plans.forEach((p, i) => { p.plan_id = i + 1; });
  const planRows = [];
  const changeRows = [];
  for (const p of plans) {
    const chain = priceChain(p);
    planRows.push({
      plan_id: p.plan_id,
      property_id: p.property_id,
      package_id: p.package_id,
      frequency: p.frequency,
      start_date: toIso(p.start),
      end_date: p.end === null ? null : toIso(p.end),
      status: p.end === null ? 'active' : 'cancelled',
      start_price_cents: p.startPrice,
      price_cents: chain.length > 0 ? chain[chain.length - 1].new : p.startPrice,
    });
    for (const c of chain) {
      changeRows.push({
        change_id: changeRows.length + 1, plan_id: p.plan_id, effective_date: toIso(c.day), old_price_cents: c.old, new_price_cents: c.new,
      });
    }
  }
  const visitRows = visits.map((v, i) => {
    v.visit_id = i + 1;
    return {
      visit_id: v.visit_id,
      property_id: v.property_id,
      plan_id: v.plan ? v.plan.plan_id : null,
      crew_id: v.crew_id,
      package_id: v.package_id,
      visit_date: toIso(v.day),
      status: v.completed ? 'completed' : 'cancelled',
    };
  });
  const invoiceRows = [];
  const lineRows = [];
  const paymentList = [];
  invoices.forEach((inv, i) => {
    const invoiceId = i + 1;
    invoiceRows.push({
      invoice_id: invoiceId,
      client_id: inv.client_id,
      visit_id: inv.visit.visit_id,
      issued_on: toIso(inv.issued),
      due_on: toIso(inv.issued + DUE_DAYS),
      total_cents: totalOf(inv),
    });
    for (const l of inv.lines) {
      lineRows.push({
        line_id: lineRows.length + 1, invoice_id: invoiceId, package_id: l.package_id, add_on_id: l.add_on_id, quantity: l.quantity, amount_cents: l.amount,
      });
    }
    inv.payments.forEach((p, n) => paymentList.push({ ...p, invoiceId, n }));
  });
  paymentList.sort((a, b) => a.day - b.day || a.invoiceId - b.invoiceId || a.n - b.n);
  const paymentRows = paymentList.map((p, i) => ({
    payment_id: i + 1, invoice_id: p.invoiceId, paid_on: toIso(p.day), amount_cents: p.amount, method: p.method,
  }));
  return {
    plans: planRows,
    plan_price_changes: changeRows,
    visits: visitRows,
    invoices: invoiceRows,
    invoice_lines: lineRows,
    payments: paymentRows,
  };
}

// Draw order is fixed: plans, planting of plans, visits, invoices, payments,
// planting of money. Changing it changes every activity seed file (never the
// reference files, whose draws all come first).
function buildActivity(rng, reference, { asOf, targets = null }) {
  const ctx = {
    asOf: toDay(asOf),
    clients: reference.clients,
    packages: new Map(reference.packages.map((p) => [p.package_id, p])),
    addOns: reference.add_ons,
    crewsByZone: new Map(),
    propertiesOf: new Map(),
    planSeq: 0,
  };
  for (const crew of reference.crews) {
    if (!ctx.crewsByZone.has(crew.zone_id)) ctx.crewsByZone.set(crew.zone_id, []);
    ctx.crewsByZone.get(crew.zone_id).push(crew);
  }
  for (const p of reference.properties) {
    if (!ctx.propertiesOf.has(p.client_id)) ctx.propertiesOf.set(p.client_id, []);
    ctx.propertiesOf.get(p.client_id).push(p);
  }

  let plans = oneLapsePerClient(ctx, simulatePlans(rng, ctx));
  if (targets) {
    if (targets['clients-total'] !== reference.clients.length) {
      fail('clients-total', `the target is ${targets['clients-total']} but the seed config makes ${reference.clients.length} clients`);
    }
    plantRises(rng, plantWinback(rng, ctx, plans, targets['winback-north-90d']), targets['winback-north-90d-price-rise']);
    plantActive(rng, ctx, plans, targets['active-plans-at-as-of']);
  }
  const visits = buildVisits(rng, ctx, plans);
  const invoices = buildInvoices(rng, ctx, visits);
  if (targets) plantBilled(rng, ctx, invoices, targets['billed-revenue-2026-09']);
  buildPayments(rng, ctx, invoices);
  if (targets) {
    plantPaid(rng, ctx, invoices, targets['paid-revenue-2026-09']);
    plantOutstanding(rng, ctx, invoices, targets['outstanding-at-as-of']);
  }
  return toRows(ctx, plans, visits, invoices);
}

module.exports = { buildActivity };
