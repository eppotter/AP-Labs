'use strict';

// Story 6.5 (AD-4): `npm test` checks the fork's app dir the way boot does, so
// a bad manifest fails the test run naming the module file and the field, not
// only app startup. The app dir is APLABS_APP_DIR, else <repo>/app; the profile
// is APLABS_PROFILE, else .aplabs/profile.yml. The template repo has neither
// (its example app is checked by the example's own boot tests), so the check
// on this repo skips and says why; the same check runs on a temp fork below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('../../kit/runtime/registry');
const { loadProfile, findProfilePath } = require('../../kit/lib/profile');
const { makeFork, addModule, FILLED } = require('../fixtures/temp-fork');

const ROOT = path.resolve(__dirname, '../..');

// Returns { skip } when there is no app dir, else { problems }.
function checkAppDir(root, env) {
  const appDir = env.APLABS_APP_DIR || path.join(root, 'app');
  if (!fs.existsSync(appDir)) return { skip: `no app dir (APLABS_APP_DIR unset and no ${path.join(root, 'app')})` };
  const profilePath = findProfilePath(root, env);
  if (!profilePath) return { problems: ['an app dir exists but no profile was found (APLABS_PROFILE or .aplabs/profile.yml)'] };
  return { problems: loadRegistry({ appDir, profile: loadProfile(profilePath) }).problems };
}

test('this repo\'s app dir loads with no problems', (t) => {
  const r = checkAppDir(ROOT, process.env);
  if (r.skip) {
    t.skip(r.skip);
    return;
  }
  assert.deepEqual(r.problems, []);
});

test('the check passes a good fork and names the module and field in a bad one', (t) => {
  const f = makeFork();
  t.after(f.cleanup);
  addModule(f.appDir);
  const env = { APLABS_APP_DIR: f.appDir };
  assert.deepEqual(checkAppDir(f.root, env), { problems: [] });

  const file = path.join(f.appDir, 'modules', FILLED.id, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete m.resource;
  fs.writeFileSync(file, JSON.stringify(m));
  assert.deepEqual(checkAppDir(f.root, env).problems, [
    'modules/weekly-report/manifest.json: field "resource" is required',
  ]);
});
