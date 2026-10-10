// Audit log: counts only, append-only, and no message content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { isSensitiveKey, recordAudit, summarizeCounts } from '../../lib/audit.js';

const projectDir = fileURLToPath(new URL('../..', import.meta.url));
const SECRET_SUBJECT = 'Secret subject line';
const SECRET_BODY = 'Secret body text';
const SECRET_ADDRESS = 'person@example.com';

test('counts keep numbers and array lengths and drop message content', () => {
  assert.equal(isSensitiveKey('total'), false);
  assert.equal(isSensitiveKey('to'), true);
  assert.equal(isSensitiveKey('subject'), true);
  assert.equal(isSensitiveKey('notes'), true);

  const counts = summarizeCounts({
    total: 4,
    unread: 1,
    messages: [{ subject: SECRET_SUBJECT, body: SECRET_BODY, from: SECRET_ADDRESS }],
    to: [SECRET_ADDRESS],
    subject: SECRET_SUBJECT,
    note: SECRET_BODY,
    password: 'fixture-app-password',
    skipped: Number.NaN,
    infinite: Number.POSITIVE_INFINITY,
    nested: { subject: SECRET_SUBJECT, count: 9 },
  });
  assert.deepEqual(counts, { total: 4, unread: 1, messages: 1 });

  assert.deepEqual(summarizeCounts([{ subject: SECRET_SUBJECT }]), { length: 1 });
  assert.deepEqual(summarizeCounts('not-an-object'), {});
  assert.deepEqual(summarizeCounts(null), {});
});

test('the audit file is append-only and omits bodies, subjects, and addresses', () => {
  const root = mkdtempSync(join(tmpdir(), 'icloud-mcp-audit-'));
  const file = join(root, 'audit.log');
  const env = { ICLOUD_MCP_AUDIT_LOG: file };
  recordAudit({
    tool: 'search_emails',
    status: 'ok',
    durationMs: 12.4,
    result: {
      total: 2,
      messages: [{ subject: SECRET_SUBJECT, body: SECRET_BODY, from: SECRET_ADDRESS }],
      to: [SECRET_ADDRESS],
      cc: ['other@example.com'],
    },
  }, env);
  recordAudit({ tool: 'get_email', status: 'error', durationMs: -5 }, env);

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.equal(first.tool, 'search_emails');
  assert.equal(first.status, 'ok');
  assert.equal(first.durationMs, 12);
  assert.deepEqual(first.counts, { total: 2, messages: 1 });
  assert.equal(typeof first.ts, 'string');
  assert.equal(second.tool, 'get_email');
  assert.equal(second.status, 'error');
  assert.equal(second.durationMs, 0);
  assert.deepEqual(second.counts, {});

  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes(SECRET_SUBJECT), false);
  assert.equal(text.includes(SECRET_BODY), false);
  assert.equal(text.includes(SECRET_ADDRESS), false);
  assert.equal(text.includes('other@example.com'), false);
  assert.equal(text.includes('fixture-app-password'), false);
});

test('a failed audit write does not throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'icloud-mcp-audit-fail-'));
  const blocked = join(root, 'not-a-directory');
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
  assert.deepEqual(lines[0].counts, { length: 1 });
  assert.equal(lines[1].tool, 'not_a_tool');
  assert.equal(lines[1].status, 'error');
  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes(SECRET_SUBJECT), false);
  assert.equal(text.includes(SECRET_BODY), false);
  assert.equal(text.includes(SECRET_ADDRESS), false);
  assert.equal(text.includes('you@icloud.com'), false);
  assert.equal(text.includes('fixture-app-password'), false);
  assert.equal(text.includes('Unknown tool'), false);
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
    'ICLOUD_MCP_ALLOW_REMOTE_SEND',
    'ICLOUD_MCP_ALLOWED_HOSTS',
    'ICLOUD_MCP_ALLOWED_ORIGINS',
    'ICLOUD_MCP_RATE_LIMIT_PER_MINUTE',
    'ICLOUD_MCP_KEYCHAIN_SERVICE',
    'IMAP_PASS',
    'ICLOUD_MCP_REMINDER_LIST',
    'ICLOUD_MCP_AUDIT_LOG',
    'ICLOUD_MCP_DATA_DIR',
  ]) {
    assert.match(readme, new RegExp(name));
  }
  assert.equal(readme.includes('fixture-app-password'), false);
});
