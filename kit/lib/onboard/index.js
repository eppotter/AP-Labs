'use strict';

// Onboarding (Story 4.1): the client files every specialist loads, and the
// pure half of `npm run onboard`. The CLI in kit/onboard/cli.js only parses
// arguments and prints.
//
// The client files live in .aplabs/context/ next to the profile. Each starts
// with YAML frontmatter recording its named client owner and their sign-off:
//
//   owner:          the client person who owns the file
//   signed_off:     pending, or the ISO date (YYYY-MM-DD) the owner signed off
//   signed_off_by:  who signed off (the owner, captured by a facilitator)
//   updated:        ISO date of the last edit
//
// A file counts as signed off only when signed_off is a real calendar date
// (kit/lib/dates rejects 2026-02-30) and signed_off_by names someone. Anything else (pending, a malformed date,
// broken frontmatter) is awaiting sign-off.

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { isIsoDate } = require('../dates');

const FILES = ['org.md', 'data.md', 'guardrails.md', 'connectors.md'];
const FIELDS = ['owner', 'signed_off', 'signed_off_by', 'updated'];
const TEMPLATES_DIR = path.join(__dirname, '../../templates/context');

const USAGE = [
  'usage: npm run onboard -- --init | --status',
  '  --init    create .aplabs/context/ and copy any missing client file template (never overwrites)',
  '  --status  print each client file: present or missing, owner, sign-off',
].join('\n');

// One of --init, --status or --help; anything else is a usage error.
function parseArgs(argv) {
  const known = new Set(['--init', '--status', '--help', '-h']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) return { error: `unknown argument: ${unknown[0]}` };
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const modes = [...new Set(argv)];
  if (modes.length !== 1) return { error: modes.length ? 'pass only one of --init or --status' : 'pass --init or --status' };
  return { mode: modes[0].slice(2) };
}

// The context directory sits beside the profile: <dir of profile.yml>/context.
const contextDirFor = (profileFile) => path.join(path.dirname(profileFile), 'context');

const filled = (v) => typeof v === 'string' && v.trim() !== '';

// Parses the leading `---` frontmatter block. Returns { data } or { error }.
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return { error: 'no frontmatter' };
  let data;
  try {
    data = YAML.parse(m[1]);
  } catch (err) {
    return { error: `frontmatter is not valid YAML: ${err.message.split('\n')[0]}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'frontmatter is not a mapping' };
  const absent = FIELDS.filter((f) => !(f in data));
  if (absent.length) return { error: `frontmatter is missing ${absent.join(', ')}` };
  const s = data.signed_off;
  if (s !== 'pending' && !isIsoDate(s)) return { error: 'signed_off must be pending or a real ISO date (YYYY-MM-DD)' };
  return { data };
}

// The state of one client file: { file, present, owner, signedOff, signed, error }.
function fileStatus(contextDir, file) {
  const full = path.join(contextDir, file);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file, present: false, signed: false };
    return { file, present: true, signed: false, error: `cannot read: ${err.code || err.message}` };
  }
  const { data, error } = parseFrontmatter(text);
  if (error) return { file, present: true, signed: false, error };
  return {
    file,
    present: true,
    owner: filled(data.owner) ? data.owner.trim() : null,
    signedOff: isIsoDate(data.signed_off) ? data.signed_off : 'pending',
    signed: isIsoDate(data.signed_off) && filled(data.signed_off_by),
  };
}

const contextStatus = (contextDir) => FILES.map((f) => fileStatus(contextDir, f));

// Copies every missing template into contextDir. Never overwrites: the
// exclusive-create flag makes "exists" a kept file even under a race.
function initContext(contextDir, templatesDir = TEMPLATES_DIR) {
  fs.mkdirSync(contextDir, { recursive: true });
  const created = [];
  const kept = [];
  for (const file of FILES) {
    const body = fs.readFileSync(path.join(templatesDir, file), 'utf8');
    try {
      fs.writeFileSync(path.join(contextDir, file), body, { flag: 'wx' });
      created.push(file);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      kept.push(file);
    }
  }
  return { created, kept };
}

// One printable line per file.
function renderStatus(statuses) {
  return statuses.map((s) => {
    if (!s.present) return `${s.file}: missing`;
    if (s.error) return `${s.file}: present, ${s.error}`;
    const owner = s.owner ? `owner ${oneLine(s.owner)}` : 'no owner named';
    const sign = s.signed ? `signed off ${s.signedOff}` : 'awaiting sign-off';
    return `${s.file}: present, ${owner}, ${sign}`;
  }).join('\n');
}

// Context text is untrusted: keep it on one line.
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// The session banner line, or null when all four files exist and are signed off.
function bannerLine(statuses) {
  const total = statuses.length;
  const missing = statuses.filter((s) => !s.present).length;
  const unsigned = statuses.filter((s) => s.present && !s.signed).length;
  if (!missing && !unsigned) return null;
  const parts = [];
  if (missing) parts.push(`${missing} of ${total} client files missing`);
  if (unsigned) parts.push(missing ? `${unsigned} awaiting sign-off` : `${unsigned} of ${total} client files awaiting sign-off`);
  return `Onboarding: ${parts.join(', ')} — run an onboarding build`;
}

module.exports = {
  FILES,
  FIELDS,
  TEMPLATES_DIR,
  USAGE,
  parseArgs,
  contextDirFor,
  parseFrontmatter,
  fileStatus,
  contextStatus,
  initContext,
  renderStatus,
  bannerLine,
};
