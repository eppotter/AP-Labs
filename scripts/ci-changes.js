#!/usr/bin/env node
'use strict';

// Which CI jobs a run needs (plan ci-save-minutes), run by the `changes` job
// of .github/workflows/ci.yml:
//
//   node scripts/ci-changes.js >> "$GITHUB_OUTPUT"
//
// Prints `code=true|false` and `container=true|false` on stdout (the job's
// outputs) and the reason on stderr. Only a pull_request run is ever narrowed:
// it lists the files the PR's merge commit changes against its base (the
// checkout of refs/pull/N/merge, HEAD^1..HEAD, fetch depth 2). Every other
// event (every push to main, a manual run) runs everything (plan ledger-rows:
// PRs land without main merged in, so main's own run is where two PRs that
// clash only together show), and template:release always sees the four jobs
// succeed on main's head.
//
//   code       false only for a docs-only PR: the review tool's docs-only rule
//              (kit/lib/review exemptionFor) AND every file under docs/. A .md
//              anywhere else (kit/templates, profile context, test fixtures,
//              CHANGELOG.md) is read by code, so it counts as code. A docs-only
//              PR skips test:slow, clean-bones and dist; the fast suite still
//              runs, including the deny-list tripwire over the shipped tree.
//   container  true when any file the image build or its smoke run reads
//              changed: everything except what .dockerignore keeps out
//              (CONTAINER_IGNORED), with test/fixtures/ (mounted into the smoke
//              run) and the workflow itself counted as inputs.
//
// It fails open to running everything: an unknown event, no merge commit, a
// git error or an empty file list all print true for both. It never exits
// non-zero for those, so it can't skip a job by failing.

const { execFileSync } = require('node:child_process');
const { exemptionFor } = require('../kit/lib/review');

const WORKFLOW = '.github/workflows/ci.yml';
// Top-level folders .dockerignore keeps out of the image (a unit test keeps
// this list in step with .dockerignore).
const CONTAINER_IGNORED_DIRS = Object.freeze(['docs/', '.claude/', '.codex/', '.agents/', '_bmad/', 'var/', '.github/', 'test/']);
// Inside an ignored folder but still an input: the smoke run mounts the test
// fixtures, and the workflow defines the job.
const CONTAINER_INPUTS = Object.freeze(['test/fixtures/', WORKFLOW]);

const ALL = Object.freeze({ code: true, container: true });

function isCiDocsOnly(files) {
  if (!files.length) return false;
  if (!files.every((f) => f.startsWith('docs/'))) return false;
  return exemptionFor({ commits: [], changes: files.map((file) => ({ file, added: 0, deleted: 0 })) }) === 'docs only';
}

function isContainerInput(file) {
  if (CONTAINER_INPUTS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p))) return true;
  if (CONTAINER_IGNORED_DIRS.some((d) => file.startsWith(d))) return false;
  // A top-level Markdown file is copied into the image but read by nothing in it.
  if (!file.includes('/') && /\.mdx?$/i.test(file)) return false;
  return true;
}

// The plan for a run: { code, container, reason }.
function plan(event, files) {
  if (event !== 'pull_request') return { ...ALL, reason: `${event || 'unknown'} event: every job runs` };
  if (!Array.isArray(files) || !files.length) return { ...ALL, reason: 'no changed files listed: every job runs' };
  const code = !isCiDocsOnly(files);
  const container = files.some(isContainerInput);
  return { code, container, reason: `${files.length} changed file(s): ${code ? 'code' : 'docs only'}, container inputs ${container ? 'changed' : 'unchanged'}` };
}

function changedFiles(cwd) {
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  git('rev-parse', '--verify', '--quiet', 'HEAD^2'); // the PR merge commit has two parents
  return git('diff', '--name-only', '-z', '--no-renames', 'HEAD^1', 'HEAD').split('\0').filter(Boolean);
}

function main(env = process.env, cwd = process.cwd()) {
  const event = env.GITHUB_EVENT_NAME;
  let files = null;
  let result;
  if (event === 'pull_request') {
    try {
      files = changedFiles(cwd);
    } catch (error) {
      result = { ...ALL, reason: `could not list the PR's files (${String(error.stderr || error.message).trim().split('\n')[0]}): every job runs` };
    }
  }
  result = result || plan(event, files);
  console.error(`ci-changes: ${result.reason}`);
  console.log(`code=${result.code}`);
  console.log(`container=${result.container}`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { plan, isCiDocsOnly, isContainerInput, main, CONTAINER_IGNORED_DIRS, CONTAINER_INPUTS, WORKFLOW };
