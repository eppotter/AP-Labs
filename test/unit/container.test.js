'use strict';

// Story 11.2: the container. The static check of the recipe (Dockerfile,
// .dockerignore and the CI `container` job) runs everywhere. Each rule is
// also run against a bad recipe, so a rule that can't fail is caught.
//
// The image build test runs only where docker is present AND
// APLABS_DOCKER_TEST=1 (Q10); otherwise node:test reports it as skipped, with
// the reason, never as passed. It runs the CI job's own build and smoke steps,
// so the two can't drift. CI builds the image in its own job.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const REPO = path.join(__dirname, '..', '..');
const DOCKERFILE = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
const DOCKERIGNORE = fs.readFileSync(path.join(REPO, '.dockerignore'), 'utf8');
const CI = YAML.parse(fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8'));

// --- reading a Dockerfile -------------------------------------------------------

// Instructions as { op, args }, with comment lines dropped and line
// continuations joined.
function instructions(text) {
  const lines = text.split('\n').filter((l) => !/^\s*#/.test(l));
  const joined = lines.join('\n').replace(/\\\n/g, ' ');
  return joined.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(\S+)\s*(.*)$/.exec(l);
      return { op: m[1].toUpperCase(), args: m[2].trim() };
    });
}

// The names an ENV or ARG instruction sets.
function namesSet({ op, args }) {
  if (op === 'ARG') return [args.split('=')[0].trim()];
  if (op !== 'ENV') return [];
  if (!args.includes('=')) return [args.split(/\s+/)[0]];
  return [...args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]);
}

// ENV values by name.
function envValues(ins) {
  const out = {};
  for (const i of ins.filter((x) => x.op === 'ENV')) {
    for (const m of i.args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|\S*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

// --- the rules -------------------------------------------------------------------

const SECRET_SEGMENTS = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'PASS'];
const SECRET_PARTS = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD'];
// The one named exception: it switches the Keychain off; it holds no secret.
const NAME_EXCEPTIONS = Object.freeze(['APLABS_NO_KEYCHAIN']);
const TOKEN_SHAPES = Object.freeze([
  /xox[abp]-/,
  /xapp-/,
  /sk-ant-/,
  // A MotherDuck token is a JWT: base64url header, payload and signature.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
]);
const BASE = /^--platform=linux\/amd64\s+node:24-bookworm-slim@sha256:[0-9a-f]{64}$/;
const INSTALLER = /^node scripts\/install-duckdb-extensions\.js(?: --extension-dir \/[^\s'";&|`$]+)?$/;

// A secret-looking ENV or ARG name: a _-separated segment equal to TOKEN,
// KEY, SECRET, PASSWORD or PASS, or TOKEN, KEY, SECRET or PASSWORD anywhere
// in it (which covers ending in _KEY or _TOKEN), except the named exception.
function secretName(name) {
  if (NAME_EXCEPTIONS.includes(name)) return false;
  const upper = name.toUpperCase();
  return upper.split('_').some((s) => SECRET_SEGMENTS.includes(s)) || SECRET_PARTS.some((p) => upper.includes(p));
}

// Every problem with a Dockerfile's text, as words. [] = passes.
function dockerfileProblems(text) {
  const ins = instructions(text);
  const problems = [];
  const of = (op) => ins.filter((i) => i.op === op);

  const froms = of('FROM');
  if (froms.length !== 1 || !BASE.test(froms[0].args)) problems.push('one FROM: node:24-bookworm-slim for linux/amd64, pinned by sha256 digest');
  if (!/glibc/.test(text) || !/not Alpine/.test(text)) problems.push('the base image has its one-line reason (glibc, not Alpine)');
  if (!/Digest source:/.test(text)) problems.push('the digest says where it came from');

  for (const i of [...of('ENV'), ...of('ARG')]) {
    for (const name of namesSet(i)) {
      if (secretName(name)) problems.push(`${i.op} ${name} looks like a secret`);
      if (['APLABS_PROFILE', 'APLABS_APP_DIR'].includes(name)) problems.push(`${name} is set by whoever runs the image, never baked in`);
    }
  }
  for (const shape of TOKEN_SHAPES) if (shape.test(text)) problems.push(`a value matches a token shape (${shape.source})`);

  const env = envValues(ins);
  if (env.APLABS_NO_KEYCHAIN !== '1') problems.push('APLABS_NO_KEYCHAIN=1 is set');
  if (!env.APLABS_VAR_DIR || !env.APLABS_VAR_DIR.startsWith('/')) problems.push('APLABS_VAR_DIR is set to an absolute folder');

  for (const i of [...of('COPY'), ...of('ADD')]) {
    if (/--chown\b/.test(i.args)) problems.push(`${i.op} --chown (the app files stay root-owned)`);
    if (/(^|\s|\/)\.env/.test(i.args)) problems.push(`${i.op} of a .env file`);
    if (/node_modules/.test(i.args)) problems.push(`${i.op} of node_modules (install it in the image)`);
  }
  if (of('ADD').length) problems.push('ADD (use COPY)');

  const runs = of('RUN');
  if (!runs.some((r) => /(^|&&\s*|;\s*)npm ci\b/.test(r.args))) problems.push('npm ci installs the dependencies');
  const workdir = (of('WORKDIR').at(-1) || { args: '/app' }).args;
  const appDir = new RegExp(`\\bchown\\b[^;&|]*\\s(\\.|${workdir.replace(/[/.]/g, '\\$&')})(/\\S*)?(\\s|$)`);
  for (const r of runs) {
    if (appDir.test(r.args)) problems.push(`RUN chown of the app dir (${workdir})`);
    if (/\bnode\s+(-e|--eval|-p|--print)\b/.test(r.args)) problems.push('RUN with inline node code');
    if (/duckdb/i.test(r.args) && !INSTALLER.test(r.args)) problems.push('DuckDB code inlined in a RUN line (use scripts/install-duckdb-extensions.js)');
  }
  if (!runs.some((r) => INSTALLER.test(r.args))) problems.push('scripts/install-duckdb-extensions.js installs the extensions');

  const users = of('USER');
  const lastUser = users.length ? users.at(-1).args.split(':')[0] : 'root';
  if (['root', '0'].includes(lastUser)) problems.push('a non-root USER runs the app');
  const lastUserAt = ins.lastIndexOf(users.at(-1));
  if (users.length && ins.slice(lastUserAt).some((i) => i.op === 'RUN' || i.op === 'COPY')) problems.push('nothing is built or copied after the runtime USER');

  const cmds = of('CMD');
  let cmd = null;
  try { cmd = cmds.length === 1 ? JSON.parse(cmds[0].args) : null; } catch { cmd = null; }
  if (!Array.isArray(cmd) || cmd.join(' ') !== 'node kit/runtime/app') problems.push('CMD is ["node", "kit/runtime/app"] in exec form');
  if (of('ENTRYPOINT').length) problems.push('no ENTRYPOINT (the CMD runs node directly)');
  return problems;
}

const KEPT_OUT = Object.freeze([
  'node_modules', '.git', 'var/', '.env*', '*.duckdb', '.claude/', '.codex/', '.agents/', '_bmad/', 'docs/', '.aplabs/context/', 'test/',
]);

function dockerignoreProblems(text) {
  const lines = new Set(text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  const problems = KEPT_OUT.filter((e) => !lines.has(e)).map((e) => `.dockerignore keeps out ${e}`);
  for (const l of lines) if (l.startsWith('!')) problems.push(`.dockerignore re-includes ${l.slice(1)}`);
  return problems;
}

// The CI job: plain docker, no third-party actions, read-only token, no
// secrets, no build args; the smoke run is offline and read-only.
function ciJobProblems(job, varDir) {
  if (!job) return ['a `container` job in ci.yml'];
  const problems = [];
  if (JSON.stringify(job.permissions) !== JSON.stringify({ contents: 'read' })) problems.push('permissions: contents: read');
  const steps = job.steps || [];
  for (const s of steps) {
    if (s.uses && !/^actions\/checkout@v\d+$/.test(s.uses)) problems.push(`no third-party actions (${s.uses})`);
    if (s.with) problems.push('no action inputs');
  }
  const text = JSON.stringify(job);
  if (/secrets\./.test(text)) problems.push('no secrets');
  if (/--build-arg/.test(text)) problems.push('no --build-arg');
  if (job.env || steps.some((s) => s.env)) problems.push('no env (no tokens reach the job)');
  const runs = steps.filter((s) => s.run).map((s) => s.run);
  if (!runs.some((r) => /^docker build\b/m.test(r.trim()))) problems.push('a plain docker build step');
  const smoke = runs.find((r) => /docker run\b/.test(r) && /node scripts\/container-smoke\.js/.test(r));
  if (!smoke) return [...problems, 'a docker run step for scripts/container-smoke.js'];
  const need = ['--network none', '--read-only', '--tmpfs /tmp', `--tmpfs ${varDir}`];
  for (const flag of need) if (!smoke.includes(flag)) problems.push(`the smoke run uses ${flag}`);
  if (!/(-v|--volume) "?\$PWD\/test\/fixtures:\/app\/test\/fixtures:ro"?/.test(smoke)) problems.push('the fixtures are mounted read-only');
  return problems;
}

// --- the checks on this repo's recipe ------------------------------------------

test('the Dockerfile passes the static check', () => {
  assert.deepEqual(dockerfileProblems(DOCKERFILE), []);
});

test('.dockerignore keeps out dependencies, git, data, secrets, agent folders, docs, client context and tests', () => {
  assert.deepEqual(dockerignoreProblems(DOCKERIGNORE), []);
});

test('the CI container job builds and smoke-tests the image offline, read-only, with no secrets', () => {
  const varDir = envValues(instructions(DOCKERFILE)).APLABS_VAR_DIR;
  assert.deepEqual(ciJobProblems(CI.jobs.container, varDir), []);
});

test('the existing CI jobs are still there', () => {
  assert.ok(CI.jobs.test && CI.jobs['clean-bones'], 'test and clean-bones jobs');
});

// --- each rule can fail ------------------------------------------------------------

// Applies edit(text) to the real Dockerfile and expects a problem matching re.
function expectProblem(edit, re) {
  const text = edit(DOCKERFILE);
  assert.notEqual(text, DOCKERFILE, `the edit for ${re} changed nothing`);
  const problems = dockerfileProblems(text);
  assert.ok(problems.some((p) => re.test(p)), `${re} not in ${JSON.stringify(problems)}`);
}

const addEnv = (line) => (t) => t.replace('WORKDIR /app', `${line}\nWORKDIR /app`);

test('secret-looking ENV and ARG names are refused; APLABS_NO_KEYCHAIN is the one exception', () => {
  for (const name of ['SLACK_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'MOTHERDUCK_TOKEN', 'DB_PASSWORD', 'DB_PASS', 'CLIENT_SECRET', 'APIKEY', 'MYTOKEN', 'KEY']) {
    assert.equal(secretName(name), true, name);
    expectProblem(addEnv(`ENV ${name}=x`), new RegExp(`ENV ${name} looks like a secret`));
    expectProblem(addEnv(`ARG ${name}`), new RegExp(`ARG ${name} looks like a secret`));
  }
  expectProblem(addEnv('ENV A=1 SLACK_APP_TOKEN=x'), /SLACK_APP_TOKEN looks like a secret/);
  expectProblem(addEnv('ENV OTHER_TOKEN x'), /OTHER_TOKEN looks like a secret/);
  for (const name of ['APLABS_NO_KEYCHAIN', 'NODE_ENV', 'APLABS_VAR_DIR', 'HOME', 'PASSAGE_DIR']) assert.equal(secretName(name), false, name);
  assert.equal(secretName('APLABS_NO_KEYCHAINS'), true, 'the exception is exact');
});

test('a token-shaped value anywhere in the Dockerfile is refused', () => {
  // Built from parts, so this file holds no token shape either.
  for (const v of [['xo', 'xb-1'], ['xo', 'xp-1'], ['xa', 'pp-1-A'], ['sk', '-ant-api03'], ['eyJhbGciOiJI', 'UzI1NiJ9.eyJzdWIiOiIx']]) {
    expectProblem(addEnv(`ENV SOMETHING=${v.join('')}`), /token shape/);
  }
});

test('the recipe rules: base image, env-only, copies, install, user, command', () => {
  expectProblem((t) => t.replace(/@sha256:[0-9a-f]{64}/, ''), /pinned by sha256 digest/);
  expectProblem((t) => t.replace('node:24-bookworm-slim@', 'node:24-alpine@'), /node:24-bookworm-slim/);
  expectProblem((t) => t.replace('--platform=linux/amd64 ', ''), /linux\/amd64/);
  expectProblem((t) => t.replace('APLABS_NO_KEYCHAIN=1', 'APLABS_NO_KEYCHAIN=0'), /APLABS_NO_KEYCHAIN=1/);
  expectProblem(addEnv('ENV APLABS_PROFILE=/p.yml'), /APLABS_PROFILE is set by whoever runs/);
  expectProblem(addEnv('ENV APLABS_APP_DIR=/app/app'), /APLABS_APP_DIR is set by whoever runs/);
  expectProblem((t) => t.replace('COPY . .', 'COPY .env* ./\nCOPY . .'), /\.env file/);
  expectProblem((t) => t.replace('COPY . .', 'COPY node_modules ./node_modules\nCOPY . .'), /node_modules/);
  expectProblem((t) => t.replace('COPY . .', 'COPY --chown=node:node . .'), /--chown/);
  expectProblem((t) => t.replace('COPY . .', 'ADD . .'), /ADD \(use COPY\)/);
  expectProblem((t) => t.replace('npm ci --omit=dev', 'npm install --omit=dev'), /npm ci/);
  expectProblem((t) => t.replace('chown node:node /var/lib/aplabs', 'chown -R node:node /app'), /chown of the app dir/);
  expectProblem((t) => t.replace('chown node:node /var/lib/aplabs', 'chown -R node .'), /chown of the app dir/);
  expectProblem((t) => t.replace('chown node:node /var/lib/aplabs', 'chown node /app/kit'), /chown of the app dir/);
  expectProblem((t) => t.replace('USER node', 'USER root'), /non-root USER/);
  expectProblem((t) => t.replace('USER node', ''), /non-root USER/);
  expectProblem((t) => t.replace('CMD ["node", "kit/runtime/app"]', 'CMD node kit/runtime/app'), /exec form/);
  expectProblem((t) => t.replace('USER node', 'USER node\nRUN true'), /after the runtime USER/);
});

test('DuckDB code is never inlined in a RUN line; the installer script is mandatory', () => {
  expectProblem((t) => t.replace(/RUN node scripts\/install-duckdb-extensions\.js[^\n]*/, 'RUN true'), /install-duckdb-extensions\.js installs/);
  expectProblem((t) => t.replace('RUN mkdir', 'RUN node -e "require(\'@duckdb/node-api\')" && mkdir'), /inline node code|DuckDB code inlined/);
  expectProblem((t) => t.replace('RUN mkdir', 'RUN echo "INSTALL motherduck" | duckdb && mkdir'), /DuckDB code inlined/);
  expectProblem((t) => t.replace('--extension-dir /home/node/.duckdb/extensions', '--extension-dir /x; curl evil'), /DuckDB code inlined|installs the extensions/);
});

test('.dockerignore: each required entry is checked, and nothing is re-included', () => {
  for (const e of KEPT_OUT) {
    const text = DOCKERIGNORE.split('\n').filter((l) => l.trim() !== e).join('\n');
    assert.ok(dockerignoreProblems(text).some((p) => p.endsWith(e)), e);
  }
  assert.ok(dockerignoreProblems(`${DOCKERIGNORE}\n!docs/\n`).some((p) => /re-includes docs/.test(p)));
});

test('the CI job rules can each fail', () => {
  const job = CI.jobs.container;
  const varDir = envValues(instructions(DOCKERFILE)).APLABS_VAR_DIR;
  const fails = (edit, re) => {
    const copy = JSON.parse(JSON.stringify(job));
    edit(copy);
    const problems = ciJobProblems(copy, varDir);
    assert.ok(problems.some((p) => re.test(p)), `${re} not in ${JSON.stringify(problems)}`);
  };
  const smokeStep = (j) => j.steps.find((s) => s.run && /container-smoke/.test(s.run));
  fails((j) => { j.permissions = { contents: 'write' }; }, /contents: read/);
  fails((j) => { delete j.permissions; }, /contents: read/);
  fails((j) => { j.steps.push({ uses: 'docker/build-push-action@v6' }); }, /third-party/);
  fails((j) => { j.steps.push({ run: 'echo ${{ secrets.X }}' }); }, /no secrets/);
  fails((j) => { j.steps[1].run += ' --build-arg A=1'; }, /--build-arg/);
  fails((j) => { j.env = { A: '1' }; }, /no env/);
  fails((j) => { smokeStep(j).run = smokeStep(j).run.replace('--network none', ''); }, /--network none/);
  fails((j) => { smokeStep(j).run = smokeStep(j).run.replace('--read-only', ''); }, /--read-only/);
  fails((j) => { smokeStep(j).run = smokeStep(j).run.replace(/:ro"/, '"'); }, /read-only/);
  assert.deepEqual(ciJobProblems(undefined, varDir), ['a `container` job in ci.yml']);
});

// --- the installer script, offline -------------------------------------------------

test('install-duckdb-extensions: installs motherduck; its arguments are checked', () => {
  const { parseArgs, EXTENSIONS } = require('../../scripts/install-duckdb-extensions');
  assert.deepEqual(EXTENSIONS, ['motherduck']);
  assert.deepEqual(parseArgs([]), { extensionDir: null });
  assert.deepEqual(parseArgs(['--extension-dir', '/home/node/.duckdb/extensions']), { extensionDir: '/home/node/.duckdb/extensions' });
  assert.throws(() => parseArgs(['--extension-dir', 'relative']), /absolute/);
  assert.throws(() => parseArgs(['--extension-dir', "/x'y"]), /quote/);
  assert.throws(() => parseArgs(['--surprise']), /unknown argument/);
});

// --- the smoke script's MotherDuck extension checks (DEP-016) --------------------------

// The CI failure text of an offline LOAD motherduck (2026-10-25), and the same
// line as raw DuckDB prints it, before paths are reduced to file names.
const INIT_NET_CI = 'Invalid Input Error: Initialization function "motherduck_duckdb_cpp_init" from file "motherduck.duckdb_extension" threw an exception: "Failed to download "http:api.motherduck.com/extension_version" (attempt 5): Could not establish connection"';
const INIT_NET_RAW = 'Invalid Input Error: Initialization function "motherduck_duckdb_cpp_init" from file "/home/node/.duckdb/extensions/v1.5.6/linux_amd64/motherduck.duckdb_extension" threw an exception: "Failed to download "http://api.motherduck.com/extension_version" (attempt 5): Could not establish connection"';

test('classifyOfflineLoad: accepts only the init failing on MotherDuck\'s network call', () => {
  const { classifyOfflineLoad } = require('../../scripts/container-smoke');
  assert.equal(classifyOfflineLoad(INIT_NET_CI), 'needs_network');
  assert.equal(classifyOfflineLoad(INIT_NET_RAW), 'needs_network');
  assert.equal(classifyOfflineLoad(INIT_NET_CI.replace('Could not establish connection', 'Could not resolve host: api.motherduck.com')), 'needs_network');

  const cases = [
    ['IO Error: Extension "motherduck.duckdb_extension" not found.', 'missing'],
    ['Catalog Error: Extension "motherduck" is not installed', 'missing'],
    ['IO Error: Failed to install extension "motherduck": autoinstall_known_extensions is disabled', 'install'],
    ['Extension Autoloading Error: An error occurred while trying to automatically install the required extension \'motherduck\'', 'install'],
    ['HTTP Error: Failed to download extension "motherduck" at URL "http:extensions.duckdb.org/v1.5.6/linux_amd64/motherduck.duckdb_extension.gz" (HTTP 0)', 'install'],
    ['IO Error: Failed to download extension from repository "core"', 'install'],
    ['Invalid Input Error: Initialization function "motherduck_duckdb_cpp_init" from file "motherduck.duckdb_extension" threw an exception: "Failed to download "http:extensions.duckdb.org/x" (attempt 5): Could not establish connection"', 'install'],
    ['Invalid Input Error: Extension "motherduck.duckdb_extension" was built for DuckDB version v1.4.0, but we can only load extensions built for DuckDB version v1.5.6.', 'other'],
    ['Invalid Input Error: Initialization function "motherduck_duckdb_cpp_init" from file "motherduck.duckdb_extension" threw an exception: "Invalid token"', 'other'],
    ['Invalid Input Error: Initialization function "motherduck_duckdb_cpp_init" from file "motherduck.duckdb_extension" threw an exception: "Failed to download "http:api.motherduck.com/extension_version" (attempt 5): HTTP 500"', 'other'],
    ['Invalid Input Error: Initialization function "other_init" from file "other.duckdb_extension" threw an exception: "Failed to download "http:api.motherduck.com/extension_version" (attempt 5): Could not establish connection"', 'other'],
    [`${INIT_NET_CI} and then something else`, 'other'],
    ['Out of Memory Error: failed to allocate', 'other'],
    ['', 'other'],
    [undefined, 'other'],
  ];
  for (const [reason, kind] of cases) assert.equal(classifyOfflineLoad(reason), kind, String(reason));
});

test('extensionFolderProblems: both MotherDuck files, in $HOME/.duckdb/extensions/<pinned version>/<platform>', () => {
  const { extensionFolderProblems } = require('../../scripts/container-smoke');
  const dir = '/home/node/.duckdb/extensions/v1.5.6/linux_amd64';
  const good = () => ({
    version: 'v1.5.6',
    platform: 'linux_amd64',
    extensions: [
      { name: 'motherduck', installed: true, installPath: `${dir}/motherduck.duckdb_extension` },
      { name: 'motherduck_impl', installed: true, installPath: `${dir}/motherduck_impl.v1.5.6-2026-10-707.duckdb_extension` },
    ],
  });
  const opts = { pinned: '1.5.6-r.2', home: '/home/node', isFile: () => true };
  assert.deepEqual(extensionFolderProblems(good(), opts), []);

  const wrongVersion = { ...good(), version: 'v1.4.0' };
  assert.match(extensionFolderProblems(wrongVersion, opts).join('\n'), /not the pinned v1\.5\.6/);
  const noImpl = good();
  noImpl.extensions[1] = { name: 'motherduck_impl', installed: false, installPath: '' };
  assert.deepEqual(extensionFolderProblems(noImpl, opts), ['motherduck_impl is not installed']);
  const elsewhere = good();
  elsewhere.extensions[0].installPath = '/root/.duckdb/extensions/v1.5.6/linux_amd64/motherduck.duckdb_extension';
  assert.match(extensionFolderProblems(elsewhere, opts).join('\n'), /motherduck is at \/root/);
  const builtIn = good();
  builtIn.extensions[0].installPath = '(BUILT-IN)';
  assert.match(extensionFolderProblems(builtIn, opts).join('\n'), /motherduck is at/);
  assert.deepEqual(extensionFolderProblems(good(), { ...opts, isFile: () => false }), [
    `motherduck file is missing: ${dir}/motherduck.duckdb_extension`,
    `motherduck_impl file is missing: ${dir}/motherduck_impl.v1.5.6-2026-10-707.duckdb_extension`,
  ]);
  assert.match(extensionFolderProblems(good(), { ...opts, pinned: 'latest' }).join('\n'), /cannot read the pinned/);
});

// --- the smoke script's boot checks, outside the image --------------------------------

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('the container smoke script boots the runtime and checks /healthz (--boot-only, outside the image)', async () => {
  const port = await freePort();
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/container-smoke.js'), '--boot-only'], {
    cwd: REPO,
    env: { PATH: process.env.PATH, APLABS_HEALTH_PORT: String(port) },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /\/healthz is 200 after the grace, because Slack connected/);
  assert.match(r.stdout, /\/healthz is 503 after an outage over 60 seconds/);
  assert.match(r.stdout, /container smoke: PASSED/);
});

// --- the image build, only where docker is ---------------------------------------------

function dockerPresent() {
  const r = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 10000 });
  return !r.error && r.status === 0;
}

// Why the build test is skipped, or null to run it.
function dockerSkipReason({ env = process.env, hasDocker = dockerPresent } = {}) {
  if (!hasDocker()) return 'docker not installed';
  if (env.APLABS_DOCKER_TEST !== '1') return 'set APLABS_DOCKER_TEST=1 to build the image';
  return null;
}

test('the build test runs only with docker present AND APLABS_DOCKER_TEST=1', () => {
  assert.equal(dockerSkipReason({ env: { APLABS_DOCKER_TEST: '1' }, hasDocker: () => false }), 'docker not installed');
  assert.equal(dockerSkipReason({ env: {}, hasDocker: () => true }), 'set APLABS_DOCKER_TEST=1 to build the image');
  assert.equal(dockerSkipReason({ env: { APLABS_DOCKER_TEST: 'true' }, hasDocker: () => true }), 'set APLABS_DOCKER_TEST=1 to build the image');
  assert.equal(dockerSkipReason({ env: { APLABS_DOCKER_TEST: '1' }, hasDocker: () => true }), null);
});

const SKIP = dockerSkipReason();
test('the image builds and its smoke test passes inside it (the CI job\'s own steps)', { skip: SKIP || false, timeout: 20 * 60 * 1000 }, () => {
  const steps = CI.jobs.container.steps.filter((s) => s.run);
  for (const s of steps) {
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', s.run], { cwd: REPO, encoding: 'utf8', timeout: 20 * 60 * 1000 });
    assert.equal(r.status, 0, `${s.name} failed:\n${r.stdout}\n${r.stderr}`);
  }
});
