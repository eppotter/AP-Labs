'use strict';

// kit/runtime/store (AD-7): synchronous get/set/consume/done/finish, a TTL per
// namespace, an injected clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, NAMESPACES } = require('../../kit/runtime/store');

const MIN = 60 * 1000;

function clockStore() {
  const clock = { t: 1000 };
  return { clock, store: createStore({ now: () => clock.t }) };
}

test('every namespace in the AD-7 table has its TTL', () => {
  assert.deepEqual(NAMESPACES, {
    welcome: 7 * 24 * 60 * MIN,
    session: 30 * MIN,
    provenance: 24 * 60 * MIN,
    approval: 30 * MIN,
    done: 10 * MIN,
    event: 10 * MIN,
    escalation: 15 * MIN,
    ratelimit: 60 * MIN,
  });
});

test('set and get are synchronous and return the stored value', () => {
  const { store } = clockStore();
  const r = store.set('session', 's1', { zone: 'north' });
  assert.equal(r, undefined);
  const v = store.get('session', 's1');
  assert.ok(!(v instanceof Promise));
  assert.deepEqual(v, { zone: 'north' });
  assert.equal(store.get('session', 'other'), undefined);
});

test('an entry expires at its namespace TTL by default', () => {
  const { clock, store } = clockStore();
  store.set('event', 'Ev1', true);
  clock.t += 10 * MIN - 1;
  assert.equal(store.get('event', 'Ev1'), true);
  clock.t += 1;
  assert.equal(store.get('event', 'Ev1'), undefined);
});

test('a shorter TTL is allowed; a longer, zero or fractional one is refused', () => {
  const { clock, store } = clockStore();
  store.set('session', 's', 1, 5);
  clock.t += 5;
  assert.equal(store.get('session', 's'), undefined);
  assert.throws(() => store.set('session', 's', 1, 30 * MIN + 1), /TTL for "session"/);
  assert.throws(() => store.set('session', 's', 1, 0), /TTL/);
  assert.throws(() => store.set('session', 's', 1, 1.5), /TTL/);
});

test('an unknown namespace or an empty key is refused', () => {
  const { store } = clockStore();
  assert.throws(() => store.set('cache', 'k', 1), /unknown store namespace "cache"/);
  assert.throws(() => store.get('__proto__', 'k'), /unknown store namespace/);
  assert.throws(() => store.set('event', '', 1), /non-empty string/);
  assert.throws(() => store.get('event', 7), /non-empty string/);
});

test('namespaces are separate', () => {
  const { store } = clockStore();
  store.set('session', 'k', 'a');
  store.set('approval', 'k', 'b');
  assert.equal(store.get('session', 'k'), 'a');
  assert.equal(store.get('approval', 'k'), 'b');
});

test('consume gets and deletes in one call and leaves a running marker; finish records the result', () => {
  const { store } = clockStore();
  store.set('approval', 'tok', { rows: 3 });
  assert.equal(store.done('approval', 'tok'), undefined);
  assert.deepEqual(store.consume('approval', 'tok'), { rows: 3 });
  assert.equal(store.get('approval', 'tok'), undefined);
  assert.deepEqual(store.done('approval', 'tok'), { state: 'running' });
  // A second click finds nothing to consume and reads the marker.
  assert.equal(store.consume('approval', 'tok'), undefined);
  store.finish('approval', 'tok', { pushed: 3 });
  assert.deepEqual(store.done('approval', 'tok'), { state: 'done', result: { pushed: 3 } });
});

test('consume(ns, key, marker) ties the done marker to whoever consumed it; finish keeps the marker (Story 10.3, decision 5)', () => {
  const { store } = clockStore();
  store.set('approval', 'tok', { rows: 3 });
  assert.deepEqual(store.consume('approval', 'tok', { person: 'U1', action: 'approve' }), { rows: 3 });
  assert.deepEqual(store.done('approval', 'tok'), { person: 'U1', action: 'approve', state: 'running' });
  assert.ok(Object.isFrozen(store.done('approval', 'tok')));
  store.finish('approval', 'tok', { pushed: 3 });
  assert.deepEqual(store.done('approval', 'tok'), { person: 'U1', action: 'approve', state: 'done', result: { pushed: 3 } });
  // A marker is a plain object, and never sets state or result itself.
  store.set('approval', 'b', 1);
  for (const bad of [null, 'U1', ['U1'], { state: 'done' }, { result: 1 }, new Map()]) {
    assert.throws(() => store.consume('approval', 'b', bad), /consume marker/);
  }
  assert.equal(store.get('approval', 'b'), 1, 'a refused marker consumes nothing');
  // The caller's object is copied: changing it later changes nothing.
  const marker = { person: 'U2' };
  store.consume('approval', 'b', marker);
  marker.person = 'U3';
  assert.equal(store.done('approval', 'b').person, 'U2');
});

test('consuming a missing or expired entry marks nothing', () => {
  const { clock, store } = clockStore();
  assert.equal(store.consume('approval', 'none'), undefined);
  assert.equal(store.done('approval', 'none'), undefined);
  store.set('approval', 'old', 1);
  clock.t += 30 * MIN;
  assert.equal(store.consume('approval', 'old'), undefined);
  assert.equal(store.done('approval', 'old'), undefined);
});

test('done markers expire after 10 minutes', () => {
  const { clock, store } = clockStore();
  store.set('approval', 'tok', 1);
  store.consume('approval', 'tok');
  clock.t += 10 * MIN;
  assert.equal(store.done('approval', 'tok'), undefined);
});

test('sweep drops expired entries, and every 100th write sweeps', () => {
  const { clock, store } = clockStore();
  for (let i = 0; i < 3; i++) store.set('event', `a${i}`, true);
  clock.t += 10 * MIN;
  assert.equal(store.sweep(), 3);
  for (let i = 0; i < 50; i++) store.set('event', `e${i}`, true);
  clock.t += 10 * MIN;
  // Writes 54 to 100: the 100th sweeps the 50 expired events first.
  for (let i = 0; i < 47; i++) store.set('session', `s${i}`, true);
  assert.equal(store.sweep(), 0);
  assert.equal(store.get('session', 's46'), true);
});
