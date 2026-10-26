'use strict';

// Story 11.4: the engagement fork guide (docs/fork-guide.md) stays true to the
// repo. Every `npm run` script it names is in package.json, and every
// repo-relative path it names (in backticks, or as a word in a code block)
// exists, or is one the fork creates or deletes in a step the guide describes
// (listed below with the reason). It also checks the parts the plan requires:
// the template-history stop sign first, cloning at a tag with `upstream`, the
// list of files a fork never edits (review B10), the profile example's tier
// rows (app/jobs at T2 or higher, review N2), the "you, not the agent"
// marks and the template update section (Story 11.6).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { validateProfile } = require('../../kit/lib/profile');
const { tierOf } = require('../../kit/lib/tier');
const { referencePatterns, isExcluded, REFERENCE_DIR } = require('../../kit/lib/dist');

const REPO = path.join(__dirname, '../..');
const GUIDE = fs.readFileSync(path.join(REPO, 'docs/fork-guide.md'), 'utf8');
const SCRIPTS = require('../../package.json').scripts;

// Paths a fork creates. Each is made by a step of the guide, so it does not
// exist in the template.
const FORK_CREATED = Object.freeze({
  '.aplabs': 'the fork\'s profile folder (step 2)',
  '.aplabs/profile.yml': 'the fork writes its profile (step 2)',
  '.aplabs/template-version': 'written by npm run template:check -- --record (step 4)',
  '.aplabs/context': 'created by npm run onboard -- --init (step 9)',
});
// The fork's app dir (`app/`, the runtime's default) and what steps 5 and 8 put in it.
const APP_CREATED = Object.freeze({
  'slack-manifest.json': 'the fork writes it, then npm run slack:manifest fills it (step 5)',
  hubs: 'the first hub (step 5)',
  modules: 'copied from kit/templates/module (step 8)',
  connectors: 'copied from kit/templates/connector (step 8)',
  jobs: 'job files (step 8, kit/templates/job.md)',
  'jobs.json': 'the job list (step 8, kit/templates/job.md)',
});
// Deleted by step 3. They must exist while the template still has the example;
// in a fork or a clean-bones copy (no example) they are gone, as the guide says.
const DELETED_BY_STEP = Object.freeze(['examples/brightside', 'profiles/brightside']);
// Bare file names the guide uses: the context files npm run onboard -- --init
// copies from kit/templates/context/ into .aplabs/context/ (step 9).
const CONTEXT_FILES = Object.freeze(['org.md', 'data.md', 'guardrails.md', 'connectors.md']);

function fences(text) {
  const blocks = [];
  const re = /^```([a-z]*)\n([\s\S]*?)^```$/gm;
  let m;
  while ((m = re.exec(text))) blocks.push({ lang: m[1], body: m[2] });
  return blocks;
}

function prose(text) {
  return text.replace(/^```[a-z]*\n[\s\S]*?^```$/gm, '');
}

function section(heading) {
  const lines = GUIDE.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  assert.ok(start >= 0, `the guide has a section "## ${heading}"`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n');
}

// Inline code spans in prose, plus whitespace-separated words of code blocks.
function pathCandidates() {
  const out = new Set();
  const inline = prose(GUIDE).match(/`[^`\n]+`/g) || [];
  for (const span of inline) out.add(span.slice(1, -1));
  for (const { body } of fences(GUIDE)) {
    for (const line of body.split('\n')) {
      const code = line.replace(/\s#.*$/, '');
      for (const word of code.split(/\s+/)) out.add(word.replace(/^["'[]+|["',\]]+$/g, ''));
    }
  }
  return [...out].filter((s) => {
    if (!s || /\s|…/.test(s)) return false;
    if (/^(https?:|\/|-|\$|<|~|\*|\.\.)/.test(s)) return false;
    if (s.includes('/')) return true;
    return /\.(md|json|ya?ml|js)$/.test(s) || s === 'Dockerfile' || /^\.[a-z]/.test(s);
  });
}

// `app/connectors/**` -> `app/connectors`; `examples/*/app` -> `examples`.
function concrete(p) {
  const segs = [];
  for (const seg of p.split('/')) {
    if (seg === '' || /[*<]/.test(seg)) break;
    segs.push(seg);
  }
  return segs.join('/');
}

const exists = (rel) => fs.existsSync(path.join(REPO, rel));

test('fork guide: every npm run script it names is in package.json', () => {
  const named = [...GUIDE.matchAll(/npm run ([a-z][\w:-]*)/g)].map((m) => m[1]);
  assert.ok(named.length >= 5, 'the guide names its commands');
  const missing = [...new Set(named)].filter((s) => !Object.hasOwn(SCRIPTS, s));
  assert.deepEqual(missing, [], `scripts the guide names that package.json lacks: ${missing.join(', ')}`);
});

test('fork guide: every path it names exists, or a step creates or deletes it', () => {
  const candidates = pathCandidates();
  assert.ok(candidates.length >= 20, 'the guide names its files');
  const hasExample = exists('examples/brightside');
  const problems = [];
  for (const raw of candidates) {
    const rel = concrete(raw);
    if (!rel) continue;
    if (Object.hasOwn(FORK_CREATED, rel)) continue;
    if (rel.startsWith('.aplabs/context/')) continue; // created by step 9
    const [top, second] = rel.split('/');
    if (top === 'app') {
      if (second === undefined || Object.hasOwn(APP_CREATED, second)) continue;
      problems.push(`${raw}: under app/ but not something a step creates`);
      continue;
    }
    if (CONTEXT_FILES.includes(rel)) {
      if (!exists(`kit/templates/context/${rel}`)) problems.push(`${raw}: no kit/templates/context/${rel}`);
      continue;
    }
    const deleted = DELETED_BY_STEP.find((d) => rel === d || rel.startsWith(`${d}/`));
    if (deleted && !hasExample) continue;
    // A distribution copy (no docs/reference/) ships without the excluded
    // paths by design (plan template-dist), so the guide may still name them.
    if (isExcluded(rel) && !exists(REFERENCE_DIR)) continue;
    if (!exists(rel)) problems.push(`${raw}: does not exist`);
  }
  assert.deepEqual(problems, []);
});

test('fork guide: opens with the template-history stop sign', () => {
  const firstSection = GUIDE.indexOf('\n## ');
  const stop = GUIDE.search(/do not create a real client fork until Ely has decided what template history ships/i);
  assert.ok(stop >= 0, 'the history warning is in the guide');
  assert.ok(stop < firstSection, 'the history warning comes before the first step');
  assert.match(GUIDE.slice(0, firstSection), /`docs\/reference\/`/);
});

test('fork guide: clones at a release tag, renames the remote to upstream, never "Use this template"', () => {
  const s = section('1.');
  assert.match(s, /git clone --branch v\d+\.\d+\.\d+ /);
  assert.match(s, /git remote rename origin upstream/);
  for (const m of GUIDE.matchAll(/Use this template/g)) {
    const line = GUIDE.slice(GUIDE.lastIndexOf('\n', m.index) + 1, GUIDE.indexOf('\n', m.index));
    assert.match(line, /never/i, `"Use this template" is only ever named as a thing not to do: ${line}`);
  }
});

test('fork guide: lists every template-owned file a fork never edits', () => {
  const s = section('What a fork never edits');
  for (const p of ['kit/**', 'profiles/_schema/**', '.github/workflows/**', '.github/workflows/ci.yml', 'Dockerfile', '.dockerignore', 'scripts/**', 'package-lock.json']) {
    assert.ok(s.includes(`\`${p}\``), `the never-edit list names ${p}`);
  }
  assert.match(s, /append/i, 'a fork may append dependencies');
  // Review B10: no step edits aplabs.appDirs.
  for (const line of GUIDE.split('\n').filter((l) => l.includes('appDirs'))) {
    assert.doesNotMatch(line, /\b(remove|delete|edit|change)\b[^.]*appDirs/i, line);
    assert.match(line, /leave/i, line);
  }
});

test('fork guide: the profile example is valid and tiers the fork\'s risky paths (N2)', () => {
  const block = fences(GUIDE).find((b) => b.lang === 'yaml' && /^schema_version:/m.test(b.body));
  assert.ok(block, 'the guide has a full profile example');
  const profile = validateProfile(YAML.parse(block.body), 'docs/fork-guide.md (profile example)');
  const rank = { T0: 0, T1: 1, T2: 2, T3: 3 };
  assert.ok(rank[tierOf(profile, 'app/jobs/nightly-check.js')] >= 2, 'app/jobs/** is T2 or higher');
  assert.ok(rank[tierOf(profile, 'app/jobs.json')] >= 2, 'app/jobs.json is T2 or higher');
  assert.equal(tierOf(profile, 'app/connectors/crm/connector.js'), 'T3');
  assert.equal(tierOf(profile, 'app/modules/crm-push/manifest.json'), 'T3');
  assert.equal(tierOf(profile, '.aplabs/profile.yml'), 'T3');
});

test('fork guide: marks every human-only step "you, not the agent"', () => {
  for (const heading of ['1.', '5.', '6.', '7.', '10.']) {
    assert.match(section(heading), /you, not the agent/i, `section ${heading} marks its human step`);
  }
});

test('fork guide: covers the required rules', () => {
  assert.match(GUIDE, /protected-columns/);
  assert.match(GUIDE, /synthetic data only/i);
  assert.match(GUIDE, /durable idempotency store/i);
  assert.match(GUIDE, /can't write to a connector or post to Slack/);
  assert.match(GUIDE, /spend cap/i);
  assert.match(GUIDE, /exactly one replica/i);
  assert.match(GUIDE, /stop-then-start/i);
});

// The reference client's names come from the deny list (docs/reference/dist-deny.txt),
// so this file never names them. null in a distribution copy (no docs/reference/).
const REFERENCE = referencePatterns(REPO);

test('fork guide: no reference-client specifics', { skip: REFERENCE ? false : 'distribution copy: no docs/reference/' }, () => {
  for (const p of REFERENCE) assert.ok(!p.re.test(GUIDE), `the fork guide matches deny pattern ${p.n}`);
});

test('fork guide: the engine floor list names kit/lib/dist/** (plan template-dist, D.1)', () => {
  assert.ok(GUIDE.includes('`kit/lib/dist/**`'));
});

test('fork guide: explains template updates with the real command (Story 11.6)', () => {
  const s = section('Taking a template update');
  assert.match(s, /npm run template:update -- v\d+\.\d+\.\d+/);
  assert.match(s, /`upstream`/);
  assert.match(s, /\*\*adds\*\* to the template and never edits the engine/);
  assert.doesNotMatch(s, /coming|not built yet/i);
  for (const p of ['docs/ledger.md', 'docs/planning/', '.aplabs/', 'package.json', 'package-lock.json', '.aplabs/template-version']) {
    assert.ok(s.includes(`\`${p}\``), `the update section names ${p}`);
  }
  assert.match(s, /npm install --package-lock-only --ignore-scripts/);
  assert.match(s, /schema_version/);
  assert.match(s, /What a fork must do/);
});

test('the Slack setup doc links the fork guide', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs/runtime/slack-app-setup.md'), 'utf8');
  assert.match(doc, /`docs\/fork-guide\.md`/);
});
