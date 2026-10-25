'use strict';

// The job-imports check (Story 11.1, N2): npm run check fails a file under
// <app dir>/jobs/ that imports @slack/, #sdk or a connectors path, naming the
// file and line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { jobImportProblems } = require('../../kit/verify/job-imports');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-job-imports.js');

function tmpRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-job-imports-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const run = (root, env = {}) => spawnSync(process.execPath, [SCRIPT, '--root', root], {
  encoding: 'utf8', env: { ...process.env, APLABS_APP_DIR: '', ...env },
});

test('npm run check runs the job-imports check', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.check, /node scripts\/check-job-imports\.js/);
});

test('this repo passes the job-imports check', () => {
  assert.deepEqual(jobImportProblems(ROOT, { env: {} }), []);
});

test('a job importing Slack, #sdk or a connector fails, naming the file and line', (t) => {
  const root = tmpRoot(t);
  put(root, 'app/jobs/slack.js', "const { App } = require('@slack/bolt');\n");
  put(root, 'app/jobs/sdk.js', "// require('@slack/web-api') in a comment is fine\nconst sdk = require('#sdk');\n");
  put(root, 'app/jobs/nested/conn.mjs', "import crm from '../../connectors/crm/connector.js';\n");
  put(root, 'app/jobs/index-import.js', "const all = require('../connectors');\nconst web = await import('@slack/web-api');\n");
  put(root, 'app/jobs/fine.js', "const path = require('node:path');\nconst helper = require('./lib/helper');\n");
  // Outside jobs/ these imports are not this check's business.
  put(root, 'app/modules/m/handler.js', "const sdk = require('#sdk');\n");
  const problems = jobImportProblems(root, { env: {} });
  assert.deepEqual(problems.map((p) => p.split(': ')[0]), [
    'app/jobs/index-import.js:1',
    'app/jobs/index-import.js:2',
    'app/jobs/nested/conn.mjs:1',
    'app/jobs/sdk.js:2',
    'app/jobs/slack.js:1',
  ]);
  assert.match(problems[4], /imports Slack \("@slack\/bolt"\)/);
  assert.match(problems[3], /imports the module SDK \(#sdk\) \("#sdk"\)/);
  assert.match(problems[2], /imports a connector \("\.\.\/\.\.\/connectors\/crm\/connector\.js"\)/);
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /check-job-imports: 5 problem\(s\)/);
  assert.match(r.stderr, /app\/jobs\/slack\.js:1/);
});

test('APLABS_APP_DIR and package.json appDirs are scanned; a missing APLABS_APP_DIR fails', (t) => {
  const root = tmpRoot(t);
  const other = tmpRoot(t);
  put(other, 'jobs/x.js', "require('@slack/bolt');\n");
  put(root, 'examples/acme/app/jobs/y.js', "require('#sdk/x');\n");
  put(root, 'package.json', JSON.stringify({ name: 'x', aplabs: { appDirs: ['examples/*/app'] } }));
  const problems = jobImportProblems(root, { env: { APLABS_APP_DIR: other } });
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.startsWith('examples/acme/app/jobs/y.js:1')));
  assert.match(jobImportProblems(root, { env: { APLABS_APP_DIR: path.join(root, 'nope') } })[0], /APLABS_APP_DIR .* is not a directory/);
  const clean = tmpRoot(t);
  put(clean, 'app/jobs/ok.js', 'module.exports = { run: async () => {} };\n');
  const ok = run(clean);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /check-job-imports: ok/);
});
