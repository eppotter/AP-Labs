'use strict';

// The engine/fork boundary (AD-1). The identical-engine set is byte-identical
// in every fork: a fork never edits these paths, and Story 11.3 asserts it.
// Everything else is template-owned but fork-editable (package.json, scripts,
// engine tests) or fork-owned (the profile, its context and the app dir).
//
// Two rules keep the boundary honest, each with a grep test
// (test/unit/engine-boundary.test.js): app code imports from kit/ only through
// kit/runtime/sdk, and no engine file references the template's example client.

const fs = require('node:fs');
const path = require('node:path');

const ENGINE_PATHS = Object.freeze(['kit/**', 'profiles/_schema/**']);
// The same set as directories relative to the repo root.
const ENGINE_DIRS = Object.freeze(ENGINE_PATHS.map((p) => p.replace(/\/\*\*$/, '')));
// The one kit/ path app code may import (as #sdk, or a relative path to it).
const SDK_DIR = 'kit/runtime/sdk';

// rel: a repo-relative path with forward slashes.
function isEnginePath(rel) {
  return ENGINE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

// Every file in the identical-engine set under root, repo-relative and sorted.
function listEngineFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.name === 'node_modules') continue;
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(child);
      else if (d.isFile()) out.push(child);
    }
  };
  for (const d of ENGINE_DIRS) walk(d);
  return out.sort();
}

module.exports = { ENGINE_PATHS, ENGINE_DIRS, SDK_DIR, isEnginePath, listEngineFiles };
