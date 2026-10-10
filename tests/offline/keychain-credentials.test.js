// Keychain lookup and the configurable reminder-list name. No real Keychain, no secrets printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  accountLookupArgs,
  applyKeychainCredentials,
  passwordLookupArgs,
  readKeychainCredentials,
  runKeychainCommand,
} from '../../lib/keychain.js';
import { loadEnvFile } from '../../mcp-call.mjs';
import { configuredReminderListName } from '../../lib/digest.js';
import { reminderListName } from '../../lib/reminder-list-name.js';

const projectDir = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_PASSWORD = 'fixture-app-password';

test('Keychain is skipped when IMAP_USER and IMAP_PASSWORD are set', () => {
  let calls = 0;
  const env = { IMAP_USER: 'you@icloud.com', IMAP_PASSWORD: FIXTURE_PASSWORD };
  const found = readKeychainCredentials(env, () => { calls += 1; return ''; });
  assert.equal(calls, 0);
  assert.equal(found.source, 'env');
  assert.equal(found.pass, FIXTURE_PASSWORD);
  applyKeychainCredentials(env, () => { calls += 1; return ''; });
  assert.equal(calls, 0);
});

test('a missing password is read from Keychain and a failure does not print it', () => {
  const env = { IMAP_USER: 'you@icloud.com', ICLOUD_MCP_KEYCHAIN_SERVICE: 'mail-example' };
  const argsSeen = [];
  applyKeychainCredentials(env, (args) => {
    argsSeen.push(args);
    return `${FIXTURE_PASSWORD}\n`;
  });
  assert.deepEqual(argsSeen, [passwordLookupArgs('mail-example', 'you@icloud.com')]);
  assert.equal(env.IMAP_PASSWORD, FIXTURE_PASSWORD);

  const logs = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, encoding, callback) => {
    logs.push(String(chunk));
    return original.call(process.stderr, chunk, encoding, callback);
  };
  try {
    const empty = {};
    applyKeychainCredentials(empty, () => { throw new Error(FIXTURE_PASSWORD); });
    assert.equal(empty.IMAP_PASSWORD, undefined);
  } finally {
    process.stderr.write = original;
  }
  assert.equal(logs.join('').includes(FIXTURE_PASSWORD), false);
});

test('a missing user and password both come from Keychain', () => {
  const env = {};
  const found = readKeychainCredentials(env, (args) => {
    if (args.includes('-w')) return `${FIXTURE_PASSWORD}\n`;
    assert.deepEqual(args, accountLookupArgs('icloud-mcp'));
    return '"acct"<blob>="you@icloud.com"\n';
  });
  assert.equal(found.user, 'you@icloud.com');
  assert.equal(found.pass, FIXTURE_PASSWORD);
  assert.equal(found.source, 'keychain');
});

test('a failed security lookup does not keep the password on the error', () => {
  assert.throws(
    () => runKeychainCommand(['find-generic-password', '-w'], () => {
      const error = new Error(`security: ${FIXTURE_PASSWORD}`);
      error.stderr = FIXTURE_PASSWORD;
      throw error;
    }),
    (error) => {
      assert.equal(error.message, 'security lookup failed');
      assert.equal(JSON.stringify(error).includes(FIXTURE_PASSWORD), false);
      return true;
    }
  );
});

test('IMAP_PASS fills IMAP_PASSWORD when that variable is unset', () => {
  const env = { IMAP_USER: 'you@icloud.com', IMAP_PASS: FIXTURE_PASSWORD };
  let calls = 0;
  applyKeychainCredentials(env, () => { calls += 1; return ''; });
  assert.equal(calls, 0);
  assert.equal(env.IMAP_PASSWORD, FIXTURE_PASSWORD);
});

test('the server starts from a fake security binary and does not log the password', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icloud-mcp-keychain-'));
  const bin = join(root, 'bin');
  const log = join(root, 'security.log');
  writeFileSync(join(root, 'placeholder'), '');
  spawnSync('mkdir', ['-p', bin]);
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if printf '%s' "$*" | grep -q -- '-w'; then
  printf '%s\\n' ${JSON.stringify(FIXTURE_PASSWORD)}
else
  printf '%s\\n' '"acct"<blob>="you@icloud.com"'
fi
`;
  writeFileSync(join(bin, 'security'), script);
  chmodSync(join(bin, 'security'), 0o755);

  function run(extra) {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ICLOUD_MCP_DATA_DIR: root };
    for (const key of ['IMAP_USER', 'IMAP_PASSWORD', 'IMAP_PASS']) delete env[key];
    const child = spawn(process.execPath, ['index.js'], { cwd: projectDir, env: { ...env, ...extra } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`timed out\n${stderr}`));
      }, 4000);
      const done = (running) => {
        clearTimeout(timer);
        child.kill();
        resolve({ stderr, running });
      };
      child.stderr.on('data', () => {
        if (stderr.includes('MCP Server running') || stderr.includes('environment variables are required')) done(stderr.includes('MCP Server running'));
      });
      child.on('exit', () => done(false));
    });
  }

  const fromKeychain = await run({});
  assert.equal(fromKeychain.running, true);
  assert.equal(fromKeychain.stderr.includes(FIXTURE_PASSWORD), false);
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /find-generic-password/);
  assert.equal(calls.includes(FIXTURE_PASSWORD), false);

  writeFileSync(log, '');
  const fromEnv = await run({ IMAP_USER: 'you@icloud.com', IMAP_PASSWORD: FIXTURE_PASSWORD });
  assert.equal(fromEnv.running, true);
  assert.equal(fromEnv.stderr.includes(FIXTURE_PASSWORD), false);
  assert.equal(readFileSync(log, 'utf8'), '');
});

test('mcp-call does not require .env', () => {
  const missing = loadEnvFile(join(tmpdir(), 'does-not-exist.env'), { IMAP_USER: 'keep@example.com' });
  assert.equal(missing.IMAP_USER, 'keep@example.com');

  const file = join(mkdtempSync(join(tmpdir(), 'icloud-mcp-dotenv-')), '.env');
  writeFileSync(file, `IMAP_USER=you@icloud.com\nIMAP_PASSWORD=${FIXTURE_PASSWORD}\n`);
  const loaded = loadEnvFile(file, {});
  assert.equal(loaded.IMAP_USER, 'you@icloud.com');
  assert.equal(loaded.IMAP_PASSWORD, FIXTURE_PASSWORD);

  const result = spawnSync(process.execPath, ['mcp-call.mjs'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: node mcp-call\.mjs/);
  assert.equal(`${result.stdout}${result.stderr}`.includes('ENOENT'), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(FIXTURE_PASSWORD), false);
});

test('the reminder list name defaults to claude and is configurable', () => {
  const previous = process.env.ICLOUD_MCP_REMINDER_LIST;
  try {
    delete process.env.ICLOUD_MCP_REMINDER_LIST;
    assert.equal(reminderListName(), 'claude');
    assert.equal(configuredReminderListName(), 'claude');
    process.env.ICLOUD_MCP_REMINDER_LIST = 'Household';
    assert.equal(reminderListName(), 'Household');
    assert.equal(configuredReminderListName(), 'Household');
  } finally {
    if (previous == null) delete process.env.ICLOUD_MCP_REMINDER_LIST;
    else process.env.ICLOUD_MCP_REMINDER_LIST = previous;
  }

  function descriptions(value) {
    const env = { ...process.env };
    if (value == null) delete env.ICLOUD_MCP_REMINDER_LIST;
    else env.ICLOUD_MCP_REMINDER_LIST = value;
    const result = spawnSync(process.execPath, ['-e', `
      const { mailTools } = await import('./lib/tools/mail.js');
      const tool = mailTools.find((entry) => entry.name === 'update_digest_state');
      process.stdout.write(tool.inputSchema.properties.dismissedReminders.description + '\\n');
      process.stdout.write(tool.inputSchema.properties.seenReminders.description + '\\n');
    `], { cwd: projectDir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }

  assert.match(descriptions(null), /"claude"/);
  const custom = descriptions('Household');
  assert.match(custom, /"Household"/);
  assert.equal(custom.includes('"claude"'), false);
});
