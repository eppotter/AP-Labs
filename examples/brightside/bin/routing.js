'use strict';

// Launcher for the dispatcher's read-only routing CLI (Story 14.5).
//
//   node examples/brightside/bin/routing.js optimize|change|gap --day <date> [...]
//
// The commands live in app code (examples/brightside/app/routing/cli.js),
// which may import only '#sdk' and cannot open a data file. This launcher sits
// outside the app dir, like kit/fixture/query.js, and does the opening: the
// governing profile (kit/lib/profile governingProfilePath: APLABS_PROFILE,
// else .aplabs/profile.yml above cwd; --profile must name that one when one
// governs), the runtime's data file (APLABS_DATA_PATH, else
// <var>/fixture/<client id>.duckdb), opened read-only by createData, whose
// data object carries travelMatrix. It reads the local fixture file only.
//
// Exit codes: 0 printed; 1 the fixture is not built or the data is not
// available; 2 bad input or a profile problem. Arguments are checked before
// the profile or the data is touched.

const fs = require('node:fs');
const path = require('node:path');
const { governingProfilePath, loadProfile, PROFILE_REL } = require('../../../kit/lib/profile');
const { createData, dataPathFor } = require('../../../kit/runtime/data');
const { notBuilt, shownPath, PROFILE_ERRORS } = require('../../../kit/fixture/validate');
const cli = require('../app/routing/cli');

async function main(argv, { env = process.env, cwd = process.cwd(), out = process.stdout, err = process.stderr } = {}) {
  const fail = (code, message) => {
    err.write(`routing: ${message}\n`);
    return code;
  };
  const args = cli.parseArgs(argv);
  if (args.help) {
    out.write(`${cli.USAGE}\n`);
    return 0;
  }
  if (args.error) return fail(2, `${args.error}\n${cli.USAGE}`);

  let profile;
  try {
    const file = governingProfilePath(args.profile, cwd, env);
    if (!file) return fail(2, `no profile (pass --profile, set APLABS_PROFILE or add ${PROFILE_REL})`);
    profile = loadProfile(file);
  } catch (e) {
    if (!PROFILE_ERRORS.has(e.code)) throw e;
    return fail(2, e.message);
  }
  if (profile.data && profile.data.source && profile.data.source !== 'local') {
    return fail(2, 'the routing CLI reads the local fixture file only; this profile reads another source');
  }
  const where = dataPathFor(profile, env);
  if (where.problem) return fail(2, where.problem);
  if (!fs.existsSync(where.path)) return fail(1, notBuilt(shownPath(cwd, path.resolve(where.path))));

  const data = createData({ file: where.path, profile });
  try {
    return await cli.execute(args, { data, routing: profile.routing, out, err });
  } finally {
    data.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`routing: unexpected failure: ${String(e && e.message).split('\n')[0]}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
