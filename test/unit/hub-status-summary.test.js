'use strict';

// Plan hub-status-menu, Story 17.1 (D3, D4, D8, architect P2-4, P2-6,
// P3-14): the approved-rule count and the bounded reads in the rules reader
// (kit/runtime/knowledge/readiness), the knowledge store's list() on an
// unreadable folder (kit/runtime/knowledge/store), and the setup summary
// (kit/runtime/knowledge/summary), one test per stage fixture. Fixtures
// only: test/fixtures/runtime/status-menu.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadProfile } = require('../../kit/lib/profile');
const { loadRegistry } = require('../../kit/runtime/registry');
const {
  readiness, createRulesReader, countApprovedRules, MAX_FILE_BYTES,
} = require('../../kit/runtime/knowledge/readiness');
const { summarize, STEPS } = require('../../kit/runtime/knowledge/summary');
const { createKnowledgeStore } = require('../../kit/runtime/knowledge/store');
const dataSources = require('../../kit/runtime/archetypes/data-sources');

const FIX = path.join(__dirname, '../fixtures/runtime/status-menu');
const PROFILE_PATH = path.join(FIX, 'profile.yml');
const profile = loadProfile(PROFILE_PATH);
const { registry } = loadRegistry({ appDir: path.join(FIX, 'app'), profile });
const hubOf = (id) => registry.hubs.find((h) => h.id === id);
const TEMPLATE_GUARDRAILS = path.join(__dirname, '../../kit/templates/context/guardrails.md');

function tmpDir(t, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aplabs-${name}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A copy of the fixture's profile and client files, edited. Returns the
// profile path.
function copied(t, edit = () => {}) {
  const dir = tmpDir(t, 'status');
  fs.cpSync(path.join(FIX, 'context'), path.join(dir, 'context'), { recursive: true });
  fs.copyFileSync(PROFILE_PATH, path.join(dir, 'profile.yml'));
  edit(path.join(dir, 'context'));
  return path.join(dir, 'profile.yml');
}

const reader = (profilePath = PROFILE_PATH, opts = {}) => createRulesReader({
  profile, profilePath, readLast: () => null, ...opts,
});
const runner = (available = true) => {
  const calls = { describe: 0 };
  return {
    calls,
    run: async () => [],
    describe: () => { calls.describe += 1; return { source: 'local fixture', label: 'tiny.duckdb', available }; },
  };
};
const viewOf = (hubId, data = runner()) => {
  const hub = hubOf(hubId);
  return {
    id: hub.id, sees: hub.sees, data: hub.sees.includes('data') ? data : null, rules: hub.sees.includes('rules'),
  };
};
const notes = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i), title: `RULE_TEXT_NEVER_SHOWN ${i}` }));

function summaryOf(hubId, { entries = [], entriesProblem = false, rules = reader(), data } = {}) {
  const view = viewOf(hubId, data);
  return summarize({
    ready: readiness(view, { rules }), entries, entriesProblem, sees: view.sees,
  });
}

// --- the approved-rule count (D3) ----------------------------------------------------

test('approved rules: only "### <ID>: <name>" cards whose status line is exactly "approved"', () => {
  const r = readiness(viewOf('full'), { rules: reader() });
  // GRD-001 and GRD-005. Not the commented template card, the draft that
  // mentions approval, the card with no status, the card in a code block, or
  // the challenged card whose prose says "status: approved".
  assert.equal(r.detail.rules.approvedRules, 2);
});

test('approved rules: the template\'s commented card is not counted', () => {
  assert.equal(countApprovedRules(fs.readFileSync(TEMPLATE_GUARDRAILS, 'utf8')), 0);
});

test('approved rules: each case on its own', () => {
  const card = (status) => `### GRD-001: A rule\n- rule: x\n${status === null ? '' : `- status: ${status}\n`}`;
  assert.equal(countApprovedRules(card('approved')), 1);
  assert.equal(countApprovedRules(card('  approved  ')), 1, 'surrounding spaces are not part of the status');
  assert.equal(countApprovedRules(card('draft (approved 2026-10-25; a line was added since)')), 0);
  assert.equal(countApprovedRules(card('Approved')), 0, 'exactly "approved"');
  assert.equal(countApprovedRules(card('approved, pending a change')), 0);
  assert.equal(countApprovedRules(card(null)), 0, 'no status line');
  assert.equal(countApprovedRules(`<!-- ${card('approved')} -->`), 0, 'a one-line comment');
  assert.equal(countApprovedRules(`<!--\n${card('approved')}-->\n`), 0, 'a comment over several lines');
  assert.equal(countApprovedRules(`\`\`\`\n${card('approved')}\`\`\`\n`), 0, 'a fenced code block');
  assert.equal(countApprovedRules(`~~~md\n${card('approved')}~~~\n`), 0, 'a tilde fence');
  assert.equal(countApprovedRules(`\`\`\`\`\n\`\`\`\n${card('approved')}\`\`\`\`\n`), 0, 'a shorter fence inside does not close it');
  assert.equal(countApprovedRules(`\`\`\`\n${card('approved')}\`\`\`\n${card('approved')}`), 1, 'the card after the fence counts');
  assert.equal(countApprovedRules(`<!-- a note --> ${card('approved')}`), 0, 'a heading must start the line');
  assert.equal(countApprovedRules(`${card('draft')}- status: approved\n`), 0, 'only the first status line');
  assert.equal(countApprovedRules(`### GRD-001: A rule\n## Next section\n- status: approved\n`), 0, 'a status after the next heading is not the card\'s');
  assert.equal(countApprovedRules(`## GRD-001: Not a card heading\n- status: approved\n`), 0);
  assert.equal(countApprovedRules(`${card('approved')}\n${card('approved')}`.replace(/\n/g, '\r\n')), 2, 'CRLF');
});

test('approved rules count only while guardrails.md is signed off, and only on a hub that sees rules', (t) => {
  const pending = copied(t, (dir) => {
    const f = path.join(dir, 'guardrails.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('signed_off: 2026-10-21', 'signed_off: pending'));
  });
  assert.equal(readiness(viewOf('full'), { rules: reader(pending) }).detail.rules.approvedRules, 0);
  assert.equal(readiness(viewOf('first-tool'), { rules: reader() }).detail.rules.approvedRules, 0);
  assert.equal(readiness(viewOf('blank'), { rules: reader() }).detail.rules.approvedRules, 0);
});

test('approved rules: an unreadable guardrails.md is 0 with problem set, as today', (t) => {
  const profilePath = copied(t, (dir) => {
    fs.rmSync(path.join(dir, 'guardrails.md'));
    fs.mkdirSync(path.join(dir, 'guardrails.md')); // reading it fails (EISDIR)
  });
  const r = readiness(viewOf('full'), { rules: reader(profilePath) });
  assert.equal(r.detail.rules.approvedRules, 0);
  assert.equal(r.detail.rules.problem, true);
  assert.ok(!JSON.stringify(r.detail).includes('EISDIR'));
});

test('no rule text reaches detail: a count only', () => {
  const r = readiness(viewOf('full'), { rules: reader() });
  const json = JSON.stringify(r.detail);
  for (const s of ['RULE_TEXT_NEVER_SHOWN', 'GRD-001', 'Read only', 'Writes only through approval']) assert.ok(!json.includes(s), s);
  assert.equal(typeof r.detail.rules.approvedRules, 'number');
});

// --- bounded reads (D8) --------------------------------------------------------------

const big = (head) => `${head}\n${'x'.repeat(MAX_FILE_BYTES)}\n`;

test('an oversized guardrails.md or data.md is not read: not set up, with problem set', (t) => {
  for (const file of ['guardrails.md', 'data.md']) {
    const profilePath = copied(t, (dir) => {
      const f = path.join(dir, file);
      fs.writeFileSync(f, big(fs.readFileSync(f, 'utf8')));
    });
    const spy = t.mock.method(fs, 'readFileSync');
    const r = readiness(viewOf('full'), { rules: reader(profilePath) });
    const opened = spy.mock.calls.map((c) => String(c.arguments[0]));
    spy.mock.restore();
    assert.ok(!opened.some((p) => p.endsWith(path.join('context', file))), `${file} was read`);
    assert.equal(r.rules, false, file);
    assert.equal(r.detail.rules.problem, true, file);
    const detail = r.detail.rules.files.find((f) => f.file === file);
    assert.deepEqual([detail.present, detail.signed], [true, false], file);
    if (file === 'data.md') assert.deepEqual(r.detail.rules.truths, []);
    if (file === 'guardrails.md') assert.equal(r.detail.rules.approvedRules, 0);
    // The summary then says it couldn't check.
    assert.equal(summarize({ ready: r, entries: [], sees: viewOf('full').sees }).problem, true, file);
  }
});

test('a file at exactly the bound is read', (t) => {
  const profilePath = copied(t, (dir) => {
    const f = path.join(dir, 'guardrails.md');
    const text = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, text + ' '.repeat(MAX_FILE_BYTES - Buffer.byteLength(text)));
  });
  const r = readiness(viewOf('full'), { rules: reader(profilePath) });
  assert.equal(r.detail.rules.problem, false);
  assert.equal(r.detail.rules.approvedRules, 2);
});

test('an oversized verify record is not read: no outcomes, problem set; a normal one is read (clock frozen)', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T12:00:00Z') });
  const profilePath = copied(t);
  const repo = path.dirname(profilePath);
  execFileSync('git', ['init', '-q', repo]);
  const gitDir = path.join(repo, '.git');
  const record = path.join(gitDir, 'aplabs', 'verify', 'last.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  const body = { at: '2026-10-31T08:00:00.000Z', results: [{ id: 'truth:active-people', outcome: 'pass' }] };
  fs.writeFileSync(record, JSON.stringify(body));
  const ok = readiness(viewOf('full'), { rules: createRulesReader({ profile, profilePath, now: () => Date.now() }) });
  assert.equal(ok.detail.rules.problem, false);
  assert.equal(ok.detail.rules.truths[0].last, 'pass');

  fs.writeFileSync(record, JSON.stringify({ ...body, pad: 'x'.repeat(MAX_FILE_BYTES) }));
  const over = readiness(viewOf('full'), { rules: createRulesReader({ profile, profilePath, now: () => Date.now() }) });
  assert.equal(over.detail.rules.problem, true);
  assert.deepEqual(over.detail.rules.truths.map((x) => x.last), [null, null]);
  assert.equal(over.detail.rules.checkedAt, null);
});

test('the reads on the full fixture finish well inside the 3-second window', () => {
  const r = reader();
  const start = process.hrtime.bigint();
  for (let i = 0; i < 20; i += 1) readiness(viewOf('full'), { rules: r });
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / 20;
  assert.ok(ms < 250, `one read took ${ms} ms`);
});

// --- the knowledge store's list() (architect P2-4) -----------------------------------

function quietLog() {
  const lines = [];
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

test('an unreadable hub folder gives a problem, never 0 notes; a missing one gives 0 notes', async (t) => {
  const varDir = tmpDir(t, 'notes');
  const store = createKnowledgeStore({ clientId: 'tiny', varDir, log: quietLog() });
  // Missing: no entries, no problem.
  const missing = await dataSources.entriesOf({ id: 'blank', knowledge: store.forHub('blank') }, quietLog());
  assert.deepEqual(missing, { entries: [], problem: false });
  assert.equal(summarize({ ready: readiness(viewOf('blank')), entries: missing.entries, entriesProblem: missing.problem, sees: [] }).counts.notes, 0);

  // There but can't be listed.
  const failing = {
    lstat: async () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); },
  };
  const broken = createKnowledgeStore({
    clientId: 'tiny', varDir, log: quietLog(), fs: failing,
  });
  await assert.rejects(broken.list('blank'), (err) => err.code === 'EACCES');
  const log = quietLog();
  const listed = await dataSources.entriesOf({ id: 'blank', knowledge: broken.forHub('blank') }, log);
  assert.deepEqual(listed, { entries: [], problem: true });
  assert.ok(log.lines.some((l) => l.msg === 'added context not listed' && l.fields.reason === 'EACCES'));
  const s = summarize({
    ready: readiness(viewOf('blank')), entries: listed.entries, entriesProblem: listed.problem, sees: [],
  });
  assert.equal(s.counts.notes, null);
  assert.equal(s.problem, true);
});

// --- the summary, one test per stage (D3, D4) ----------------------------------------

const stepsOf = (s) => s.steps.map((x) => [x.step, x.counted, x.done]);

test('blank (sees nothing, no notes): 0 of 1, then complete after one note; nothing read for sources, truths or rules', () => {
  const data = runner();
  const rules = { reads: 0, read() { this.reads += 1; return reader().read(); } };
  const s = summaryOf('blank', { data, rules });
  assert.deepEqual({ ...s.counts }, {
    notes: 0, sources: 0, truths: 0, rules: 0,
  });
  assert.deepEqual([s.done, s.of, s.problem], [0, 1, false]);
  assert.deepEqual(stepsOf(s), [['taught', true, false], ['data', false, false], ['truths', false, false], ['rules', false, false]]);
  const after = summaryOf('blank', { entries: notes(1), data, rules });
  assert.deepEqual([after.counts.notes, after.done, after.of], [1, 1, 1]);
  // The existing readiness guarantee: a hub that sees nothing reads nothing.
  assert.equal(data.calls.describe, 0);
  assert.equal(rules.reads, 0);
});

test('onboarded (sees context): taught with no notes; two notes count', () => {
  const s = summaryOf('onboarded');
  assert.deepEqual([s.counts.notes, s.done, s.of], [0, 1, 1]);
  const two = summaryOf('onboarded', { entries: notes(2) });
  assert.deepEqual({ ...two.counts }, {
    notes: 2, sources: 0, truths: 0, rules: 0,
  });
});

test('first tool (sees data only): 2 counted steps, 1 source when the runner is available', () => {
  const s = summaryOf('first-tool');
  assert.deepEqual(stepsOf(s), [['taught', true, false], ['data', true, true], ['truths', false, false], ['rules', false, false]]);
  assert.deepEqual([s.counts.sources, s.counts.truths, s.counts.rules, s.done, s.of], [1, 0, 0, 1, 2]);
  const off = summaryOf('first-tool', { data: runner(false) });
  assert.deepEqual([off.counts.sources, off.done, off.of], [0, 0, 2]);
});

test('full (sees context, data and rules): 4 counted steps; one signed-off truth and two approved rules', () => {
  const s = summaryOf('full', { entries: notes(3) });
  assert.deepEqual({ ...s.counts }, {
    notes: 3, sources: 1, truths: 1, rules: 2,
  });
  assert.deepEqual([s.done, s.of, s.problem], [4, 4, false]);
  assert.deepEqual(stepsOf(s), [['taught', true, true], ['data', true, true], ['truths', true, true], ['rules', true, true]]);
});

test('full with guardrails.md pending: 0 rules and step 4 not done; truths still count', (t) => {
  const pending = copied(t, (dir) => {
    const f = path.join(dir, 'guardrails.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('signed_off: 2026-10-21', 'signed_off: pending'));
  });
  const s = summaryOf('full', { rules: reader(pending) });
  assert.deepEqual([s.counts.truths, s.counts.rules, s.done, s.of], [1, 0, 3, 4]);
  assert.equal(s.steps.find((x) => x.step === 'rules').done, false);
});

test('the summary\'s truths and rules steps agree with readiness.rules (Ask and the menu agree)', (t) => {
  const pending = copied(t, (dir) => {
    const f = path.join(dir, 'data.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/signed_off: 2026-10-20\n```/, 'signed_off: pending\n```'));
  });
  for (const rules of [reader(), reader(pending)]) {
    const view = viewOf('full');
    const ready = readiness(view, { rules });
    const s = summarize({ ready, entries: [], sees: view.sees });
    const both = s.steps.filter((x) => x.step === 'truths' || x.step === 'rules').every((x) => x.done);
    assert.equal(both, ready.rules);
  }
});

test('an entries problem, an unreadable client file or a runner that throws sets problem', (t) => {
  assert.equal(summaryOf('blank', { entriesProblem: true }).problem, true);
  const broken = copied(t, (dir) => {
    fs.rmSync(path.join(dir, 'data.md'));
    fs.mkdirSync(path.join(dir, 'data.md'));
  });
  assert.equal(summaryOf('full', { rules: reader(broken) }).problem, true);
  const throwing = { describe: () => { throw new Error('x'); }, run: async () => [] };
  assert.equal(summaryOf('first-tool', { data: throwing }).problem, true);
});

test('the summary holds numbers and flags only, never a note, truth or rule', () => {
  const s = summaryOf('full', { entries: notes(2) });
  const json = JSON.stringify(s);
  for (const x of ['RULE_TEXT_NEVER_SHOWN', 'active-people', 'There are this many', 'Ada Owner', 'GRD-']) assert.ok(!json.includes(x), x);
  assert.deepEqual(Object.keys(s).sort(), ['counts', 'done', 'of', 'problem', 'steps']);
  assert.deepEqual([...STEPS], ['taught', 'data', 'truths', 'rules']);
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.counts) && Object.isFrozen(s.steps));
});

test('summarize needs readiness', () => {
  assert.throws(() => summarize({}), TypeError);
  assert.throws(() => summarize(), TypeError);
});
