'use strict';

// Plan brightside-v1, Story 19.6 (D11): Brightside's seven seed query rules,
// QR-000 to QR-006, in profiles/brightside/context/data.md. Each restates a
// signed MET rule or Terminology term, is linked to a signed truth, reads only
// inside the allow-list (the profile's ask block, Story 19.7), and was
// signed by the plan's gate approval (Ely Potter, 2026-10-31, gate item 8).
// On a temporary build of the fixture every rule's verify check passes, and
// QR-006's five zones sum to QR-001's 815.
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
const { loadRules, allowListFor, readsOutside } = require('../../../kit/lib/query-rules');
const { loadTruths } = require('../../../kit/lib/truths');
const { main } = require('../../../kit/query-rules/cli');
const { loadProfile } = require('../../../kit/lib/profile');
const { createAskData } = require('../../../kit/runtime/data/ask');

const ROOT = path.join(__dirname, '../../..');
const PROFILE = path.join(ROOT, 'profiles/brightside/profile.yml');
const CONTEXT = path.join(ROOT, 'profiles/brightside/context');
const IDS = ['QR-000', 'QR-001', 'QR-002', 'QR-003', 'QR-004', 'QR-005', 'QR-006'];
const LINKS = {
  'QR-001': ['MET-001', 'active-plans-at-as-of'],
  'QR-002': ['Client (Terminology)', 'clients-total'],
  'QR-003': ['MET-003', 'paid-revenue-2026-09'],
  'QR-004': ['MET-004', 'billed-revenue-2026-09'],
  'QR-005': ['MET-005', 'outstanding-at-as-of'],
  'QR-006': ['MET-001', 'active-plans-at-as-of'],
};

let tmp;
let FIXTURE;
before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-qr-brightside-')));
  FIXTURE = path.join(tmp, 'brightside.duckdb');
  await build({ fixtureDir: path.join(ROOT, 'examples/brightside/fixture'), out: FIXTURE });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const entries = loadRules(CONTEXT);

test('the seven seed rules are valid and signed by the gate approval: Ely Potter, 2026-10-31', () => {
  assert.deepEqual(entries.map((e) => e.id), IDS);
  for (const e of entries) {
    assert.deepEqual(e.problems, [], e.id);
    assert.equal(e.rule.status, 'approved', e.id);
    assert.equal(e.rule.signedOff, '2026-10-31', e.id);
    assert.equal(e.rule.signedOffBy, 'Ely Potter', e.id);
    assert.equal(e.rule.owner, 'Ely Potter', e.id);
  }
});

test('QR-000 holds the six traps (D10, SQLsmith P3-15)', () => {
  const [qr0] = entries;
  assert.equal(qr0.rule.kind, 'traps');
  assert.equal(qr0.rule.traps.length, 6);
  for (const s of ['scheduled_visits', "status = 'completed'", 'COUNT(DISTINCT client_id)', 'invoice_lines', 'per invoice first', 'as_of']) {
    assert.ok(qr0.rule.traps.some((t) => t.includes(s)), s);
  }
});

test('each metric rule restates its MET rule and is checked against a signed truth', () => {
  const truths = loadTruths(CONTEXT);
  for (const e of entries.slice(1)) {
    const [metric, truth] = LINKS[e.id];
    assert.equal(e.rule.metric, metric, e.id);
    assert.equal(e.rule.check.truth, truth, e.id);
    const t = truths.find((x) => x.id === truth);
    assert.ok(t && t.truth.signedOff !== 'pending', `${truth} is signed off`);
  }
  assert.equal(entries[6].rule.check.rows, 5);
  assert.equal(entries[6].rule.check.sum, 'active_plans');
  assert.ok(!/status\s*=\s*'active'/.test(entries[1].rule.sql), 'QR-001 never uses status = active');
});

test('the allow-list is the profile\'s ask block, and every rule reads inside it', () => {
  const allow = allowListFor(loadProfile(PROFILE));
  assert.equal(allow.source, 'profile ask.tables');
  assert.ok(!fs.existsSync(path.join(CONTEXT, 'ask-tables.yml')), 'Story 19.7 deleted the bridge file');
  for (const e of entries.slice(1)) assert.deepEqual(readsOutside(e.rule, allow.tables), [], e.id);
});

test('on the fixture every seed rule\'s verify check passes; QR-006\'s five zones sum to 815', async () => {
  const env = { APLABS_GOVERNING_PROFILE: PROFILE, APLABS_DATA_PATH: FIXTURE };
  for (const id of IDS) {
    const out = [];
    const code = await main(['--check', id, '--rows'], { env, cwd: ROOT, out: (l) => out.push(l), err: (l) => out.push(l) });
    assert.equal(code, 0, `${id}: ${out.join('\n')}`);
    if (id === 'QR-006') {
      const rows = out.slice(1).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      assert.equal(rows.length, 5);
      assert.equal(rows.reduce((n, r) => n + Number(r.active_plans), 0), 815);
      // --rows prints aggregates only: the zone id and name are hidden.
      for (const r of rows) assert.deepEqual([r.zone_id, r.zone], ['[hidden]', '[hidden]']);
    }
  }
});

// Story 19.7: boot's check passes on the fixture (every allowed table and column
// exists, no bare-name clash), and Ask's connection answers the demo's paid revenue
// question with the reviewed figure, $350,186.40 (QR-003's SQL with its check params).
test('Ask\'s connection opens on the fixture and runs QR-003 to the signed figure', async () => {
  const profile = loadProfile(PROFILE);
  const ask = createAskData({ file: FIXTURE, profile });
  try {
    await ask.open();
    const qr3 = entries.find((e) => e.id === 'QR-003').rule;
    const r = await ask.run(qr3.sql, qr3.check.params, { declared: Object.keys(qr3.params) });
    assert.deepEqual(r.rows, [{ paid_cents: '35018640' }]);
    assert.deepEqual(r.tables, ['payments']);
  } finally {
    ask.close();
  }
});
