'use strict';

// The write-path check (DEP-012, AD-15): only the approval-write archetype
// writes to an external system for real. `npm run check` runs it through
// scripts/check-write-path.js, and test/unit/write-path.test.js runs it in
// `npm test`.
//
// The allow-list (ALLOWED below):
//   - kit/runtime/archetypes/approval-write/**: the one caller of a connector
//     write with dryRun: false (Epic 10, Stories 10.2 and 10.3). A module that
//     pushes declares a `write` block in its manifest (AD-4); the archetype
//     makes the call, after the preview, the approval and the kill switches.
//   - kit/runtime/connectors/**: the contract and its suite.
//   - each connector's own folder (<app dir>/connectors/<id>/**, and the
//     template kit/templates/connector/**): the adapter and its tests. A loose
//     file directly in <app dir>/connectors/ is not a connector's folder and
//     is scanned.
// Everything else that is scanned fails, naming the file and line, when the
// code on a line (leading comments stripped):
//   - mentions dryRun other than `dryRun: true` (a live write, or a flag that
//     could be false);
//   - reaches a connector's write operations (`x.write.op`, `x.write?.op`,
//     `x.write[op]`, `x['write']`, `const { write } =`); `stream.write(...)`
//     and passing a `deps.write` function along are fine;
//   - in a file that imports from a connectors folder (`connectors/...` or
//     `connectors` itself): aliases `.write` (`const w = c.write`,
//     `fn(c.write)`), or calls .create( (an instance of its own: the app makes
//     connector instances, not modules);
//   - in app code or a template: calls defineConnector.
//
// Scanned: kit/runtime/** and kit/templates/** always, plus the app dirs:
// APLABS_APP_DIR when set (it must exist), <repo>/app, and any extra dirs the
// caller passes (the template repo's example clients). In a governed repo
// (.aplabs/profile.yml at the root) finding no app dir at all is a failure, not
// a pass: checking nothing must never pass. JS files only, node_modules
// skipped. This is a tripwire for honest mistakes, not a sandbox: app code is
// trusted, reviewed code.

const fs = require('node:fs');
const path = require('node:path');
const { PROFILE_REL } = require('../lib/profile');

const ALLOWED = Object.freeze([
  'kit/runtime/archetypes/approval-write/**',
  'kit/runtime/connectors/**',
  'kit/templates/connector/**',
  '<app dir>/connectors/<id>/**',
]);
const ARCHETYPE = 'kit/runtime/archetypes/approval-write';
const WHY = `only ${ARCHETYPE} writes live (AD-15, DEP-012)`;
const JS = /\.(c|m)?js$/;
const IMPORT = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)|\bimport\s*\(\s*(['"`])([^'"`]+)\3\s*\)|\bfrom\s*(['"])([^'"]+)\5|^\s*import\s+(['"])([^'"]+)\7/gm;
const CONNECTOR_SPEC = /(^|\/)connectors(\/|$)/;

// Each rule: a pattern on one line's code, what it does, and the fix.
const RULES = Object.freeze([
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
    test: /\.write\b(?!\s*(?:\?\.|\.|\[|\())/,
    importsConnector: true,
    what: 'aliases a connector\'s write operations',
    fix: 'never hand a connector\'s writes on; only the approval-write archetype calls them',
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
    what: 'declares a connector outside a connector\'s own folder',
    fix: 'put the connector in <app dir>/connectors/<id>/ (kit/templates/connector.md)',
  },
]);

const slash = (p) => p.split(path.sep).join('/');
const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

// skip(abs, dirent) says whether to leave a path out.
function jsFiles(dir, skip) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'node_modules') continue;
    const abs = path.join(dir, d.name);
    if (skip(abs, d)) continue;
    if (d.isDirectory()) out.push(...jsFiles(abs, skip));
    else if (d.isFile() && JS.test(d.name)) out.push(abs);
  }
  return out;
}

// What to scan and what the caller got wrong. Returns { set, problems }: set
// is [{ dir, skip, app }] (existing dirs only).
function plan(root, { env = process.env, appDirs = [] } = {}) {
  const problems = [];
  const under = (...dirs) => (abs) => dirs.some((d) => inside(abs, d));
  const set = [
    { dir: path.join(root, 'kit/runtime'), skip: under(path.join(root, 'kit/runtime/connectors'), path.join(root, ARCHETYPE)), app: false },
    { dir: path.join(root, 'kit/templates'), skip: under(path.join(root, 'kit/templates/connector')), app: true },
  ].filter((s) => isDir(s.dir));
  const apps = [path.join(root, 'app')];
  if (env.APLABS_APP_DIR) {
    const dir = path.resolve(root, env.APLABS_APP_DIR);
    if (isDir(dir)) apps.push(dir);
    else problems.push(`APLABS_APP_DIR ${env.APLABS_APP_DIR} is not a directory: the app code it names can't be checked`);
  }
  apps.push(...appDirs.map((d) => path.resolve(root, d)));
  const found = [...new Set(apps)].filter(isDir);
  for (const dir of found) {
    const connectors = path.join(dir, 'connectors');
    // Only a connector's own folder (connectors/<id>/) is allowed.
    set.push({ dir, skip: (abs, d) => d.isDirectory() && path.dirname(abs) === connectors, app: true });
  }
  if (!found.length && fs.existsSync(path.join(root, PROFILE_REL))) {
    problems.push(`no app dir found (looked for ${slash(path.relative(root, path.join(root, 'app')))}/ and APLABS_APP_DIR) in a governed repo (${slash(PROFILE_REL)}): the app code can't be checked`);
  }
  return { set, problems };
}

function importsConnector(text) {
  for (const m of text.matchAll(IMPORT)) {
    if (CONNECTOR_SPEC.test(m[2] || m[4] || m[6] || m[8])) return true;
  }
  return false;
}

// Each line's code with comments that lead it stripped: whole // lines, and
// /* */ comments that open the line (one may span lines). A comment after code
// is kept, so the check reads more, never less.
function codeLines(text) {
  let inBlock = false;
  return text.split('\n').map((line) => {
    let s = line;
    for (;;) {
      if (inBlock) {
        const end = s.indexOf('*/');
        if (end < 0) return '';
        s = s.slice(end + 2);
        inBlock = false;
      }
      const t = s.trimStart();
      if (t.startsWith('//')) return '';
      if (!t.startsWith('/*')) return s;
      s = t.slice(2);
      inBlock = true;
    }
  });
}

// Every problem, as "<file>:<line>: <what> (<why>; <fix>)" with file relative
// to root, sorted by file then line, after any setup problem.
function writePathProblems(root, opts = {}) {
  const { set, problems } = plan(root, opts);
  const files = new Map();
  for (const { dir, skip, app } of set) {
    for (const file of jsFiles(dir, skip)) if (!files.has(file)) files.set(file, app);
  }
  const rel = (f) => slash(path.relative(root, f));
  for (const file of [...files.keys()].sort((a, b) => rel(a).localeCompare(rel(b)))) {
    const app = files.get(file);
    const text = fs.readFileSync(file, 'utf8');
    const connectorImport = importsConnector(text);
    codeLines(text).forEach((code, i) => {
      if (!code.trim()) return;
      for (const rule of RULES) {
        if (rule.appOnly && !app) continue;
        if (rule.importsConnector && !connectorImport) continue;
        if (rule.test.test(code)) problems.push(`${rel(file)}:${i + 1}: ${rule.what} (${WHY}; ${rule.fix})`);
      }
    });
  }
  return problems;
}

const scannedDirs = (root, opts) => plan(root, opts).set.map((s) => s.dir);

module.exports = { ALLOWED, RULES, writePathProblems, scannedDirs, codeLines };
