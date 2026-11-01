'use strict';

// Plan brightside-v1, Story 19.8 (D10, D11): the demo questions on
// /brightside-v1, answered by query on a build of the Brightside fixture,
// from the signed seed rules QR-000 to QR-006 in profiles/brightside/context/
// data.md, through Ask's own connection (the profile's ask block). The AI is
// a stand-in (it checks each request as the real API does) scripted with the
// plan each question should get; every figure comes from the data:
//
//   paid revenue, September 2026   35,018,640 cents ($350,186.40), QR-003
//   billed revenue, September 2026 36,402,350 cents ($364,023.50), QR-004
//   active plans today             815 (QR-001; not status = 'active', 814)
//   outstanding at as_of           19,875,325 cents ($198,753.25), QR-005
//   active plans by zone           5 rows summing to 815 (QR-006, and composed
//                                  from QR-001 and QR-006)
//
// The last verify record is handed in (every signed truth and rule passed a
// day ago), as `npm run verify` leaves it on the bot's machine. Each answer
// is printed as a test diagnostic, for the PR.
//
// An example test (architecture carve-out): it reads profiles/brightside/ and
// the Brightside fixture, and is deleted with the example in a fork.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../../../kit/fixture/build');
const { loadProfile } = require('../../../kit/lib/profile');
const { loadTruths } = require('../../../kit/lib/truths');
const { loadRules } = require('../../../kit/lib/query-rules');
const { loadRegistry } = require('../../../kit/runtime/registry');
const { createHubViews } = require('../../../kit/runtime/slack/hub-view');
const { registerHubs } = require('../../../kit/runtime/slack/hubs');
const { createStore } = require('../../../kit/runtime/store');
const { createLlm } = require('../../../kit/runtime/llm');
const { createData } = require('../../../kit/runtime/data');
const { createAskData } = require('../../../kit/runtime/data/ask');
const { createRulesReader } = require('../../../kit/runtime/knowledge/readiness');
const { createAskQueue } = require('../../../kit/runtime/knowledge/ask-queue');
const askTool = require('../../../kit/runtime/archetypes/ask');
const query = require('../../../kit/runtime/archetypes/ask/query');
const { FakeSlackApp } = require('../../../test/fixtures/fake-slack');
const { checkRequest } = require('../../../test/fixtures/fake-anthropic');

const ROOT = path.join(__dirname, '../../..');
const PROFILE_PATH = path.join(ROOT, 'profiles/brightside/profile.yml');
const CONTEXT = path.join(ROOT, 'profiles/brightside/context');
const profile = loadProfile(PROFILE_PATH);
const { registry } = loadRegistry({ appDir: path.join(ROOT, 'examples/brightside/app'), profile });
const ely = profile.users.find((u) => u.id === 'ely');
const steven = profile.users.find((u) => u.id === 'steven');
const ELY = { id: ely.identities.slack, name: 'ely' };
const STEVEN = { id: steven.identities.slack, name: 'steven' };
const T0 = Date.UTC(2026, 10, 1, 12, 0);
const SEP = { month_start: '2026-09-01', month_end: '2026-10-01' };

// The last verify record: every signed truth and every rule passed a day ago.
const RECORD = {
  at: new Date(T0 - 24 * 60 * 60 * 1000).toISOString(),
  source: 'verify',
  results: [
    ...loadTruths(CONTEXT).filter((e) => e.truth && e.truth.signedOff && e.truth.signedOff !== 'pending').map((e) => ({ id: `truth:${e.id}`, outcome: 'pass' })),
    ...loadRules(CONTEXT).map((e) => ({ id: `query-rule:${e.id}`, outcome: 'pass' })),
  ],
};

let tmp;
let FIXTURE;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-v1-queries-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeModel(write) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        checkRequest(params);
        const usage = { input_tokens: 100, output_tokens: 20 };
        const tool = params.tools && params.tools[0].name;
        if (tool === query.WRITE_TOOL_NAME) return { content: [{ type: 'tool_use', id: 'tu_w', name: tool, input: write }], stop_reason: 'tool_use', usage };
        return { content: [{ type: 'tool_use', id: 'tu_r', name: askTool.TOOL_NAME, input: { kind: 'data' } }], stop_reason: 'tool_use', usage };
      },
    },
  };
}

const quiet = () => {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return {
    lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'),
  };
};

async function askV1(t, write, question, user = ELY) {
  const now = () => T0;
  const log = quiet();
  const store = createStore({ now });
  const model = fakeModel(write);
  const llm = createLlm({
    apiKey: 'sk-ant-test-not-a-real-key', profile, profilePath: PROFILE_PATH, store, log, env: {}, now, deps: { createClient: () => model },
  });
  const data = createData({ file: FIXTURE, profile });
  await data.open();
  const askData = createAskData({ file: FIXTURE, profile, log });
  t.after(() => { data.close(); askData.close(); });
  const varDir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'var-')));
  const queue = createAskQueue({
    clientId: profile.client.id, varDir, log, now,
  });
  const rules = createRulesReader({
    profile, profilePath: PROFILE_PATH, readLast: () => RECORD, now,
  });
  const app = new FakeSlackApp({ views: true, channels: [profile.slack.build_requests_channel] });
  const views = createHubViews({
    hubs: registry.hubs, data, llm, askData,
  });
  registerHubs(app, {
    registry, profile, env: 'dev', log, store, forHub: views.forHub, rules, buildRequest: { now }, ask: { queue, now },
  });
  await app.dispatchAction('v1-ask:open', { user, view: { id: 'VMENU', type: 'modal', private_metadata: 'brightside-v1', hash: 'h' } });
  const form = app.views.filter((v) => v.method === 'push').at(-1).args.view;
  await app.dispatchView(askTool.FORM_CALLBACK, {
    user,
    view: {
      ...form, id: 'VASK', hash: 'hask', state: { values: { [askTool.QUESTION_BLOCK]: { [askTool.QUESTION_ACTION]: { type: 'plain_text_input', value: question } } } },
    },
  });
  const view = app.views.filter((v) => v.method === 'update').at(-1).args.view;
  const text = view.blocks.filter((b) => b.text).map((b) => b.text.text).join('\n');
  t.diagnostic(`${question}\n${text}`);
  return { text, model, queue };
}

const rule = (id, params, label, extra = {}) => ({
  covered: true, rule_ids: [id], path: 'rule', params, label, unit: 'cents', ...extra,
});

test('demo 1: paid revenue, September 2026: $350,186.40 from QR-003, the AI\'s own query agreeing', async (t) => {
  const { text } = await askV1(t, rule('QR-003', SEP, 'Paid revenue, September 2026', {
    truth_id: 'paid-revenue-2026-09',
    sql: "SELECT SUM(p.amount_cents) AS paid_cents FROM payments p WHERE p.paid_on >= DATE '2026-09-01' AND p.paid_on < DATE '2026-10-01'",
  }), 'What was paid revenue in September 2026?');
  assert.match(text, /^\*Paid revenue, September 2026:\* \$350,186\.40$/m);
  assert.match(text, /^The AI's own query agreed: \$350,186\.40\.$/m);
  assert.match(text, /^From signed rule QR-003 \(reviewed query\)\.$/m);
  assert.match(text, /as of 2026-09-30\. 1 row\. Tables: payments\.$/m);
});

test('demo 2: billed revenue, September 2026: $364,023.50 from QR-004', async (t) => {
  const { text } = await askV1(t, rule('QR-004', SEP, 'Billed revenue, September 2026'), 'What did we bill in September 2026?');
  assert.match(text, /^\*Billed revenue, September 2026:\* \$364,023\.50$/m);
  assert.match(text, /^From signed rule QR-004 \(reviewed query\)\.$/m);
});

test('demo 3: active plans today: 815 from QR-001; an AI query using status = \'active\' (814) disagrees and the signed figure stands', async (t) => {
  const { text } = await askV1(t, rule('QR-001', {}, 'Plans active today', {
    unit: 'count', truth_id: 'active-plans-at-as-of', sql: "SELECT COUNT(pl.plan_id) AS n FROM plans pl WHERE pl.status = 'active'",
  }), 'How many plans are active today?');
  assert.match(text, /^\*Plans active today:\* 815$/m);
  assert.match(text, /^The AI's own query disagreed; the figure shown is from the signed rule\.$/m);
  assert.match(text, /^It gave 814\.$/m);
});

test('demo 4: outstanding at as_of: $198,753.25 from QR-005', async (t) => {
  const { text } = await askV1(t, rule('QR-005', {}, 'Outstanding at 2026-09-30'), 'What do clients owe us right now?', STEVEN);
  assert.match(text, /^\*Outstanding at 2026-09-30:\* \$198,753\.25$/m);
  assert.match(text, /^From signed rule QR-005 \(reviewed query\)\.$/m);
});

const zoneRows = (text) => [...text.matchAll(/^([a-z]+)\s+\| [^|]+\| ([\d,]+)$/gm)].map((m) => Number(m[2].replace(/,/g, '')));

test('demo 5: active plans by zone: five rows summing to 815, from QR-006, and composed from QR-001 and QR-006', async (t) => {
  const signed = await askV1(t, rule('QR-006', {}, 'Active plans by zone', { unit: 'count' }), 'How many plans are active today, by zone?');
  assert.deepEqual(zoneRows(signed.text).length, 5, signed.text);
  assert.equal(zoneRows(signed.text).reduce((a, b) => a + b, 0), 815);
  assert.match(signed.text, /^From signed rule QR-006 \(reviewed query\)\.$/m);
  const composed = await askV1(t, {
    covered: true,
    rule_ids: ['QR-001', 'QR-006'],
    path: 'composed',
    label: 'Active plans by zone',
    unit: 'count',
    sql: [
      "WITH meta AS (SELECT CAST(m.value AS DATE) AS as_of FROM fixture_meta m WHERE m.key = 'as_of')",
      'SELECT c.zone_id, COUNT(pl.plan_id) AS active_plans',
      'FROM plans pl JOIN properties p ON p.property_id = pl.property_id JOIN clients c ON c.client_id = p.client_id CROSS JOIN meta',
      'WHERE pl.start_date <= meta.as_of AND (pl.end_date IS NULL OR pl.end_date >= meta.as_of)',
      'GROUP BY c.zone_id ORDER BY c.zone_id',
    ].join('\n'),
  }, 'How many plans are active today, by zone?');
  const rows = [...composed.text.matchAll(/^([a-z]+)\s+\| ([\d,]+)$/gm)].map((m) => Number(m[2]));
  assert.equal(rows.length, 5, composed.text);
  assert.equal(rows.reduce((a, b) => a + b, 0), 815);
  assert.match(composed.text, /^Composed from QR-001 and QR-006 \(AI-written, checked\); not itself a signed rule\.$/m);
});

test('the hidden-column demo question: the refusal text, and the question queued with no figure', async (t) => {
  const question = 'List the clients with the highest unpaid balance and their emails.';
  const { text, queue } = await askV1(t, {
    covered: true, rule_ids: ['QR-005'], path: 'composed', label: 'Unpaid by client', unit: 'cents', sql: 'SELECT c.client_id, c.email FROM clients c',
  }, question);
  assert.match(text, /^The data and rules are ready, but no signed query rule covers that yet, so I won't guess\. I've noted the question for the team\. Press Request a tool if you need it sooner\.$/);
  assert.deepEqual((await queue.list()).map((e) => [e.reason, e.question]), [['hidden_column', question]]);
});

test('the writer\'s prompt on Brightside holds no truth figure: not 815, 814, 35018640, 36402350 or 19875325', async (t) => {
  const { model } = await askV1(t, rule('QR-001', {}, 'Plans active today', { unit: 'count' }), 'How many plans are active today?');
  const sent = JSON.stringify(model.calls);
  for (const figure of ['815', '814', '35018640', '36402350', '19875325', '35,018,640', '19,875,325']) assert.ok(!sent.includes(figure), figure);
  assert.ok(!sent.includes('<client_context file='), 'no org.md or data.md prose: the writer\'s prompt is never the hub\'s');
  assert.ok(!sent.includes('<added_context'), 'no notes');
});
