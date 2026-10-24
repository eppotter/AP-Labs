'use strict';

// Onboarding (Story 4.1): the client file templates, `npm run onboard` (init
// and status) against temp repos, and the onboarding line in the session banner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  FILES, FIELDS, TEMPLATES_DIR, parseArgs, parseFrontmatter, contextStatus, initContext, bannerLine,
} = require('../../kit/lib/onboard');
const { sessionStart } = require('../../kit/lib/session');

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'kit/onboard/cli.js');
const fixture = (name) => path.join(__dirname, '../fixtures/profiles', `${name}.yml`);

const tmpDirs = [];
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aplabs-onboard-'));
  tmpDirs.push(d);
  return d;
}

// A temp repo, governed (with the minimal fixture profile) unless told otherwise.
function repo({ governed = true } = {}) {
  const d = tmpDir();
  if (governed) {
    fs.mkdirSync(path.join(d, '.aplabs'));
    fs.copyFileSync(fixture('minimal'), path.join(d, '.aplabs/profile.yml'));
  }
  return d;
}

const ctx = (d) => path.join(d, '.aplabs/context');

function writeContext(d, file, front) {
  fs.mkdirSync(ctx(d), { recursive: true });
  fs.writeFileSync(path.join(ctx(d), file), `---\n${front}\n---\n\n# body\n`);
}
const SIGNED = 'owner: Pat Lee\nsigned_off: 2026-10-01\nsigned_off_by: Pat Lee\nupdated: 2026-10-01';
const PENDING = 'owner: Pat Lee\nsigned_off: pending\nsigned_off_by: ""\nupdated: 2026-10-01';

// Runs the CLI with a clean env so an APLABS_PROFILE from the shell cannot leak in.
function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('there is one template per client file, each with valid pending frontmatter', () => {
  assert.deepEqual(fs.readdirSync(TEMPLATES_DIR).sort(), [...FILES].sort());
  for (const f of FILES) {
    const { data, error } = parseFrontmatter(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8'));
    assert.equal(error, undefined, `${f}: ${error}`);
    assert.deepEqual(Object.keys(data), FIELDS, f);
    assert.equal(data.signed_off, 'pending', f);
  }
});

test('templates carry the sections their specialists load', () => {
  const read = (f) => fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8');
  const has = (f, headings) => headings.forEach((h) => assert.match(read(f), new RegExp(`^## ${h}$`, 'm'), `${f}: ${h}`));
  has('data.md', ['Data model', 'Approved sources', 'Grain notes', 'Join patterns', 'Terminology', 'Deprecated sources', 'Known truths']);
  has('guardrails.md', ['Guardrails', 'Protected systems', 'Write paths', 'Approvers', 'Cost limits', 'Rule cards']);
  has('connectors.md', ['Systems', 'Missing connections']);
  has('org.md', ['What the company does', 'Teams', 'Tools and systems', 'Vocabulary']);
  assert.match(read('data.md'), /## Known truths\n\nEach known truth is a fenced block/);
  assert.match(read('guardrails.md'), /- rule:[\s\S]*- owner:[\s\S]*- evidence:[\s\S]*- status:/);
});

test('parseFrontmatter rejects missing frontmatter, missing fields and bad dates', () => {
  assert.match(parseFrontmatter('# no front\n').error, /no frontmatter/);
  assert.match(parseFrontmatter('---\nowner: x\n---\n').error, /missing signed_off, signed_off_by, updated/);
  assert.match(parseFrontmatter('---\nowner: x\nsigned_off: soon\nsigned_off_by: x\nupdated: x\n---\n').error, /ISO date/);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-04-31', '2025-02-29']) {
    assert.match(parseFrontmatter(`---\nowner: x\nsigned_off: ${bad}\nsigned_off_by: x\nupdated: x\n---\n`).error, /real ISO date/, bad);
  }
  assert.equal(parseFrontmatter('---\nowner: x\nsigned_off: 2028-02-29\nsigned_off_by: x\nupdated: x\n---\n').data.signed_off, '2028-02-29');
  assert.match(parseFrontmatter('---\nowner: [unclosed\n---\n').error, /not valid YAML/);
  assert.match(parseFrontmatter('---\n- a\n---\n').error, /not a mapping/);
  assert.equal(parseFrontmatter(`---\n${SIGNED}\n---\n`).data.signed_off, '2026-10-01');
});

test('parseArgs: one of --init or --status; anything else is a usage error', () => {
  assert.deepEqual(parseArgs(['--init']), { mode: 'init' });
  assert.deepEqual(parseArgs(['--status']), { mode: 'status' });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.match(parseArgs([]).error, /pass --init or --status/);
  assert.match(parseArgs(['--init', '--status']).error, /only one/);
  assert.match(parseArgs(['--bogus']).error, /unknown argument: --bogus/);
});

test('init: a governed repo gets the four files with valid frontmatter', () => {
  const d = repo();
  const r = run(['--init'], d);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /created org\.md, data\.md, guardrails\.md, connectors\.md; kept nothing/);
  for (const f of FILES) {
    const text = fs.readFileSync(path.join(ctx(d), f), 'utf8');
    assert.equal(text, fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8'));
    assert.equal(parseFrontmatter(text).error, undefined);
  }
});

test('init: a re-run keeps every file, and never overwrites an edited one', () => {
  const d = repo();
  run(['--init'], d);
  writeContext(d, 'data.md', SIGNED);
  fs.rmSync(path.join(ctx(d), 'org.md'));
  const before = fs.readFileSync(path.join(ctx(d), 'data.md'), 'utf8');
  const r = run(['--init'], d);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /created org\.md; kept data\.md, guardrails\.md, connectors\.md/);
  assert.equal(fs.readFileSync(path.join(ctx(d), 'data.md'), 'utf8'), before);
  assert.deepEqual(initContext(ctx(d)), { created: [], kept: FILES });
});

test('init and status: an ungoverned repo is refused with exit 2', () => {
  const d = repo({ governed: false });
  for (const flag of ['--init', '--status']) {
    const r = run([flag], d);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not a governed repo/);
  }
  assert.equal(fs.existsSync(ctx(d)), false);
});

test('cli: unknown flags and no flag exit 2 with usage', () => {
  const d = repo();
  for (const args of [['--bogus'], [], ['--init', '--status']]) {
    const r = run(args, d);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /usage: npm run onboard/);
  }
});

test('status: per file, present or missing, owner and sign-off; exit 0', () => {
  const d = repo();
  writeContext(d, 'data.md', SIGNED);
  writeContext(d, 'guardrails.md', PENDING);
  fs.writeFileSync(path.join(ctx(d), 'connectors.md'), '# no frontmatter\n');
  const sub = path.join(d, 'src');
  fs.mkdirSync(sub);
  const r = run(['--status'], sub);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, [
    `${path.join('..', '.aplabs/context')}:`,
    'org.md: missing',
    'data.md: present, owner Pat Lee, signed off 2026-10-01',
    'guardrails.md: present, owner Pat Lee, awaiting sign-off',
    'connectors.md: present, no frontmatter',
    '',
  ].join('\n'));
});

test('a dated sign-off with no signer still counts as awaiting sign-off', () => {
  const d = repo();
  writeContext(d, 'org.md', 'owner: ""\nsigned_off: 2026-10-01\nsigned_off_by: ""\nupdated: ""');
  const [org] = contextStatus(ctx(d));
  assert.deepEqual(org, { file: 'org.md', present: true, owner: null, signedOff: '2026-10-01', signed: false });
});

test('bannerLine: counts missing and pending files; silent when all are signed', () => {
  const d = repo();
  assert.equal(bannerLine(contextStatus(ctx(d))), 'Onboarding: 4 of 4 client files missing — run an onboarding build');
  writeContext(d, 'org.md', SIGNED);
  writeContext(d, 'data.md', PENDING);
  assert.equal(bannerLine(contextStatus(ctx(d))),
    'Onboarding: 2 of 4 client files missing, 1 awaiting sign-off — run an onboarding build');
  writeContext(d, 'guardrails.md', PENDING);
  writeContext(d, 'connectors.md', SIGNED);
  assert.equal(bannerLine(contextStatus(ctx(d))), 'Onboarding: 2 of 4 client files awaiting sign-off — run an onboarding build');
  writeContext(d, 'data.md', SIGNED);
  writeContext(d, 'guardrails.md', SIGNED);
  assert.equal(bannerLine(contextStatus(ctx(d))), null);
});

test('session banner: adds the onboarding line for missing or pending files', () => {
  const d = repo();
  let out = sessionStart(d);
  assert.equal(out.systemMessage.split('\n')[1], 'Onboarding: 4 of 4 client files missing — run an onboarding build');
  assert.match(out.hookSpecificOutput.additionalContext.split('\n')[3],
    /^Onboarding: 4 of 4 client files missing — run an onboarding build \(npm run onboard -- --status/);

  run(['--init'], d);
  out = sessionStart(d);
  assert.equal(out.systemMessage.split('\n')[1], 'Onboarding: 4 of 4 client files awaiting sign-off — run an onboarding build');
});

test('session banner: silent about onboarding once all four files are signed off', () => {
  const d = repo();
  for (const f of FILES) writeContext(d, f, SIGNED);
  const out = sessionStart(d);
  assert.ok(!out.systemMessage.includes('\n'));
  assert.ok(!/Onboarding/.test(out.hookSpecificOutput.additionalContext));
  assert.equal(out.hookSpecificOutput.additionalContext.split('\n').length, 3);
});
