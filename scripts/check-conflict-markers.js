#!/usr/bin/env node
'use strict';

// Fails when a tracked file still holds git conflict markers (a merge-main
// step once committed them into package.json). Run by `npm run check`:
//
//   node scripts/check-conflict-markers.js
//
// A line starting with `<<<<<<< ` or `>>>>>>> ` always fails. A line that is
// exactly `=======` fails only between a `<<<<<<< ` and a `>>>>>>> ` line, so
// markdown setext headings pass. Vendored skills (.agents/skills/) are pinned
// upstream copies and are excluded; git grep only sees tracked files, so
// node_modules never is searched. Exit codes: 0 pass, 1 markers found, 2 git error.

const { spawnSync } = require('node:child_process');

const OPEN = '<<<<<<< ';
const CLOSE = '>>>>>>> ';
const MIDDLE = '=======';

// Pure: `git grep -n -z` records (file NUL line NUL text) in, findings out.
function findMarkers(output) {
  const byFile = new Map();
  for (const record of output.split('\n')) {
    if (!record) continue;
    const [file, line, ...rest] = record.split('\0');
    const text = rest.join('\0').replace(/\r$/, '');
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ line: Number(line), text });
  }
  const findings = [];
  for (const [file, hits] of byFile) {
    let open = false;
    for (const { line, text } of hits.sort((a, b) => a.line - b.line)) {
      if (text.startsWith(OPEN)) {
        open = true;
        findings.push({ file, line, text });
      } else if (text.startsWith(CLOSE)) {
        open = false;
        findings.push({ file, line, text });
      } else if (text === MIDDLE && open) {
        findings.push({ file, line, text });
      }
    }
  }
  return findings;
}

function main(cwd = process.cwd()) {
  const r = spawnSync('git', ['grep', '-n', '-z', '-I', '-E', '^(<<<<<<< |>>>>>>> |=======)', '--', '.', ':(exclude).agents/skills', ':(exclude)node_modules'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // git grep exits 1 when nothing matches; anything else above 0 is an error.
  if (r.error || r.status > 1) {
    console.error(`check-conflict-markers: git grep failed: ${String(r.error ? r.error.message : r.stderr).trim().split('\n')[0]}`);
    return 2;
  }
  const findings = r.status === 1 ? [] : findMarkers(r.stdout);
  for (const f of findings) console.error(`${f.file}:${f.line}: conflict marker: ${f.text}`);
  if (findings.length) {
    console.error(`check-conflict-markers: ${findings.length} conflict marker line(s) found; resolve the merge`);
    return 1;
  }
  console.log('check-conflict-markers: no conflict markers');
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { findMarkers, main };
