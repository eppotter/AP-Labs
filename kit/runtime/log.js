'use strict';

// The runtime's only logger (AD-12, Conventions): one JSON line per event,
// every registered secret redacted from every line.
//
//   const log = createLog();
//   log.registerSecret(token);           // every secret read, at boot
//   log.info('started', { client: 'Brightside Home Cleaning' });
//
// Redaction runs on the field values before the line is serialised, so the
// line stays valid JSON whatever a secret contains. Shapes that are secrets
// whether or not they were registered (Slack tokens, a Socket Mode connection
// URL, which carries a ticket) are masked too, as defence in depth.
// Never log query rows, prompts or LLM replies.
//
// slackLogger(log) adapts this logger to the Logger interface Bolt and the
// Slack SDK accept. Their DEBUG output is dropped whatever level they ask for:
// at debug the SDK prints the Socket Mode connection URL.

const util = require('node:util');
const { redact } = require('../lib/secrets');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MASK = '[redacted]';
const PATTERNS = [
  /\bx(?:ox[a-z]|app)-[A-Za-z0-9-]+/g,
  /\bwss?:\/\/[^\s'"<>]*slack[^\s'"<>]*/gi,
  /([?&]ticket=)[^&\s'"<>]+/gi,
];

function createLog({
  // write(line, level): warnings and errors go to stderr, the rest to stdout.
  write = (line, lvl) => (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`),
  now = () => new Date(),
  level = 'info',
} = {}) {
  if (!Object.hasOwn(LEVELS, level)) throw new Error(`unknown log level "${level}"`);
  const secrets = [];
  const clean = (value) => redact(value, secrets, { mask: MASK, patterns: PATTERNS });

  // Deep copy with every string redacted. Errors keep name, message and stack.
  function scrub(value, seen = new WeakSet()) {
    if (typeof value === 'string') return clean(value);
    if (value instanceof Error) {
      return { name: value.name, message: clean(value.message), stack: clean(value.stack || '') };
    }
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => scrub(v, seen));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[clean(k)] = scrub(v, seen);
    return out;
  }

  function emit(lvl, msg, fields) {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const entry = { ts: now().toISOString(), level: lvl, msg: clean(msg), ...scrub(fields || {}) };
    write(JSON.stringify(entry), lvl);
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    // Registers a secret's value; empty values are ignored. Returns the value
    // so a read can be registered inline.
    registerSecret(value) {
      if (typeof value === 'string' && value && !secrets.includes(value)) secrets.push(value);
      return value;
    },
    redact: clean,
  };
}

// Bolt / Slack SDK Logger interface. The requested level is remembered (Bolt
// reads it back) but never lowers the floor below INFO.
function slackLogger(log, name = 'slack') {
  let requested = 'info';
  let label = name;
  const fmt = (args) => util.format(...args);
  return {
    debug() {},
    info: (...args) => log.info(fmt(args), { source: label }),
    warn: (...args) => log.warn(fmt(args), { source: label }),
    error: (...args) => log.error(fmt(args), { source: label }),
    setLevel(level) { requested = level; },
    getLevel: () => requested,
    setName(n) { label = n; },
  };
}

module.exports = { createLog, slackLogger, LEVELS };
