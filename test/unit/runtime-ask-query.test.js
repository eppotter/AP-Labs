'use strict';

// Story 19.8 (plan brightside-v1, D10, D11): Ask answers a data question by
// running a query from signed query rules (kit/runtime/archetypes/ask/query),
// through the hubs with the fake Slack client and a stand-in Anthropic client
// that checks each request as the real API does (test/fixtures/fake-anthropic:
// write_query's input_schema too). Real DuckDB on a build of
// test/fixtures/runtime/ask-query/data (a made-up client) through Ask's own
// connection (kit/runtime/data/ask), its signed rules and truths in
// test/fixtures/runtime/ask-query/context/data.md, read by the real rules
// reader with the last verify record handed in (readLast). The review queue
// is the real one, in a fresh var dir.
//
// Every clock the code reads is the one test clock (clock.t): the store (the
// AI's and Ask's hourly limits, the kept answers), the AI service and its
// breaker, the truth gate's 7 days, the review queue's `at` and the notes
// store. Nothing here reads Date.now().

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../kit/fixture/build');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry } = require('../../kit/runtime/registry');
const { createHubViews } = require('../../kit/runtime/slack/hub-view');
const { registerHubs, FORM_NEEDS_WINDOW } = require('../../kit/runtime/slack/hubs');
const { createStore } = require('../../kit/runtime/store');
const { createLlm } = require('../../kit/runtime/llm');
const { createData } = require('../../kit/runtime/data');
const { createAskData } = require('../../kit/runtime/data/ask');
const { createRulesReader } = require('../../kit/runtime/knowledge/readiness');
const { createKnowledgeStore } = require('../../kit/runtime/knowledge/store');
const { createAskQueue } = require('../../kit/runtime/knowledge/ask-queue');
const { LlmUnavailable, AskQueryRefused } = require('../../kit/runtime/errors');
const { ASK_WORDS: WORDS, messageFor } = require('../../kit/runtime/messages');
const askTool = require('../../kit/runtime/archetypes/ask');
const query = require('../../kit/runtime/archetypes/ask/query');
const { FakeSlackApp } = require('../fixtures/fake-slack');
const { checkRequest } = require('../fixtures/fake-anthropic');

const FIX = path.join(__dirname, '../fixtures/runtime/ask-query');
const PROFILE_PATH = path.join(FIX, 'profile.yml');
const profile = loadProfile(PROFILE_PATH);
const { registry, problems: loadProblems } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });
const ADA = { id: 'UADA', name: 'ada' };
const BO = { id: 'UBO', name: 'bo' };
const T0 = Date.UTC(2026, 10, 1, 12, 0);
const DAY = 24 * 60 * 60 * 1000;
const KEY = 'sk-ant-test-not-a-real-key';
const QUESTION = 'What was paid revenue in September 2026?';
const SEP = { month_start: '2026-09-01', month_end: '2026-10-01' };
// What must never reach the AI: rows, figures, notes, org.md, guardrails.md,
// data.md's own prose and evidence, a draft rule or metric.
const NEVER_SENT = [
  '45456', '35456', '98765', '23456', '12000', 'ann@example.invalid', 'Ann', 'Sam Staff',
  'ORG_TEXT_NEVER_IN_QUERY', 'GUARDRAILS_NEVER_IN_QUERY', 'DATA_PROSE_NEVER_IN_QUERY', 'FIGURE_PROSE_NEVER_IN_QUERY',
  'EVIDENCE_NEVER_IN_QUERY', 'DRAFT_RULE_NEVER_IN_QUERY', 'DRAFT_METRIC_NEVER_IN_QUERY', 'NOTE_TEXT_NEVER_IN_QUERY',
];

let DIR;
let DB;
test.before(async () => {
  DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-ask-query-')));
  DB = path.join(DIR, 'askq.duckdb');
  await build({ fixtureDir: path.join(FIX, 'data'), out: DB });
});
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return {
    lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'),
  };
}

// The last verify record: every signed truth and rule passed at `at`.
const PASSED = ['truth:paid-revenue-2026-09', 'query-rule:QR-000', 'query-rule:QR-003', 'query-rule:QR-006', 'query-rule:QR-007', 'query-rule:QR-008'];
const record = (at, results = PASSED.map((id) => ({ id, outcome: 'pass' }))) => ({ at: new Date(at).toISOString(), source: 'verify', results });

// A stand-in Anthropic client. route_question answers with route;
// write_query with write (an object, or a function of the call); the notes
// call says not covered; a plain ask answers with text. gate: a promise the
// write call waits for; writeFail: an error for the write call only.
function fakeModel({
  route = { kind: 'data' }, write = null, gate = null, writeFail = null,
} = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        checkRequest(params);
        const usage = { input_tokens: 100, output_tokens: 20 };
        const tool = params.tools && params.tools[0].name;
        if (tool === query.WRITE_TOOL_NAME) {
          if (gate) await gate;
          if (writeFail) throw writeFail;
          const input = typeof write === 'function' ? write(params) : write;
          const content = input ? [{ type: 'tool_use', id: 'tu_w', name: tool, input }] : [{ type: 'text', text: 'Hmm.' }];
          return { content, stop_reason: input ? 'tool_use' : 'end_turn', usage };
        }
        if (tool === askTool.TOOL_NAME) return { content: [{ type: 'tool_use', id: 'tu_r', name: tool, input: route }], stop_reason: 'tool_use', usage };
        if (tool === askTool.NOTES_TOOL_NAME) return { content: [{ type: 'tool_use', id: 'tu_n', name: tool, input: { covered: false } }], stop_reason: 'tool_use', usage };
        return { content: [{ type: 'text', text: 'From the context.' }], stop_reason: 'end_turn', usage };
      },
    },
  };
}

const RULE_PLAN = {
  covered: true, rule_ids: ['QR-003'], path: 'rule', params: SEP, label: 'Paid revenue, September 2026', unit: 'cents',
};
const AI_SQL = "SELECT SUM(p.amount_cents) AS paid FROM payments p WHERE p.paid_on >= DATE '2026-09-01' AND p.paid_on < DATE '2026-10-01'";
const TRUTH_PLAN = { ...RULE_PLAN, truth_id: 'paid-revenue-2026-09', sql: AI_SQL };
const COMPOSED_SQL = 'SELECT c.zone_id, COUNT(i.invoice_id) AS invoices FROM invoices i JOIN clients c ON c.client_id = i.client_id GROUP BY c.zone_id';
const COMPOSED_PLAN = {
  covered: true, rule_ids: ['QR-003', 'QR-006'], path: 'composed', sql: COMPOSED_SQL, label: 'Invoices by zone', unit: 'count',
};

// Everything on the one clock. last: the verify record (null: never run).
// askData / llmWrap: stand-ins or wrappers for the failure ways out.
async function setup(t, {
  prof = profile, model = fakeModel({ write: RULE_PLAN }), last = record(T0 - DAY), askData: askOverride = null, llmWrap = null,
} = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const varDir = fs.realpathSync(fs.mkdtempSync(path.join(DIR, 'var-')));
  const log = quietLog();
  const store = createStore({ now });
  const knowledge = createKnowledgeStore({
    clientId: 'askq', varDir, log: quietLog(), now,
  });
  await knowledge.add({
    hub: 'full', kind: 'text', title: 'A note', text: 'NOTE_TEXT_NEVER_IN_QUERY: payments arrive on Fridays.', addedBy: ADA.id,
  });
  const realLlm = createLlm({
    apiKey: KEY, profile: prof, profilePath: PROFILE_PATH, store, log, env: {}, now, deps: { createClient: () => model }, knowledge,
  });
  const llm = llmWrap ? llmWrap(realLlm) : realLlm;
  const data = createData({ file: DB, profile: prof });
  await data.open();
  const askData = askOverride || (prof.ask ? createAskData({ file: DB, profile: prof, log }) : null);
  t.after(() => {
    data.close();
    if (askData && askData.close) askData.close();
  });
  const queue = createAskQueue({
    clientId: 'askq', varDir, log: quietLog(), now,
  });
  const rules = createRulesReader({ profile: prof, profilePath: PROFILE_PATH, readLast: () => last, now });
  const app = new FakeSlackApp({ views: true, channels: ['C0BUILDREQ1'] });
  const views = createHubViews({
    hubs: registry.hubs, data, llm, knowledge, askData,
  });
  registerHubs(app, {
    registry, profile: prof, env: 'dev', log, store, forHub: views.forHub, rules, buildRequest: { now }, ask: { queue, now },
  });
  return {
    app, log, store, clock, model, queue,
  };
}

const MENU = (hub) => ({ id: 'VMENU', type: 'modal', private_metadata: hub, hash: 'hmenu' });
const calls = (app, method) => app.views.filter((v) => v.method === method).map((v) => v.args);
const allText = (view) => view.blocks.filter((b) => b.text).map((b) => b.text.text).join('\n');
const buttonsOf = (view) => view.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
const lastUpdate = (app) => calls(app, 'update').at(-1).view;
const writeCalls = (model) => model.calls.filter((c) => c.tools && c.tools[0].name === query.WRITE_TOOL_NAME);
const logged = (ctx, msg) => ctx.log.lines.filter((l) => l.msg === msg);

async function ask(ctx, question = QUESTION, { hub = 'full', user = ADA } = {}) {
  await ctx.app.dispatchAction(`${hub}-ask:open`, { user, view: MENU(hub) });
  const form = calls(ctx.app, 'push').at(-1).view;
  await ctx.app.dispatchView(askTool.FORM_CALLBACK, {
    user,
    view: {
      ...form, id: 'VASK', hash: 'hask', state: { values: { [askTool.QUESTION_BLOCK]: { [askTool.QUESTION_ACTION]: { type: 'plain_text_input', value: question } } } },
    },
  });
  return lastUpdate(ctx.app);
}

function click(ctx, button, { user = ADA, hub = 'full', view = true } = {}) {
  return ctx.app.dispatchAction(button.action_id, {
    user,
    value: button.value,
    ...(view ? { view: { id: 'VASK', type: 'modal', private_metadata: `${hub}:${hub}-ask`, title: { type: 'plain_text', text: 'Ask' } } } : {}),
  });
}

const REFUSAL = WORDS.noQueryRule(true, 'x');
const refused = (view) => allText(view).startsWith("The data and rules are ready, but no signed query rule covers that yet, so I won't guess. I've noted the question for the team.");

test('the fixture loads: Ask and Request a tool on the full hub, Ask on the hub without rules', () => {
  assert.deepEqual(loadProblems, []);
  assert.deepEqual(registry.modules.map((m) => m.id).sort(), ['full-ask', 'full-request', 'plain-ask']);
});

// --- the rule path -------------------------------------------------------------------

test('the rule path runs the signed rule\'s reviewed SQL with the typed parameters: "*Paid revenue, September 2026:* $454.56", with provenance, Show the query, Request a tool and Ask another', async (t) => {
  const ctx = await setup(t);
  const view = await ask(ctx);
  const text = allText(view);
  assert.match(text, /^\*Paid revenue, September 2026:\* \$454\.56$/m);
  assert.match(text, /^From signed rule QR-003 \(reviewed query\)\.$/m);
  assert.match(text, /^Source: .+, as of 2026-09-30\. 1 row\. Tables: payments\.$/m);
  assert.match(text, /Not what you needed\?/);
  assert.deepEqual(buttonsOf(view).map((b) => [b.action_id, b.text.text]), [
    [askTool.ACTIONS.query, 'Show the query'], [askTool.ACTIONS.buildRequest, 'Request a tool'], [askTool.ACTIONS.again, 'Ask another'],
  ]);
  const answered = logged(ctx, 'ask query answered');
  assert.equal(answered.length, 1);
  assert.deepEqual({ ...answered[0].fields, ms: 0, queryHash: 'h' }, {
    module: 'full-ask', path: 'rule', rules: ['QR-003'], queryHash: 'h', tables: ['payments'], rows: 1, ms: 0,
  });
});

test('two AI calls per answer (route_question, write_query), both counted against the AI\'s per-person limit; one query answer counted', async (t) => {
  const ctx = await setup(t);
  await ask(ctx);
  assert.deepEqual(ctx.model.calls.map((c) => c.tools[0].name), [askTool.TOOL_NAME, query.WRITE_TOOL_NAME]);
  assert.equal(ctx.store.get('ratelimit', ADA.id).count, 2);
  assert.equal(ctx.store.get('ratelimit', `ask-query:${ADA.id}`).count, 1);
});

test('the AI\'s requests hold no row, no truth figure, no expect, no note text, no org.md or guardrails text, no draft rule; the writer gets the schema, the signed rules and the as-of date', async (t) => {
  const ctx = await setup(t, { model: fakeModel({ write: TRUTH_PLAN }) });
  await ask(ctx);
  const sent = JSON.stringify(ctx.model.calls);
  for (const s of NEVER_SENT) assert.ok(!sent.includes(s), s);
  const [write] = writeCalls(ctx.model);
  for (const s of ['<query_reference>', 'As-of date ("today"): 2026-09-30', '- payments: payment_id (INTEGER), invoice_id (INTEGER), paid_on (DATE), amount_cents (BIGINT)',
    '[QR-000] traps every query avoids', '[QR-003] implements MET-003', 'known truth: paid-revenue-2026-09 (for month_start = 2026-09-01, month_end = 2026-10-01)',
    'MET-003 Paid revenue for a month: cash received in the month.', '**Paid:** cash received']) {
    assert.ok(write.system.includes(s), s);
  }
  // Hidden columns and tables are never named in the schema.
  for (const s of ['first_name', 'email (', '- staff']) assert.ok(!write.system.includes(s), s);
  // The "&lt;" in the rules' SQL is explained, as is every tag.
  assert.ok(write.system.includes('&lt; CAST($month_end AS DATE)'));
  assert.ok(write.system.includes('stand for <, > and &'));
});

test('the answer and the query view show the query, escaped, with its parameters; Back to the answer returns to it', async (t) => {
  const ctx = await setup(t);
  const view = await ask(ctx);
  await click(ctx, buttonsOf(view)[0]);
  const shown = lastUpdate(ctx.app);
  const text = allText(shown);
  assert.match(text, /^\*The signed rule's query \(QR-003, reviewed\):\*$/m);
  assert.ok(text.includes('AND p.paid_on &lt; CAST($month_end AS DATE)'));
  assert.ok(text.includes('Parameters: month_start = 2026-09-01, month_end = 2026-10-01.'));
  assert.deepEqual(buttonsOf(shown).map((b) => [b.action_id, b.text.text]), [[askTool.ACTIONS.answer, 'Back to the answer'], [askTool.ACTIONS.again, 'Ask another']]);
  assert.equal(shown.close.text, 'Back');
  await click(ctx, buttonsOf(shown)[0]);
  assert.deepEqual(lastUpdate(ctx.app).blocks, view.blocks);
  assert.equal(calls(ctx.app, 'update').at(-1).view_id, 'VASK', 'in place: no trigger needed');
});

test('a bad parameter refuses with the refusal text, and is queued as guard: a month that does not exist, a date far outside the data, a missing or extra parameter, a zone not in zones', async (t) => {
  for (const params of [{ ...SEP, month_start: '2026-13-01' }, { ...SEP, month_start: '1990-01-01' }, { month_start: '2026-09-01' }, { ...SEP, extra: 'x' }]) {
    const ctx = await setup(t, { model: fakeModel({ write: { ...RULE_PLAN, params } }) });
    assert.ok(refused(await ask(ctx)), JSON.stringify(params));
    assert.deepEqual((await ctx.queue.list()).map((e) => e.reason), ['guard'], JSON.stringify(params));
    assert.equal(logged(ctx, 'ask query answered').length, 0);
  }
  const zone = (z) => ({
    ...RULE_PLAN, rule_ids: ['QR-007'], params: { zone: z, ...SEP }, label: 'Paid revenue from North, September 2026',
  });
  const ctx = await setup(t, { model: fakeModel({ write: zone('east') }) });
  assert.ok(refused(await ask(ctx)));
  const ok = await setup(t, { model: fakeModel({ write: zone('north') }) });
  assert.match(allText(await ask(ok)), /^\*Paid revenue from North, September 2026:\* \$354\.56$/m);
});

test('a rule with ORDER BY shows a table, escaped, a *_cents column as dollars, and no "Not ranked" line', async (t) => {
  const ctx = await setup(t, { model: fakeModel({ write: { ...RULE_PLAN, rule_ids: ['QR-006'], label: 'Paid by zone <September>' } }) });
  const text = allText(await ask(ctx));
  assert.ok(text.includes('*Paid by zone &lt;September&gt;*'));
  assert.ok(text.includes('```\nzone_id | zone  | paid_cents\nnorth   | North | $354.56\nsouth   | South | $100.00\n```'), text);
  assert.ok(!text.includes('Not ranked'));
  assert.match(text, /2 rows\. Tables: clients, invoices, payments, zones\./);
});

// --- the composed path -----------------------------------------------------------------

test('the composed path runs the AI\'s checked SQL, labelled "Composed from QR-003 and QR-006 (AI-written, checked); not itself a signed rule", "Not ranked" without ORDER BY', async (t) => {
  const ctx = await setup(t, { model: fakeModel({ write: COMPOSED_PLAN }) });
  const view = await ask(ctx, 'How many invoices per zone?');
  const text = allText(view);
  assert.ok(text.includes('*Invoices by zone*'));
  assert.ok(text.includes(WORDS.notRanked()));
  assert.match(text, /^Composed from QR-003 and QR-006 \(AI-written, checked\); not itself a signed rule\.$/m);
  await click(ctx, buttonsOf(view)[0]);
  const shown = allText(lastUpdate(ctx.app));
  assert.match(shown, /^\*The AI-written query \(checked\):\*$/m);
  assert.ok(shown.includes(COMPOSED_SQL));
  assert.equal(logged(ctx, 'ask query answered')[0].fields.path, 'composed');
});

test('a composed query that needs a hidden column or table is refused by the guard: the refusal text, queued as hidden_column; any other guard refusal as guard', async (t) => {
  for (const [sql, reason] of [
    ['SELECT c.email FROM clients c', 'hidden_column'],
    ['SELECT c.first_name, i.total_cents FROM invoices i JOIN clients c ON c.client_id = i.client_id', 'hidden_column'],
    ['SELECT COUNT(s.staff_id) AS n FROM staff s', 'hidden_column'],
    ['SELECT COUNT(p.payment_id) AS n FROM payments p WHERE p.paid_on < CURRENT_DATE', 'guard'],
  ]) {
    const ctx = await setup(t, { model: fakeModel({ write: { ...COMPOSED_PLAN, sql } }) });
    const view = await ask(ctx, 'List the clients with the highest unpaid balance and their emails.');
    assert.ok(refused(view), sql);
    assert.deepEqual(buttonsOf(view).map((b) => b.action_id), [askTool.ACTIONS.buildRequest, askTool.ACTIONS.again]);
    const entries = await ctx.queue.list();
    assert.deepEqual(entries.map((e) => [e.reason, e.question]), [[reason, 'List the clients with the highest unpaid balance and their emails.']], sql);
    assert.deepEqual(Object.keys(entries[0]).sort(), ['at', 'hub', 'id', 'question', 'reason']);
    assert.equal(entries[0].at, new Date(T0).toISOString());
  }
});

// --- truth figures -----------------------------------------------------------------------

test('a truth question shows the signed rule\'s figure with the AI\'s own query beside it, agreeing; Show the query shows both', async (t) => {
  const ctx = await setup(t, { model: fakeModel({ write: TRUTH_PLAN }) });
  const view = await ask(ctx);
  const text = allText(view);
  assert.match(text, /^\*Paid revenue, September 2026:\* \$454\.56$/m);
  assert.match(text, /^The AI's own query agreed: \$454\.56\.$/m);
  assert.match(text, /^From signed rule QR-003 \(reviewed query\)\.$/m);
  await click(ctx, buttonsOf(view)[0]);
  const shown = allText(lastUpdate(ctx.app));
  assert.ok(shown.includes("*The signed rule's query (QR-003, reviewed):*"));
  assert.ok(shown.includes("*The AI's own query (checked, shown beside the signed rule's figure):*"));
  assert.ok(shown.includes('&lt; DATE'));
  assert.equal(logged(ctx, 'ask query answered')[0].fields.path, 'truth');
  assert.equal(logged(ctx, 'ask query compared').length, 1);
});

test('a cents-versus-dollars result counts as a mismatch: the signed figure stands, "The AI\'s own query disagreed", and what it gave', async (t) => {
  const sql = AI_SQL.replace('SUM(p.amount_cents)', 'SUM(p.amount_cents) / 100');
  const ctx = await setup(t, { model: fakeModel({ write: { ...TRUTH_PLAN, sql } }) });
  const text = allText(await ask(ctx));
  assert.match(text, /^\*Paid revenue, September 2026:\* \$454\.56$/m);
  assert.match(text, /^The AI's own query disagreed; the figure shown is from the signed rule\.$/m);
  assert.match(text, /^It gave \$4\.55\.$/m);
  assert.ok(!text.includes('agreed:'));
});

test('a two-row result for a truth claim counts as a mismatch, and its value is hidden', async (t) => {
  const sql = 'SELECT SUM(p.amount_cents) AS paid FROM payments p GROUP BY p.paid_on >= DATE \'2026-09-15\'';
  const ctx = await setup(t, { model: fakeModel({ write: { ...TRUTH_PLAN, sql } }) });
  const text = allText(await ask(ctx));
  assert.match(text, /^The AI's own query disagreed; the figure shown is from the signed rule\.$/m);
  assert.ok(!text.includes('It gave'));
});

test('an unknown or pending truth_id, or other parameters, hides the AI\'s result: the rule\'s answer only, the AI\'s query never run', async (t) => {
  for (const write of [
    { ...TRUTH_PLAN, truth_id: 'no-such-truth' },
    { ...TRUTH_PLAN, truth_id: 'billed-pending' },
    { ...TRUTH_PLAN, params: { month_start: '2026-08-01', month_end: '2026-09-01' }, label: 'Paid revenue, August 2026' },
  ]) {
    const ctx = await setup(t, { model: fakeModel({ write }) });
    const text = allText(await ask(ctx));
    assert.match(text, /^From signed rule QR-003 \(reviewed query\)\.$/m, write.truth_id);
    assert.ok(!/AI's own query/.test(text), write.truth_id);
    assert.equal(logged(ctx, 'ask query compared').length, 0, write.truth_id);
  }
});

test('on the composed path, a truth claim that does not hold hides the AI\'s result, so the question is declined (no_rule); one that holds shows the signed rule\'s figure', async (t) => {
  const ctx = await setup(t, { model: fakeModel({ write: { ...COMPOSED_PLAN, truth_id: 'billed-pending' } }) });
  assert.ok(refused(await ask(ctx)));
  assert.deepEqual((await ctx.queue.list()).map((e) => e.reason), ['no_rule']);
  const held = await setup(t, {
    model: fakeModel({
      write: {
        ...COMPOSED_PLAN, sql: AI_SQL, truth_id: 'paid-revenue-2026-09', label: 'Paid revenue, September 2026', unit: 'cents',
      },
    }),
  });
  const text = allText(await ask(held));
  assert.match(text, /^\*Paid revenue, September 2026:\* \$454\.56$/m);
  assert.match(text, /^The AI's own query agreed: \$454\.56\.$/m);
  assert.match(text, /^From signed rule QR-003 \(reviewed query\)\.$/m);
});

// --- when Ask runs a query: each condition missing ----------------------------------------

test('no signed rule covers it (covered false, an unsigned or unknown rule id, no tool call): the refusal text, queued as no_rule with the question only', async (t) => {
  for (const write of [{ covered: false }, { ...RULE_PLAN, rule_ids: ['QR-008'] }, { ...RULE_PLAN, rule_ids: ['QR-999'] }, { ...RULE_PLAN, rule_ids: ['QR-000'] }, null]) {
    const ctx = await setup(t, { model: fakeModel({ write }) });
    const view = await ask(ctx);
    assert.equal(allText(view), REFUSAL, JSON.stringify(write));
    const entries = await ctx.queue.list();
    assert.deepEqual(entries.map((e) => [e.hub, e.reason, e.question]), [['full', 'no_rule', QUESTION]]);
  }
});

test('the person without ASK_DATA gets the refusal text (with "Tell <admin>", having no Request a tool), queued as no_key; no write_query call', async (t) => {
  const ctx = await setup(t);
  const view = await ask(ctx, QUESTION, { user: BO });
  assert.match(allText(view), /^The data and rules are ready, but no signed query rule covers that yet, so I won't guess\. I've noted the question for the team\. Tell .+ if you need it sooner\.$/);
  assert.deepEqual(buttonsOf(view).map((b) => b.action_id), [askTool.ACTIONS.again]);
  assert.equal(writeCalls(ctx.model).length, 0);
  assert.deepEqual((await ctx.queue.list()).map((e) => e.reason), ['no_key']);
});

test('the truth gate fails closed: verify never run, a failed, skipped or timed-out truth, a truth missing from the record, a pass 8 days old: the gate\'s words, no write_query, nothing queued', async (t) => {
  const others = PASSED.filter((id) => !id.startsWith('truth:')).map((id) => ({ id, outcome: 'pass' }));
  for (const [name, last] of [
    ['never run', null],
    ['failed', record(T0 - DAY, [{ id: 'truth:paid-revenue-2026-09', outcome: 'fail' }, ...others])],
    ['skipped', record(T0 - DAY, [{ id: 'truth:paid-revenue-2026-09', outcome: 'skip' }, ...others])],
    ['timed out', record(T0 - DAY, [{ id: 'truth:paid-revenue-2026-09', outcome: 'timeout' }, ...others])],
    ['missing', record(T0 - DAY, others)],
    ['8 days old', record(T0 - 8 * DAY)],
  ]) {
    const ctx = await setup(t, { last });
    assert.equal(allText(await ask(ctx)), WORDS.truthGate(), name);
    assert.equal(writeCalls(ctx.model).length, 0, name);
    assert.deepEqual(await ctx.queue.list(), [], name);
  }
  const fresh = await setup(t, { last: record(T0 - 6 * DAY) });
  assert.match(allText(await ask(fresh)), /\$454\.56/);
});

test('with no signed metric rule (no rule check passed), every data question gets the refusal text, queued as no_rule, with no write_query', async (t) => {
  const ctx = await setup(t, { last: record(T0 - DAY, [{ id: 'truth:paid-revenue-2026-09', outcome: 'pass' }, { id: 'query-rule:QR-000', outcome: 'pass' }]) });
  assert.equal(allText(await ask(ctx)), REFUSAL);
  assert.equal(writeCalls(ctx.model).length, 0);
  assert.deepEqual((await ctx.queue.list()).map((e) => e.reason), ['no_rule']);
});

test('a hub that does not see the rules keeps its readiness message; a profile with no ask block keeps "There\'s no tool for that yet"; neither writes a query', async (t) => {
  const plain = await setup(t);
  assert.equal(allText(await ask(plain, QUESTION, { hub: 'plain' })), WORDS.dataNoRules());
  assert.equal(writeCalls(plain.model).length, 0);
  const { ask: _drop, ...noAsk } = profile;
  const none = await setup(t, { prof: Object.freeze(noAsk) });
  assert.equal(allText(await ask(none)), WORDS.noToolYet());
  assert.equal(writeCalls(none.model).length, 0);
});

test('the profile\'s ask.queries_per_hour (3 here) caps query answers a person an hour, on the test clock', async (t) => {
  const ctx = await setup(t);
  for (let i = 0; i < 3; i += 1) assert.match(allText(await ask(ctx)), /\$454\.56/);
  assert.equal(allText(await ask(ctx)), WORDS.queryLimit(3));
  assert.equal(writeCalls(ctx.model).length, 3);
  ctx.clock.t += 60 * 60 * 1000;
  assert.match(allText(await ask(ctx)), /\$454\.56/);
});

// --- ways out ------------------------------------------------------------------------------

test('way out, a second question while one is being answered: "Another question is being answered. Try again in a moment."; the first still answers', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = await setup(t, { model: fakeModel({ write: RULE_PLAN, gate }) });
  const first = ask(ctx);
  await new Promise((r) => setImmediate(r));
  const second = await ask(ctx);
  assert.equal(allText(second), messageFor(new AskQueryRefused('busy')));
  release();
  assert.match(allText(await first), /\$454\.56/);
});

test('way out, the AI off, failing or over budget at write_query: its own words; nothing queued', async (t) => {
  const failing = await setup(t, { model: fakeModel({ writeFail: Object.assign(new Error('boom'), { status: 500 }) }) });
  assert.equal(allText(await ask(failing)), messageFor(new LlmUnavailable('failed')));
  const over = await setup(t, {
    llmWrap: (llm) => ({
      ...llm,
      forHub: (b) => ({ ...llm.forHub(b), writeQuery: async () => { throw new LlmUnavailable('over_budget'); } }),
    }),
  });
  assert.equal(allText(await ask(over)), messageFor(new LlmUnavailable('over_budget')));
  assert.deepEqual(await over.queue.list(), []);
});

// A stand-in for Ask's connection whose run (or schema) fails as given.
function failingAskData(err, { at = 'run' } = {}) {
  return {
    idle: async () => {},
    describe: () => ({ available: true, problem: null }),
    schema: async () => {
      if (at === 'schema') throw err;
      return { payments: [{ column: 'paid_on', type: 'DATE' }, { column: 'amount_cents', type: 'BIGINT' }] };
    },
    run: async () => { throw err; },
    close() {},
  };
}

test('ways out, the data unavailable, a failure, a timeout: fixed words, never DuckDB\'s text; nothing queued', async (t) => {
  for (const [err, at, said] of [
    [new AskQueryRefused('failed', { errorClass: 'data_unavailable' }), 'schema', "The data isn't available right now, so I can't answer that. The app is still running; please tell your admin."],
    [new AskQueryRefused('failed', { errorClass: 'binder' }), 'run', "I couldn't run that query safely."],
    [new AskQueryRefused('timeout'), 'run', 'That question took too long to answer; narrow it.'],
  ]) {
    const ctx = await setup(t, { askData: failingAskData(err, { at }) });
    assert.equal(allText(await ask(ctx)), said);
    assert.deepEqual(await ctx.queue.list(), []);
  }
});

test('way out, closing while it thinks: the answer is dropped, and the next question is answered (one at a time is released)', async (t) => {
  const ctx = await setup(t);
  ctx.app.viewsFail.update = Object.assign(new Error('An API error occurred: not_found'), { data: { ok: false, error: 'not_found' } });
  await ask(ctx).catch(() => {});
  assert.equal(logged(ctx, 'ask answer dropped').length, 1);
  ctx.app.viewsFail.update = null;
  assert.match(allText(await ask(ctx)), /\$454\.56/);
});

test('ways out of Show the query: an answer kept no longer (30 minutes), someone else\'s answer, a forged id, a click from an old message', async (t) => {
  const ctx = await setup(t);
  const view = await ask(ctx);
  const [show] = buttonsOf(view);
  await click(ctx, show, { user: BO });
  assert.equal(allText(lastUpdate(ctx.app)), WORDS.answerNotYours());
  await click(ctx, { ...show, value: '0123456789abcdef' });
  assert.equal(allText(lastUpdate(ctx.app)), WORDS.answerGone());
  await click(ctx, { ...show, value: '../../etc' });
  assert.equal(allText(lastUpdate(ctx.app)), WORDS.answerGone());
  const updates = calls(ctx.app, 'update').length;
  await click(ctx, show, { view: false });
  assert.equal(ctx.app.responded.at(-1).text, FORM_NEEDS_WINDOW);
  assert.equal(calls(ctx.app, 'update').length, updates);
  ctx.clock.t += 31 * 60 * 1000;
  await click(ctx, show);
  const gone = lastUpdate(ctx.app);
  assert.equal(allText(gone), WORDS.answerGone());
  assert.deepEqual(buttonsOf(gone).map((b) => b.action_id), [askTool.ACTIONS.again]);
});

test('logs hold no question, SQL, label, parameter value or row', async (t) => {
  const ctx = await setup(t, { model: fakeModel({ write: TRUTH_PLAN }) });
  await ask(ctx);
  const composed = await setup(t, { model: fakeModel({ write: { ...COMPOSED_PLAN, sql: 'SELECT c.email FROM clients c' } }) });
  await ask(composed, 'PRIVATE_QUESTION_TEXT please');
  const lines = JSON.stringify([...ctx.log.lines, ...composed.log.lines]);
  for (const s of ['paid revenue in September', 'PRIVATE_QUESTION_TEXT', 'SELECT', 'amount_cents', 'Paid revenue, September', '2026-09-01', '45456', '454.56', 'north', 'email']) {
    assert.ok(!lines.includes(s), s);
  }
});

// --- the pieces, alone ---------------------------------------------------------------------

test('renderResult: "not ranked", "the first 50 by its order", at most 10 columns and 100 characters a cell, escaped', () => {
  const columns = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const rows = Array.from({ length: 51 }, (_, r) => Object.fromEntries(columns.map((c, i) => [c, i === 0 ? `<b>${'x'.repeat(150)}` : r])));
  const unordered = query.renderResult({ rows, columns, ordered: false }, { label: 'L', unit: 'count' }).join('\n');
  assert.ok(unordered.includes(WORDS.notRankedMore(50)));
  assert.ok(unordered.includes(WORDS.moreColumns(10, 12)));
  assert.ok(!unordered.includes('c10'));
  assert.ok(unordered.includes(`&lt;b&gt;${'x'.repeat(96)}…`));
  assert.ok(!unordered.includes('x'.repeat(98)));
  assert.equal((unordered.match(/^&lt;b&gt;/gm) || []).length, 50);
  const ordered = query.renderResult({ rows, columns, ordered: true }, { label: 'L', unit: 'count' }).join('\n');
  assert.ok(ordered.includes(WORDS.firstByOrder(50)));
  assert.ok(!ordered.includes('Not ranked'));
  const few = query.renderResult({ rows: rows.slice(0, 3), columns: ['a', 'b'], ordered: false }, { label: 'L', unit: 'count' }).join('\n');
  assert.ok(few.includes(WORDS.notRanked()));
});

test('numbers: cents as dollars, counts with commas, a single number found only in 1 row and 1 column, compared exactly', () => {
  assert.equal(query.dollars('35018640'), '$350,186.40');
  assert.equal(query.dollars(-150), '-$1.50');
  assert.equal(query.dollars('350186.4'), '$3,501.86');
  assert.equal(query.plainNumber('815'), '815');
  assert.equal(query.plainNumber(1234567), '1,234,567');
  assert.equal(query.singleNumber({ rows: [{ n: '5' }], columns: ['n'] }), '5');
  assert.equal(query.singleNumber({ rows: [{ n: '5' }, { n: '6' }], columns: ['n'] }), null);
  assert.equal(query.singleNumber({ rows: [{ n: 'five' }], columns: ['n'] }), null);
  assert.equal(query.singleNumber({ rows: [{ a: 1, b: 2 }], columns: ['a', 'b'] }), null);
  assert.equal(query.sameNumber('35018640', '35018640'), true);
  assert.equal(query.sameNumber('35018640', '350186.4'), false);
  assert.equal(query.sameNumber('9007199254740993', '9007199254740992'), false);
});

test('write_query declares effects "none" and a schema the Anthropic fake accepts; its plan is checked against the signed rules only', () => {
  assert.equal(query.WRITE_TOOL.effects, 'none');
  const rules = new Map([
    ['QR-000', { id: 'QR-000', kind: 'traps' }],
    ['QR-003', { id: 'QR-003', kind: 'metric', unit: 'cents' }],
  ]);
  assert.equal(query.planOf({ covered: false }, rules), null);
  assert.equal(query.planOf({ ...RULE_PLAN, label: '' }, rules), null);
  assert.equal(query.planOf({ ...RULE_PLAN, path: 'other' }, rules), null);
  assert.equal(query.planOf({ ...RULE_PLAN, rule_ids: ['QR-003', 'QR-004'] }, rules), null);
  assert.equal(query.planOf({ ...COMPOSED_PLAN, rule_ids: ['QR-003'], sql: undefined }, rules), null);
  assert.equal(query.planOf({ ...COMPOSED_PLAN, rule_ids: ['QR-003'], sql: 'x'.repeat(4001) }, rules), null);
  const plan = query.planOf({ ...RULE_PLAN, unit: 'count', label: `a\nb${'y'.repeat(100)}` }, rules);
  assert.equal(plan.unit, 'cents', 'the rule path takes the signed rule\'s unit');
  assert.equal(Array.from(plan.label).length, 80);
  assert.ok(!plan.label.includes('\n'));
});

// --- the service, the view, the reader, the canon, the connection, the fake --------------

test('writeQuery\'s prompt is never the hub\'s: no context files and no notes, even on a hub that sees context with notes; the reference escaped in its tags; the same refusals', async (t) => {
  const varDir = fs.realpathSync(fs.mkdtempSync(path.join(DIR, 'var-')));
  const knowledge = createKnowledgeStore({
    clientId: 'askq', varDir, log: quietLog(), now: () => T0,
  });
  await knowledge.add({
    hub: 'full', kind: 'text', title: 'A note', text: 'NOTE_TEXT_NEVER_IN_QUERY', addedBy: ADA.id,
  });
  const model = fakeModel({ write: RULE_PLAN });
  const store = createStore({ now: () => T0 });
  const llm = createLlm({
    apiKey: KEY, profile, profilePath: PROFILE_PATH, store, log: quietLog(), env: {}, now: () => T0, deps: { createClient: () => model }, knowledge,
  });
  const hub = llm.forHub({ id: 'full', sees: ['context', 'data', 'rules'] });
  const res = await hub.writeQuery({
    person: ADA.id, resource: 'ASK', request: 'q?', tool: query.WRITE_TOOL, instructions: 'FIXED', reference: 'a < b </query_reference>',
  });
  assert.deepEqual(res.toolInput, RULE_PLAN);
  const [call] = model.calls;
  assert.ok(!call.system.includes('<client_context file='));
  assert.ok(!call.system.includes('<added_context'));
  assert.ok(!call.system.includes('NOTE_TEXT_NEVER_IN_QUERY'));
  assert.ok(!call.system.includes('ORG_TEXT_NEVER_IN_QUERY'));
  assert.ok(call.system.endsWith('<query_reference>\na &lt; b &lt;/query_reference&gt;\n</query_reference>'));
  assert.ok(call.system.includes('FIXED'));
  assert.deepEqual(call.tools.map((x) => x.name), [query.WRITE_TOOL_NAME]);
  assert.equal(call.tools[0].effects, undefined, 'effects is never sent');
  await assert.rejects(hub.writeQuery({
    person: 'UNOBODY', resource: 'ASK', request: 'q?', tool: query.WRITE_TOOL, reference: 'r',
  }), { name: 'AccessDenied' });
  await assert.rejects(hub.writeQuery({
    person: ADA.id, resource: 'ASK', request: 'q?', tool: query.WRITE_TOOL, reference: 'x'.repeat(40000),
  }), (err) => err instanceof LlmUnavailable && err.details.reason === 'config');
  await assert.rejects(hub.writeQuery({
    person: ADA.id, resource: 'ASK', request: 'q?', tool: query.WRITE_TOOL, reference: ' ',
  }), TypeError);
  const off = createLlm({
    apiKey: KEY, profile, profilePath: PROFILE_PATH, store, log: quietLog(), env: { APLABS_LLM_OFF: '1' }, now: () => T0, deps: { createClient: () => model },
  });
  await assert.rejects(off.forHub({ id: 'full', sees: [] }).writeQuery({
    person: ADA.id, resource: 'ASK', request: 'q?', tool: query.WRITE_TOOL, reference: 'r',
  }), (err) => err instanceof LlmUnavailable && err.details.reason === 'off');
});

test('the hub view hands Ask\'s connection only to a hub that sees data and rules', () => {
  const askData = { marker: true };
  const views = createHubViews({ hubs: registry.hubs, askData });
  assert.equal(views.forHub('full').askData, askData);
  assert.equal(views.forHub('plain').askData, null);
});

test('forQueries: the signed rules only (a draft never), the truths with signed and last (never expect), the canon without figures; data.md missing gives none', () => {
  const reader = createRulesReader({ profile, profilePath: PROFILE_PATH, readLast: () => record(T0 - DAY) });
  const q = reader.forQueries();
  assert.deepEqual(q.rules.map((r) => r.id), ['QR-000', 'QR-003', 'QR-006', 'QR-007']);
  assert.deepEqual(q.truths, [{ id: 'paid-revenue-2026-09', signed: true, last: 'pass' }, { id: 'billed-pending', signed: false, last: null }]);
  assert.equal(q.checkedAt, new Date(T0 - DAY).toISOString());
  assert.ok(!JSON.stringify(q.canon).includes('45456'));
  const unsigned = createRulesReader({ profile, profilePath: PROFILE_PATH, readLast: () => record(T0 - DAY, [{ id: 'query-rule:QR-003', outcome: 'fail' }]) });
  assert.deepEqual(unsigned.forQueries().rules.map((r) => r.id), []);
  const none = createRulesReader({ profile, profilePath: path.join(DIR, 'nowhere', 'profile.yml'), readLast: () => record(T0) });
  assert.deepEqual(none.forQueries().rules, []);
  assert.deepEqual(none.forQueries().truths, []);
});

test('writerCanon: Terminology bullets and approved metric rule lines; a sentence holding a number dropped whole; comments, fences, drafts and other fields never read', () => {
  const { writerCanon, numberFree } = require('../../kit/lib/query-rules');
  assert.equal(numberFree('Keep this. Drop 815 here. Keep MET-001 and 2026-09-30. Drop $1.00 too.'), 'Keep this. Keep MET-001 and 2026-09-30.');
  const canon = writerCanon(fs.readFileSync(path.join(FIX, 'context/data.md'), 'utf8'));
  assert.deepEqual(canon.terminology, [
    "**as_of:** the \"today\" of every query: `fixture_meta.value` where `key = 'as_of'`. Never `CURRENT_DATE`.",
    '**Money:** every amount is integer cents.',
    '**Paid:** cash received (`payments.amount_cents`, dated by `paid_on`).',
  ]);
  assert.deepEqual(canon.metrics, [{ id: 'MET-003', name: 'Paid revenue for a month', rule: 'cash received in the month. Formula: `SUM(payments.amount_cents)` by `paid_on`.' }]);
  const hidden = writerCanon('## Terminology\n<!-- - **x:** HIDDEN -->\n```\n- **y:** FENCED\n```\n- **z:** shown\n## Other\n- **w:** OTHER\n');
  assert.deepEqual(hidden.terminology, ['**z:** shown']);
});

test('Ask\'s connection: schema() lists the allowed columns with their types, never a hidden one; idle() resolves once nothing runs', async (t) => {
  const askData = createAskData({ file: DB, profile });
  t.after(() => askData.close());
  const schema = await askData.schema();
  assert.deepEqual(Object.keys(schema), ['zones', 'clients', 'invoices', 'payments', 'fixture_meta']);
  assert.deepEqual(schema.clients, [{ column: 'client_id', type: 'INTEGER' }, { column: 'zone_id', type: 'VARCHAR' }]);
  assert.ok(!JSON.stringify(schema).includes('email') && !JSON.stringify(schema).includes('first_name') && !JSON.stringify(schema).includes('staff'));
  await askData.idle();
  const first = askData.run('SELECT COUNT(z.zone_id) AS n FROM zones z');
  await first;
  await askData.idle();
  const second = await askData.run('SELECT COUNT(c.client_id) AS n FROM clients c');
  assert.deepEqual(second.rows, [{ n: '4' }]);
  const gone = createAskData({ file: path.join(DIR, 'missing.duckdb'), profile });
  await assert.rejects(gone.schema(), (err) => err instanceof AskQueryRefused && err.details.errorClass === 'data_unavailable');
});

test('the Anthropic fake refuses what the API refuses for write_query\'s fields: an invalid JSON Schema, a system that is not text, no messages', () => {
  const ok = {
    model: 'claude-sonnet-5-5', max_tokens: 100, system: 's', messages: [{ role: 'user', content: 'q' }],
  };
  const { toolDef } = require('../../kit/runtime/llm');
  checkRequest({ ...ok, tools: [{ ...toolDef(query.WRITE_TOOL) }] });
  const schema = (props) => ({ ...ok, tools: [{ name: 'write_query', input_schema: { type: 'object', properties: props } }] });
  for (const bad of [{ a: { type: 'int' } }, { a: { type: 'string', maxLength: -1 } }, { a: { enum: 'x' } }, { a: { type: 'array', items: 5 } }, { a: { type: 'object', additionalProperties: 'no' } }]) {
    assert.throws(() => checkRequest(schema(bad)), (err) => err.status === 400 && /JSON schema is invalid/.test(err.message), JSON.stringify(bad));
  }
  assert.throws(() => checkRequest({ ...ok, system: 5 }), (err) => err.status === 400);
  assert.throws(() => checkRequest({ ...ok, messages: [] }), (err) => err.status === 400);
  assert.throws(() => checkRequest({ ...ok, messages: [{ role: 'user', content: '' }] }), (err) => err.status === 400);
});
