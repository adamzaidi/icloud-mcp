import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD;

if (!IMAP_USER || !IMAP_PASSWORD) {
  console.error('Error: IMAP_USER and IMAP_PASSWORD environment variables are required');
  process.exit(1);
}

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

// Timeout in ms per tool category
const TIMEOUTS = {
  mailbox_mgmt: 60000,   // create/rename/delete mailbox — can be slow on iCloud
  bulk_move: 900000,     // pre-flight restore may have many stranded emails; test moves use limit:50
  default: 300000        // everything else — allow up to 5 min for large operations
};

const MAILBOX_MGMT_TOOLS = new Set(['create_mailbox', 'rename_mailbox', 'delete_mailbox']);

// Tools whose stderr output is always interesting (move pipeline logging)
const ALWAYS_LOG_STDERR = new Set(['bulk_move', 'bulk_move_by_sender', 'bulk_move_by_domain', 'archive_older_than']);

function callToolRaw(name, args = {}, timeout = TIMEOUTS.default) {
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
        timeout,
        env: { ...process.env, IMAP_USER, IMAP_PASSWORD }
      }
    );

    // Capture stderr for logging
    const stderr = (result.stderr || '').trim();

    // Print stderr for move operations (always) or all tools (verbose mode)
    if (stderr && (VERBOSE || ALWAYS_LOG_STDERR.has(name))) {
      const lines = stderr.split('\n');
      for (const line of lines) {
        // Only print [move], [timeout], [retry] lines — skip noise
        if (VERBOSE || /^\[(move|timeout|retry)\]/.test(line)) {
          console.log(`     ${line}`);
        }
      }
    }

    if (result.error) throw new Error(`Spawn error: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Process exited with code ${result.status}: ${stderr}`);

    const lines = (result.stdout || '').trim().split('\n').filter(l => l.trim().startsWith('{'));
    const responses = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const toolResponse = responses.find(r => r.id === 1);
    if (!toolResponse) throw new Error(`No response for tool: ${name}`);
    const content = toolResponse.result?.content?.[0]?.text;
    if (!content) throw new Error(`No content in response for: ${name}`);
    if (toolResponse.result?.isError) {
      // On tool errors, always show stderr for diagnostics
      if (stderr && !VERBOSE && !ALWAYS_LOG_STDERR.has(name)) {
        const stderrLines = stderr.split('\n').filter(l => /^\[(move|timeout|retry)\]/.test(l));
        if (stderrLines.length > 0) {
          console.log(`\n     📋 stderr diagnostics:`);
          for (const line of stderrLines) {
            console.log(`     ${line}`);
          }
        }
      }
      throw new Error(`Tool error: ${content}`);
    }
    return JSON.parse(content);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function callTool(name, args = {}) {
  let timeout = TIMEOUTS.default;
  if (MAILBOX_MGMT_TOOLS.has(name)) timeout = TIMEOUTS.mailbox_mgmt;
  else if (name === 'bulk_move' || name === 'bulk_move_by_sender' || name === 'archive_older_than') timeout = TIMEOUTS.bulk_move;

  try {
    return callToolRaw(name, args, timeout);
  } catch (err) {
    // Only retry on spawn-level transient errors (ECONNRESET, ETIMEDOUT on the
    // child process itself) — NOT on Tool errors, which are application-level
    // failures that should propagate immediately.
    // Never retry bulk_move: a timed-out move leaves the manifest in_progress,
    // so a retry would immediately fail with a manifest conflict.
    const isBulkMove = name === 'bulk_move' || name === 'bulk_move_by_sender' || name === 'archive_older_than';
    const isSpawnTransient = (
      err.message.includes('ECONNRESET') ||
      err.message.includes('ETIMEDOUT')
    ) && !err.message.startsWith('Tool error:');
    if (isSpawnTransient && !isBulkMove) {
      console.log(`\n     ⚠️  transient spawn error (${err.message.split(':')[0]}), retrying...`);
      return callToolRaw(name, args, timeout);
    }
    throw err;
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

console.log(`\n🧪 iCloud MCP Server Tests v${version}\n`);
if (VERBOSE) console.log('🔊 Verbose mode: showing all stderr output\n');

// ─── Pre-flight cleanup ───────────────────────────────────────────────────────
// Abandon any leftover in-progress manifest from a previous crashed run,
// then restore any emails stranded in the test folder.
console.log('🧹 Pre-flight cleanup');

try {
  const status = callTool('get_move_status');
  if (status.current && status.current.status === 'in_progress') {
    console.log(`  ⚠️  found in-progress manifest (${status.current.operationId}) — abandoning before cleanup`);
    callTool('abandon_move');
  }
} catch (err) {
  console.log(`  ⚠️  could not check manifest: ${err.message}`);
}

try { callTool('delete_mailbox', { name: 'mcp-test-folder-renamed' }); } catch {}
try { callTool('delete_mailbox', { name: 'mcp-test-folder' }); } catch {}

// Clean up any leftover mcp-test-* temp folders from previous crashed runs
try {
  const allMailboxes = callTool('list_mailboxes');
  const tempFolders = allMailboxes.filter(m => m.path.startsWith('mcp-test-'));
  if (tempFolders.length > 0) {
    console.log(`  ⚠️  found ${tempFolders.length} leftover mcp-test-* folders from previous runs — cleaning up`);
    for (const folder of tempFolders) {
      try {
        // Move any stranded emails back to INBOX first
        const count = callTool('count_emails', { mailbox: folder.path });
        if (count.count > 0) {
          console.log(`  ⚠️  moving ${count.count} stranded emails from ${folder.path} to INBOX`);
          callTool('bulk_move', { sourceMailbox: folder.path, targetMailbox: 'INBOX' });
        }
        callTool('delete_mailbox', { name: folder.path });
        console.log(`  ✓  deleted ${folder.path}`);
      } catch (e) {
        console.log(`  ⚠️  could not clean up ${folder.path}: ${e.message}`);
      }
    }
  }
} catch (err) {
  console.log(`  ⚠️  temp folder cleanup failed: ${err.message} — proceeding anyway`);
}

console.log('');

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

test('get_email (attachments field)', () => {
  const inbox = callTool('read_inbox', { limit: 1 });
  assert(inbox.emails.length > 0, 'inbox should have at least one email');
  const uid = inbox.emails[0].uid;
  const result = callTool('get_email', { uid });
  assert(result.attachments !== undefined, 'result should have attachments field');
  assert(typeof result.attachments.count === 'number', 'attachments.count should be a number');
  assert(Array.isArray(result.attachments.items), 'attachments.items should be an array');
  assert(result.attachments.items.length === result.attachments.count, 'count should match items length');
  console.log(`\n     → ${result.attachments.count} attachment(s)`);
});

test('get_email (maxChars truncation)', () => {
  const inbox = callTool('read_inbox', { limit: 1 });
  assert(inbox.emails.length > 0, 'inbox should have at least one email');
  const uid = inbox.emails[0].uid;
  const result = callTool('get_email', { uid, maxChars: 100 });
  assert(typeof result.body === 'string', 'body should be a string');
  // Body either fits in 100 chars, or is truncated (truncated text is appended)
  const wasTruncated = result.body.includes('[... truncated');
  if (wasTruncated) {
    assert(result.body.indexOf('[... truncated') <= 105, 'truncation marker should be near 100 char limit');
  }
  console.log(`\n     → body length: ${result.body.length} chars (truncated: ${wasTruncated})`);
});

test('get_email (includeHeaders)', () => {
  const inbox = callTool('read_inbox', { limit: 1 });
  assert(inbox.emails.length > 0, 'inbox should have at least one email');
  const uid = inbox.emails[0].uid;
  const result = callTool('get_email', { uid, includeHeaders: true });
  assert(result.headers !== undefined, 'result should have headers field');
  assert(Array.isArray(result.headers.to), 'headers.to should be an array');
  assert(Array.isArray(result.headers.cc), 'headers.cc should be an array');
  assert(Array.isArray(result.headers.references), 'headers.references should be an array');
  assert('messageId' in result.headers, 'headers should have messageId');
  assert('inReplyTo' in result.headers, 'headers should have inReplyTo');
  assert('replyTo' in result.headers, 'headers should have replyTo');
  assert('listUnsubscribe' in result.headers, 'headers should have listUnsubscribe');
  console.log(`\n     → to: ${result.headers.to.length}, refs: ${result.headers.references.length}, messageId: ${result.headers.messageId?.slice(0, 30)}`);
});

test('get_email_raw', () => {
  const inbox = callTool('read_inbox', { limit: 1 });
  assert(inbox.emails.length > 0, 'inbox should have at least one email');
  const uid = inbox.emails[0].uid;
  const result = callTool('get_email_raw', { uid });
  assert(result.uid === uid, 'uid should match');
  assert(typeof result.size === 'number', 'size should be a number');
  assert(result.size > 0, 'size should be > 0');
  assert(typeof result.truncated === 'boolean', 'truncated should be a boolean');
  assert(typeof result.data === 'string', 'data should be a string');
  assert(result.dataEncoding === 'base64', 'dataEncoding should be base64');
  // Verify it decodes to something that looks like an email
  const decoded = Buffer.from(result.data, 'base64').toString();
  assert(decoded.includes(':'), 'raw email should contain header colons');
  console.log(`\n     → size: ${result.size} bytes, truncated: ${result.truncated}`);
});

test('search_emails (subjectQuery only)', () => {
  const result = callTool('search_emails', { subjectQuery: 'the', limit: 5 });
  assert(typeof result.total === 'number', 'total should be a number');
  assert(Array.isArray(result.emails), 'emails should be an array');
  console.log(`\n     → ${result.total} results with subjectQuery`);
});

test('search_emails (fromQuery only)', () => {
  const senders = callTool('get_top_senders', { sampleSize: 20 });
  const topDomain = senders.topDomains[0]?.domain;
  assert(topDomain, 'should have at least one domain');
  const result = callTool('search_emails', { fromQuery: topDomain, limit: 5 });
  assert(typeof result.total === 'number', 'total should be a number');
  assert(Array.isArray(result.emails), 'emails should be an array');
  console.log(`\n     → ${result.total} results with fromQuery @${topDomain}`);
});

test('search_emails (includeSnippet)', () => {
  const result = callTool('search_emails', { query: 'the', limit: 3, includeSnippet: true });
  assert(typeof result.total === 'number', 'total should be a number');
  assert(Array.isArray(result.emails), 'emails should be an array');
  // At least one email should have a snippet (if there are any results)
  if (result.emails.length > 0) {
    const withSnippet = result.emails.filter(e => e.snippet !== undefined);
    assert(withSnippet.length > 0, 'at least one email should have a snippet');
    assert(typeof result.emails[0].snippet === 'string' || result.emails[0].snippet === undefined, 'snippet should be a string or undefined');
  }
  console.log(`\n     → ${result.emails.length} results, ${result.emails.filter(e => e.snippet).length} with snippets`);
});

test('list_attachments', () => {
  const inbox = callTool('read_inbox', { limit: 1 });
  assert(inbox.emails.length > 0, 'inbox should have at least one email');
  const uid = inbox.emails[0].uid;
  const result = callTool('list_attachments', { uid });
  assert(result.uid === uid, 'uid should match');
  assert(typeof result.attachmentCount === 'number', 'attachmentCount should be a number');
  assert(Array.isArray(result.attachments), 'attachments should be an array');
  assert(result.attachments.length === result.attachmentCount, 'attachmentCount should match array length');
  console.log(`\n     → ${result.attachmentCount} attachment(s) in email "${result.subject?.slice(0, 30)}"`);
});

test('get_unsubscribe_info', () => {
  const inbox = callTool('read_inbox', { limit: 1 });
  assert(inbox.emails.length > 0, 'inbox should have at least one email');
  const uid = inbox.emails[0].uid;
  const result = callTool('get_unsubscribe_info', { uid });
  assert(result.uid === uid, 'uid should match');
  assert('email' in result, 'result should have email field');
  assert('url' in result, 'result should have url field');
  assert('raw' in result, 'result should have raw field');
  // email/url/raw may be null if no List-Unsubscribe header
  console.log(`\n     → email: ${result.email ?? 'none'}, url: ${result.url ? result.url.slice(0, 40) + '...' : 'none'}`);
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
  assert(result.targetMailbox === 'Archive', 'targetMailbox should be Archive');
  console.log(`\n     → would move ${result.wouldMove} emails from @${topDomain}`);
});

test('bulk_delete (dryRun)', () => {
  const result = callTool('bulk_delete', { before: '2015-01-01', dryRun: true });
  assert(result.dryRun === true, 'dryRun should be true');
  assert(typeof result.wouldDelete === 'number', 'wouldDelete should be a number');
  assert(typeof result.sourceMailbox === 'string', 'sourceMailbox should be a string');
  console.log(`\n     → would delete ${result.wouldDelete} emails before 2015`);
});

test('bulk_move_by_domain (dryRun)', () => {
  const senders = callTool('get_top_senders', { sampleSize: 20 });
  const topDomain = senders.topDomains[0]?.domain;
  assert(topDomain, 'should have at least one domain');
  const result = callTool('bulk_move_by_domain', { domain: topDomain, targetMailbox: 'Archive', dryRun: true });
  assert(result.dryRun === true, 'dryRun should be true');
  assert(typeof result.wouldMove === 'number', 'wouldMove should be a number');
  assert(result.targetMailbox === 'Archive', 'targetMailbox should be Archive');
  console.log(`\n     → would move ${result.wouldMove} emails from @${topDomain}`);
});

test('count_emails (hasAttachment scan limit error has candidateCount)', () => {
  // Use a bare count with hasAttachment on a large mailbox — should hit the scan limit
  // and return candidateCount. If inbox is small enough, it may succeed instead.
  const result = callTool('count_emails', { hasAttachment: true });
  if (result.error) {
    // Hit scan limit — verify candidateCount is present
    assert(typeof result.candidateCount === 'number', 'candidateCount should be a number');
    assert(result.count === null, 'count should be null on scan limit error');
    console.log(`\n     → scan limit hit, candidateCount: ${result.candidateCount}`);
  } else {
    // Inbox small enough to scan — still valid
    assert(typeof result.count === 'number', 'count should be a number when scan succeeds');
    console.log(`\n     → scan succeeded, ${result.count} emails with attachments`);
  }
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

test('mark_older_than_read (ancient date — marks 0, non-destructive)', () => {
  // Days so large no email could be that old — safe no-op (100 years)
  const result = callTool('mark_older_than_read', { days: 36500 });
  assert(typeof result.marked === 'number', 'marked should be a number');
  assert(typeof result.olderThan === 'string', 'olderThan should be a date string');
  assert(result.marked === 0, `expected 0 emails marked (none are 100 years old), got ${result.marked}`);
  console.log(`\n     → marked ${result.marked} emails as read (olderThan: ${result.olderThan.slice(0, 10)})`);
});

test('empty_trash (dryRun)', () => {
  const result = callTool('empty_trash', { dryRun: true });
  assert(result.dryRun === true, 'dryRun should be true');
  assert(typeof result.wouldDelete === 'number', 'wouldDelete should be a number');
  assert(typeof result.mailbox === 'string', 'mailbox should be a string');
  console.log(`\n     → would delete ${result.wouldDelete} emails from ${result.mailbox}`);
});

test('bulk_flag_by_sender (flag then unflag — non-destructive)', () => {
  const senders = callTool('get_top_senders', { sampleSize: 20 });
  const topSender = senders.topAddresses[0]?.address;
  assert(topSender, 'should have at least one sender');
  // Count emails from sender first
  const count = callTool('count_emails', { sender: topSender });
  if (count.count === 0) {
    console.log(`\n     → no emails from ${topSender}, skipping flag test`);
    return;
  }
  // Flag
  const flagResult = callTool('bulk_flag_by_sender', { sender: topSender, flagged: true });
  assert(typeof (flagResult.flagged ?? flagResult.unflagged) === 'number', 'should return flagged or unflagged count');
  // Unflag
  const unflagResult = callTool('bulk_flag_by_sender', { sender: topSender, flagged: false });
  assert(typeof (unflagResult.flagged ?? unflagResult.unflagged) === 'number', 'should return flagged or unflagged count');
  console.log(`\n     → flagged then unflagged ${flagResult.flagged} emails from ${topSender}`);
});

// ─── Mailbox Management ───────────────────────────────────────────────────────
console.log('\n🗂️  Mailbox Management');

test('create_mailbox', () => {
  const result = callTool('create_mailbox', { name: 'mcp-test-folder' });
  assert(result.created === 'mcp-test-folder', 'should confirm creation');
  console.log(`\n     → created: ${result.created}`);
});

test('rename_mailbox + delete_mailbox', () => {
  const renamed = callTool('rename_mailbox', { oldName: 'mcp-test-folder', newName: 'mcp-test-folder-renamed' });
  assert(renamed.renamed.from === 'mcp-test-folder', 'from should match old name');
  assert(renamed.renamed.to === 'mcp-test-folder-renamed', 'to should match new name');
  console.log(`\n     → renamed: ${renamed.renamed.from} → ${renamed.renamed.to}`);

  const deleted = callTool('delete_mailbox', { name: 'mcp-test-folder-renamed' });
  assert(deleted.deleted === 'mcp-test-folder-renamed', 'should confirm deletion');
  console.log(`\n     → deleted: ${deleted.deleted}`);
});

test('get_storage_report', () => {
  const result = callTool('get_storage_report', { sampleSize: 20 });
  assert(result.mailbox === 'INBOX', 'mailbox should be INBOX');
  assert(Array.isArray(result.buckets), 'buckets should be an array');
  assert(result.buckets.length === 4, 'should have 4 size buckets');
  assert(typeof result.estimatedTotalKB === 'number', 'estimatedTotalKB should be a number');
  assert(Array.isArray(result.topSendersBySize), 'topSendersBySize should be an array');
  result.buckets.forEach(b => {
    assert(typeof b.range === 'string', 'bucket range should be a string');
    assert(typeof b.count === 'number', 'bucket count should be a number');
  });
  const totalBucketCount = result.buckets.reduce((sum, b) => sum + b.count, 0);
  console.log(`\n     → ${totalBucketCount} emails > 10KB, estimated total: ${Math.round(result.estimatedTotalKB / 1024)} MB`);
  console.log(`\n     → top sender by size: ${result.topSendersBySize[0]?.address ?? 'none'} (${result.topSendersBySize[0]?.estimateKB ?? 0} KB)`);
});

test('get_thread', () => {
  const inbox = callTool('read_inbox', { limit: 1 });
  assert(inbox.emails.length > 0, 'inbox should have at least one email');
  const uid = inbox.emails[0].uid;
  const result = callTool('get_thread', { uid });
  assert(result.uid === uid, 'uid should match');
  assert(typeof result.count === 'number', 'count should be a number');
  assert(result.count >= 1, 'thread should include at least the target email');
  assert(Array.isArray(result.emails), 'emails should be an array');
  assert(result.emails.length === result.count, 'emails array length should match count');
  if (result.emails.length > 0) {
    const first = result.emails[0];
    assert(typeof first.uid === 'number', 'email uid should be a number');
    assert(typeof first.seen === 'boolean', 'email seen should be a boolean');
  }
  console.log(`\n     → thread has ${result.count} email(s), subject: "${result.subject?.slice(0, 40)}"`);
});

test('archive_older_than (dryRun)', () => {
  const result = callTool('archive_older_than', { days: 365, targetMailbox: 'Archive', dryRun: true });
  assert(result.dryRun === true, 'dryRun should be true');
  assert(typeof result.wouldMove === 'number', 'wouldMove should be a number');
  assert(result.targetMailbox === 'Archive', 'targetMailbox should be Archive');
  assert(result.sourceMailbox === 'INBOX', 'sourceMailbox should be INBOX');
  assert(typeof result.olderThan === 'string', 'olderThan should be a date string');
  console.log(`\n     → would archive ${result.wouldMove} emails older than 1 year`);
});

// ─── Move Manifest ────────────────────────────────────────────────────────────
console.log('\n🗺️  Move Manifest');

test('get_move_status (no operation)', () => {
  // Abandon any leftover operation so we start clean
  try { callTool('abandon_move'); } catch {}
  const result = callTool('get_move_status');
  assert(result.status === 'no_operation', `expected no_operation, got ${result.status}`);
  assert(Array.isArray(result.history), 'history should be an array');
  console.log(`\n     → status: ${result.status}, history: ${result.history.length} entries`);
});

test('abandon_move (nothing to abandon)', () => {
  const result = callTool('abandon_move');
  assert(result.abandoned === false, 'should return abandoned: false when nothing in progress');
  assert(typeof result.message === 'string', 'should include a message');
  console.log(`\n     → ${result.message}`);
});

// ─── Safe Move Test (live) ─────────────────────────────────────────────────────────
// Creates temp folders dynamically — no hardcoded folder dependencies.
// Seeds 50 emails from INBOX, moves them src→dst→src, then restores to INBOX.
console.log('\n🔐 Safe Move Test (live — dynamic temp folders, 50-email sample)');

const MOVE_SAMPLE = 50;
const TS = Date.now();
const SRC_FOLDER = `mcp-test-src-${TS}`;
const DST_FOLDER = `mcp-test-dst-${TS}`;

// Setup: create temp folders and seed emails from INBOX
test('safe move setup: create temp folders and seed from INBOX', () => {
  const inbox = callTool('count_emails', { mailbox: 'INBOX' });
  assert(inbox.count >= MOVE_SAMPLE, `INBOX needs at least ${MOVE_SAMPLE} emails for safe move test, has ${inbox.count}`);

  callTool('create_mailbox', { name: SRC_FOLDER });
  callTool('create_mailbox', { name: DST_FOLDER });

  // Move 50 emails from INBOX to src (seed)
  const seedResult = callTool('bulk_move', { sourceMailbox: 'INBOX', targetMailbox: SRC_FOLDER, limit: MOVE_SAMPLE });
  console.log(`\n     → seeded ${seedResult.moved} emails into ${SRC_FOLDER}`);
  assert(seedResult.status === 'complete', `seed move should complete, got ${seedResult.status}: ${seedResult.message || ''}`);
  assert(seedResult.moved === MOVE_SAMPLE, `expected ${MOVE_SAMPLE} seeded, got ${seedResult.moved}`);
});

test(`bulk_move src → dst (${MOVE_SAMPLE} emails, fingerprint verified)`, () => {
  const beforeSource = callTool('count_emails', { mailbox: SRC_FOLDER });
  assert(beforeSource.count === MOVE_SAMPLE, `${SRC_FOLDER} should have ${MOVE_SAMPLE} emails, has ${beforeSource.count}`);
  console.log(`\n     → src before: ${beforeSource.count} (moving ${MOVE_SAMPLE})`);

  const moveResult = callTool('bulk_move', { sourceMailbox: SRC_FOLDER, targetMailbox: DST_FOLDER, limit: MOVE_SAMPLE });
  console.log(`\n     → status: ${moveResult.status}, moved: ${moveResult.moved} of ${moveResult.total}`);
  assert(moveResult.status === 'complete', `expected complete, got ${moveResult.status}: ${moveResult.message || ''}`);
  assert(moveResult.moved === MOVE_SAMPLE, `moved ${moveResult.moved} but expected ${MOVE_SAMPLE}`);

  const afterSource = callTool('count_emails', { mailbox: SRC_FOLDER });
  console.log(`\n     → src after: ${afterSource.count} (should be 0)`);
  assert(afterSource.count === 0, `${SRC_FOLDER} should be empty, has ${afterSource.count}`);

  const afterTarget = callTool('count_emails', { mailbox: DST_FOLDER });
  console.log(`\n     → dst after: ${afterTarget.count} (should be ${MOVE_SAMPLE})`);
  assert(afterTarget.count === MOVE_SAMPLE, `${DST_FOLDER} should have ${MOVE_SAMPLE}, has ${afterTarget.count}`);
});

test('get_move_status (after completed move)', () => {
  const result = callTool('get_move_status');
  assert(result.status === 'no_operation', `expected no_operation after completed move, got ${result.status}`);
  assert(result.history.length > 0, 'history should have at least one entry');
  const last = result.history[0];
  assert(last.status === 'complete', `last operation should be complete, got ${last.status}`);
  assert(last.moved === MOVE_SAMPLE, `last op should have moved ${MOVE_SAMPLE}, got ${last.moved}`);
  console.log(`\n     → last op: ${last.status}, ${last.moved}/${last.total} moved from ${last.source} → ${last.target}`);
});

test(`bulk_move dst → src (restore ${MOVE_SAMPLE} emails, fingerprint verified)`, () => {
  const beforeSource = callTool('count_emails', { mailbox: DST_FOLDER });
  assert(beforeSource.count === MOVE_SAMPLE, `${DST_FOLDER} should have ${MOVE_SAMPLE} emails, has ${beforeSource.count}`);
  console.log(`\n     → dst before restore: ${beforeSource.count}`);

  const moveBack = callTool('bulk_move', { sourceMailbox: DST_FOLDER, targetMailbox: SRC_FOLDER });
  console.log(`\n     → status: ${moveBack.status}, moved: ${moveBack.moved} of ${moveBack.total}`);
  assert(moveBack.status === 'complete', `expected complete, got ${moveBack.status}: ${moveBack.message || ''}`);
  assert(moveBack.moved === MOVE_SAMPLE, `moved ${moveBack.moved} but expected ${MOVE_SAMPLE}`);

  const afterSource = callTool('count_emails', { mailbox: DST_FOLDER });
  console.log(`\n     → dst after (should be 0): ${afterSource.count}`);
  assert(afterSource.count === 0, `${DST_FOLDER} should be empty, has ${afterSource.count}`);
});

test('get_move_status (history has both moves)', () => {
  const result = callTool('get_move_status');
  assert(result.status === 'no_operation', 'no operation should be in progress');
  assert(result.history.length >= 2, `history should have at least 2 entries, has ${result.history.length}`);
  const [restore, forward] = result.history;
  assert(restore.status === 'complete', `restore op should be complete, got ${restore.status}`);
  assert(forward.status === 'complete', `forward op should be complete, got ${forward.status}`);
  console.log(`\n     → history[0]: ${restore.source} → ${restore.target} (${restore.status}, ${restore.moved} emails)`);
  console.log(`\n     → history[1]: ${forward.source} → ${forward.target} (${forward.status}, ${forward.moved} emails)`);
});

// Teardown: restore emails to INBOX and delete temp folders
test('safe move teardown: restore to INBOX and delete temp folders', () => {
  // Restore emails to INBOX
  const restoreResult = callTool('bulk_move', { sourceMailbox: SRC_FOLDER, targetMailbox: 'INBOX' });
  console.log(`\n     → restored ${restoreResult.moved ?? 0} emails to INBOX`);
  // Delete temp folders (should be empty now)
  try { callTool('delete_mailbox', { name: SRC_FOLDER }); } catch (e) { console.log(`\n     → warn: could not delete ${SRC_FOLDER}: ${e.message}`); }
  try { callTool('delete_mailbox', { name: DST_FOLDER }); } catch (e) { console.log(`\n     → warn: could not delete ${DST_FOLDER}: ${e.message}`); }
  console.log(`\n     → deleted temp folders ${SRC_FOLDER}, ${DST_FOLDER}`);
});

// ─── Session Log ─────────────────────────────────────────────────────────────
console.log('\n📝 Session Log');

test('log_clear', () => {
  const result = callTool('log_clear');
  assert(result.cleared === true, 'should confirm cleared');
  console.log(`\n     → log cleared`);
});

test('log_write (plan)', () => {
  const result = callTool('log_write', { step: 'plan: test log functionality' });
  assert(Array.isArray(result.steps), 'steps should be an array');
  assert(result.steps.length === 1, 'should have 1 step');
  assert(typeof result.startedAt === 'string', 'startedAt should be a string');
  assert(result.steps[0].step === 'plan: test log functionality', 'step content should match');
  assert(typeof result.steps[0].time === 'string', 'step should have a timestamp');
  console.log(`\n     → wrote step, log has ${result.steps.length} entry`);
});

test('log_write (second step)', () => {
  const result = callTool('log_write', { step: 'done: log test complete' });
  assert(Array.isArray(result.steps), 'steps should be an array');
  assert(result.steps.length === 2, 'should have 2 steps');
  assert(result.steps[1].step === 'done: log test complete', 'second step content should match');
  console.log(`\n     → log now has ${result.steps.length} entries`);
});

test('log_read', () => {
  const result = callTool('log_read');
  assert(Array.isArray(result.steps), 'steps should be an array');
  assert(result.steps.length === 2, 'should have 2 steps');
  assert(result.steps[0].step === 'plan: test log functionality', 'first step should match');
  assert(result.steps[1].step === 'done: log test complete', 'second step should match');
  assert(typeof result.startedAt === 'string', 'startedAt should persist');
  console.log(`\n     → read log: ${result.steps.length} steps, started ${result.startedAt}`);
});

test('log_clear (cleanup)', () => {
  const result = callTool('log_clear');
  assert(result.cleared === true, 'should confirm cleared');
  const log = callTool('log_read');
  assert(log.steps.length === 0, 'log should be empty after clear');
  assert(log.startedAt === null, 'startedAt should be null after clear');
  console.log(`\n     → log cleared and verified empty`);
});

// ─── Destructive (skipped) ────────────────────────────────────────────────────
console.log('\n⚠️  Destructive Tests (skipped by default)');
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