'use strict';

// Container smoke test (Story 11.2), run inside the built image by the CI
// `container` job:
//
//   docker run --rm --network none --read-only --tmpfs /tmp \
//     --tmpfs /var/lib/aplabs -v "$PWD/test/fixtures:/app/test/fixtures:ro" \
//     <image> node scripts/container-smoke.js
//
// No real token, no Slack, no MotherDuck, no network. test/ is not in the
// image; its fixtures are mounted read-only. Each step prints one line.
//
// Image checks: the process is not root; the app's files are not writable;
// APLABS_VAR_DIR is; the folders .dockerignore keeps out are absent (test/
// holds only the mounted fixtures); the MotherDuck extension is installed in
// the image and DuckDB finds it with the network off (DEP-016):
//   - installedExtensions: DuckDB is the pinned version, and motherduck and
//     motherduck_impl (fetched by the build-time LOAD) are files in
//     $HOME/.duckdb/extensions/<version>/<platform>;
//   - extensionLoads: an offline LOAD motherduck gets past DuckDB's lookup.
//     A real LOAD needs MotherDuck's network (the extension's own init calls
//     MotherDuck's API on every LOAD), so offline the one accepted failure is
//     that init's network call (classifyOfflineLoad). "Not found", "not
//     installed", an auto-install or repository download, or any other error
//     fails the smoke test, with DuckDB's text.
// Boot checks: the real runtime boots a throwaway stub fork (in /tmp) against
// a fake Slack client, with the health listener on; /healthz answers 200
// during the grace and, with the clock moved past it, 200 because the fake
// connected, 503 after an outage over 60 seconds, 200 again on reconnect;
// any other path is 404; the hub menu lists the module.
//
// --boot-only runs only the boot checks (npm test runs it that way outside
// the image). The health port is APLABS_HEALTH_PORT, else 8080.
// Exits 0 on pass, 1 on fail.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../kit/runtime/app');
const { extensionLoads, installedExtensions } = require('../kit/runtime/data');
const { GRACE_MS, OUTAGE_MS } = require('../kit/runtime/app/health');
const { FakeSlackApp } = require('../test/fixtures/fake-slack');
const { makeFork, addModule, FILLED } = require('../test/fixtures/temp-fork');

const REPO = path.resolve(__dirname, '..');
const PORT = process.env.APLABS_HEALTH_PORT || '8080';
// Paths .dockerignore keeps out of the image.
const KEPT_OUT = Object.freeze(['.git', '.github', 'docs', '.claude', '.codex', '.agents', '_bmad', '.aplabs/context', 'var', '.env']);

// The extensions the image must hold: motherduck, and the implementation
// part its build-time LOAD fetched (scripts/install-duckdb-extensions.js).
const MD_EXTENSIONS = Object.freeze(['motherduck', 'motherduck_impl']);

// How an offline LOAD motherduck failed, from its reason (DuckDB's first
// line, paths possibly reduced to file names):
//   'needs_network' - DuckDB found and opened the extension, and only its own
//                     init failed, on MotherDuck's API call (the network is
//                     off). The one accepted result.
//   'missing'       - DuckDB did not find it (not found, not installed).
//   'install'       - something tried to install or download it from an
//                     extension repository.
//   'other'         - anything else.
const INIT_NETWORK = new RegExp([
  '^Invalid Input Error: Initialization function "motherduck_duckdb_cpp_init" ',
  'from file "[^"]*motherduck\\.duckdb_extension" threw an exception: ',
  '"Failed to download "[^"\\s]*(?:api\\.motherduck\\.com|extension_version)[^"\\s]*"(?: \\(attempt \\d+\\))?: ',
  '(?:Could not establish connection|Could not resolve host[^"]*|Couldn\'t resolve host[^"]*)"$',
].join(''));
function classifyOfflineLoad(reason) {
  const text = String(reason == null ? '' : reason);
  if (/not found|not installed|no such file|unable to find|could not find/i.test(text)) return 'missing';
  if (/auto-?install|auto-?load|repository|extensions\.duckdb\.org|community-extensions|INSTALL\b|download(?:ing)? extension|Failed to download extension/i.test(text)) return 'install';
  if (INIT_NETWORK.test(text)) return 'needs_network';
  return 'other';
}

// What is wrong with the image's extension folder, as a list (empty = fine).
// info is installedExtensions(MD_EXTENSIONS); pinned the @duckdb/node-api
// version in package.json; home the runtime user's $HOME.
function extensionFolderProblems(info, { pinned, home, isFile = (f) => fs.statSync(f, { throwIfNoEntry: false })?.isFile() === true }) {
  const problems = [];
  const want = /^(\d+\.\d+\.\d+)/.exec(String(pinned));
  if (!want) problems.push(`cannot read the pinned DuckDB version from "${pinned}"`);
  else if (info.version !== `v${want[1]}`) problems.push(`DuckDB is ${info.version}, not the pinned v${want[1]}`);
  const folder = path.join(home, '.duckdb', 'extensions', String(info.version), String(info.platform));
  for (const name of MD_EXTENSIONS) {
    const e = info.extensions.find((x) => x.name === name);
    if (!e || !e.installed || !e.installPath) { problems.push(`${name} is not installed`); continue; }
    if (path.dirname(e.installPath) !== folder) problems.push(`${name} is at ${e.installPath}, not in ${folder}`);
    else if (!new RegExp(`^${name}(?:\\.[^/]+)?\\.duckdb_extension$`).test(path.basename(e.installPath))) problems.push(`${name} has an unexpected file name: ${path.basename(e.installPath)}`);
    else if (!isFile(e.installPath)) problems.push(`${name} file is missing: ${e.installPath}`);
  }
  return problems;
}

const step = (msg) => console.log(`container smoke: ok - ${msg}`);

// GET a path on the health listener. Resolves { status, body }.
function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: Number(PORT), path: urlPath, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${urlPath} timed out`)));
    req.on('error', reject);
  });
}

async function imageChecks() {
  assert.notEqual(process.getuid(), 0, 'the app must not run as root');
  step(`runs as uid ${process.getuid()}, not root`);

  const probe = path.join(REPO, '.container-smoke-write');
  let wrote = false;
  try {
    fs.writeFileSync(probe, 'x');
    wrote = true;
  } catch (err) {
    assert.ok(['EROFS', 'EACCES', 'EPERM'].includes(err.code), `unexpected error writing the app dir: ${err.code}`);
  } finally {
    if (wrote) fs.rmSync(probe, { force: true });
  }
  assert.equal(wrote, false, 'the app files must not be writable');
  step('the app files are not writable');

  const varDir = process.env.APLABS_VAR_DIR;
  assert.ok(varDir && path.isAbsolute(varDir), 'APLABS_VAR_DIR is set in the image');
  const varProbe = path.join(varDir, '.container-smoke');
  fs.writeFileSync(varProbe, 'x');
  fs.rmSync(varProbe);
  step('APLABS_VAR_DIR is writable');

  const baked = KEPT_OUT.filter((rel) => fs.existsSync(path.join(REPO, rel)));
  assert.deepEqual(baked, [], 'kept out of the image by .dockerignore');
  const testDir = path.join(REPO, 'test');
  assert.deepEqual(fs.existsSync(testDir) ? fs.readdirSync(testDir) : [], ['fixtures'], 'test/ holds only the mounted fixtures');
  step('the image holds no tests, docs, agent folders, client context or data files');

  const pinned = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).dependencies['@duckdb/node-api'];
  const info = await installedExtensions([...MD_EXTENSIONS]);
  const problems = extensionFolderProblems(info, { pinned, home: os.homedir() });
  assert.deepEqual(problems, [], 'the MotherDuck extension files are installed for the pinned DuckDB version');
  step(`the MotherDuck extension files are installed for DuckDB ${info.version} (${info.platform})`);

  const md = await extensionLoads('motherduck');
  if (!md.loaded) {
    const kind = classifyOfflineLoad(md.reason);
    assert.equal(kind, 'needs_network', `an offline LOAD motherduck must fail only in its own init, on MotherDuck's network call; it failed (${kind}): ${md.reason}`);
  }
  step(md.loaded
    ? 'DuckDB found and loaded the MotherDuck extension offline'
    : 'DuckDB found the MotherDuck extension offline; only its init failed, on MotherDuck\'s network call (a real LOAD needs the network)');
}

async function bootChecks() {
  const f = makeFork();
  const lines = [];
  let t = Date.now();
  let res;
  try {
    addModule(f.appDir);
    res = await main({
      env: {
        APLABS_NO_KEYCHAIN: '1',
        // Fake values, shaped like the real ones; nothing here is a credential.
        SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue',
        SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue',
        APLABS_APP_DIR: f.appDir,
        APLABS_DATA_PATH: path.join(f.root, 'no-data', 'stub.duckdb'),
        APLABS_HEALTH_PORT: PORT,
      },
      cwd: f.root,
      deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: () => null, now: () => t },
    });
    assert.equal(res.code, 0, `boot refused:\n${lines.join('\n')}`);
    const started = JSON.parse(lines.find((l) => /bot started/.test(l)));
    assert.equal(started.health, `on (port ${PORT})`);
    step('the runtime booted a stub fork with a fake Slack client');

    assert.deepEqual(await get('/healthz'), { status: 200, body: 'ok' });
    step('/healthz is 200 during the boot grace');
    assert.equal((await get('/')).status, 404);
    step('any other path is 404');

    t += GRACE_MS + 1000;
    assert.deepEqual(await get('/healthz'), { status: 200, body: 'ok' });
    step('/healthz is 200 after the grace, because Slack connected');
    res.app.disconnect();
    t += OUTAGE_MS + 1000;
    assert.deepEqual(await get('/healthz'), { status: 503, body: 'down' });
    step('/healthz is 503 after an outage over 60 seconds');
    res.app.connect();
    assert.deepEqual(await get('/healthz'), { status: 200, body: 'ok' });
    step('/healthz is 200 again once Slack reconnects');

    await res.app.dispatchCommand('/ops', { user_id: 'UBO' });
    const entries = res.app.responded[0].blocks.filter((b) => b.accessory && /^entry:/.test(b.block_id));
    assert.deepEqual(entries.map((b) => b.accessory.action_id), [`${FILLED.id}:open`], 'the hub menu lists the module');
    step('the hub menu lists the module');
  } finally {
    if (res && res.jobs) res.jobs.stop();
    if (res && res.health) await res.health.close();
    if (res && res.data) res.data.close();
    f.cleanup();
  }
}

async function smoke(argv) {
  if (!argv.includes('--boot-only')) await imageChecks();
  await bootChecks();
}

module.exports = { classifyOfflineLoad, extensionFolderProblems, MD_EXTENSIONS };

if (require.main === module) {
  smoke(process.argv.slice(2)).then(
    () => console.log('container smoke: PASSED'),
    (err) => {
      console.error(`container smoke: FAILED\n${err.message}`);
      process.exitCode = 1;
    },
  );
}
