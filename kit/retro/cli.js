'use strict';

// The measured retro (Story 5.2): merged PRs against the process budgets.
//
//   npm run retro -- --since YYYY-MM-DD | --prs 11,12,14 [--json]
//
// Reads merged PRs with gh, prints one table row per PR, each budget breach
// under the table and a summary line. --json prints the same result as JSON.
// Exit codes: 0 report printed (breaches included), 1 gh failed, 2 usage.
//
// The gh binary can be overridden (APLABS_GH_BIN) so tests need no network.

const { execFileSync } = require('node:child_process');
const { USAGE, parseArgs, toRow, summarize, renderReport } = require('../lib/retro');

const FIELDS = 'number,title,body,createdAt,mergedAt,commits';
const LIST_LIMIT = 200;

function main(argv, env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    return 2;
  }
  const ghBin = env.APLABS_GH_BIN || 'gh';
  const gh = (ghArgs) => {
    let out;
    try {
      out = execFileSync(ghBin, ghArgs, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const detail = error.code === 'ENOENT' ? 'not found' : String(error.stderr || error.message).trim().split('\n')[0];
      throw new Error(`${ghBin} ${ghArgs.slice(0, 2).join(' ')} failed: ${detail}`);
    }
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`${ghBin} ${ghArgs.slice(0, 2).join(' ')} printed something that is not JSON`);
    }
  };

  let prs;
  try {
    if (args.prs) {
      prs = args.prs.map((n) => gh(['pr', 'view', String(n), '--json', FIELDS]));
    } else {
      prs = gh(['pr', 'list', '--state', 'merged', '--search', `merged:>=${args.since}`, '--limit', String(LIST_LIMIT), '--json', FIELDS]);
      if (!Array.isArray(prs)) throw new Error(`${ghBin} pr list did not print a list`);
      // A full page may be cut short: refuse rather than measure part of the window.
      if (prs.length >= LIST_LIMIT) throw new Error(`${LIST_LIMIT} or more merged PRs since ${args.since}; narrow --since or use --prs`);
    }
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const notMerged = prs.filter((pr) => !pr || !pr.mergedAt).map((pr) => pr && pr.number);
  const result = summarize(prs.filter((pr) => pr && pr.mergedAt).map(toRow));
  if (args.json) {
    console.log(JSON.stringify({ ...result, notMerged }, null, 2));
  } else {
    console.log(renderReport(result, { notMerged }));
  }
  return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
