'use strict';

// Story 19.6 (plan brightside-v1, D11): query rules, the pure half
// (kit/lib/query-rules), the context prompt that strips them
// (kit/runtime/llm/context) and the signed count Data sources shows
// (kit/runtime/knowledge/readiness, kit/runtime/archetypes/data-sources).
// Every rule here is made up for the test; none is a client's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const qr = require('../../kit/lib/query-rules');
const { parseTruths } = require('../../kit/lib/truths');
const { stripContext } = require('../../kit/runtime/llm/context');
const { readiness, createRulesReader } = require('../../kit/runtime/knowledge/readiness');
const dataSources = require('../../kit/runtime/archetypes/data-sources');

// A valid metric rule, as YAML-ready data. over: fields to replace (undefined deletes).
function metric(over = {}) {
  const base = {
    id: 'QR-001',
    kind: 'metric',
    metric: 'MET-001',
    question_patterns: ['revenue in <month>'],
    definition: 'Revenue of the shops opened in the month.',
    sql: 'SELECT SUM(s.revenue_cents) AS cents FROM shops s WHERE s.opened_on >= CAST($from AS DATE)',
    params: { from: { type: 'date' } },
    grain: 'one row, one number',
    unit: 'cents',
    reads: { shops: ['revenue_cents', 'opened_on'] },
    check: { truth: 'shop-revenue', params: { from: '2026-01-01' } },
    owner: 'Ada Owner',
    status: 'approved',
    signed_off: '2026-10-31',
    signed_off_by: 'Ada Owner',
  };
  const out = { ...base, ...over };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete out[k];
  return out;
}
const traps = (over = {}) => ({
  id: 'QR-000', kind: 'traps', traps: ['never join payments to lines'], owner: 'Ada Owner', status: 'approved', signed_off: '2026-10-31', signed_off_by: 'Ada Owner', ...over,
});

const block = (data) => `\`\`\`query-rule\n${YAML.stringify(data)}\`\`\`\n`;
const doc = (...blocks) => `# Data canon\n\n## Query rules\n\n${blocks.join('\n')}`;
const problemsOf = (data) => qr.validate(data).problems;

// --- the block format and its refusals (D11) ------------------------------------------

test('a complete metric rule and a traps entry are valid', () => {
  assert.deepEqual(problemsOf(metric()), []);
  assert.deepEqual(problemsOf(traps()), []);
  const { rule } = qr.validate(metric());
  assert.equal(rule.id, 'QR-001');
  assert.deepEqual(rule.params, { from: { type: 'date' } });
  assert.deepEqual(rule.reads, { shops: ['revenue_cents', 'opened_on'] });
  assert.equal(rule.check.truth, 'shop-revenue');
});

test('every required field is required, by kind', () => {
  for (const k of ['id', 'kind', 'owner', 'status', 'signed_off', 'signed_off_by', 'metric', 'question_patterns', 'definition', 'sql', 'params', 'grain', 'unit', 'reads', 'check']) {
    assert.ok(problemsOf(metric({ [k]: undefined })).some((p) => p.includes(`missing ${k}`) || (k === 'kind' && p.startsWith('kind'))), k);
  }
  for (const k of ['traps', 'owner', 'status', 'signed_off', 'signed_off_by']) {
    const data = traps();
    delete data[k];
    assert.ok(problemsOf(data).some((p) => p.includes(`missing ${k}`)), k);
  }
});

test('unknown keys are refused, in the rule, a param and the check', () => {
  assert.ok(problemsOf(metric({ note: 'x' })).includes('unknown key "note"'));
  assert.ok(problemsOf(traps({ sql: 'SELECT 1' })).includes('unknown key "sql"'), 'a traps entry has no SQL');
  assert.ok(problemsOf(metric({ params: { from: { type: 'date', default: 'x' } } })).some((p) => p.includes('unknown key "default"')));
  assert.ok(problemsOf(metric({ check: { truth: 'shop-revenue', params: { from: '2026-01-01' }, note: 1 } })).some((p) => p.includes('check: unknown key "note"')));
});

test('ids, kinds, statuses, units and param types are checked', () => {
  assert.ok(problemsOf(metric({ id: 'QR-1' })).some((p) => p.startsWith('id must be QR-NNN')));
  assert.ok(problemsOf(metric({ kind: 'report' })).some((p) => p.startsWith('kind must be')));
  assert.ok(problemsOf(metric({ status: 'signed' })).some((p) => p.startsWith('status must be')));
  assert.ok(problemsOf(metric({ unit: 'dollars' })).some((p) => p.startsWith('unit must be')));
  assert.ok(problemsOf(metric({ params: { from: { type: 'string' } } })).some((p) => p.includes('type must be one of')));
  assert.ok(problemsOf(metric({ params: { from: { type: 'enum' } } })).some((p) => p.includes('an enum needs values')));
  assert.ok(problemsOf(metric({ params: { from: { type: 'date', values: ['a'] } } })).some((p) => p.includes('only an enum has values')));
});

test('sign-off: an approved rule needs a date and a name; the two agree', () => {
  assert.ok(problemsOf(metric({ signed_off: 'pending', signed_off_by: 'pending' })).some((p) => p.startsWith('an approved rule needs')));
  assert.deepEqual(problemsOf(metric({ status: 'draft', signed_off: 'pending', signed_off_by: 'pending' })), []);
  assert.ok(problemsOf(metric({ signed_off_by: 'pending' })).some((p) => p.startsWith('signed_off is a date')));
  assert.ok(problemsOf(metric({ status: 'draft', signed_off: 'pending' })).some((p) => p.startsWith('signed_off_by names a signer')));
  assert.ok(problemsOf(metric({ signed_off: '2026-02-30' })).some((p) => p.startsWith('signed_off must be')));
});

test('the SQL\'s $placeholders and params agree; positional parameters are refused', () => {
  assert.ok(problemsOf(metric({ params: {} , check: { truth: 'shop-revenue', params: {} } })).some((p) => p.includes('$from, which params does not declare')));
  assert.ok(problemsOf(metric({ params: { from: { type: 'date' }, to: { type: 'date' } }, check: { truth: 'shop-revenue', params: { from: '2026-01-01', to: '2026-02-01' } } })).some((p) => p.includes('param to is not used')));
  assert.ok(problemsOf(metric({ sql: 'SELECT SUM(s.revenue_cents) FROM shops s WHERE s.opened_on >= $1', params: {}, check: { truth: 'shop-revenue', params: {} } })).some((p) => p.includes('by position')));
  assert.deepEqual([...qr.placeholders("SELECT '$no' AS a, $yes -- $nor\n /* $neither */")], ['yes']);
});

test('the check names exactly one of truth or expect, and gives every parameter a typed value', () => {
  assert.ok(problemsOf(metric({ check: { params: { from: '2026-01-01' } } })).some((p) => p.includes('exactly one of truth')));
  assert.ok(problemsOf(metric({ check: { truth: 'x', expect: 1, params: { from: '2026-01-01' } } })).some((p) => p.includes('exactly one of truth')));
  assert.ok(problemsOf(metric({ check: { truth: 'shop-revenue', params: {} } })).some((p) => p.includes('no value for from')));
  assert.ok(problemsOf(metric({ check: { truth: 'shop-revenue', params: { from: 'January' } } })).some((p) => p.includes('real ISO date')));
  assert.ok(problemsOf(metric({ check: { truth: 'shop-revenue', params: { from: '2026-01-01', extra: 1 } } })).some((p) => p.includes('not a declared parameter')));
  assert.ok(problemsOf(metric({ check: { truth: 'shop-revenue', tolerance: 1, params: { from: '2026-01-01' } } })).some((p) => p.includes('goes with expect only')));
  assert.deepEqual(problemsOf(metric({ check: { expect: 5, tolerance: '1%', params: { from: '2026-01-01' }, rows: 2, sum: 'cents' } })), []);
  assert.ok(problemsOf(metric({ check: { expect: 5, params: { from: '2026-01-01' }, rows: 0 } })).some((p) => p.startsWith('check.rows')));
});

test('parameter values by type', () => {
  assert.equal(qr.paramValueProblem({ type: 'date' }, '2026-09-01'), null);
  assert.ok(qr.paramValueProblem({ type: 'date' }, '2026-13-01'));
  assert.equal(qr.paramValueProblem({ type: 'integer' }, 4), null);
  assert.ok(qr.paramValueProblem({ type: 'integer' }, '4'));
  assert.equal(qr.paramValueProblem({ type: 'zone' }, 'north'), null);
  assert.ok(qr.paramValueProblem({ type: 'zone' }, "north' OR 1=1"));
  assert.equal(qr.paramValueProblem({ type: 'enum', values: ['a', 'b'] }, 'b'), null);
  assert.ok(qr.paramValueProblem({ type: 'enum', values: ['a', 'b'] }, 'c'));
});

test('parseRules: blocks under "## Query rules" only, comments skipped, duplicates flagged', () => {
  const text = [
    '## Known truths', '', block(metric({ id: 'QR-009' })),
    '## Query rules', '', '<!--', block(metric({ id: 'QR-008' })), '-->', '',
    block(traps()), block(metric()), block(metric()), '```query-rule', 'id: [', '```', '',
    '## Deprecated sources', '', block(metric({ id: 'QR-007' })),
  ].join('\n');
  const entries = qr.parseRules(text);
  assert.deepEqual(entries.map((e) => e.id), ['QR-000', 'QR-001', 'block-3', 'block-4']);
  assert.ok(entries[2].problems.includes('duplicate id "QR-001"'));
  assert.ok(entries[3].problems[0].startsWith('block is not valid YAML'));
  assert.deepEqual(qr.parseRules('## Query rules\n\n```query-rule\nid: QR-001\n').map((e) => e.problems), [['block is not closed (no closing ```)']]);
});

// --- the allow-list ----------------------------------------------------------------------

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-qr-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the allow-list: the profile\'s ask.tables wins, else ask-tables.yml, else none (fail closed)', (t) => {
  const dir = tmp(t);
  assert.match(qr.allowListFor({}, dir).problem, /no allow-list/);
  assert.equal(qr.allowListFor({}, dir).tables, null);
  fs.writeFileSync(path.join(dir, 'ask-tables.yml'), 'tables:\n  shops: [shop_id, opened_on]\n');
  assert.deepEqual(qr.allowListFor({}, dir), { tables: { shops: ['shop_id', 'opened_on'] }, problem: null, source: 'ask-tables.yml' });
  const fromProfile = qr.allowListFor({ ask: { tables: { regions: ['region_id'] } } }, dir);
  assert.deepEqual(fromProfile.tables, { regions: ['region_id'] });
  assert.equal(fromProfile.source, 'profile ask.tables');
  fs.writeFileSync(path.join(dir, 'ask-tables.yml'), 'tables:\n  shops: [shop_id]\nextra: 1\n');
  assert.equal(qr.allowListFor({}, dir).tables, null);
  fs.writeFileSync(path.join(dir, 'ask-tables.yml'), 'tables:\n  Shops: [shop_id]\n');
  assert.equal(qr.allowListFor({}, dir).tables, null);
});

test('reads outside the allow-list are named, table and column', () => {
  const { rule } = qr.validate(metric({ reads: { shops: ['revenue_cents', 'opened_on'], staff: ['name'] } }));
  assert.deepEqual(qr.readsOutside(rule, { shops: ['opened_on'] }), [
    'reads shops.revenue_cents, which the allow-list does not allow',
    'reads table staff, which the allow-list does not allow',
  ]);
});

// --- the figure and the target -------------------------------------------------------------

test('figureOf: one row and one number by default; sum and rows when set', () => {
  const one = qr.validate(metric()).rule;
  assert.deepEqual(qr.figureOf(one, [{ cents: '9007' }]), { value: 9007 });
  assert.match(qr.figureOf(one, [{ cents: '1' }, { cents: '2' }]).error, /expected 1 row/);
  assert.match(qr.figureOf(one, [{ a: 1, b: 2 }]).error, /expected 1 column/);
  assert.match(qr.figureOf(one, [{ cents: null }]).error, /not a number/);
  assert.match(qr.figureOf(one, [{ cents: 'north' }]).error, /not a number/);
  const summed = qr.validate(metric({ check: { truth: 'shop-revenue', params: { from: '2026-01-01' }, rows: 2, sum: 'n' } })).rule;
  assert.deepEqual(qr.figureOf(summed, [{ zone: 'a', n: '3' }, { zone: 'b', n: '4' }]), { value: 7 });
  assert.match(qr.figureOf(summed, [{ zone: 'a', n: '3' }]).error, /expected 2 rows, got 1/);
  assert.match(qr.figureOf(summed, [{ zone: 'a', m: '3' }, { zone: 'b', m: '4' }]).error, /no column n/);
});

test('targetOf: a linked truth must be in data.md, valid and signed off; a pending one never passes', () => {
  const truths = parseTruths([
    '## Known truths', '',
    '```truth', 'id: shop-revenue', 'statement: x', 'run: [node, x.js]', 'expect: 100', 'tolerance: 2', 'owner: Ada Owner', 'signed_off: 2026-10-01', '```',
    '```truth', 'id: pending-one', 'statement: x', 'run: [node, x.js]', 'expect: 100', 'owner: Ada Owner', 'signed_off: pending', '```',
  ].join('\n'));
  const rule = (truth) => qr.validate(metric({ check: { truth, params: { from: '2026-01-01' } } })).rule;
  const target = qr.targetOf(rule('shop-revenue'), truths);
  assert.equal(target.expect, 100);
  assert.equal(qr.judgeFigure(101, target).outcome, 'pass');
  assert.equal(qr.judgeFigure(103, target).outcome, 'fail');
  assert.match(qr.targetOf(rule('pending-one'), truths).error, /not signed off/);
  assert.match(qr.targetOf(rule('missing'), truths).error, /not in data.md/);
  const stated = qr.validate(metric({ check: { expect: 50, params: { from: '2026-01-01' } } })).rule;
  assert.equal(qr.judgeFigure(50, qr.targetOf(stated, truths)).outcome, 'pass');
  assert.equal(qr.judgeFigure(5000, qr.targetOf(stated, truths)).outcome, 'fail', 'cents against dollars is a mismatch');
});

// --- the verify checks and "signed" ----------------------------------------------------------

test('verify checks: one per rule that is not retired; a malformed one fails without running', () => {
  const entries = qr.parseRules(doc(block(traps()), block(metric()), block(metric({ id: 'QR-002', status: 'retired' })), block(metric({ id: 'QR-003', unit: 'x' }))));
  const checks = qr.queryRuleChecks(entries);
  assert.deepEqual(checks.map((c) => c.id), ['query-rule:QR-000', 'query-rule:QR-001', 'query-rule:QR-003']);
  assert.deepEqual(checks[1].run, ['node', 'kit/query-rules/cli.js', '--check', 'QR-001']);
  assert.match(checks[2].problem, /unit must be one of/);
});

test('signed means valid, approved, dated, named and its last check passed', () => {
  const entries = qr.parseRules(doc(
    block(traps()),
    block(metric()),
    block(metric({ id: 'QR-002', status: 'draft', signed_off: 'pending', signed_off_by: 'pending' })),
    block(metric({ id: 'QR-003' })),
    block(metric({ id: 'QR-004', unit: 'x' })),
  ));
  const last = {
    at: '2026-11-01T00:00:00Z',
    results: ['QR-000', 'QR-001', 'QR-002', 'QR-004'].map((id) => ({ id: `query-rule:${id}`, outcome: 'pass' }))
      .concat([{ id: 'query-rule:QR-003', outcome: 'fail' }]),
  };
  assert.deepEqual(entries.map((e) => qr.isSigned(e, last)), [true, true, false, false, false]);
  assert.equal(qr.countSigned(entries, last), 2);
  assert.equal(qr.countSigned(entries, null), 0, 'never checked on this machine: none signed');
});

// --- --new: the scaffold ------------------------------------------------------------------

test('scaffold: a draft with the question as its pattern, which fails until SQLsmith fills it', () => {
  const b = qr.scaffold('QR-007', 'Which zone\nbilled the most?');
  const [entry] = qr.parseRules(doc(b));
  assert.equal(entry.id, 'QR-007');
  assert.equal(entry.rule.status, 'draft');
  assert.equal(entry.rule.signedOff, 'pending');
  assert.deepEqual(entry.rule.questionPatterns, ['Which zone billed the most?']);
  assert.ok(entry.problems.length > 0, 'a TODO draft is not valid');
  assert.throws(() => qr.scaffold('QR-7', 'x'), TypeError);
});

test('insertBlock: at the end of the Query rules section, before the next section; creates it when absent', () => {
  const b = qr.scaffold('QR-002', 'q');
  const text = `# D\n\n## Query rules\n\nIntro.\n\n${block(traps())}\n## Deprecated sources\n\nNone.\n`;
  const out = qr.insertBlock(text, b);
  assert.ok(out.indexOf('QR-002') > out.indexOf('QR-000') && out.indexOf('QR-002') < out.indexOf('## Deprecated sources'));
  assert.deepEqual(qr.parseRules(out).map((e) => e.id), ['QR-000', 'QR-002']);
  const created = qr.insertBlock('# D\n\n## Known truths\n', b);
  assert.deepEqual(qr.parseRules(created).map((e) => e.id), ['QR-002']);
  // A "## " line inside a fence does not end the section.
  const fenced = `## Query rules\n\n\`\`\`text\n## not a heading\n\`\`\`\n`;
  assert.ok(qr.insertBlock(fenced, b).endsWith(b));
});

// --- the context prompt never holds a rule -----------------------------------------------

test('the context prompt strips query-rule blocks, as it strips truths', () => {
  const text = `---\nowner: x\n---\n# Data\n\nKEEP_PROSE.\n\n## Query rules\n\n${block(metric({ definition: 'RULE_DEFINITION_NEVER_IN_PROMPT' }))}\n~~~ query-rule\nsql: TILDE_RULE_NEVER\n~~~\n\n\`\`\`\`md\n\`\`\`query-rule\nNESTED_RULE_NEVER\n\`\`\`\n\`\`\`\`\n`;
  const out = stripContext(text);
  assert.match(out, /KEEP_PROSE/);
  for (const s of ['RULE_DEFINITION_NEVER_IN_PROMPT', 'revenue_cents', 'TILDE_RULE_NEVER', 'NESTED_RULE_NEVER', 'shop-revenue']) assert.ok(!out.includes(s), s);
  assert.equal(stripContext('KEEP\n```query-rule\nUNCLOSED_NEVER\n'), 'KEEP', 'an unclosed rule fence drops the rest');
});

// --- Data sources: "Query rules signed: N" ------------------------------------------------

test('readiness counts signed query rules (a number only) and Data sources shows it', (t) => {
  const root = tmp(t);
  const ctx = path.join(root, 'context');
  fs.mkdirSync(ctx);
  fs.writeFileSync(path.join(root, 'profile.yml'), 'schema_version: 1\n');
  const front = '---\nowner: Ada Owner\nsigned_off: 2026-10-20\nsigned_off_by: Ada Owner\nupdated: 2026-10-20\n---\n';
  fs.writeFileSync(path.join(ctx, 'data.md'), `${front}# Data\n\n${doc(block(traps()), block(metric({ definition: 'RULE_TEXT_NEVER_SHOWN' })), block(metric({ id: 'QR-002', status: 'draft', signed_off: 'pending', signed_off_by: 'pending' })))}`);
  fs.writeFileSync(path.join(ctx, 'guardrails.md'), `${front}# Guardrails\n`);
  const last = { at: '2026-11-01T00:00:00.000Z', results: ['QR-000', 'QR-001', 'QR-002'].map((id) => ({ id: `query-rule:${id}`, outcome: 'pass' })) };
  const rules = createRulesReader({ profile: {}, profilePath: path.join(root, 'profile.yml'), readLast: () => last });
  const view = { id: 'hub', sees: ['rules'], rules: true };
  const ready = readiness(view, { rules });
  assert.equal(ready.detail.rules.signedQueryRules, 2, 'QR-002 is a draft');
  assert.ok(!JSON.stringify(ready.detail).includes('RULE_TEXT_NEVER_SHOWN'));
  assert.ok(!JSON.stringify(ready.detail).includes('QR-001'));
  const { text, blocks } = dataSources.render({ ready });
  const shown = JSON.stringify(blocks) + text;
  assert.match(shown, /Query rules signed: 2/);
  // Never checked on this machine: none signed.
  const unchecked = createRulesReader({ profile: {}, profilePath: path.join(root, 'profile.yml'), readLast: () => null });
  assert.match(JSON.stringify(dataSources.render({ ready: readiness(view, { rules: unchecked }) }).blocks), /Query rules signed: 0/);
  // A hub that doesn't see rules reads nothing.
  assert.equal(readiness({ id: 'hub', sees: [], rules: false }, { rules }).detail.rules.signedQueryRules, 0);
});
