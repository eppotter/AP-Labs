'use strict';

// kit/lib/secrets: env first, then the macOS Keychain (skipped off macOS and
// when APLABS_NO_KEYCHAIN=1), and redact(). The Keychain reader is always
// injected; no test touches the real one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readSecret, redact } = require('../../kit/lib/secrets');

function keychain(value) {
  const calls = [];
  const read = (service) => { calls.push(service); return value; };
  return { read, calls };
}

test('readSecret: env wins and the Keychain is not read', () => {
  const kc = keychain('from-keychain');
  const v = readSecret('TOKEN', 'svc', { env: { TOKEN: 'from-env' }, platform: 'darwin', readKeychain: kc.read });
  assert.equal(v, 'from-env');
  assert.deepEqual(kc.calls, []);
});

test('readSecret: an empty env var falls through to the Keychain on macOS, trimmed', () => {
  const kc = keychain('  from-keychain\n');
  const v = readSecret('TOKEN', 'svc', { env: { TOKEN: '' }, platform: 'darwin', readKeychain: kc.read });
  assert.equal(v, 'from-keychain');
  assert.deepEqual(kc.calls, ['svc']);
});

test('readSecret: APLABS_NO_KEYCHAIN=1 skips the Keychain', () => {
  const kc = keychain('from-keychain');
  const v = readSecret('TOKEN', 'svc', { env: { APLABS_NO_KEYCHAIN: '1' }, platform: 'darwin', readKeychain: kc.read });
  assert.equal(v, null);
  assert.deepEqual(kc.calls, []);
});

test('readSecret: off macOS the Keychain is never read', () => {
  const kc = keychain('from-keychain');
  assert.equal(readSecret('TOKEN', 'svc', { env: {}, platform: 'linux', readKeychain: kc.read }), null);
  assert.deepEqual(kc.calls, []);
});

test('readSecret: nothing found, or only whitespace, is null', () => {
  assert.equal(readSecret('TOKEN', 'svc', { env: { TOKEN: '   ' }, platform: 'darwin', readKeychain: () => null }), null);
  assert.equal(readSecret('TOKEN', null, { env: {}, platform: 'darwin', readKeychain: () => 'x' }), null);
});

test('redact: masks every secret, longest first, and every pattern match', () => {
  const out = redact('a=abc123 b=abc123xyz c=abc', ['abc', 'abc123xyz', 'abc123', '', null], { mask: '#' });
  assert.equal(out, 'a=# b=# c=#');
  assert.equal(redact('id 42 and 7', [], { mask: '<n>', patterns: [/\d+/g] }), 'id <n> and <n>');
  assert.equal(redact('nothing here', ['secret']), 'nothing here');
  assert.equal(redact('the secret', ['secret']), 'the [redacted]');
  assert.equal(redact(12345, ['234']), '1[redacted]5');
});
