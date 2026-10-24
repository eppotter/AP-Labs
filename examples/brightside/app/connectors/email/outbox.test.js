'use strict';

// The outbox's own safety: owner-only permissions on an existing file, and one
// writer at a time across processes (a lockfile around check-then-append, a
// lock taken over only when its owner is gone). Every test writes to its own
// temporary outbox.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { openOutbox } = require('./outbox');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function freshPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-outbox-'));
  dirs.push(dir);
  return path.join(dir, 'outbox', 'email.jsonl');
}

const list = (key) => ({ type: 'list', operation: 'createList', key, payload: { listId: `list-${key}`, name: key } });
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// A process that stays alive until killed: a lock holder that is not us.
function liveProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  return child.pid;
}

function holdLock(file, pid, at = new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid, at: at.toISOString() }));
  fs.utimesSync(`${file}.lock`, at, at);
}

test('outbox: an existing file with wider permissions is made owner-only on the next write', () => {
  const file = freshPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  openOutbox(file).append(list('a'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('outbox: the lock is released after a write, and after a write that throws', () => {
  const file = freshPath();
  const outbox = openOutbox(file);
  outbox.append(list('a'));
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.throws(() => outbox.transaction(() => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  outbox.append(list('b'));
  assert.deepEqual(lines(file).map((l) => l.key), ['a', 'b']);
});

test('outbox: while another live process holds the lock, a write fails loudly and appends nothing', (t) => {
  const file = freshPath();
  const outbox = openOutbox(file, { lockWaitMs: 100 });
  outbox.append(list('a'));
  const pid = liveProcess(t);
  holdLock(file, pid);
  assert.throws(() => outbox.append(list('b')), new RegExp(`locked by another process \\(pid ${pid}\\)`));
  assert.throws(() => outbox.transaction(() => assert.fail('must not run')), /locked by another process/);
  assert.deepEqual(lines(file).map((l) => l.key), ['a']);
  assert.ok(fs.existsSync(`${file}.lock`), 'the other process keeps its lock');
});

test('outbox: a lock left by a process that has exited is taken over', () => {
  const file = freshPath();
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  holdLock(file, pid);
  openOutbox(file, { lockWaitMs: 100 }).append(list('a'));
  assert.deepEqual(lines(file).map((l) => l.key), ['a']);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('outbox: a lock held by a live pid is never taken over, however old: the second writer fails loudly', (t) => {
  const file = freshPath();
  const outbox = openOutbox(file, { lockWaitMs: 100, lockStaleMs: 60_000 });
  outbox.append(list('a'));
  const pid = liveProcess(t);
  holdLock(file, pid, new Date(Date.now() - 120_000));
  const before = fs.readFileSync(`${file}.lock`, 'utf8');
  assert.throws(() => outbox.append(list('b')), new RegExp(`locked by another process \\(pid ${pid}\\)`));
  assert.deepEqual(lines(file).map((l) => l.key), ['a'], 'nothing appended');
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), before, 'the live writer keeps its lock');
});

test('outbox: an unparseable lock file is treated as held while it is newer than the stale age', () => {
  const file = freshPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.lock`, 'garbage');
  assert.throws(() => openOutbox(file, { lockWaitMs: 50 }).append(list('a')), /locked by another process/);
  assert.ok(fs.existsSync(`${file}.lock`));
});

test('outbox: an unparseable lock file older than the stale age is taken over', () => {
  const file = freshPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = new Date(Date.now() - 120_000);
  fs.writeFileSync(`${file}.lock`, 'garbage');
  fs.utimesSync(`${file}.lock`, old, old);
  openOutbox(file, { lockWaitMs: 50, lockStaleMs: 60_000 }).append(list('a'));
  assert.deepEqual(lines(file).map((l) => l.key), ['a']);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('outbox: several processes checking then appending the same keys at once record each key exactly once', async () => {
  const file = freshPath();
  const script = `
    const { openOutbox } = require(${JSON.stringify(path.join(__dirname, 'outbox.js'))});
    const outbox = openOutbox(process.argv[1], { lockWaitMs: 10000 });
    for (let i = 0; i < 25; i += 1) {
      const key = 'k' + i;
      outbox.transaction((tx) => { if (!tx.find('list', key)) tx.append({ type: 'list', operation: 'createList', key, payload: { listId: key, name: key } }); });
    }`;
  const runs = Array.from({ length: 4 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, err }));
  }));
  for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.err);
  const keys = lines(file).map((l) => l.key);
  assert.equal(keys.length, 25, `each key once, got ${keys.length} lines`);
  assert.equal(new Set(keys).size, 25);
});
