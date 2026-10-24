'use strict';

// Plain-language progress to the team's Slack channel (Story 5.3):
//
//   npm run notify -- [--kind <merged|epic|decision|blocked|info>] [--dry-run] "<message>"
//
// Posts {"text": "<emoji> <message>"} to a Slack incoming webhook. The webhook
// comes from env APLABS_SLACK_WEBHOOK, else on macOS the Keychain item named by
// APLABS_SLACK_KEYCHAIN_SERVICE (default aplabs-slack-webhook), unless
// APLABS_NO_KEYCHAIN=1 (kit/lib/secrets). The URL is
// never printed; every error built from fetch or Slack output is redacted.
// --dry-run prints the text and touches neither the Keychain nor the network.
//
// Exit codes: 0 posted (or dry run), 1 not configured, refused or failed,
// 2 usage. main is async because fetch is; deps lets tests inject fetch, the
// Keychain reader, the platform and the output streams.

const {
  DEFAULT_KEYCHAIN_SERVICE,
  TIMEOUT_MS,
  USAGE,
  parseArgs,
  formatText,
  isSlackWebhook,
  redact,
  notConfiguredHelp,
} = require('../lib/notify');
const { readSecret } = require('../lib/secrets');

async function main(argv, env = process.env, deps = {}) {
  const out = deps.out || ((s) => console.log(s));
  const err = deps.err || ((s) => console.error(s));
  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.error) {
    err(`${args.error}\n${USAGE}`);
    return 2;
  }
  const text = formatText(args.kind, args.message);
  if (args.dryRun) {
    out(text);
    return 0;
  }

  // Env first, then the macOS Keychain (kit/lib/secrets).
  const service = env.APLABS_SLACK_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE;
  const url = readSecret('APLABS_SLACK_WEBHOOK', service, {
    env,
    platform: deps.platform,
    readKeychain: deps.readKeychain,
  }) || '';
  if (!url) {
    err(notConfiguredHelp(service));
    return 1;
  }
  if (!isSlackWebhook(url)) {
    err('Refusing to post: the configured webhook is not a Slack incoming webhook (https://hooks.slack.com/services/...).');
    return 1;
  }

  const fetchFn = deps.fetch || globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).trim().slice(0, 200);
      } catch {
        // The status alone is enough to act on.
      }
      err(redact(`Slack refused the message (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`, url));
      return 1;
    }
  } catch (e) {
    const reason = controller.signal.aborted
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : [e && e.message, e && e.cause && (e.cause.code || e.cause.message)].filter(Boolean).join(': ');
    err(redact(`Could not reach Slack: ${reason || 'unknown error'}.`, url));
    return 1;
  } finally {
    clearTimeout(timer);
  }
  out('posted');
  return 0;
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
