'use strict';

// Boot smoke test (Story 6.5, run by scripts/clean-bones.sh): boots the real
// runtime (kit/runtime/app main()) in a throwaway fork with the stub profile
// (test/fixtures/fork/), one hub and the module template filled in, against a
// fake Slack client (no network, no tokens, no data file). Passes when boot
// succeeds, the hub menu lists the module and Open replies privately.
// Exits 0 on pass, 1 on fail.

const assert = require('node:assert/strict');
const path = require('node:path');
const { main } = require('../kit/runtime/app');
const { FakeSlackApp } = require('../test/fixtures/fake-slack');
const { makeFork, addModule, FILLED } = require('../test/fixtures/temp-fork');

async function smoke() {
  const f = makeFork();
  const lines = [];
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
      },
      cwd: f.root,
      deps: { App: FakeSlackApp, write: (line) => lines.push(line), readKeychain: () => null },
    });
    assert.equal(res.code, 0, `boot refused:\n${lines.join('\n')}`);
    const { app } = res;
    await app.dispatchCommand('/ops', { user_id: 'UBO' });
    const entries = app.responded[0].blocks.filter((b) => b.accessory && /^entry:/.test(b.block_id));
    assert.deepEqual(entries.map((b) => b.accessory.action_id), [`${FILLED.id}:open`], 'the hub menu lists the module');
    await app.dispatchAction(`${FILLED.id}:open`, { user: { id: 'UBO', name: 'bo' } });
    const reply = app.responded.at(-1);
    assert.equal(reply.response_type, 'ephemeral', 'Open replies privately');
  } finally {
    if (res && res.data) res.data.close();
    f.cleanup();
  }
}

smoke().then(
  () => console.log('boot smoke: ok (booted a stub fork, listed and opened the template module)'),
  (err) => {
    console.error(`boot smoke: FAILED\n${err.message}`);
    process.exitCode = 1;
  },
);
