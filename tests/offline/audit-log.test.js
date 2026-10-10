// Audit log: fixed fields, private modes, size rotation, and no message content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { AUDIT_DIR_MODE, AUDIT_FILE_MODE, integerCount, recordAudit } from '../../lib/audit.js';

const projectDir = fileURLToPath(new URL('../..', import.meta.url));
const SECRET_SUBJECT = 'Secret subject line';
const SECRET_BODY = 'Secret body text';
const SECRET_ADDRESS = 'person@example.com';
const OTHER_ADDRESS = 'other@example.com';

function modeOf(path) {
  return statSync(path).mode & 0o777;
}

test('the integer count ignores keys taken from the result', () => {
  assert.equal(integerCount({
    total: 4,
    unread: 1,
    messages: [{ subject: SECRET_SUBJECT, body: SECRET_BODY, from: SECRET_ADDRESS }],
    [SECRET_ADDRESS]: 3,
    [OTHER_ADDRESS]: 1,
    subject: SECRET_SUBJECT,
    note: SECRET_BODY,
    password: 'fixture-app-password',
    skipped: Number.NaN,
    infinite: Number.POSITIVE_INFINITY,
    nested: { subject: SECRET_SUBJECT, count: 9 },
  }), 4);
  assert.equal(integerCount({ [SECRET_ADDRESS]: 3, subject: SECRET_SUBJECT }), 0);
  assert.equal(integerCount({ total: Number.NaN, count: 5.9 }), 5);
  assert.equal(integerCount([{ subject: SECRET_SUBJECT }]), 1);
  assert.equal(integerCount('not-an-object'), 0);
  assert.equal(integerCount(null), 0);
});

test('an address-keyed result is not written, and only fixed fields are', () => {
  const root = mkdtempSync(join(tmpdir(), 'icloud-mcp-audit-'));
  const file = join(root, 'audit.log');
  const env = { ICLOUD_MCP_AUDIT_LOG: file };
  recordAudit({
    tool: 'search_emails',
    status: 'ok',
    durationMs: 12.4,
    result: {
      total: 2,
      [SECRET_ADDRESS]: 3,
      [`Me <${OTHER_ADDRESS}>`]: 1,
      messages: [{ subject: SECRET_SUBJECT, body: SECRET_BODY, from: SECRET_ADDRESS }],
      to: [SECRET_ADDRESS],
      cc: [OTHER_ADDRESS],
      subject: SECRET_SUBJECT,
    },
  }, env);
  recordAudit({ tool: 'get_email', status: 'error', durationMs: -5 }, env);

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.deepEqual(Object.keys(first).sort(), ['count', 'durationMs', 'status', 'tool', 'ts']);
  assert.deepEqual(Object.keys(second).sort(), ['count', 'durationMs', 'status', 'tool', 'ts']);
  assert.equal(first.tool, 'search_emails');
  assert.equal(first.status, 'ok');
  assert.equal(first.durationMs, 12);
  assert.equal(first.count, 2);
  assert.equal(typeof first.ts, 'string');
  assert.equal(second.tool, 'get_email');
  assert.equal(second.status, 'error');
  assert.equal(second.durationMs, 0);
  assert.equal(second.count, 0);

  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes(SECRET_SUBJECT), false);
  assert.equal(text.includes(SECRET_BODY), false);
  assert.equal(text.includes(SECRET_ADDRESS), false);
  assert.equal(text.includes(OTHER_ADDRESS), false);
  assert.equal(text.includes('fixture-app-password'), false);
  assert.equal(modeOf(file), AUDIT_FILE_MODE);
  assert.equal(modeOf(root), AUDIT_DIR_MODE);
});

test('an existing audit file and directory are forced to 0600 and 0700', () => {
  const root = mkdtempSync(join(tmpdir(), 'icloud-mcp-audit-mode-'));
  const dir = join(root, 'data');
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const file = join(dir, 'audit.log');
  writeFileSync(file, '', { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.equal(modeOf(dir), 0o755);
  assert.equal(modeOf(file), 0o644);

  recordAudit({
    tool: 'list_accounts',
    status: 'ok',
    durationMs: 1,
    result: { [SECRET_ADDRESS]: 4 },
  }, { ICLOUD_MCP_AUDIT_LOG: file });

  assert.equal(modeOf(file), AUDIT_FILE_MODE);
  assert.equal(modeOf(dir), AUDIT_DIR_MODE);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes(SECRET_ADDRESS), false);
  assert.equal(JSON.parse(text).count, 0);
});

test('a new parent directory is created mode 0700', () => {
  const root = mkdtempSync(join(tmpdir(), 'icloud-mcp-audit-dir-'));
  const dir = join(root, 'private');
  const file = join(dir, 'audit.log');
  recordAudit({ tool: 'list_accounts', status: 'ok', durationMs: 1, result: [] }, {
    ICLOUD_MCP_AUDIT_LOG: file,
  });
  assert.equal(existsSync(file), true);
  assert.equal(modeOf(file), AUDIT_FILE_MODE);
  assert.equal(modeOf(dir), AUDIT_DIR_MODE);
});

test('the audit log rotates by size and keeps private modes', () => {
  const root = mkdtempSync(join(tmpdir(), 'icloud-mcp-audit-rotate-'));
  const file = join(root, 'audit.log');
  const env = { ICLOUD_MCP_AUDIT_LOG: file, ICLOUD_MCP_AUDIT_LOG_MAX_BYTES: '80' };
  for (let i = 0; i < 8; i += 1) {
    recordAudit({ tool: 'list_accounts', status: 'ok', durationMs: i, result: { total: i } }, env);
  }
  assert.equal(existsSync(`${file}.1`), true);
  assert.equal(existsSync(`${file}.2`), true);
  assert.equal(existsSync(`${file}.3`), true);
  assert.equal(existsSync(`${file}.4`), false);
  for (const path of [file, `${file}.1`, `${file}.2`, `${file}.3`]) {
    assert.equal(modeOf(path), AUDIT_FILE_MODE);
    const text = readFileSync(path, 'utf8');
    assert.equal(text.includes(SECRET_ADDRESS), false);
    for (const line of text.trim().split('\n')) {
      const parsed = JSON.parse(line);
      assert.deepEqual(Object.keys(parsed).sort(), ['count', 'durationMs', 'status', 'tool', 'ts']);
    }
  }
  assert.ok(statSync(file).size < 80 * 8);
});

test('a failed audit write does not throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'icloud-mcp-audit-fail-'));
  const blocked = join(root, 'not-a-directory');
  writeFileSync(blocked, '');
  recordAudit({ tool: 'list_accounts', status: 'ok', durationMs: 1, result: { total: 1 } }, {
    ICLOUD_MCP_AUDIT_LOG: join(blocked, 'audit.log'),
  });
});

test('stdio tool calls append an audit line without arguments or credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icloud-mcp-audit-stdio-'));
  const file = join(root, 'audit.log');
  const env = { ...process.env, ICLOUD_MCP_DATA_DIR: root, ICLOUD_MCP_AUDIT_LOG: file };
  for (const key of Object.keys(env)) {
    if (key.startsWith('IMAP_')) delete env[key];
  }
  env.IMAP_USER = 'you@icloud.com';
  env.IMAP_PASSWORD = 'fixture-app-password';

  const child = spawn(process.execPath, ['index.js'], { cwd: projectDir, env });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const messages = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'audit-test', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_accounts', arguments: { subject: SECRET_SUBJECT, to: SECRET_ADDRESS } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'not_a_tool', arguments: { body: SECRET_BODY } } },
  ];
  child.stdin.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out\n${stdout.slice(0, 500)}`));
    }, 8000);
    child.stdout.on('data', () => {
      const lines = stdout.split('\n').slice(0, -1).filter((line) => line.trim().startsWith('{'));
      const parsed = lines.map((line) => JSON.parse(line));
      if (!parsed.some((message) => message.id === 1) || !parsed.some((message) => message.id === 2)) return;
      clearTimeout(timer);
      child.kill();
      resolve();
    });
  });

  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].tool, 'list_accounts');
  assert.equal(lines[0].status, 'ok');
  assert.equal(typeof lines[0].durationMs, 'number');
  assert.equal(lines[0].count, 1);
  assert.equal(lines[1].tool, 'not_a_tool');
  assert.equal(lines[1].status, 'error');
  assert.equal(lines[1].count, 0);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes(SECRET_SUBJECT), false);
  assert.equal(text.includes(SECRET_BODY), false);
  assert.equal(text.includes(SECRET_ADDRESS), false);
  assert.equal(text.includes('you@icloud.com'), false);
  assert.equal(text.includes('fixture-app-password'), false);
  assert.equal(text.includes('Unknown tool'), false);
  assert.equal(modeOf(file), AUDIT_FILE_MODE);
});

test('the README documents remote access and every new environment variable', () => {
  const readme = readFileSync(join(projectDir, 'README.md'), 'utf8');
  assert.match(readme, /## Remote access/);
  assert.match(readme, /Cloudflare Tunnel/);
  assert.match(readme, /Managed OAuth/);
  assert.match(readme, /LaunchAgent/);
  assert.match(readme, /prompt injection/i);
  for (const name of [
    'ICLOUD_MCP_SEND_MODE',
    'ICLOUD_MCP_TOOL_PROFILE',
    'ICLOUD_MCP_ALLOW_BULK',
    'ICLOUD_MCP_HTTP_PORT',
    'CF_ACCESS_TEAM_DOMAIN',
    'CF_ACCESS_AUD',
    'ICLOUD_MCP_ALLOWED_EMAILS',
    'ICLOUD_MCP_BEARER_TOKEN',
    'ICLOUD_MCP_ALLOWED_HOSTS',
    'ICLOUD_MCP_ALLOWED_ORIGINS',
    'ICLOUD_MCP_RATE_LIMIT_PER_MINUTE',
    'ICLOUD_MCP_KEYCHAIN_SERVICE',
    'IMAP_PASS',
    'ICLOUD_MCP_REMINDER_LIST',
    'ICLOUD_MCP_AUDIT_LOG',
    'ICLOUD_MCP_AUDIT_LOG_MAX_BYTES',
    'ICLOUD_MCP_DATA_DIR',
  ]) {
    assert.match(readme, new RegExp(name));
  }
  assert.equal(readme.includes('ICLOUD_MCP_ALLOW_REMOTE_SEND'), false);
  assert.equal(readme.includes('ICLOUD_MCP_ALLOW_FULL_REMOTE'), false);
  assert.equal(readme.includes('fixture-app-password'), false);
});
