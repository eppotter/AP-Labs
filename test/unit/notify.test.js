'use strict';

// Slack notify: the pure helpers and the CLI with injected fetch, Keychain and
// output. No real network or Keychain access; the one spawned run is a dry run.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  KINDS,
  DEFAULT_KEYCHAIN_SERVICE,
  parseArgs,
  formatText,
  isSlackWebhook,
  redact,
} = require('../../kit/lib/notify');
const { main } = require('../../kit/notify/cli');

const ENV_URL = 'https://hooks.slack.com/services/TENV/BENV/envsecret123';
const KEY_URL = 'https://hooks.slack.com/services/TKEY/BKEY/keysecret456';
const SECRETS = ['envsecret123', 'keysecret456', 'TENV/BENV', 'TKEY/BKEY'];

// Runs main with captured output. fetch and the Keychain fail loudly unless a
// test supplies them, so nothing falls through to the real ones.
async function run(argv, { env = {}, platform = 'darwin', fetch, readKeychain, timeoutMs } = {}) {
  const stdout = [];
  const stderr = [];
  const calls = { fetch: [], keychain: [] };
  const code = await main(argv, env, {
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    platform,
    timeoutMs,
    fetch: async (url, opts) => {
      calls.fetch.push({ url, opts });
      if (!fetch) throw new Error('unexpected fetch');
      return fetch(url, opts);
    },
    readKeychain: (service) => {
      calls.keychain.push(service);
      return readKeychain ? readKeychain(service) : null;
    },
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), calls };
}

const ok = async () => ({ ok: true, status: 200, text: async () => 'ok' });

function assertNoSecret(r) {
  for (const s of SECRETS) {
    assert.ok(!r.stdout.includes(s), `stdout leaked ${s}: ${r.stdout}`);
    assert.ok(!r.stderr.includes(s), `stderr leaked ${s}: ${r.stderr}`);
  }
}

test('parseArgs: message, default kind, flags in any order', () => {
  assert.deepEqual(parseArgs(['Story 5.3 merged']), { kind: 'info', dryRun: false, message: 'Story 5.3 merged' });
  assert.deepEqual(parseArgs(['--kind', 'merged', 'hi', '--dry-run']), { kind: 'merged', dryRun: true, message: 'hi' });
  assert.deepEqual(parseArgs(['--kind=epic', 'Epic', '1', 'done']), { kind: 'epic', dryRun: false, message: 'Epic 1 done' });
  assert.deepEqual(parseArgs(['--', '--not-a-flag']), { kind: 'info', dryRun: false, message: '--not-a-flag' });
  assert.deepEqual(parseArgs(['-h']), { help: true });
});

test('parseArgs: usage errors', () => {
  assert.match(parseArgs([]).error, /no message/);
  assert.match(parseArgs(['   ']).error, /no message/);
  assert.match(parseArgs(['--dry-run']).error, /no message/);
  assert.match(parseArgs(['--loud', 'hi']).error, /unknown argument: --loud/);
  assert.match(parseArgs(['--kind', 'party', 'hi']).error, /--kind needs one of/);
  assert.match(parseArgs(['hi', '--kind']).error, /--kind needs one of/);
  assert.match(parseArgs(['--kind', 'constructor', 'hi']).error, /--kind needs one of/);
});

test('formatText: every kind gets its emoji', () => {
  const expected = { merged: '✅', epic: '🏁', decision: '🙋', blocked: '⛔', info: '🔧' };
  assert.deepEqual(Object.keys(KINDS).sort(), Object.keys(expected).sort());
  for (const [kind, emoji] of Object.entries(expected)) {
    assert.equal(formatText(kind, 'PR #9 landed'), `${emoji} PR #9 landed`);
  }
});

test('isSlackWebhook: only Slack incoming webhooks', () => {
  assert.equal(isSlackWebhook(ENV_URL), true);
  assert.equal(isSlackWebhook('http://hooks.slack.com/services/T/B/x'), false);
  assert.equal(isSlackWebhook('https://hooks.slack.com.evil.example/services/T/B/x'), false);
  assert.equal(isSlackWebhook('https://example.com/?u=https://hooks.slack.com/services/x'), false);
  assert.equal(isSlackWebhook('https://hooks.slack.com/workflows/T/x'), false);
  assert.equal(isSlackWebhook(`${ENV_URL} extra`), false);
  assert.equal(isSlackWebhook(undefined), false);
});

test('redact: removes the secret and anything webhook-shaped', () => {
  assert.equal(redact(`POST ${ENV_URL} failed`, ENV_URL), 'POST [webhook] failed');
  assert.equal(redact('see hooks.slack.com/services/T/B/zzz', ''), 'see [webhook]');
  assert.equal(redact('token envsecret123 alone', 'envsecret123'), 'token [webhook] alone');
});

test('dry run prints the text only, never resolves or posts', async () => {
  const r = await run(['--kind', 'blocked', '--dry-run', 'Story 2.4 waits on a profile key'], { env: { APLABS_SLACK_WEBHOOK: ENV_URL } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '⛔ Story 2.4 waits on a profile key');
  assert.equal(r.calls.fetch.length, 0);
  assert.equal(r.calls.keychain.length, 0);
  assertNoSecret(r);
});

test('posts {text} as JSON and prints only "posted"', async () => {
  const r = await run(['--kind', 'merged', 'PR #20 merged: notify'], { env: { APLABS_SLACK_WEBHOOK: ENV_URL }, fetch: ok });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'posted');
  assert.equal(r.stderr, '');
  assert.equal(r.calls.fetch.length, 1);
  const { url, opts } = r.calls.fetch[0];
  assert.equal(url, ENV_URL);
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(opts.body), { text: '✅ PR #20 merged: notify' });
  assert.ok(opts.signal instanceof AbortSignal);
  assertNoSecret(r);
});

test('env wins over the Keychain', async () => {
  const r = await run(['hi'], { env: { APLABS_SLACK_WEBHOOK: ENV_URL }, fetch: ok, readKeychain: () => KEY_URL });
  assert.equal(r.code, 0);
  assert.equal(r.calls.keychain.length, 0);
  assert.equal(r.calls.fetch[0].url, ENV_URL);
});

test('Keychain on macOS when env is unset or empty, with the service override', async () => {
  const r = await run(['hi'], { env: { APLABS_SLACK_WEBHOOK: '' }, fetch: ok, readKeychain: () => `${KEY_URL}\n` });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.keychain, [DEFAULT_KEYCHAIN_SERVICE]);
  assert.equal(r.calls.fetch[0].url, KEY_URL);
  const o = await run(['hi'], { env: { APLABS_SLACK_KEYCHAIN_SERVICE: 'other-service' }, fetch: ok, readKeychain: () => KEY_URL });
  assert.deepEqual(o.calls.keychain, ['other-service']);
  assertNoSecret(r);
});

test('no webhook: exit 1 with both ways to configure, no Keychain off macOS', async () => {
  const r = await run(['hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no Slack webhook configured/);
  assert.match(r.stderr, /APLABS_SLACK_WEBHOOK/);
  assert.match(r.stderr, /security add-generic-password -s aplabs-slack-webhook/);
  assert.equal(r.calls.fetch.length, 0);
  const linux = await run(['hi'], { platform: 'linux', readKeychain: () => KEY_URL });
  assert.equal(linux.code, 1);
  assert.equal(linux.calls.keychain.length, 0);
  assertNoSecret(r);
});

test('a non-Slack URL is refused without being echoed', async () => {
  const bad = 'https://attacker.example/collect/sneaky';
  const r = await run(['hi'], { env: { APLABS_SLACK_WEBHOOK: bad }, fetch: ok });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Refusing to post/);
  assert.ok(!r.stderr.includes('attacker') && !r.stderr.includes('sneaky'));
  assert.equal(r.calls.fetch.length, 0);
});

test('non-2xx exits 1 with the status, redacting an echoed URL', async () => {
  const r = await run(['hi'], {
    env: { APLABS_SLACK_WEBHOOK: ENV_URL },
    fetch: async () => ({ ok: false, status: 404, text: async () => `no_service for ${ENV_URL}` }),
  });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /HTTP 404/);
  assert.match(r.stderr, /no_service/);
  assertNoSecret(r);
});

test('network error exits 1 with a redacted reason', async () => {
  const r = await run(['hi'], {
    env: { APLABS_SLACK_WEBHOOK: ENV_URL },
    fetch: async () => {
      throw new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED ${ENV_URL}`) });
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Could not reach Slack: fetch failed/);
  assertNoSecret(r);
});

test('a hung request is aborted by the timeout', async () => {
  const r = await run(['hi'], {
    env: { APLABS_SLACK_WEBHOOK: ENV_URL },
    timeoutMs: 20,
    fetch: (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error(`aborted ${url}`)));
    }),
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /timed out/);
  assertNoSecret(r);
});

test('the webhook URL never appears in output on any path', async () => {
  const env = { APLABS_SLACK_WEBHOOK: ENV_URL };
  const leaky = `boom ${ENV_URL} ${KEY_URL}`;
  const paths = [
    run([], { env }),
    run(['--bogus', 'x'], { env }),
    run(['--help'], { env }),
    run(['--dry-run', 'x'], { env }),
    run(['x'], { env, fetch: ok }),
    run(['x'], { readKeychain: () => KEY_URL, fetch: ok }),
    run(['x'], { env: { APLABS_SLACK_WEBHOOK: `${ENV_URL.replace('https', 'http')}` } }),
    run(['x'], {}),
    run(['x'], { env, fetch: async () => ({ ok: false, status: 500, text: async () => leaky }) }),
    run(['x'], { env, fetch: async () => ({ ok: false, status: 500, text: async () => { throw new Error(leaky); } }) }),
    run(['x'], { env, fetch: async () => { throw new Error(leaky); } }),
    run(['x'], { readKeychain: () => KEY_URL, fetch: async () => { throw new Error(leaky); } }),
  ];
  for (const r of await Promise.all(paths)) assertNoSecret(r);
});

test('the CLI runs as a script: usage exit 2, dry run exit 0', () => {
  const cli = path.join(__dirname, '../../kit/notify/cli.js');
  const env = { PATH: process.env.PATH, APLABS_SLACK_WEBHOOK: ENV_URL };
  const usage = spawnSync(process.execPath, [cli], { env, encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: npm run notify/);
  const dry = spawnSync(process.execPath, [cli, '--kind', 'decision', '--dry-run', 'Pick a tier for Story 2.5'], { env, encoding: 'utf8' });
  assert.equal(dry.status, 0);
  assert.equal(dry.stdout, '🙋 Pick a tier for Story 2.5\n');
  assertNoSecret(usage);
  assertNoSecret(dry);
});
