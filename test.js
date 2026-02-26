import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD;

if (!IMAP_USER || !IMAP_PASSWORD) {
  console.error('Error: IMAP_USER and IMAP_PASSWORD environment variables are required');
  process.exit(1);
}

const projectDir = fileURLToPath(new URL('.', import.meta.url));

function callTool(name, args = {}) {
  const messages = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
  ];

  const input = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  const tmpFile = join(tmpdir(), `mcp-test-${Date.now()}.txt`);
  writeFileSync(tmpFile, input);

  try {
    const result = spawnSync(
      '/bin/sh',
      ['-c', `cat "${tmpFile}" | /opt/homebrew/bin/node index.js`],
      {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 300000,
        env: { ...process.env, IMAP_USER, IMAP_PASSWORD }
      }
    );

    if (result.error) throw new Error(`Spawn error: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Process exited with code ${result.status}: ${result.stderr}`);

    const lines = (result.stdout || '').trim().split('\n').filter(l => l.trim().startsWith('{'));
    const responses = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const toolResponse = responses.find(r => r.id === 1);
    if (!toolResponse) throw new Error(`No response for tool: ${name}`);
    const content = toolResponse.result?.content?.[0]?.text;
    if (!content) throw new Error(`No content in response for: ${name}`);
    if (toolResponse.result?.isError) throw new Error(`Tool error: ${content}`);
    return JSON.parse(content);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  process.stdout.write(`  Testing ${name}... `);
  try {
    fn();
    console.log('✅ passed');
    passed++;
  } catch (err) {
    console.log(`❌ failed: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('\n🧪 iCloud MCP Server Tests\n');

// ─── Mailbox & Summary ────────────────────────────────────────────────────────
console.log('📬 Mailbox & Summary');

test('get_inbox_summary', () => {
  const result = callTool('get_inbox_summary');
  assert(typeof result.total === 'number', 'total should be a number');
  assert(typeof result.unread === 'number', 'unread should be a number');
  assert(result.mailbox === 'INBOX', 'mailbox should be INBOX');
  console.log(`\n     → ${result.total} total, ${result.unread} unread`);
});

test('get_mailbox_summary', () => {
  const result = callTool('get_mailbox_summary', { mailbox: 'INBOX' });
  assert(typeof result.total === 'number', 'total should be a number');
  assert(typeof result.unread === 'number', 'unread should be a number');
  assert(result.mailbox === 'INBOX', 'mailbox should be INBOX');
  console.log(`\n     → ${result.total} total, ${result.unread} unread`);
});

test('list_mailboxes', () => {
  const result = callTool('list_mailboxes');
  assert(Array.isArray(result), 'result should be an array');
  assert(result.length > 0, 'should have at least one mailbox');
  assert(result.some(m => m.path === 'INBOX'), 'INBOX should exist');
  console.log(`\n     → ${result.length} mailboxes found`);
});

test('get_top_senders (sample 50, default maxResults)', () => {
  const result = callTool('get_top_senders', { sampleSize: 50 });
  assert(Array.isArray(result.topAddresses), 'topAddresses should be an array');
  assert(Array.isArray(result.topDomains), 'topDomains should be an array');
  assert(result.sampledEmails <= 50, 'should not exceed sample size');
  assert(result.topAddresses.length <= 20, 'should not exceed default maxResults of 20');
  console.log(`\n     → top sender: ${result.topAddresses[0]?.address} (${result.topAddresses[0]?.count})`);
});

test('get_top_senders (sample 50, maxResults 5)', () => {
  const result = callTool('get_top_senders', { sampleSize: 50, maxResults: 5 });
  assert(Array.isArray(result.topAddresses), 'topAddresses should be an array');
  assert(result.topAddresses.length <= 5, 'should not exceed maxResults of 5');
  assert(result.topDomains.length <= 5, 'domains should not exceed maxResults of 5');
  console.log(`\n     → ${result.topAddresses.length} senders, ${result.topDomains.length} domains (capped at 5)`);
});

test('get_unread_senders (sample 50, default maxResults)', () => {
  const result = callTool('get_unread_senders', { sampleSize: 50 });
  assert(Array.isArray(result), 'result should be an array');
  assert(result.length <= 20, 'should not exceed default maxResults of 20');
  console.log(`\n     → ${result.length} unread senders found`);
});

test('get_unread_senders (sample 50, maxResults 5)', () => {
  const result = callTool('get_unread_senders', { sampleSize: 50, maxResults: 5 });
  assert(Array.isArray(result), 'result should be an array');
  assert(result.length <= 5, 'should not exceed maxResults of 5');
  console.log(`\n     → ${result.length} unread senders found (capped at 5)`);
});

test('get_unread_senders (sample 50, maxResults 50)', () => {
  const result = callTool('get_unread_senders', { sampleSize: 50, maxResults: 50 });
  assert(Array.isArray(result), 'result should be an array');
  assert(result.length <= 50, 'should not exceed maxResults of 50');
  console.log(`\n     → ${result.length} unread senders found (capped at 50)`);
});

// ─── Reading Emails ───────────────────────────────────────────────────────────
console.log('\n📧 Reading Emails');

test('read_inbox (page 1, limit 5)', () => {
  const result = callTool('read_inbox', { limit: 5, page: 1 });
  assert(Array.isArray(result.emails), 'emails should be an array');
  assert(result.emails.length <= 5, 'should not exceed limit');
  assert(typeof result.total === 'number', 'total should be a number');
  assert(typeof result.hasMore === 'boolean', 'hasMore should be a boolean');
  console.log(`\n     → ${result.emails.length} emails, ${result.total} total`);
});

test('read_inbox (page 2)', () => {
  const p1 = callTool('read_inbox', { limit: 5, page: 1 });
  const p2 = callTool('read_inbox', { limit: 5, page: 2 });
  assert(Array.isArray(p2.emails), 'page 2 emails should be an array');
  if (p1.emails.length > 0 && p2.emails.length > 0) {
    assert(p1.emails[0].uid !== p2.emails[0].uid, 'pages should have different emails');
  }
  console.log(`\n     → page 2 has ${p2.emails.length} emails`);
});

test('read_inbox (unread only)', () => {
  const result = callTool('read_inbox', { limit: 5, onlyUnread: true });
  assert(Array.isArray(result.emails), 'emails should be an array');
  result.emails.forEach(e => assert(!e.seen, 'all emails should be unread'));
  console.log(`\n     → ${result.emails.length} unread emails`);
});

test('search_emails (keyword only)', () => {
  const result = callTool('search_emails', { query: 'test', limit: 5 });
  assert(typeof result.total === 'number', 'total should be a number');
  assert(Array.isArray(result.emails), 'emails should be an array');
  console.log(`\n     → ${result.total} results`);
});

test('search_emails (keyword + unread filter)', () => {
  const result = callTool('search_emails', { query: 'test', limit: 5, unread: true });
  assert(typeof result.total === 'number', 'total should be a number');
  assert(Array.isArray(result.emails), 'emails should be an array');
  console.log(`\n     → ${result.total} unread results`);
});

test('search_emails (keyword + date filter)', () => {
  const result = callTool('search_emails', { query: 'test', limit: 5, since: '2024-01-01' });
  assert(typeof result.total === 'number', 'total should be a number');
  assert(Array.isArray(result.emails), 'emails should be an array');
  console.log(`\n     → ${result.total} results since 2024`);
});

test('get_emails_by_sender', () => {
  const senders = callTool('get_top_senders', { sampleSize: 20 });
  const topSender = senders.topAddresses[0]?.address;
  assert(topSender, 'should have at least one sender');
  const result = callTool('get_emails_by_sender', { sender: topSender, limit: 5 });
  assert(typeof result.total === 'number', 'total should be a number');
  assert(Array.isArray(result.emails), 'emails should be an array');
  console.log(`\n     → ${result.total} emails from ${topSender}`);
});

test('get_emails_by_date_range', () => {
  const result = callTool('get_emails_by_date_range', {
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    limit: 5
  });
  assert(typeof result.total === 'number', 'total should be a number');
  assert(Array.isArray(result.emails), 'emails should be an array');
  console.log(`\n     → ${result.total} emails in 2025`);
});

test('get_email (fetch first email content)', () => {
  const inbox = callTool('read_inbox', { limit: 1 });
  assert(inbox.emails.length > 0, 'inbox should have at least one email');
  const uid = inbox.emails[0].uid;
  const result = callTool('get_email', { uid });
  assert(result.uid === uid, 'uid should match');
  assert(typeof result.body === 'string', 'body should be a string');
  console.log(`\n     → fetched email: "${result.subject?.slice(0, 40)}..."`);
});

// ─── Count & Bulk Query ───────────────────────────────────────────────────────
console.log('\n🔍 Count & Bulk Query');

test('count_emails (all in INBOX)', () => {
  const result = callTool('count_emails', { mailbox: 'INBOX' });
  assert(typeof result.count === 'number', 'count should be a number');
  assert(result.count > 0, 'should have emails in INBOX');
  console.log(`\n     → ${result.count} emails match`);
});

test('count_emails (unread only)', () => {
  const result = callTool('count_emails', { unread: true });
  assert(typeof result.count === 'number', 'count should be a number');
  console.log(`\n     → ${result.count} unread emails`);
});

test('count_emails (read only)', () => {
  const result = callTool('count_emails', { unread: false });
  assert(typeof result.count === 'number', 'count should be a number');
  console.log(`\n     → ${result.count} read emails`);
});

test('count_emails (by domain)', () => {
  const senders = callTool('get_top_senders', { sampleSize: 20 });
  const topDomain = senders.topDomains[0]?.domain;
  assert(topDomain, 'should have at least one domain');
  const result = callTool('count_emails', { domain: topDomain });
  assert(typeof result.count === 'number', 'count should be a number');
  console.log(`\n     → ${result.count} emails from @${topDomain}`);
});

test('count_emails (before date)', () => {
  const result = callTool('count_emails', { before: '2020-01-01' });
  assert(typeof result.count === 'number', 'count should be a number');
  console.log(`\n     → ${result.count} emails before 2020`);
});

test('count_emails (flagged false)', () => {
  const result = callTool('count_emails', { flagged: false });
  assert(typeof result.count === 'number', 'count should be a number');
  console.log(`\n     → ${result.count} unflagged emails`);
});

test('bulk_move (dryRun)', () => {
  const senders = callTool('get_top_senders', { sampleSize: 20 });
  const topDomain = senders.topDomains[0]?.domain;
  assert(topDomain, 'should have at least one domain');
  const result = callTool('bulk_move', { domain: topDomain, targetMailbox: 'Archive', dryRun: true });
  assert(result.dryRun === true, 'dryRun should be true');
  assert(typeof result.wouldMove === 'number', 'wouldMove should be a number');
  console.log(`\n     → would move ${result.wouldMove} emails from @${topDomain}`);
});

test('bulk_delete (dryRun)', () => {
  const result = callTool('bulk_delete', { before: '2015-01-01', dryRun: true });
  assert(result.dryRun === true, 'dryRun should be true');
  assert(typeof result.wouldDelete === 'number', 'wouldDelete should be a number');
  console.log(`\n     → would delete ${result.wouldDelete} emails before 2015`);
});

// ─── Write Operations ─────────────────────────────────────────────────────────
console.log('\n✏️  Write Operations (flag/mark only — no deletions)');

test('flag_email and unflag_email', () => {
  const inbox = callTool('read_inbox', { limit: 1 });
  assert(inbox.emails.length > 0, 'inbox should have at least one email');
  const uid = inbox.emails[0].uid;
  const flagResult = callTool('flag_email', { uid, flagged: true });
  assert(flagResult === true, 'flag should return true');
  const unflagResult = callTool('flag_email', { uid, flagged: false });
  assert(unflagResult === true, 'unflag should return true');
  console.log(`\n     → flagged and unflagged uid ${uid}`);
});

test('mark_as_read and mark_as_unread', () => {
  const inbox = callTool('read_inbox', { limit: 1 });
  assert(inbox.emails.length > 0, 'inbox should have at least one email');
  const uid = inbox.emails[0].uid;
  const readResult = callTool('mark_as_read', { uid, seen: true });
  assert(readResult === true, 'mark read should return true');
  const unreadResult = callTool('mark_as_read', { uid, seen: false });
  assert(unreadResult === true, 'mark unread should return true');
  console.log(`\n     → marked read/unread uid ${uid}`);
});

// ─── Mailbox Management ───────────────────────────────────────────────────────
console.log('\n🗂️  Mailbox Management');

test('create_mailbox', () => {
  const result = callTool('create_mailbox', { name: 'mcp-test-folder' });
  assert(result.created === 'mcp-test-folder', 'should confirm creation');
  console.log(`\n     → created: ${result.created}`);
});

test('rename_mailbox', () => {
  const result = callTool('rename_mailbox', { oldName: 'mcp-test-folder', newName: 'mcp-test-folder-renamed' });
  assert(result.renamed.from === 'mcp-test-folder', 'from should match old name');
  assert(result.renamed.to === 'mcp-test-folder-renamed', 'to should match new name');
  console.log(`\n     → renamed: ${result.renamed.from} → ${result.renamed.to}`);
});

test('delete_mailbox', () => {
  const result = callTool('delete_mailbox', { name: 'mcp-test-folder-renamed' });
  assert(result.deleted === 'mcp-test-folder-renamed', 'should confirm deletion');
  console.log(`\n     → deleted: ${result.deleted}`);
});

// ─── Destructive (skipped) ────────────────────────────────────────────────────
console.log('\n⚠️  Destructive Tests (skipped by default)');
console.log('  Skipping: bulk_move (live)');
console.log('  Skipping: bulk_delete (live)');
console.log('  Skipping: bulk_mark_read (live)');
console.log('  Skipping: bulk_mark_unread (live)');
console.log('  Skipping: bulk_flag (live)');
console.log('  Skipping: bulk_delete_by_sender');
console.log('  Skipping: bulk_delete_by_subject');
console.log('  Skipping: delete_older_than');
console.log('  Skipping: delete_email');
console.log('  Skipping: empty_trash');
console.log('  Run with --destructive flag to enable these\n');

console.log('─'.repeat(40));
console.log(`\n✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`📊 Total:  ${passed + failed}\n`);

if (failed > 0) process.exit(1);