// Optional macOS Keychain lookup. Used only when IMAP_USER or the password
// env var is missing. Never logs the password.
import { execFileSync } from 'node:child_process';

export const DEFAULT_KEYCHAIN_SERVICE = 'icloud-mcp';

export function keychainServiceName(env = process.env) {
  const name = String(env.ICLOUD_MCP_KEYCHAIN_SERVICE ?? '').trim();
  return name || DEFAULT_KEYCHAIN_SERVICE;
}

export function accountLookupArgs(service) {
  return ['find-generic-password', '-s', service];
}

export function passwordLookupArgs(service, account) {
  return ['find-generic-password', '-s', service, '-a', account, '-w'];
}

export function parseKeychainAccount(output) {
  const match = String(output ?? '').match(/"acct"<blob>="([^"]*)"/);
  return match ? match[1] : '';
}

function chomp(value) {
  return String(value ?? '').replace(/\r?\n$/, '');
}

function envPassword(env) {
  const primary = String(env.IMAP_PASSWORD ?? '').trim();
  if (primary) return primary;
  return String(env.IMAP_PASS ?? '').trim();
}

function defaultRunner(args) {
  return execFileSync('security', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
}

// Returns { user, pass, source } where source is env, keychain, or missing.
// `pass` is empty when nothing was found. Callers must not print it.
export function readKeychainCredentials(env = process.env, runner = defaultRunner) {
  const user = String(env.IMAP_USER ?? '').trim();
  const pass = envPassword(env);
  if (user && pass) return { user, pass, source: 'env' };

  const service = keychainServiceName(env);
  let account = user;
  if (!account) {
    try {
      account = parseKeychainAccount(runner(accountLookupArgs(service)));
    } catch {
      account = '';
    }
  }
  if (!account) return { user: '', pass: '', source: 'missing' };

  let password = pass;
  if (!password) {
    try {
      password = chomp(runner(passwordLookupArgs(service, account)));
    } catch {
      password = '';
    }
  }
  if (!password) return { user: account, pass: '', source: 'missing' };
  return { user: account, pass: password, source: pass ? 'env' : 'keychain' };
}

// Fills IMAP_USER / IMAP_PASSWORD on `env` when a value is missing.
// Does not call Keychain when both are already set.
export function applyKeychainCredentials(env = process.env, runner = defaultRunner) {
  const hadPassword = Boolean(String(env.IMAP_PASSWORD ?? '').trim());
  const found = readKeychainCredentials(env, runner);
  if (found.user && !String(env.IMAP_USER ?? '').trim()) env.IMAP_USER = found.user;
  if (found.pass && !hadPassword) env.IMAP_PASSWORD = found.pass;
  return { source: found.source };
}
