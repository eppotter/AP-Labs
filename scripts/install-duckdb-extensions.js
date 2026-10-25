'use strict';

// Installs the DuckDB extensions the app needs, at image build only (Story
// 11.2, DEP-016). The Dockerfile runs it; nothing under kit/runtime/ requires
// it, and the app itself never installs anything (auto-install stays off).
// It is the only image-build installer: the Dockerfile never inlines DuckDB
// code in a RUN line.
//
//   node scripts/install-duckdb-extensions.js [--extension-dir <absolute dir>]
//
// For each extension: INSTALL it for the pinned @duckdb/node-api version,
// then LOAD it once. Loading motherduck (the build has network) fetches its
// implementation part (motherduck_impl) into the same folder; keep the LOAD.
// A later LOAD still needs MotherDuck's network, because the extension's init
// calls MotherDuck's API every time; the container smoke test checks both
// files are installed and that DuckDB finds the extension offline. --extension-dir is the runtime user's $HOME/.duckdb/extensions
// in the image, written by root so the app can read it but not change it.
// Without it, DuckDB's default folder for the current user is used.
// No token is read or needed. Exits 0 when every extension installed and
// loaded, 1 otherwise.

const path = require('node:path');
const { DuckDBInstance } = require('@duckdb/node-api');

const EXTENSIONS = Object.freeze(['motherduck']);

function parseArgs(argv) {
  const out = { extensionDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--extension-dir' && argv[i + 1]) {
      out.extensionDir = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument: ${argv[i]} (usage: install-duckdb-extensions.js [--extension-dir <absolute dir>])`);
    }
  }
  if (out.extensionDir !== null && !path.isAbsolute(out.extensionDir)) throw new Error('--extension-dir must be an absolute path');
  if (out.extensionDir !== null && /'/.test(out.extensionDir)) throw new Error('--extension-dir must not contain a quote');
  return out;
}

async function install({ extensionDir = null, names = EXTENSIONS, log = console.log } = {}) {
  const options = { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' };
  if (extensionDir) options.extension_directory = extensionDir;
  const instance = await DuckDBInstance.create(':memory:', options);
  try {
    const conn = await instance.connect();
    try {
      for (const name of names) {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`bad extension name: ${name}`);
        await conn.run(`INSTALL ${name}`);
        await conn.run(`LOAD ${name}`);
        log(`install-duckdb-extensions: ${name} installed and loads`);
      }
      const rows = (await conn.runAndReadAll('SELECT library_version AS v FROM pragma_version()')).getRowObjectsJson();
      log(`install-duckdb-extensions: DuckDB ${rows[0] ? rows[0].v : 'unknown'}`);
    } finally {
      conn.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

module.exports = { install, parseArgs, EXTENSIONS };

if (require.main === module) {
  Promise.resolve()
    .then(() => install(parseArgs(process.argv.slice(2))))
    .catch((err) => {
      console.error(`install-duckdb-extensions: FAILED\n${String(err && err.message).split('\n')[0]}`);
      process.exitCode = 1;
    });
}
