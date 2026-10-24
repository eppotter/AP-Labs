'use strict';

// Land (Story 1.5): the pure half. Argument parsing, PR-body lines and the
// conditions a PR must meet before it is merged. No I/O here; the CLI in
// kit/land/cli.js does gh, git and notify.
//
// Every condition fails closed: a line that is missing, malformed or appears
// twice refuses the merge rather than being read generously. The lines are the
// ones `npm run review` writes (kit/lib/review).

const { hasKindLine } = require('../review');

const DEFAULT_TIMEOUT_MIN = 15;
const POLL_MS = 15000;

const USAGE = 'usage: npm run land -- <pr-number> [--notify "<message>"] [--timeout-min N]';

// Fields the CLI asks `gh pr view --json` for.
const PR_FIELDS = 'number,state,baseRefName,headRefName,headRefOid,isDraft,isCrossRepository,body';

// Strict flags: an unknown flag or a missing value is a usage error, never a merge.
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let pr;
  let notify;
  let timeoutMin = DEFAULT_TIMEOUT_MIN;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--notify') {
      notify = argv[++i];
      if (!notify || !notify.trim() || notify.startsWith('-')) return { error: '--notify needs the message as its value' };
    } else if (a === '--timeout-min') {
      const value = argv[++i];
      if (!/^\d+(\.\d+)?$/.test(value ?? '')) return { error: '--timeout-min needs a number of minutes (0 or more)' };
      timeoutMin = Number(value);
    } else if (a.startsWith('-')) {
      return { error: `unknown argument: ${a}` };
    } else if (pr !== undefined) {
      return { error: `one PR number only, not ${a}` };
    } else if (/^[1-9]\d*$/.test(a)) {
      pr = Number(a);
    } else {
      return { error: `not a PR number: ${a}` };
    }
  }
  if (pr === undefined) return { error: 'no PR number' };
  return { pr, notify, timeoutMin };
}

const EXEMPT_LINE = /^Review: exempt — \S.*$/gm;
const HEAD_LINE = /^Reviewed head:.*$/gm;
const HEAD_VALUE = /^Reviewed head: ([0-9a-f]{40})\s*$/;
const REFUTER_LINE = /^Refuter:.*$/gm;
const REFUTER_VALUE = /^Refuter: (\d+) confirmed, (\d+) not reproduced, (\d+) escalated, (\d+) pending\s*$/;

// The review lines in a PR body. reviewedHead and refuter are null when the
// line is absent and 'invalid' when it is malformed or repeated.
function parseBody(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const one = (pattern, value, read) => {
    const lines = text.match(pattern) || [];
    if (!lines.length) return null;
    const m = lines.length === 1 && value.exec(lines[0]);
    return m ? read(m) : 'invalid';
  };
  return {
    kind: hasKindLine(text),
    exempt: (text.match(EXEMPT_LINE) || []).length > 0,
    reviewedHead: one(HEAD_LINE, HEAD_VALUE, (m) => m[1]),
    refuter: one(REFUTER_LINE, REFUTER_VALUE, (m) => ({
      confirmed: Number(m[1]), notReproduced: Number(m[2]), escalated: Number(m[3]), pending: Number(m[4]),
    })),
  };
}

// Conditions a-d of Story 1.5 on a `gh pr view` result: a list of plain
// reasons, empty when the PR may land as far as its body and state go.
function prRefusals(pr) {
  const reasons = [];
  if (pr.state !== 'OPEN') reasons.push(`PR #${pr.number} is ${pr.state || 'not open'}, not OPEN.`);
  if (pr.baseRefName !== 'main') reasons.push(`PR #${pr.number} targets ${pr.baseRefName || 'no branch'}, not main.`);
  const body = parseBody(pr.body);
  if (!body.kind) reasons.push('The PR body has no valid Kind line (Kind: user-visible|groundwork|fix|infra|docs).');
  if (!body.exempt) {
    if (body.reviewedHead === null) {
      reasons.push('The PR body has no Reviewed head line and no Review: exempt line. Run npm run review.');
    } else if (body.reviewedHead === 'invalid') {
      reasons.push('The PR body\'s Reviewed head line is malformed or repeated.');
    } else if (body.reviewedHead !== pr.headRefOid) {
      reasons.push(`The reviewed head ${body.reviewedHead.slice(0, 12)} is not the PR head ${String(pr.headRefOid).slice(0, 12)}: ` +
        'the code being merged was not reviewed. Run npm run review.');
    }
  }
  if (body.refuter === 'invalid') {
    reasons.push('The PR body\'s Refuter line is malformed or repeated.');
  } else if (body.refuter) {
    const { confirmed, escalated, pending } = body.refuter;
    if (confirmed || escalated || pending) {
      reasons.push(`Refuter shows ${confirmed} confirmed, ${escalated} escalated, ${pending} pending: every P1 must be fixed ` +
        'and re-reviewed, not reproduced, or cleared by the human.');
    }
  }
  return reasons;
}

// gh pr checks buckets: pass, fail, pending, skipping, cancel.
const isPending = (checks) => checks.some((c) => c.bucket === 'pending');

// Condition e on finished checks: a reason, or null when every check passed.
function checksRefusal(checks) {
  if (!checks.length) return 'No CI checks are reported on the PR head; at least one must pass.';
  const bad = checks.filter((c) => c.bucket !== 'pass' && c.bucket !== 'skipping');
  if (!bad.length) return null;
  return `CI is not green: ${bad.map((c) => `${c.name} (${c.bucket || c.state || 'unknown'})`).join(', ')}.`;
}

// True when `git push origin --delete` failed only because the branch is gone
// already (GitHub's auto-delete, or an earlier land).
const alreadyDeleted = (stderr) => /remote ref does not exist|unable to delete .*: .*not found/i.test(String(stderr));

module.exports = {
  DEFAULT_TIMEOUT_MIN,
  POLL_MS,
  USAGE,
  PR_FIELDS,
  parseArgs,
  parseBody,
  prRefusals,
  isPending,
  checksRefusal,
  alreadyDeleted,
};
