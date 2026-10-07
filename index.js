#!/usr/bin/env node
import { readFileSync } from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRateLimitedClient } from './lib/imap.js';
import { mailTools, handleMailTool } from './lib/tools/mail.js';
import { contactTools, handleContactTool } from './lib/tools/contacts.js';
import { calendarTools, suggestEventTools, handleCalendarTool } from './lib/tools/calendar.js';
import { reminderTools, handleReminderTool } from './lib/tools/reminders.js';


const { version: SERVER_VERSION } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD;

if (!IMAP_USER || !IMAP_PASSWORD) {
  if (process.argv.includes('--doctor')) {
    // Doctor will handle missing credentials with friendly output
  } else {
    process.stderr.write('Error: IMAP_USER and IMAP_PASSWORD environment variables are required\n');
    process.exit(1);
  }
}

// ─── Multi-account support ────────────────────────────────────────────────────
// Configure additional accounts via numbered env vars:
//   IMAP_ACCOUNT_1_USER, IMAP_ACCOUNT_1_PASSWORD, IMAP_ACCOUNT_1_HOST,
//   IMAP_ACCOUNT_1_SMTP_HOST, IMAP_ACCOUNT_1_NAME
// Falls back to IMAP_USER / IMAP_PASSWORD (iCloud) when no numbered accounts set.

function parseAccounts() {
  const accounts = {};
  for (let i = 1; i <= 10; i++) {
    const user = process.env[`IMAP_ACCOUNT_${i}_USER`];
    const pass = process.env[`IMAP_ACCOUNT_${i}_PASSWORD`];
    if (!user || !pass) continue;
    const host     = process.env[`IMAP_ACCOUNT_${i}_HOST`]      || 'imap.mail.me.com';
    const smtpHost = process.env[`IMAP_ACCOUNT_${i}_SMTP_HOST`] || 'smtp.mail.me.com';
    const name     = process.env[`IMAP_ACCOUNT_${i}_NAME`]      || `account${i}`;
    accounts[name] = { user, pass, host, smtpHost };
  }
  // Legacy fallback — single iCloud account via IMAP_USER / IMAP_PASSWORD
  if (Object.keys(accounts).length === 0 && IMAP_USER) {
    accounts['icloud'] = { user: IMAP_USER, pass: IMAP_PASSWORD, host: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com' };
  }
  return accounts;
}

const ACCOUNTS = parseAccounts();
const DEFAULT_ACCOUNT = Object.keys(ACCOUNTS)[0] || 'icloud';

function resolveCreds(account) {
  const name = account || DEFAULT_ACCOUNT;
  const creds = ACCOUNTS[name];
  if (!creds) throw new Error(`Account '${name}' not configured. Available: ${Object.keys(ACCOUNTS).join(', ') || 'none'}`);
  return creds;
}

// Gmail uses different folder names than iCloud for system folders.
const GMAIL_MAILBOX_MAP = {
  'Sent Messages':   '[Gmail]/Sent Mail',
  'Archive':         '[Gmail]/All Mail',
  'Deleted Messages':'[Gmail]/Trash',
  'Junk':            '[Gmail]/Spam',
  'Drafts':          '[Gmail]/Drafts',
};

function resolveMailbox(name, creds) {
  if (!name || creds?.host !== 'imap.gmail.com') return name;
  return GMAIL_MAILBOX_MAP[name] || name;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    { name: 'icloud-mail', version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  const orderedTools = [
    ...mailTools,
    ...contactTools,
    ...calendarTools,
    ...reminderTools,
    ...suggestEventTools,
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: orderedTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const ctx = { resolveCreds, resolveMailbox, accounts: ACCOUNTS };
      const handlers = [handleMailTool, handleContactTool, handleCalendarTool, handleReminderTool];
      let result;
      let handled = false;
      for (const handle of handlers) {
        const out = await handle(name, args, ctx);
        if (out !== undefined) {
          result = out;
          handled = true;
          break;
        }
      }
      if (!handled) throw new Error(`Unknown tool: ${name}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      process.stderr.write(`[tool-error] ${name}: ${error.responseText ?? error.message}\n`);
      return { content: [{ type: 'text', text: `Error: ${friendlyError(error)}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('iCloud Mail MCP Server running\n');
}

// ─── Friendly error messages ──────────────────────────────────────────────────

function friendlyError(err) {
  const msg = err.message ?? '';

  if (msg.includes('AUTHENTICATIONFAILED') || msg.includes('Invalid credentials') || msg.includes('Authentication failed')) {
    return [
      'Authentication failed.',
      '→ Make sure IMAP_PASSWORD is an app-specific password, not your regular iCloud password.',
      '→ Generate one at: appleid.apple.com → Sign-In and Security → App-Specific Passwords',
      '→ Also check that IMAP_USER is your full iCloud email address (e.g. you@icloud.com)'
    ].join('\n');
  }

  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ENETUNREACH')) {
    return [
      'Could not reach imap.mail.me.com:993.',
      '→ Check your internet connection.',
      '→ If you are behind a firewall or VPN, port 993 may be blocked.'
    ].join('\n');
  }

  if (msg.includes('ETIMEDOUT') || msg.includes('socket hang up')) {
    return [
      'Connection to iCloud timed out.',
      '→ Check your internet connection and try again.',
      '→ iCloud IMAP can be slow under load — this is usually transient.'
    ].join('\n');
  }

  if (msg.includes('ECONNRESET')) {
    return [
      'iCloud closed the connection unexpectedly.',
      '→ This is usually transient. Try again in a few seconds.'
    ].join('\n');
  }

  if (msg.includes('timed out after')) {
    return [
      `Operation ${msg}`,
      '→ This usually means iCloud is slow or the operation is larger than expected.',
      '→ Try again — if it persists, the operation may need to be broken into smaller steps.'
    ].join('\n');
  }

  if (msg.includes('Mailbox does not exist') || msg.includes('does not exist') || msg.includes('NONEXISTENT')) {
    return [
      `Mailbox not found: ${msg}`,
      '→ Check the folder name is correct — iCloud folder names are case-sensitive.',
      '→ Use list_mailboxes to see all available folders.'
    ].join('\n');
  }

  // Fall through — return original message
  return msg;
}

// ─── Doctor command ───────────────────────────────────────────────────────────

async function runDoctor() {
  const divider = '─'.repeat(45);
  process.stdout.write(`\nicloud-mcp doctor\n${divider}\n`);

  const checks = [
    {
      label: 'IMAP_USER is set',
      run: () => {
        if (!IMAP_USER) throw new Error('IMAP_USER environment variable is not set.\n→ Add it to your Claude Desktop config env block.');
      }
    },
    {
      label: 'IMAP_PASSWORD is set',
      run: () => {
        if (!IMAP_PASSWORD) throw new Error('IMAP_PASSWORD environment variable is not set.\n→ Add it to your Claude Desktop config env block.');
      }
    },
    {
      label: 'IMAP_USER looks like an email address',
      run: () => {
        if (!IMAP_USER?.includes('@')) throw new Error(`IMAP_USER "${IMAP_USER}" doesn't look like an email address.\n→ Use your full iCloud address, e.g. you@icloud.com`);
      }
    },
    {
      label: `Connected to imap.mail.me.com:993`,
      run: async () => {
        const client = createRateLimitedClient();
        await client.connect();
        await client.logout();
      }
    },
    {
      label: `Authenticated as ${IMAP_USER}`,
      run: async () => {
        // Auth is validated as part of connect — if we reach here it passed.
        // This check exists to give a clearer label in the output.
      }
    },
    {
      label: 'INBOX opened',
      run: async () => {
        const client = createRateLimitedClient();
        await client.connect();
        const mb = await client.mailboxOpen('INBOX');
        await client.logout();
        return `${mb.exists.toLocaleString()} messages`;
      }
    }
  ];

  let allPassed = true;

  for (const check of checks) {
    try {
      const detail = await check.run();
      const suffix = detail ? ` (${detail})` : '';
      process.stdout.write(`✅ ${check.label}${suffix}\n`);
    } catch (err) {
      process.stdout.write(`❌ ${check.label}\n   ${friendlyError(err).replace(/\n/g, '\n   ')}\n`);
      allPassed = false;
      break; // No point continuing after a failure
    }
  }

  process.stdout.write(`${divider}\n`);
  if (allPassed) {
    process.stdout.write('All checks passed. Ready to use with Claude Desktop.\n\n');
    process.exit(0);
  } else {
    process.stdout.write('Setup is not complete. Fix the issue above and run --doctor again.\n\n');
    process.exit(1);
  }
}


process.on('uncaughtException', (err) => {
  process.stderr.write(`Uncaught exception: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`Unhandled rejection: ${reason}\n`);
  process.exit(1);
});

if (process.argv.includes('--doctor')) {
  runDoctor().catch((err) => {
    process.stderr.write(`Doctor failed unexpectedly: ${err.message}\n`);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}
