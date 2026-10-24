'use strict';

// Onboarding files (Story 4.1).
//
//   npm run onboard -- --init | --status
//
// --init creates .aplabs/context/ in a governed repo and copies any missing
// client file template; it never overwrites. --status prints each client
// file: present or missing, its owner and its sign-off.
// Exit codes: 0 done, 1 unexpected error, 2 usage or not a governed repo.
//
// The repo is found like every kit module finds it: APLABS_PROFILE, else walk
// up from the cwd to .aplabs/profile.yml.

const path = require('path');
const { findProfilePath, ProfileError } = require('../lib/profile');
const { USAGE, parseArgs, contextDirFor, contextStatus, initContext, renderStatus } = require('../lib/onboard');

function main(argv, cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    return 2;
  }

  let profile;
  try {
    profile = findProfilePath(cwd);
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    console.error(err.message);
    return 2;
  }
  if (!profile) {
    console.error('not a governed repo: no .aplabs/profile.yml found. Onboarding runs only in a client fork with a profile.');
    return 2;
  }
  const dir = contextDirFor(profile);
  const shown = path.relative(cwd, dir) || dir;

  if (args.mode === 'init') {
    const { created, kept } = initContext(dir);
    console.log(`${shown}: created ${created.length ? created.join(', ') : 'nothing'}; kept ${kept.length ? kept.join(', ') : 'nothing'}`);
    if (created.length) console.log('Next: the Onboarder fills data.md, guardrails.md and connectors.md; Scribe drafts org.md; each file needs its client owner\'s sign-off.');
    return 0;
  }
  console.log(`${shown}:`);
  console.log(renderStatus(contextStatus(dir)));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`onboard failed: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
