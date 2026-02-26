#!/usr/bin/env node
import { ImapFlow } from 'imapflow';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD;

if (!IMAP_USER || !IMAP_PASSWORD) {
  process.stderr.write('Error: IMAP_USER and IMAP_PASSWORD environment variables are required\n');
  process.exit(1);
}

function createClient() {
  return new ImapFlow({
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false
  });
}

async function fetchEmails(mailbox = 'INBOX', limit = 10, onlyUnread = false, page = 1) {
  const client = createClient();
  await client.connect();
  const mb = await client.mailboxOpen(mailbox);
  const total = mb.exists;
  const emails = [];

  if (total === 0) {
    await client.logout();
    return { emails, page, limit, total, totalPages: 0, hasMore: false };
  }

  if (onlyUnread) {
    const uids = (await client.search({ seen: false }, { uid: true })) ?? [];
    const totalUnread = uids.length;
    const skip = (page - 1) * limit;
    const pageUids = uids.reverse().slice(skip, skip + limit);
    for (const uid of pageUids) {
      const msg = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
      if (msg) {
        emails.push({
          uid,
          subject: msg.envelope.subject,
          from: msg.envelope.from?.[0]?.address,
          date: msg.envelope.date,
          flagged: msg.flags.has('\\Flagged'),
          seen: msg.flags.has('\\Seen')
        });
      }
    }
    await client.logout();
    return { emails, page, limit, total: totalUnread, totalPages: Math.ceil(totalUnread / limit), hasMore: (page * limit) < totalUnread };
  }

  const end = Math.max(1, total - ((page - 1) * limit));
  const start = Math.max(1, end - limit + 1);
  const range = `${start}:${end}`;

  for await (const msg of client.fetch(range, { envelope: true, flags: true })) {
    emails.push({
      uid: msg.uid,
      subject: msg.envelope.subject,
      from: msg.envelope.from?.[0]?.address,
      date: msg.envelope.date,
      flagged: msg.flags.has('\\Flagged'),
      seen: msg.flags.has('\\Seen')
    });
  }

  await client.logout();
  emails.reverse();
  return { emails, page, limit, total, totalPages: Math.ceil(total / limit), hasMore: (page * limit) < total };
}

async function getInboxSummary(mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  const status = await client.status(mailbox, { messages: true, unseen: true, recent: true });
  await client.logout();
  return { mailbox, total: status.messages, unread: status.unseen, recent: status.recent };
}

async function getTopSenders(mailbox = 'INBOX', sampleSize = 500, maxResults = 20) {
  const client = createClient();
  await client.connect();
  const mb = await client.mailboxOpen(mailbox);
  const total = mb.exists;
  const senderCounts = {};
  const senderDomains = {};

  const end = total;
  const start = Math.max(1, total - sampleSize + 1);
  const range = `${start}:${end}`;
  let count = 0;

  for await (const msg of client.fetch(range, { envelope: true })) {
    const address = msg.envelope.from?.[0]?.address;
    if (address) {
      senderCounts[address] = (senderCounts[address] || 0) + 1;
      const domain = address.split('@')[1];
      if (domain) senderDomains[domain] = (senderDomains[domain] || 0) + 1;
    }
    count++;
  }

  await client.logout();
  const topAddresses = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]).slice(0, maxResults).map(([address, count]) => ({ address, count }));
  const topDomains = Object.entries(senderDomains).sort((a, b) => b[1] - a[1]).slice(0, maxResults).map(([domain, count]) => ({ domain, count }));
  return { sampledEmails: count, topAddresses, topDomains };
}

async function getUnreadSenders(mailbox = 'INBOX', sampleSize = 500, maxResults = 20) {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = (await client.search({ seen: false }, { uid: true })) ?? [];
  const recentUids = uids.reverse().slice(0, sampleSize);
  const senderCounts = {};

  if (recentUids.length === 0) {
    await client.logout();
    return [];
  }

  for await (const msg of client.fetch(recentUids, { envelope: true }, { uid: true })) {
    const address = msg.envelope.from?.[0]?.address;
    if (address) senderCounts[address] = (senderCounts[address] || 0) + 1;
  }

  await client.logout();
  return Object.entries(senderCounts).sort((a, b) => b[1] - a[1]).slice(0, maxResults).map(([address, count]) => ({ address, count }));
}

async function getEmailsBySender(sender, mailbox = 'INBOX', limit = 10) {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = (await client.search({ from: sender }, { uid: true })) ?? [];
  const total = uids.length;
  const recentUids = uids.slice(-limit).reverse();
  const emails = [];
  for (const uid of recentUids) {
    const msg = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
    if (msg) {
      emails.push({
        uid,
        subject: msg.envelope.subject,
        from: msg.envelope.from?.[0]?.address,
        date: msg.envelope.date,
        flagged: msg.flags.has('\\Flagged'),
        seen: msg.flags.has('\\Seen')
      });
    }
  }
  await client.logout();
  return { total, showing: emails.length, emails };
}

async function bulkDeleteBySender(sender, mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = (await client.search({ from: sender }, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { deleted: 0 }; }
  await client.messageDelete(uids, { uid: true });
  await client.logout();
  return { deleted: uids.length, sender };
}

async function bulkMoveBySender(sender, targetMailbox, sourceMailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  const uids = (await client.search({ from: sender }, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { moved: 0 }; }
  await client.messageMove(uids, targetMailbox, { uid: true });
  await client.logout();
  return { moved: uids.length, sender, targetMailbox };
}

async function bulkDeleteBySubject(subject, mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = (await client.search({ subject }, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { deleted: 0 }; }
  await client.messageDelete(uids, { uid: true });
  await client.logout();
  return { deleted: uids.length, subject };
}

async function deleteOlderThan(days, mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const date = new Date();
  date.setDate(date.getDate() - days);
  const uids = (await client.search({ before: date }, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { deleted: 0 }; }
  await client.messageDelete(uids, { uid: true });
  await client.logout();
  return { deleted: uids.length, olderThan: date.toISOString() };
}

async function getEmailsByDateRange(startDate, endDate, mailbox = 'INBOX', limit = 10) {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = (await client.search({ since: new Date(startDate), before: new Date(endDate) }, { uid: true })) ?? [];
  const total = uids.length;
  const recentUids = uids.slice(-limit).reverse();
  const emails = [];
  for (const uid of recentUids) {
    const msg = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
    if (msg) {
      emails.push({
        uid,
        subject: msg.envelope.subject,
        from: msg.envelope.from?.[0]?.address,
        date: msg.envelope.date,
        flagged: msg.flags.has('\\Flagged'),
        seen: msg.flags.has('\\Seen')
      });
    }
  }
  await client.logout();
  return { total, showing: emails.length, emails };
}

async function bulkMarkRead(mailbox = 'INBOX', sender = null) {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const query = sender ? { from: sender, seen: false } : { seen: false };
  const uids = (await client.search(query, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { marked: 0 }; }
  await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
  await client.logout();
  return { marked: uids.length, sender: sender || 'all' };
}

async function bulkMarkUnread(mailbox = 'INBOX', sender = null) {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const query = sender ? { from: sender, seen: true } : { seen: true };
  const uids = (await client.search(query, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { marked: 0 }; }
  await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
  await client.logout();
  return { marked: uids.length, sender: sender || 'all' };
}

async function bulkFlag(filters, flagged, mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const query = buildQuery(filters);
  const uids = (await client.search(query, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { flagged: 0 }; }
  if (flagged) {
    await client.messageFlagsAdd(uids, ['\\Flagged'], { uid: true });
  } else {
    await client.messageFlagsRemove(uids, ['\\Flagged'], { uid: true });
  }
  await client.logout();
  return { [flagged ? 'flagged' : 'unflagged']: uids.length, filters };
}

async function emptyTrash() {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen('Deleted Messages');
  const uids = (await client.search({ all: true }, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { deleted: 0 }; }
  await client.messageDelete(uids, { uid: true });
  await client.logout();
  return { deleted: uids.length };
}

async function createMailbox(name) {
  const client = createClient();
  await client.connect();
  await client.mailboxCreate(name);
  await client.logout();
  return { created: name };
}

async function renameMailbox(oldName, newName) {
  const client = createClient();
  await client.connect();
  await client.mailboxRename(oldName, newName);
  await client.logout();
  return { renamed: { from: oldName, to: newName } };
}

async function deleteMailbox(name) {
  const client = createClient();
  await client.connect();
  await client.mailboxDelete(name);
  await client.logout();
  return { deleted: name };
}

async function getMailboxSummary(mailbox) {
  const client = createClient();
  await client.connect();
  const status = await client.status(mailbox, { messages: true, unseen: true, recent: true });
  await client.logout();
  return { mailbox, total: status.messages, unread: status.unseen, recent: status.recent };
}

async function getEmailContent(uid, mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const meta = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
  let body = '(body unavailable)';
  try {
    const sourceMsg = await Promise.race([
      client.fetchOne(uid, { source: true }, { uid: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
    ]);
    if (sourceMsg?.source) {
      const raw = sourceMsg.source.toString();
      const bodyStart = raw.indexOf('\r\n\r\n');
      body = bodyStart > -1 ? raw.slice(bodyStart + 4, bodyStart + 2000) : raw.slice(0, 2000);
    }
  } catch {
    body = '(body unavailable - email may be too large)';
  }
  await client.logout();
  return {
    uid: meta.uid,
    subject: meta.envelope.subject,
    from: meta.envelope.from?.[0]?.address,
    date: meta.envelope.date,
    flags: [...meta.flags],
    body
  };
}

async function flagEmail(uid, flagged, mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  if (flagged) {
    await client.messageFlagsAdd(uid, ['\\Flagged'], { uid: true });
  } else {
    await client.messageFlagsRemove(uid, ['\\Flagged'], { uid: true });
  }
  await client.logout();
  return true;
}

async function markAsRead(uid, seen, mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  if (seen) {
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
  } else {
    await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
  }
  await client.logout();
  return true;
}

async function deleteEmail(uid, mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  await client.messageDelete(uid, { uid: true });
  await client.logout();
  return true;
}

async function listMailboxes() {
  const client = createClient();
  await client.connect();
  const tree = await client.listTree();
  const mailboxes = [];
  function walk(items) {
    for (const item of items) {
      mailboxes.push({ name: item.name, path: item.path });
      if (item.folders && item.folders.length > 0) walk(item.folders);
    }
  }
  walk(tree.folders);
  await client.logout();
  return mailboxes;
}

async function searchEmails(query, mailbox = 'INBOX', limit = 10, filters = {}) {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);

  // Build base text search
  const textQuery = { or: [{ subject: query }, { from: query }, { body: query }] };

  // Merge with additional filters if provided
  const extraQuery = buildQuery(filters);
  const finalQuery = Object.keys(extraQuery).length > 0 && !extraQuery.all
    ? { ...textQuery, ...extraQuery }
    : textQuery;

  const uids = (await client.search(finalQuery, { uid: true })) ?? [];
  const emails = [];
  const recentUids = uids.slice(-limit).reverse();
  for (const uid of recentUids) {
    const msg = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
    if (msg) {
      emails.push({
        uid,
        subject: msg.envelope.subject,
        from: msg.envelope.from?.[0]?.address,
        date: msg.envelope.date,
        flagged: msg.flags.has('\\Flagged'),
        seen: msg.flags.has('\\Seen')
      });
    }
  }
  await client.logout();
  return { total: uids.length, showing: emails.length, emails };
}

async function moveEmail(uid, targetMailbox, sourceMailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  await client.messageMove(uid, targetMailbox, { uid: true });
  await client.logout();
  return true;
}

// Build an IMAP search query from a filters object
function buildQuery(filters) {
  const query = {};
  if (filters.sender) query.from = filters.sender;
  if (filters.domain) query.from = filters.domain.replace(/^@/, '');
  if (filters.subject) query.subject = filters.subject;
  if (filters.before) query.before = new Date(filters.before);
  if (filters.since) query.since = new Date(filters.since);
  if (filters.unread === true) query.seen = false;
  if (filters.unread === false) query.seen = true;
  if (filters.flagged === true) query.flagged = true;
  if (filters.flagged === false) query.unflagged = true;
  if (filters.larger) query.larger = filters.larger * 1024;
  if (filters.smaller) query.smaller = filters.smaller * 1024;
  if (filters.hasAttachment) query.header = ['Content-Type', 'multipart/mixed'];
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

async function bulkMove(filters, targetMailbox, sourceMailbox = 'INBOX', dryRun = false) {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  const query = buildQuery(filters);
  const uids = (await client.search(query, { uid: true })) ?? [];
  if (dryRun) {
    await client.logout();
    return { dryRun: true, wouldMove: uids.length, sourceMailbox, targetMailbox, filters };
  }
  if (uids.length === 0) { await client.logout(); return { moved: 0, sourceMailbox, targetMailbox }; }
  await client.messageMove(uids, targetMailbox, { uid: true });
  await client.logout();
  return { moved: uids.length, sourceMailbox, targetMailbox, filters };
}

async function bulkDelete(filters, sourceMailbox = 'INBOX', dryRun = false) {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  const query = buildQuery(filters);
  const uids = (await client.search(query, { uid: true })) ?? [];
  if (dryRun) {
    await client.logout();
    return { dryRun: true, wouldDelete: uids.length, sourceMailbox, filters };
  }
  if (uids.length === 0) { await client.logout(); return { deleted: 0, sourceMailbox }; }
  await client.messageDelete(uids, { uid: true });
  await client.logout();
  return { deleted: uids.length, sourceMailbox, filters };
}

async function countEmails(filters, mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const query = buildQuery(filters);
  const uids = (await client.search(query, { uid: true })) ?? [];
  await client.logout();
  return { count: uids.length, mailbox, filters };
}

async function main() {
  const server = new Server(
    { name: 'icloud-mail', version: '1.2.0' },
    { capabilities: { tools: {} } }
  );

  const filtersSchema = {
    sender: { type: 'string', description: 'Match exact sender email address' },
    domain: { type: 'string', description: 'Match any sender from this domain (e.g. substack.com)' },
    subject: { type: 'string', description: 'Keyword to match in subject' },
    before: { type: 'string', description: 'Only emails before this date (YYYY-MM-DD)' },
    since: { type: 'string', description: 'Only emails since this date (YYYY-MM-DD)' },
    unread: { type: 'boolean', description: 'True for unread only, false for read only' },
    flagged: { type: 'boolean', description: 'True for flagged only, false for unflagged only' },
    larger: { type: 'number', description: 'Only emails larger than this size in KB' },
    smaller: { type: 'number', description: 'Only emails smaller than this size in KB' },
    hasAttachment: { type: 'boolean', description: 'Only emails with attachments' }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_inbox_summary',
        description: 'Get a summary of a mailbox including total, unread, and recent email counts',
        inputSchema: { type: 'object', properties: { mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' } } }
      },
      {
        name: 'get_mailbox_summary',
        description: 'Get total, unread, and recent email counts for any specific mailbox/folder',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox path to summarize (e.g. Newsletters, Archive)' }
          },
          required: ['mailbox']
        }
      },
      {
        name: 'get_top_senders',
        description: 'Get the top senders by email count from a sample of the inbox',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox to analyze (default INBOX)' },
            sampleSize: { type: 'number', description: 'Number of emails to sample (default 500)' },
            maxResults: { type: 'number', description: 'Max number of senders/domains to return (default 20)' }
          }
        }
      },
      {
        name: 'get_unread_senders',
        description: 'Get top senders of unread emails',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox to analyze (default INBOX)' },
            sampleSize: { type: 'number', description: 'Number of emails to sample (default 500)' },
            maxResults: { type: 'number', description: 'Max number of senders to return (default 20)' }
          }
        }
      },
      {
        name: 'get_emails_by_sender',
        description: 'Get all emails from a specific sender',
        inputSchema: {
          type: 'object',
          properties: {
            sender: { type: 'string', description: 'Sender email address or domain' },
            mailbox: { type: 'string', description: 'Mailbox to search (default INBOX)' },
            limit: { type: 'number', description: 'Max results to show (default 10)' }
          },
          required: ['sender']
        }
      },
      {
        name: 'read_inbox',
        description: 'Read emails from iCloud inbox with pagination',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of emails per page (default 10)' },
            page: { type: 'number', description: 'Page number (default 1)' },
            onlyUnread: { type: 'boolean', description: 'Only fetch unread emails' },
            mailbox: { type: 'string', description: 'Mailbox to read (default INBOX)' }
          }
        }
      },
      {
        name: 'get_email',
        description: 'Get full content of a specific email by UID',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' }
          },
          required: ['uid']
        }
      },
      {
        name: 'search_emails',
        description: 'Search emails by keyword, with optional filters for date, read status, domain, and more',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keyword (matches subject, sender, body)' },
            mailbox: { type: 'string', description: 'Mailbox to search (default INBOX)' },
            limit: { type: 'number', description: 'Max results (default 10)' },
            ...filtersSchema
          },
          required: ['query']
        }
      },
      {
        name: 'count_emails',
        description: 'Count how many emails match a set of filters without moving or deleting them. Use this before bulk_move or bulk_delete to preview how many emails will be affected.',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox to count in (default INBOX)' },
            ...filtersSchema
          }
        }
      },
      {
        name: 'bulk_move',
        description: 'Move emails matching any combination of filters from one mailbox to another. Operates on ALL matching emails in a single IMAP operation. Use dryRun: true to preview without making changes.',
        inputSchema: {
          type: 'object',
          properties: {
            targetMailbox: { type: 'string', description: 'Destination mailbox path' },
            sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' },
            dryRun: { type: 'boolean', description: 'If true, preview what would be moved without actually moving' },
            ...filtersSchema
          },
          required: ['targetMailbox']
        }
      },
      {
        name: 'bulk_delete',
        description: 'Delete emails matching any combination of filters. Operates on ALL matching emails in a single IMAP operation. Use dryRun: true to preview without making changes.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceMailbox: { type: 'string', description: 'Mailbox to delete from (default INBOX)' },
            dryRun: { type: 'boolean', description: 'If true, preview what would be deleted without actually deleting' },
            ...filtersSchema
          }
        }
      },
      {
        name: 'bulk_flag',
        description: 'Flag or unflag emails matching any combination of filters in bulk',
        inputSchema: {
          type: 'object',
          properties: {
            flagged: { type: 'boolean', description: 'True to flag, false to unflag' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
            ...filtersSchema
          },
          required: ['flagged']
        }
      },
      {
        name: 'bulk_delete_by_sender',
        description: 'Delete all emails from a specific sender',
        inputSchema: {
          type: 'object',
          properties: {
            sender: { type: 'string', description: 'Sender email address' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' }
          },
          required: ['sender']
        }
      },
      {
        name: 'bulk_move_by_sender',
        description: 'Move all emails from a specific sender to a folder',
        inputSchema: {
          type: 'object',
          properties: {
            sender: { type: 'string', description: 'Sender email address' },
            targetMailbox: { type: 'string', description: 'Destination folder' },
            sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' }
          },
          required: ['sender', 'targetMailbox']
        }
      },
      {
        name: 'bulk_delete_by_subject',
        description: 'Delete all emails matching a subject pattern',
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Subject keyword to match' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' }
          },
          required: ['subject']
        }
      },
      {
        name: 'bulk_mark_read',
        description: 'Mark all emails as read, optionally filtered by sender',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
            sender: { type: 'string', description: 'Optional: only mark emails from this sender as read' }
          }
        }
      },
      {
        name: 'bulk_mark_unread',
        description: 'Mark all emails as unread, optionally filtered by sender',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
            sender: { type: 'string', description: 'Optional: only mark emails from this sender as unread' }
          }
        }
      },
      {
        name: 'delete_older_than',
        description: 'Delete all emails older than a certain number of days',
        inputSchema: {
          type: 'object',
          properties: {
            days: { type: 'number', description: 'Delete emails older than this many days' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' }
          },
          required: ['days']
        }
      },
      {
        name: 'get_emails_by_date_range',
        description: 'Get emails between two dates',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
            endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
            limit: { type: 'number', description: 'Max results (default 10)' }
          },
          required: ['startDate', 'endDate']
        }
      },
      {
        name: 'flag_email',
        description: 'Flag or unflag a single email',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            flagged: { type: 'boolean', description: 'True to flag, false to unflag' },
            mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' }
          },
          required: ['uid', 'flagged']
        }
      },
      {
        name: 'mark_as_read',
        description: 'Mark a single email as read or unread',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            seen: { type: 'boolean', description: 'True to mark as read, false for unread' },
            mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' }
          },
          required: ['uid', 'seen']
        }
      },
      {
        name: 'delete_email',
        description: 'Delete a single email',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' }
          },
          required: ['uid']
        }
      },
      {
        name: 'move_email',
        description: 'Move a single email to a different mailbox/folder',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            targetMailbox: { type: 'string', description: 'Destination mailbox path' },
            sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' }
          },
          required: ['uid', 'targetMailbox']
        }
      },
      {
        name: 'list_mailboxes',
        description: 'List all mailboxes/folders in iCloud Mail',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'create_mailbox',
        description: 'Create a new mailbox/folder',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name of the new mailbox' }
          },
          required: ['name']
        }
      },
      {
        name: 'rename_mailbox',
        description: 'Rename an existing mailbox/folder',
        inputSchema: {
          type: 'object',
          properties: {
            oldName: { type: 'string', description: 'Current mailbox path' },
            newName: { type: 'string', description: 'New mailbox path' }
          },
          required: ['oldName', 'newName']
        }
      },
      {
        name: 'delete_mailbox',
        description: 'Delete a mailbox/folder. The folder must be empty first.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Mailbox path to delete' }
          },
          required: ['name']
        }
      },
      {
        name: 'empty_trash',
        description: 'Permanently delete all emails in Deleted Messages',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      if (name === 'get_inbox_summary') {
        result = await getInboxSummary(args.mailbox || 'INBOX');
      } else if (name === 'get_mailbox_summary') {
        result = await getMailboxSummary(args.mailbox);
      } else if (name === 'get_top_senders') {
        result = await getTopSenders(args.mailbox || 'INBOX', args.sampleSize || 500, args.maxResults || 20);
      } else if (name === 'get_unread_senders') {
        result = await getUnreadSenders(args.mailbox || 'INBOX', args.sampleSize || 500, args.maxResults || 20);
      } else if (name === 'get_emails_by_sender') {
        result = await getEmailsBySender(args.sender, args.mailbox || 'INBOX', args.limit || 10);
      } else if (name === 'read_inbox') {
        result = await fetchEmails(args.mailbox || 'INBOX', args.limit || 10, args.onlyUnread || false, args.page || 1);
      } else if (name === 'get_email') {
        result = await getEmailContent(args.uid, args.mailbox || 'INBOX');
      } else if (name === 'search_emails') {
        const { query, mailbox, limit, ...filters } = args;
        result = await searchEmails(query, mailbox || 'INBOX', limit || 10, filters);
      } else if (name === 'count_emails') {
        const { mailbox, ...filters } = args;
        result = await countEmails(filters, mailbox || 'INBOX');
      } else if (name === 'bulk_move') {
        const { targetMailbox, sourceMailbox, dryRun, ...filters } = args;
        result = await bulkMove(filters, targetMailbox, sourceMailbox || 'INBOX', dryRun || false);
      } else if (name === 'bulk_delete') {
        const { sourceMailbox, dryRun, ...filters } = args;
        result = await bulkDelete(filters, sourceMailbox || 'INBOX', dryRun || false);
      } else if (name === 'bulk_flag') {
        const { flagged, mailbox, ...filters } = args;
        result = await bulkFlag(filters, flagged, mailbox || 'INBOX');
      } else if (name === 'bulk_delete_by_sender') {
        result = await bulkDeleteBySender(args.sender, args.mailbox || 'INBOX');
      } else if (name === 'bulk_move_by_sender') {
        result = await bulkMoveBySender(args.sender, args.targetMailbox, args.sourceMailbox || 'INBOX');
      } else if (name === 'bulk_delete_by_subject') {
        result = await bulkDeleteBySubject(args.subject, args.mailbox || 'INBOX');
      } else if (name === 'bulk_mark_read') {
        result = await bulkMarkRead(args.mailbox || 'INBOX', args.sender || null);
      } else if (name === 'bulk_mark_unread') {
        result = await bulkMarkUnread(args.mailbox || 'INBOX', args.sender || null);
      } else if (name === 'delete_older_than') {
        result = await deleteOlderThan(args.days, args.mailbox || 'INBOX');
      } else if (name === 'get_emails_by_date_range') {
        result = await getEmailsByDateRange(args.startDate, args.endDate, args.mailbox || 'INBOX', args.limit || 10);
      } else if (name === 'flag_email') {
        result = await flagEmail(args.uid, args.flagged, args.mailbox || 'INBOX');
      } else if (name === 'mark_as_read') {
        result = await markAsRead(args.uid, args.seen, args.mailbox || 'INBOX');
      } else if (name === 'delete_email') {
        result = await deleteEmail(args.uid, args.mailbox || 'INBOX');
      } else if (name === 'move_email') {
        result = await moveEmail(args.uid, args.targetMailbox, args.sourceMailbox || 'INBOX');
      } else if (name === 'list_mailboxes') {
        result = await listMailboxes();
      } else if (name === 'create_mailbox') {
        result = await createMailbox(args.name);
      } else if (name === 'rename_mailbox') {
        result = await renameMailbox(args.oldName, args.newName);
      } else if (name === 'delete_mailbox') {
        result = await deleteMailbox(args.name);
      } else if (name === 'empty_trash') {
        result = await emptyTrash();
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('iCloud Mail MCP Server running\n');
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`Uncaught exception: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`Unhandled rejection: ${reason}\n`);
  process.exit(1);
});

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});