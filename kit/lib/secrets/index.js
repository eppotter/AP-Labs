'use strict';

// Secrets (AD-12): one way to read a secret and one way to keep it out of
// output. Extracted from kit/lib/notify (Story 6.1); notify and the runtime
// both read through here.
//
// readSecret(envName, keychainService) reads env first. An empty env var
// counts as unset, so a blank export does not mask the Keychain. The Keychain
// is read only on macOS and never when APLABS_NO_KEYCHAIN=1 (the container and
// tests set it: env only). The value is trimmed; nothing found is null.
//
// A secret's value never goes into an error message, a log line or a return
// value other than readSecret's own. Callers name the env var, never the value.

const { execFileSync } = require('node:child_process');

// stderr is discarded: security's "item not found" text is noise, and it is
// never allowed to carry the secret onto the terminal.
function readKeychain(service) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function keychainAllowed(env, platform) {
  return platform === 'darwin' && env.APLABS_NO_KEYCHAIN !== '1';
}

// deps lets tests inject env, the platform and the Keychain reader.
function readSecret(envName, keychainService, deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  let value = env[envName] || '';
  if (!value && keychainService && keychainAllowed(env, platform)) {
    value = (deps.readKeychain || readKeychain)(keychainService) || '';
  }
  value = String(value).trim();
  return value || null;
}

// Replaces every occurrence of each secret, then every match of each pattern,
// with the mask. Empty secrets are ignored; longer secrets go first so one
// secret containing another is masked whole.
function redact(text, secrets = [], { mask = '[redacted]', patterns = [] } = {}) {
  let out = String(text);
  const values = [...new Set((secrets || []).filter((s) => typeof s === 'string' && s))];
  values.sort((a, b) => b.length - a.length);
  for (const s of values) out = out.split(s).join(mask);
  for (const re of patterns) out = out.replace(re, mask);
  return out;
}

module.exports = { readSecret, readKeychain, redact };
