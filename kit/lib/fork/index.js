'use strict';

// What may differ between forks of the template (AD-1, Story 11.3). One
// definition of "allowed differences", shared by the two-forks acceptance test
// and, later, the engine check and the update command (Stories 11.5, 11.6).
//
//   compareForks(rootA, rootB, { appDir })  walks both trees (never .git or
//       node_modules) and lists every path that differs, by area:
//         engine    the identical-engine set (kit/runtime/paths.js): never differs
//         fork      the fork's own files: .aplabs/** (profile and context) and
//                   the app dir (default app/)
//         package   package.json and package-lock.json: judged by packageDelta
//         template  everything else the template ships: never differs
//       An engine or template difference is a problem, naming the file.
//
//   packageDelta(templatePkg, forkPkg, { templateLock, forkLock })  what a
//       fork changed in package.json (and, given both, package-lock.json)
//       against the template's. A fork may only append dependencies: a
//       dependency changed or removed, or any other field changed, is a
//       problem naming it. In the lockfile, the root entry follows the same
//       rule, and the only other change allowed is a new package entry (what
//       installing an appended dependency adds). An existing entry changed or
//       removed is a problem naming it.
//
// Both are read-only: they never write, spawn or reach the network.

const fs = require('node:fs');
const path = require('node:path');
const { isEnginePath } = require('../../runtime/paths');

const SKIP_DIRS = Object.freeze(['.git', 'node_modules']);
const PACKAGE_FILES = Object.freeze(['package.json', 'package-lock.json']);
const FORK_DIRS = Object.freeze(['.aplabs']);
const DEP_SECTIONS = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);

const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);

// The area of one repo-relative path (forward slashes). appDir: the fork's
// app dir, repo-relative.
function areaOf(rel, { appDir = 'app' } = {}) {
  if (isEnginePath(rel)) return 'engine';
  if (FORK_DIRS.some((d) => under(rel, d)) || under(rel, appDir)) return 'fork';
  if (PACKAGE_FILES.includes(rel)) return 'package';
  return 'template';
}

// Every file and symlink under root, repo-relative and sorted. A symlink is
// listed, never followed, so a link cannot pull outside files into the walk.
function listFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP_DIRS.includes(d.name)) continue;
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(child);
      else if (d.isFile() || d.isSymbolicLink()) out.push(child);
    }
  };
  walk('');
  return out.sort();
}

// The bytes that stand for one entry: a file's content, or a link's target.
function contentOf(root, rel) {
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs);
  return st.isSymbolicLink() ? Buffer.from(`symlink:${fs.readlinkSync(abs)}`) : fs.readFileSync(abs);
}

/**
 * Lists what differs between two fork roots.
 * Returns { differences: [{ path, change, area }], problems: [string] }, where
 * change is 'changed', 'only-in-a' or 'only-in-b', sorted by path. problems
 * names each engine or template difference; fork and package differences are
 * listed for the caller (package ones go to packageDelta).
 */
function compareForks(rootA, rootB, { appDir = 'app' } = {}) {
  const a = new Set(listFiles(rootA));
  const b = new Set(listFiles(rootB));
  const differences = [];
  for (const rel of [...new Set([...a, ...b])].sort()) {
    let change = null;
    if (!b.has(rel)) change = 'only-in-a';
    else if (!a.has(rel)) change = 'only-in-b';
    else if (!contentOf(rootA, rel).equals(contentOf(rootB, rel))) change = 'changed';
    if (change) differences.push({ path: rel, change, area: areaOf(rel, { appDir }) });
  }
  const problems = differences
    .filter((d) => d.area === 'engine' || d.area === 'template')
    .map((d) => `${d.path}: ${d.change === 'changed' ? 'differs between the forks' : `is ${d.change.replace(/-/g, ' ')}`} (${d.area === 'engine' ? 'an engine file, identical in every fork' : 'a template file a fork does not change'})`);
  return { differences, problems };
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const has = (o, k) => Object.hasOwn(o, k);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// The dependency rule for one package.json-shaped object. where prefixes each
// problem ('package.json' or the lockfile's root entry).
function depsDelta(template, fork, where) {
  const appended = [];
  const problems = [];
  if (!isObject(template) || !isObject(fork)) return { appended, problems: [`${where}: is not an object`] };
  for (const key of [...new Set([...Object.keys(template), ...Object.keys(fork)])].sort()) {
    if (DEP_SECTIONS.includes(key)) continue;
    if (!has(fork, key)) problems.push(`${where}: field "${key}" was removed`);
    else if (!has(template, key)) problems.push(`${where}: field "${key}" was added`);
    else if (!same(template[key], fork[key])) problems.push(`${where}: field "${key}" was changed`);
  }
  for (const section of DEP_SECTIONS) {
    const t = template[section] === undefined ? {} : template[section];
    const f = fork[section] === undefined ? {} : fork[section];
    if (!isObject(t) || !isObject(f)) {
      if (!same(t, f)) problems.push(`${where}: field "${section}" was changed`);
      continue;
    }
    for (const name of Object.keys(t)) {
      if (!has(f, name)) problems.push(`${where}: ${section} "${name}" was removed`);
      else if (!same(f[name], t[name])) problems.push(`${where}: ${section} "${name}" was changed (${t[name]} to ${f[name]})`);
    }
    // Appended: a name the template does not have. Position is not checked:
    // npm sorts the section when it installs.
    for (const name of Object.keys(f)) {
      if (!has(t, name)) appended.push({ section, name, spec: f[name] });
    }
  }
  return { appended, problems };
}

// The lockfile rule: the top-level fields match, the root entry follows the
// dependency rule, every template package entry is unchanged, and new
// entries are allowed only when the fork appended a dependency.
function lockDelta(templateLock, forkLock, appendedCount) {
  const problems = [];
  if (!isObject(templateLock) || !isObject(forkLock)) return ['package-lock.json: is not an object'];
  for (const key of [...new Set([...Object.keys(templateLock), ...Object.keys(forkLock)])].sort()) {
    if (key === 'packages') continue;
    if (!same(templateLock[key], forkLock[key])) problems.push(`package-lock.json: field "${key}" was changed`);
  }
  const t = isObject(templateLock.packages) ? templateLock.packages : {};
  const f = isObject(forkLock.packages) ? forkLock.packages : {};
  const root = depsDelta(t[''] || {}, f[''] || {}, 'package-lock.json root entry');
  problems.push(...root.problems);
  for (const name of Object.keys(t)) {
    if (name === '') continue;
    if (!has(f, name)) problems.push(`package-lock.json: entry "${name}" was removed`);
    else if (!same(t[name], f[name])) problems.push(`package-lock.json: entry "${name}" was changed`);
  }
  const added = Object.keys(f).filter((n) => !has(t, n));
  if (added.length && !appendedCount) {
    for (const name of added) problems.push(`package-lock.json: entry "${name}" was added with no appended dependency`);
  }
  return problems;
}

/**
 * What a fork changed in its package files against the template's.
 * Returns { appended: [{ section, name, spec }], problems: [string] }.
 * appended lists the dependencies the fork added (names the template's
 * section does not have). Lockfiles are judged only when both are given.
 */
function packageDelta(templatePkg, forkPkg, { templateLock, forkLock } = {}) {
  const { appended, problems } = depsDelta(templatePkg, forkPkg, 'package.json');
  if (templateLock !== undefined || forkLock !== undefined) {
    problems.push(...lockDelta(templateLock, forkLock, appended.length));
  }
  return { appended, problems };
}

module.exports = { compareForks, packageDelta, areaOf, listFiles, PACKAGE_FILES, DEP_SECTIONS };
