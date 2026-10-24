#!/usr/bin/env node
'use strict';

// The write-path check (DEP-012, AD-15): only the approval-write archetype
// writes to an external system for real. Run by `npm run check` and, through
// test/unit/write-path.test.js, by `npm test`:
//
//   node scripts/check-write-path.js [--root <repo>]
//
// The allow-list (ALLOWED below):
//   - kit/runtime/archetypes/approval-write/**: the one caller of a connector
//     write with dryRun: false (Epic 10, Stories 10.2 and 10.3). A module that
//     pushes declares a `write` block in its manifest (AD-4); the archetype
//     makes the call, after the preview, the approval and the kill switches.
//   - kit/runtime/connectors/**: the contract and its suite.
//   - each connector's own folder (<app dir>/connectors/<id>/**, and the
//     template kit/templates/connector/**): the adapter and its tests.
// Everything else that is scanned fails, naming the file and line, when a
// line that is not a comment:
//   - mentions dryRun other than `dryRun: true` (a live write, or a flag that
//     could be false);
//   - reaches a connector's write operations (`x.write.op`, `x.write?.op`,
//     `x.write[op]`, `x['write']`, `const { write } =`); `stream.write(...)`
//     and passing a `deps.write` function along are fine;
//   - calls .create( in a file that imports from a connectors/ folder (an
//     instance of its own: the app makes connector instances, not modules);
//   - calls defineConnector (a connector belongs in a connectors/ folder).
// Scanned: kit/runtime/** and kit/templates/** always; app code in
// APLABS_APP_DIR when set, <repo>/app (a fork) and examples/*/app (template
// development). JS files only, node_modules skipped. This is a tripwire for
// honest mistakes, not a sandbox: app code is trusted, reviewed code.
// Exit codes: 0 pass, 1 problems found.

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED = Object.freeze([
  'kit/runtime/archetypes/approval-write/**',
  'kit/runtime/connectors/**',
  'kit/templates/connector/**',
  '<app dir>/connectors/**',
]);
const ARCHETYPE = 'kit/runtime/archetypes/approval-write';
const WHY = `only ${ARCHETYPE} writes live (AD-15, DEP-012)`;
const JS = /\.(c|m)?js$/;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;
const IMPORT = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)|\bimport\s*\(\s*(['"`])([^'"`]+)\3\s*\)|\bfrom\s*(['"])([^'"]+)\5|^\s*import\s+(['"])([^'"]+)\7/gm;

// Each rule: a pattern on one line, what it does, and the fix.
const RULES = [
  {
    test: /\bdryRun\b(?!\s*:\s*true\b)/,
    what: 'passes dryRun other than true',
    fix: 'leave writes as dry runs; a module pushes through its manifest\'s write block and the approval-write archetype',
  },
  {
    test: /\.write\s*(?:\?\.|\.|\[)|\[\s*(['"`])write\1\s*\]|\b(?:const|let|var)\s*\{[^}]*\bwrite\b/,
    what: 'reaches a connector\'s write operations',
    fix: 'call connector writes only from the approval-write archetype',
  },
  {
    test: /(?<!\bObject)\.create\s*\(/,
    importsConnector: true,
    what: 'creates a connector instance',
    fix: 'the app creates connector instances; a module does not make its own',
  },
  {
    test: /\bdefineConnector\b/,
    appOnly: true,
    what: 'declares a connector outside a connectors/ folder',
    fix: 'put the connector in <app dir>/connectors/<id>/ (kit/templates/connector.md)',
  },
];

const slash = (p) => p.split(path.sep).join('/');
const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);

function jsFiles(dir, skip) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'node_modules') continue;
    const abs = path.join(dir, d.name);
    if (skip.some((s) => inside(abs, s))) continue;
    if (d.isDirectory()) out.push(...jsFiles(abs, skip));
    else if (d.isFile() && JS.test(d.name)) out.push(abs);
  }
  return out;
}

const isDir = (d) => fs.existsSync(d) && fs.statSync(d).isDirectory();

// [{ dir, skip: [allowed dirs inside it], app: is app code }], existing only.
function scanSet(root, env = process.env) {
  const set = [
    { dir: path.join(root, 'kit/runtime'), skip: [path.join(root, 'kit/runtime/connectors'), path.join(root, ARCHETYPE)], app: false },
    { dir: path.join(root, 'kit/templates'), skip: [path.join(root, 'kit/templates/connector')], app: true },
  ];
  const apps = [path.join(root, 'app')];
  if (env.APLABS_APP_DIR) apps.push(path.resolve(env.APLABS_APP_DIR));
  const examples = path.join(root, 'examples');
  if (isDir(examples)) for (const d of fs.readdirSync(examples).sort()) apps.push(path.join(examples, d, 'app'));
  for (const dir of [...new Set(apps)]) set.push({ dir, skip: [path.join(dir, 'connectors')], app: true });
  return set.filter((s) => isDir(s.dir));
}

const scannedDirs = (root, env) => scanSet(root, env).map((s) => s.dir);

function importsConnector(text) {
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[2] || m[4] || m[6] || m[8];
    if (/(^|\/)connectors\//.test(spec)) return true;
  }
  return false;
}

// Every problem under root, as "<file>:<line>: <what> (<why>; <fix>)", with
// file relative to root, sorted by file then line.
function writePathProblems(root, env = process.env) {
  const files = new Map();
  for (const { dir, skip, app } of scanSet(root, env)) {
    for (const file of jsFiles(dir, skip)) if (!files.has(file)) files.set(file, app);
  }
  const problems = [];
  const rel = (f) => slash(path.relative(root, f));
  for (const file of [...files.keys()].sort((a, b) => rel(a).localeCompare(rel(b)))) {
    const app = files.get(file);
    const text = fs.readFileSync(file, 'utf8');
    const connectorImport = importsConnector(text);
    text.split('\n').forEach((line, i) => {
      if (COMMENT.test(line)) return;
      for (const rule of RULES) {
        if (rule.appOnly && !app) continue;
        if (rule.importsConnector && !connectorImport) continue;
        if (rule.test.test(line)) problems.push(`${rel(file)}:${i + 1}: ${rule.what} (${WHY}; ${rule.fix})`);
      }
    });
  }
  return problems;
}

function main(argv) {
  const at = argv.indexOf('--root');
  const root = at >= 0 ? path.resolve(argv[at + 1]) : path.resolve(__dirname, '..');
  const problems = writePathProblems(root);
  if (problems.length) {
    process.stderr.write(`check-write-path: ${problems.length} live-write path(s) outside the allow-list (${ALLOWED.join(', ')}):\n`);
    for (const p of problems) process.stderr.write(`  ${p}\n`);
    return 1;
  }
  process.stdout.write(`check-write-path: ok (${scannedDirs(root).length} dirs scanned)\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { ALLOWED, RULES, writePathProblems, scannedDirs };
