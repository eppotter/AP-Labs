'use strict';

// Story 11.3: two forks differ only by profile and modules. Builds two client
// forks as real copies of this repo in temp dirs (test/fixtures/temp-fork.js,
// copied mode: no example client, only node_modules linked), from the fixture
// clients test/fixtures/fork/ (Stub Co) and test/fixtures/fork-b/ (Bravo Ltd).
// Fork B appends a dependency. Then:
//   - kit/lib/fork finds every engine file byte-identical and nothing else
//     different but the profiles, contexts, app dirs and the appended
//     dependency (with its lockfile entries); one changed kit/ byte, and a
//     changed or removed dependency, are reported by name;
//   - each fork boots its own copy of the runtime (main()) with a fake Slack
//     client, and the same two Slack people see each fork's own client name,
//     menu and access;
//   - in each fork, the tier CLI, `npm run verify` and the write gate follow
//     that fork's profile.
// Offline: no Slack, no model, no MotherDuck, no network. Both forks are
// removed at the end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compareForks, packageDelta } = require('../../kit/lib/fork');
const { listEngineFiles } = require('../../kit/runtime/paths');
const { FakeSlackApp } = require('../fixtures/fake-slack');
const { makeCopyFork, REPO } = require('../fixtures/temp-fork');

// Fake values, shaped like the real ones; nothing here is a credential.
const TOKENS = { SLACK_BOT_TOKEN: 'xoxb-000-111-faketokenvalue', SLACK_APP_TOKEN: 'xapp-1-A000-222-fakeappvalue' };
// The dependency fork B appends, and the lockfile entry installing it would
// add. Never installed: nothing requires it.
const APPENDED = Object.freeze({ name: 'left-pad', spec: '1.3.0' });
const APPENDED_LOCK_ENTRY = Object.freeze({
  version: '1.3.0',
  resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
  integrity: 'sha512-fixturefixturefixturefixturefixturefixturefixturefixturefixture00==',
  license: 'WTFPL',
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const TEMPLATE_PKG = readJson(path.join(REPO, 'package.json'));
const TEMPLATE_LOCK = readJson(path.join(REPO, 'package-lock.json'));

// What a fork's builder does to add a dependency: package.json plus the
// lockfile entries `npm install` would write.
function appendDependency(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  pkg.dependencies = { ...pkg.dependencies, [APPENDED.name]: APPENDED.spec };
  writeJson(path.join(root, 'package.json'), pkg);
  const lock = readJson(path.join(root, 'package-lock.json'));
  lock.packages[''].dependencies = { ...lock.packages[''].dependencies, [APPENDED.name]: APPENDED.spec };
  lock.packages[`node_modules/${APPENDED.name}`] = APPENDED_LOCK_ENTRY;
  writeJson(path.join(root, 'package-lock.json'), lock);
}

let A;
let B;
const started = Date.now();
test.before(() => {
  A = makeCopyFork('fork');
  B = makeCopyFork('fork-b');
  appendDependency(B.root);
});
test.after((t) => {
  for (const f of [A, B]) {
    if (!f) continue;
    f.cleanup();
    assert.equal(fs.existsSync(f.root), false, `temp fork ${f.root} removed`);
  }
  // The Story 11.3 time budget (30 s): reported, not enforced.
  t.diagnostic(`two-forks: ${((Date.now() - started) / 1000).toFixed(1)} s`);
});

// A clean env for a child process in a fork: no APLABS_PROFILE or git config
// from the shell running the tests; HOME is the fork, so nothing lands outside it.
const childEnv = (f, extra = {}) => ({ PATH: process.env.PATH, HOME: f.root, GIT_CONFIG_NOSYSTEM: '1', ...extra });
const run = (f, cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: f.root, env: childEnv(f, opts.env), encoding: 'utf8', input: opts.input, timeout: 60000 });

test('each fork is a copy of the template without the example client, and the two differ only by profile, context, app dir and the appended dependency', () => {
  for (const f of [A, B]) {
    assert.equal(fs.lstatSync(path.join(f.root, 'kit')).isDirectory(), true, 'kit/ is a real copy, not a link');
    assert.equal(fs.lstatSync(path.join(f.root, 'node_modules')).isSymbolicLink(), true, 'only node_modules is linked');
    for (const gone of ['examples/brightside', 'profiles/brightside']) assert.equal(fs.existsSync(path.join(f.root, gone)), false, `${gone} deleted`);
  }
  const engine = listEngineFiles(A.root);
  assert.ok(engine.length > 50, 'the engine set is listed');
  assert.deepEqual(listEngineFiles(B.root), engine);

  const { differences, problems } = compareForks(A.root, B.root);
  assert.deepEqual(problems, []);
  assert.deepEqual(differences.filter((d) => d.area !== 'fork' && d.area !== 'package'), []);
  assert.deepEqual(differences, [
    { path: '.aplabs/context/org.md', change: 'changed', area: 'fork' },
    { path: '.aplabs/profile.yml', change: 'changed', area: 'fork' },
    { path: 'app/hubs/desk.json', change: 'only-in-b', area: 'fork' },
    { path: 'app/hubs/ops.json', change: 'only-in-a', area: 'fork' },
    ...['handler.js', 'handler.test.js', 'manifest.json'].map((file) => ({ path: `app/modules/rota-planner/${file}`, change: 'only-in-b', area: 'fork' })),
    ...['handler.js', 'handler.test.js', 'manifest.json'].map((file) => ({ path: `app/modules/weekly-report/${file}`, change: 'only-in-a', area: 'fork' })),
    { path: 'package-lock.json', change: 'changed', area: 'package' },
    { path: 'package.json', change: 'changed', area: 'package' },
  ]);

  const locks = (f) => ({ templateLock: TEMPLATE_LOCK, forkLock: readJson(path.join(f.root, 'package-lock.json')) });
  assert.deepEqual(packageDelta(TEMPLATE_PKG, readJson(path.join(A.root, 'package.json')), locks(A)), { appended: [], problems: [] });
  assert.deepEqual(packageDelta(TEMPLATE_PKG, readJson(path.join(B.root, 'package.json')), locks(B)), {
    appended: [{ section: 'dependencies', ...APPENDED }],
    problems: [],
  });
});

test('one byte changed under kit/ in one fork is reported, naming the file', () => {
  const rel = 'kit/runtime/paths.js';
  const file = path.join(B.root, rel);
  const original = fs.readFileSync(file);
  const edited = Buffer.from(original);
  edited[edited.length - 1] ^= 1;
  fs.writeFileSync(file, edited);
  try {
    const { problems } = compareForks(A.root, B.root);
    assert.deepEqual(problems, [`${rel}: differs between the forks (an engine file, identical in every fork)`]);
  } finally {
    fs.writeFileSync(file, original);
  }
  assert.deepEqual(compareForks(A.root, B.root).problems, []);
});

test('a dependency changed or removed in a fork, rather than appended, is reported, naming it', () => {
  const pkg = readJson(path.join(B.root, 'package.json'));
  const [first, second] = Object.keys(TEMPLATE_PKG.dependencies);
  const changed = { ...pkg, dependencies: { ...pkg.dependencies, [first]: '0.0.1' } };
  assert.deepEqual(packageDelta(TEMPLATE_PKG, changed).problems, [
    `package.json: dependencies "${first}" was changed (${TEMPLATE_PKG.dependencies[first]} to 0.0.1)`,
  ]);
  const removed = { ...pkg, dependencies: { ...pkg.dependencies } };
  delete removed.dependencies[second];
  assert.deepEqual(packageDelta(TEMPLATE_PKG, removed).problems, [`package.json: dependencies "${second}" was removed`]);
});

// Boots the fork's own copy of the runtime (its kit/, not this repo's):
// profile found from cwd (.aplabs/), app dir from APLABS_APP_DIR, fake Slack,
// no data file.
async function boot(t, f) {
  const { main } = require(path.join(f.root, 'kit/runtime/app'));
  const lines = [];
  const res = await main({
    env: { APLABS_NO_KEYCHAIN: '1', ...TOKENS, APLABS_APP_DIR: f.appDir, APLABS_DATA_PATH: path.join(f.root, 'no-data', 'stub.duckdb') },
    cwd: f.root,
    deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: () => assert.fail('no Keychain') },
  });
  if (res.data) t.after(() => res.data.close());
  assert.equal(res.code, 0, lines.join('\n'));
  res.app.users.UBO = { real_name: 'Bo', profile: { display_name: 'Bo', real_name: 'Bo' } };
  res.app.users.UCY = { real_name: 'Cy', profile: { display_name: 'Cy', real_name: 'Cy' } };
  return res.app;
}

// The Open action ids on the menu one person gets from a hub command.
async function menuFor(app, command, user_id) {
  const before = app.responded.length;
  await app.dispatchCommand(command, { user_id });
  const menu = app.responded[before];
  return menu.blocks.filter((b) => b.accessory && /^entry:/.test(b.block_id)).map((b) => b.accessory.action_id);
}

async function openReply(app, actionId, user) {
  await app.dispatchAction(actionId, { user });
  return app.responded.at(-1);
}

test('each fork boots offline and shows the same people its own client name, menu and access', async (t) => {
  const bo = { id: 'UBO', name: 'bo' };
  const cy = { id: 'UCY', name: 'cy' };

  const appA = await boot(t, A);
  assert.deepEqual([...appA.commandListeners.keys()], ['/ops'], 'fork A has only its own hub');
  assert.deepEqual(await menuFor(appA, '/ops', bo.id), ['weekly-report:open'], 'bo may use the weekly report in fork A');
  assert.deepEqual(await menuFor(appA, '/ops', cy.id), [], 'cy may not, in fork A');
  const replyA = await openReply(appA, 'weekly-report:open', bo);
  assert.equal(replyA.response_type, 'ephemeral');
  assert.match(replyA.text, /^Hi Bo, this is a new Stub Co tool/);

  const appB = await boot(t, B);
  assert.deepEqual([...appB.commandListeners.keys()], ['/desk'], 'fork B has only its own hub');
  assert.deepEqual(await menuFor(appB, '/desk', bo.id), [], 'bo may not use the rota planner in fork B');
  assert.deepEqual(await menuFor(appB, '/desk', cy.id), ['rota-planner:open'], 'cy may, in fork B');
  const replyB = await openReply(appB, 'rota-planner:open', cy);
  assert.match(replyB.text, /^Hi Cy, this is a new Bravo Ltd tool/);
  assert.doesNotMatch(JSON.stringify(appB.responded), /Stub Co|weekly-report/, 'nothing of fork A reaches fork B');
  assert.doesNotMatch(JSON.stringify(appA.responded), /Bravo Ltd|rota-planner/, 'nothing of fork B reaches fork A');
});

test('in each fork, the tier CLI follows that fork\'s profile', () => {
  const tierIn = (f, rel) => {
    const r = run(f, process.execPath, ['kit/lib/tier', rel]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).floor;
  };
  const moduleFile = 'app/modules/x/handler.js';
  assert.equal(tierIn(A, moduleFile), 'T2', 'fork A tiers its modules T2');
  assert.equal(tierIn(B, moduleFile), 'T1', 'fork B tiers its modules T1');
  for (const f of [A, B]) assert.equal(tierIn(f, 'kit/lib/gate/index.js'), 'T3', 'an engine floor is T3 in every fork');
});

test('in each fork, npm run verify runs that fork\'s own checks', () => {
  for (const [f, own, other] of [[A, 'stub-check', 'bravo-check'], [B, 'bravo-check', 'stub-check']]) {
    const r = run(f, 'npm', ['run', '--silent', 'verify']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`\\b${own}\\b`));
    assert.doesNotMatch(r.stdout, new RegExp(`\\b${other}\\b`));
    const summary = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.equal(summary.ok, true, r.stdout);
  }
});

test('in each fork, the write gate blocks an unplanned write by that fork\'s profile', () => {
  const gate = (f, rel) => run(f, 'bash', ['kit/hooks/write-gate.sh'], {
    env: { CLAUDE_PROJECT_DIR: f.root },
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'two-forks', cwd: f.root, tool_name: 'Write',
      tool_input: { file_path: path.join(f.root, rel), content: 'x' },
    }),
  });
  const reasonOf = (r) => {
    assert.equal(r.status, 0, r.stderr);
    if (!r.stdout) return null;
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
  };
  const target = (f) => `app/modules/${f.client.module.id}/handler.js`;

  // No work routed: blocked in both forks.
  for (const f of [A, B]) assert.match(reasonOf(gate(f, target(f))), /no edits in this repo until the work is routed/);

  // Work routed, but no plan: fork A tiers its modules T2, so a plan is
  // needed there; fork B tiers them T1, so the edit goes ahead.
  for (const f of [A, B]) {
    const r = run(f, process.execPath, ['kit/hooks/engage.js', '--reason', 'two-forks acceptance test']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  assert.match(reasonOf(gate(A, target(A))), /This is T2 work and no plan is recorded/);
  assert.equal(reasonOf(gate(B, target(B))), null);
});
