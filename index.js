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

async function fetchEmails(mailbox = 'INBOX', limit = 20, onlyUnread = false) {
  const client = createClient();
  await client.connect();
  const emails = [];
  await client.mailboxOpen(mailbox);
  const query = onlyUnread ? { seen: false } : { all: true };
  for await (const msg of client.fetch(query, { envelope: true, flags: true }, { limitCount: limit, reverse: true })) {
    emails.push({
      uid: msg.uid,
      subject: msg.envelope.subject,
      from: msg.envelope.from?.[0]?.address,
      date: msg.envelope.date,
      flags: [...msg.flags],
      flagged: msg.flags.has('\\Flagged'),
      seen: msg.flags.has('\\Seen')
    });
  }
  await client.logout();
  return emails;
}

async function getEmailContent(uid, mailbox = 'INBOX') {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const msg = await client.fetchOne(uid, { source: true, envelope: true, flags: true });
  const raw = msg.source.toString();
  const bodyStart = raw.indexOf('\r\n\r\n');
  const body = bodyStart > -1 ? raw.slice(bodyStart + 4, bodyStart + 2000) : raw.slice(0, 2000);
  await client.logout();
  return {
    uid: msg.uid,
    subject: msg.envelope.subject,
    from: msg.envelope.from?.[0]?.address,
    date: msg.envelope.date,
    flags: [...msg.flags],
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
  const mailboxes = [];
  for await (const mb of client.list()) {
    mailboxes.push({ name: mb.name, path: mb.path });
  }
  await client.logout();
  return mailboxes;
}

async function searchEmails(query, mailbox = 'INBOX', limit = 20) {
  const client = createClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = await client.search({ or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true });
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
  return emails;
}

async function main() {
  const server = new Server(
    { name: 'icloud-mail', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'read_inbox',
        description: 'Read emails from iCloud inbox',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of emails to fetch (default 20)' },
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
        description: 'Search emails by keyword',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            mailbox: { type: 'string', description: 'Mailbox to search (default INBOX)' },
            limit: { type: 'number', description: 'Max results (default 20)' }
          },
          required: ['query']
        }
      },
      {
        name: 'flag_email',
        description: 'Flag or unflag an email',
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
        description: 'Mark an email as read or unread',
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
        description: 'Delete an email',
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
        name: 'list_mailboxes',
        description: 'List all mailboxes/folders in iCloud Mail',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      if (name === 'read_inbox') {
        result = await fetchEmails(args.mailbox || 'INBOX', args.limit || 20, args.onlyUnread || false);
      } else if (name === 'get_email') {
        result = await getEmailContent(args.uid, args.mailbox || 'INBOX');
      } else if (name === 'search_emails') {
        result = await searchEmails(args.query, args.mailbox || 'INBOX', args.limit || 20);
      } else if (name === 'flag_email') {
        result = await flagEmail(args.uid, args.flagged, args.mailbox || 'INBOX');
      } else if (name === 'mark_as_read') {
        result = await markAsRead(args.uid, args.seen, args.mailbox || 'INBOX');
      } else if (name === 'delete_email') {
        result = await deleteEmail(args.uid, args.mailbox || 'INBOX');
      } else if (name === 'list_mailboxes') {
        result = await listMailboxes();
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