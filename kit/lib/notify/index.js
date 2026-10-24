'use strict';

// Slack progress updates (Story 5.3): the pure half. Argument parsing, the
// kind prefix, webhook URL checks and redaction. No I/O here; the CLI in
// kit/notify/cli.js resolves the webhook and posts.
//
// The webhook URL is a secret: anyone holding it can post to the channel. It
// must never reach stdout, stderr or an error message, so every message built
// from something we do not control goes through redact() first.

const KINDS = {
  merged: '✅',
  epic: '🏁',
  decision: '🙋',
  blocked: '⛔',
  info: '🔧',
};

const DEFAULT_KEYCHAIN_SERVICE = 'aplabs-slack-webhook';
const WEBHOOK_PREFIX = 'https://hooks.slack.com/services/';
const TIMEOUT_MS = 10000;

const USAGE = `usage: npm run notify -- [--kind <${Object.keys(KINDS).join('|')}>] [--dry-run] "<message>"`;

// Strict flags: an unknown flag is a usage error, never part of the message.
// Words after `--`, or any word not starting with `-`, form the message.
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let kind = 'info';
  let dryRun = false;
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--kind' || a.startsWith('--kind=')) {
      const value = a === '--kind' ? argv[++i] : a.slice('--kind='.length);
      if (!Object.hasOwn(KINDS, value ?? '')) {
        return { error: `--kind needs one of: ${Object.keys(KINDS).join(', ')}` };
      }
      kind = value;
    } else if (a.startsWith('-')) {
      return { error: `unknown argument: ${a}` };
    } else {
      words.push(a);
    }
  }
  const message = words.join(' ').trim();
  if (!message) return { error: 'no message to post' };
  return { kind, dryRun, message };
}

function formatText(kind, message) {
  return `${KINDS[kind]} ${message}`;
}

function isSlackWebhook(url) {
  return typeof url === 'string' && url.startsWith(WEBHOOK_PREFIX) && !/\s/.test(url);
}

// Strips the given secret and anything shaped like a Slack webhook, with or
// without the scheme, so a URL echoed back by fetch or Slack cannot leak.
function redact(text, secret) {
  let out = String(text);
  if (secret) out = out.split(secret).join('[webhook]');
  return out.replace(/(?:https?:\/\/)?hooks\.slack\.com\/services\/[^\s'"<>)]*/gi, '[webhook]');
}

function notConfiguredHelp(service = DEFAULT_KEYCHAIN_SERVICE) {
  return `no Slack webhook configured. Either set APLABS_SLACK_WEBHOOK to the incoming webhook URL, or on macOS store it in the Keychain:
  security add-generic-password -s ${service} -a aplabs -w
(-w last makes security prompt for the URL, so it stays out of shell history.)`;
}

module.exports = {
  KINDS,
  DEFAULT_KEYCHAIN_SERVICE,
  WEBHOOK_PREFIX,
  TIMEOUT_MS,
  USAGE,
  parseArgs,
  formatText,
  isSlackWebhook,
  redact,
  notConfiguredHelp,
};
