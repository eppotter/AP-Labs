'use strict';

// Story 19.6 (plan brightside-v1, D11): the review queue
// (kit/runtime/knowledge/ask-queue), where Ask's declined data questions
// wait for SQLsmith. What is stored, its caps, its file modes, and that
// nothing but the five fields ever reaches a file or the log.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createAskQueue, REASONS, MAX_QUESTION_CHARS, MAX_ENTRIES,
} = require('../../kit/runtime/knowledge/ask-queue');

function varDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-askq-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recorder() {
  const lines = [];
  const at = (level) => (msg, fields = {}) => lines.push({ level, msg, fields });
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error') } };
}

const queueOf = (t, opts = {}) => {
  const dir = varDir(t);
  const rec = recorder();
  return { dir, ...rec, queue: createAskQueue({ clientId: 'tiny', varDir: dir, log: rec.log, ...opts }) };
};
const filesIn = (q) => fs.readdirSync(q.root).filter((n) => n.endsWith('.json'));

test('an entry is exactly { id, at, hub, reason, question }; a planted row, SQL, figure or person is never stored', async (t) => {
  const { queue, lines } = queueOf(t, { now: () => Date.parse('2026-11-01T10:00:00Z') });
  const question = 'Which clients owe the most? | 4412 | jo@example.com | 19875325 |';
  const entry = await queue.add({
    hub: 'brightside-v1',
    reason: 'no_rule',
    question,
    sql: 'SELECT SECRET_SQL_NEVER_STORED',
    rows: [{ client_id: 4412, email: 'ROW_EMAIL_NEVER_STORED@example.com' }],
    figure: 'FIGURE_NEVER_STORED',
    user: 'U0PERSONNEVER',
  });
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'hub', 'id', 'question', 'reason']);
  assert.match(entry.id, /^[0-9a-f]{16}$/);
  assert.equal(entry.at, '2026-11-01T10:00:00.000Z');
  const [file] = filesIn(queue);
  assert.equal(file, `${entry.id}.json`);
  const raw = fs.readFileSync(path.join(queue.root, file), 'utf8');
  assert.deepEqual(JSON.parse(raw), {
    id: entry.id, at: '2026-11-01T10:00:00.000Z', hub: 'brightside-v1', reason: 'no_rule', question,
  });
  for (const s of ['SECRET_SQL_NEVER_STORED', 'ROW_EMAIL_NEVER_STORED', 'FIGURE_NEVER_STORED', 'U0PERSONNEVER']) assert.ok(!raw.includes(s), s);
  // The log has the id, hub and reason only: never the question.
  assert.ok(!JSON.stringify(lines).includes('Which clients'));
  assert.deepEqual(lines.map((l) => l.fields), [{ id: entry.id, hub: 'brightside-v1', reason: 'no_rule' }]);
});

test('files are 0600 and folders 0700, under <var>/ask-queue/<client id>', async (t) => {
  const { queue, dir } = queueOf(t);
  await queue.add({ hub: 'h', reason: 'guard', question: 'q' });
  assert.equal(queue.root, path.join(dir, 'ask-queue', 'tiny'));
  assert.equal(fs.statSync(queue.root).mode & 0o777, 0o700);
  for (const f of filesIn(queue)) assert.equal(fs.statSync(path.join(queue.root, f)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(queue.root).filter((n) => !n.endsWith('.json')), [], 'no temporary file is left');
});

test('the question is one line and at most 500 characters', async (t) => {
  const { queue } = queueOf(t);
  const e = await queue.add({ hub: 'h', reason: 'hidden_column', question: `  line one\n\tline‮two ${'x'.repeat(600)}` });
  assert.ok(!/[\n\t‮]/.test(e.question));
  assert.equal([...e.question].length, MAX_QUESTION_CHARS);
  assert.ok(e.question.startsWith('line one line two'));
});

test('refusals: a bad hub, reason or question stores nothing', async (t) => {
  const { queue } = queueOf(t);
  await assert.rejects(queue.add({ hub: '../x', reason: 'no_rule', question: 'q' }), TypeError);
  await assert.rejects(queue.add({ hub: 'h', reason: 'other', question: 'q' }), TypeError);
  await assert.rejects(queue.add({ hub: 'h', reason: 'no_rule', question: '  \n ' }), TypeError);
  await assert.rejects(queue.add({ hub: 'h', reason: 'no_rule', question: 42 }), TypeError);
  assert.deepEqual(await queue.list(), []);
  assert.deepEqual(REASONS, ['no_rule', 'guard', 'hidden_column', 'no_key']);
  assert.throws(() => createAskQueue({ clientId: 'tiny', varDir: 'relative', log: recorder().log }), TypeError);
  await assert.rejects(queue.remove('../../etc'), TypeError);
});

test(`at most ${MAX_ENTRIES} entries: the oldest is dropped and logged by id`, async (t) => {
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const { queue, lines } = queueOf(t, { now: () => { clock += 1000; return clock; } });
  const first = await queue.add({ hub: 'h', reason: 'no_rule', question: 'question 0' });
  for (let i = 1; i < MAX_ENTRIES; i += 1) await queue.add({ hub: 'h', reason: 'no_rule', question: `question ${i}` });
  assert.equal((await queue.list()).length, MAX_ENTRIES);
  await queue.add({ hub: 'h', reason: 'no_rule', question: 'one more' });
  const held = await queue.list();
  assert.equal(held.length, MAX_ENTRIES);
  assert.ok(!held.some((e) => e.id === first.id));
  assert.equal(held[0].question, 'question 1');
  assert.equal(held[held.length - 1].question, 'one more');
  const dropped = lines.filter((l) => l.msg.includes('oldest entry dropped'));
  assert.deepEqual(dropped.map((l) => l.fields), [{ id: first.id, hub: 'h' }]);
});

test('list skips a malformed or extra-field file; get and remove by id', async (t) => {
  const { queue, lines } = queueOf(t);
  const e = await queue.add({ hub: 'h', reason: 'no_key', question: 'kept' });
  fs.writeFileSync(path.join(queue.root, 'aaaaaaaaaaaaaaaa.json'), JSON.stringify({ ...e, id: 'aaaaaaaaaaaaaaaa', rows: [1] }));
  fs.writeFileSync(path.join(queue.root, 'bbbbbbbbbbbbbbbb.json'), 'not json');
  fs.writeFileSync(path.join(queue.root, 'notes.txt'), 'ignored');
  assert.deepEqual((await queue.list()).map((x) => x.id), [e.id]);
  assert.equal(lines.filter((l) => l.msg === 'review queue entry skipped').length, 2);
  assert.equal((await queue.get(e.id)).question, 'kept');
  assert.equal(await queue.get('cccccccccccccccc'), null);
  assert.equal(await queue.remove(e.id), true);
  assert.equal(await queue.remove(e.id), false);
});

test('a queue folder that is a symlink is never read or written', async (t) => {
  const { queue, dir } = queueOf(t);
  const elsewhere = path.join(dir, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.dirname(queue.root), { recursive: true });
  fs.symlinkSync(elsewhere, queue.root);
  await assert.rejects(queue.add({ hub: 'h', reason: 'no_rule', question: 'q' }));
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.deepEqual(await queue.list(), []);
});
