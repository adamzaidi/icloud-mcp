#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  TIMEOUT, withTimeout, createRateLimitedClient,
  fetchEmails, getInboxSummary, getMailboxSummary, getTopSenders, getUnreadSenders,
  getEmailsBySender, getEmailsByDateRange, searchEmails,
  getEmailContent, getEmailRaw, listAttachments, getAttachment, getUnsubscribeInfo,
  getThread, getStorageReport,
  flagEmail, markAsRead, deleteEmail, moveEmail, listMailboxes,
  bulkMove, bulkMoveBySender, bulkMoveByDomain, archiveOlderThan,
  bulkDelete, bulkDeleteBySender, bulkDeleteBySubject, deleteOlderThan,
  bulkMarkRead, bulkMarkUnread, markOlderThanRead,
  bulkFlag, bulkFlagBySender, emptyTrash,
  createMailbox, renameMailbox, deleteMailbox,
  getMoveStatus, abandonMove, countEmails,
  createRule, listRules, runRule, deleteRule, runAllRules,
} from './lib/imap.js';
import { logRead, logWrite, logClear } from './lib/session.js';
import { composeEmail, replyToEmail, forwardEmail, saveDraft } from './lib/smtp.js';
import { listContacts, searchContacts, getContact, createContact, updateContact, deleteContact } from './lib/carddav.js';
import { formatEmailForExtraction } from './lib/event-extractor.js';
import { listCalendars, listEvents, getEvent, createEvent, updateEvent, deleteEvent, searchEvents } from './lib/caldav.js';

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

// ─── MCP Server ───────────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    { name: 'icloud-mail', version: '2.3.0' },
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
    hasAttachment: { type: 'boolean', description: 'Only emails with attachments (client-side BODYSTRUCTURE scan — must be combined with other filters that narrow results to under 500 emails first)' }
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
          properties: { mailbox: { type: 'string', description: 'Mailbox path to summarize (e.g. Newsletters, Archive)' } },
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
            mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' },
            maxChars: { type: 'number', description: 'Max body characters to return (default 8000, max 50000)' },
            includeHeaders: { type: 'boolean', description: 'If true, include a headers object with to/cc/replyTo/messageId/inReplyTo/references/listUnsubscribe' }
          },
          required: ['uid']
        }
      },
      {
        name: 'search_emails',
        description: 'Search emails by keyword or targeted field queries, with optional filters for date, read status, domain, and more',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keyword (matches subject, sender, body — use OR across all fields)' },
            subjectQuery: { type: 'string', description: 'Match only in subject field' },
            bodyQuery: { type: 'string', description: 'Match only in body field' },
            fromQuery: { type: 'string', description: 'Match only in from/sender field' },
            queryMode: { type: 'string', enum: ['or', 'and'], description: 'How to combine subjectQuery/bodyQuery/fromQuery: or (default) or and' },
            mailbox: { type: 'string', description: 'Mailbox to search (default INBOX)' },
            limit: { type: 'number', description: 'Max results (default 10)' },
            includeSnippet: { type: 'boolean', description: 'If true, include a 200-char body preview snippet for each result (max 10 emails)' },
            ...filtersSchema
          }
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
        description: 'Move emails matching any combination of filters from one mailbox to another. Uses safe copy-verify-delete with fingerprint verification and a persistent manifest. Use dryRun: true to preview without making changes.',
        inputSchema: {
          type: 'object',
          properties: {
            targetMailbox: { type: 'string', description: 'Destination mailbox path' },
            sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' },
            dryRun: { type: 'boolean', description: 'If true, preview what would be moved without actually moving' },
            limit: { type: 'number', description: 'Maximum number of emails to move (default: all matching)' },
            ...filtersSchema
          },
          required: ['targetMailbox']
        }
      },
      {
        name: 'bulk_delete',
        description: 'Delete emails matching any combination of filters. Processes in chunks of 250 with per-chunk timeouts for reliability. Use dryRun: true to preview without making changes.',
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
            sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' },
            dryRun: { type: 'boolean', description: 'Preview only — return count without moving' }
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
          properties: { name: { type: 'string', description: 'Name of the new mailbox' } },
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
          properties: { name: { type: 'string', description: 'Mailbox path to delete' } },
          required: ['name']
        }
      },
      {
        name: 'empty_trash',
        description: 'Permanently delete all emails in the trash (Deleted Messages or Trash folder). Use dryRun: true to preview first.',
        inputSchema: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', description: 'If true, preview how many emails would be deleted without deleting' }
          }
        }
      },
      {
        name: 'get_move_status',
        description: 'Check the status of the current or most recent bulk move operation. Shows progress, chunk statuses, and any failures. Call this to monitor a long-running move or inspect a failed one.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'abandon_move',
        description: 'Abandon an in-progress move operation so a new one can start. Only use if you are certain the operation should not be resumed. Emails already moved will not be returned to source.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'log_write',
        description: 'Write a step to the session log. Use this to record your plan before starting, and after each completed step. Helps maintain progress across long operations.',
        inputSchema: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'Description of what you are doing or just completed' }
          },
          required: ['step']
        }
      },
      {
        name: 'log_read',
        description: 'Read the current session log to see what has been done so far.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'log_clear',
        description: 'Clear the session log and start fresh. Use this at the start of a new task.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'list_attachments',
        description: 'List all attachments in an email without downloading them. Returns filename, MIME type, size, and IMAP part ID for each attachment.',
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
        name: 'get_attachment',
        description: 'Download a specific attachment from an email. Returns the file content as base64-encoded data. Use list_attachments first to get the partId. Maximum 20 MB per request; use offset+length for larger files.',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            partId: { type: 'string', description: 'IMAP body part ID from list_attachments (e.g. "2", "1.2")' },
            mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' },
            offset: { type: 'number', description: 'Byte offset for paginated download (returns raw encoded bytes, not decoded)' },
            length: { type: 'number', description: 'Max bytes to return for paginated download (default 20 MB)' }
          },
          required: ['uid', 'partId']
        }
      },
      {
        name: 'get_unsubscribe_info',
        description: 'Get the List-Unsubscribe header from an email, parsed into email and URL components. Useful for AI-assisted inbox cleanup.',
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
        name: 'mark_older_than_read',
        description: 'Mark all unread emails older than N days as read. Useful for bulk triage of a cluttered inbox.',
        inputSchema: {
          type: 'object',
          properties: {
            days: { type: 'number', description: 'Mark emails older than this many days as read' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' }
          },
          required: ['days']
        }
      },
      {
        name: 'bulk_move_by_domain',
        description: 'Move all emails from a specific domain to a folder. Convenience wrapper around bulk_move with a domain filter.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Sender domain to match (e.g. github.com, substack.com)' },
            targetMailbox: { type: 'string', description: 'Destination folder' },
            sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' },
            dryRun: { type: 'boolean', description: 'Preview only — return count without moving' }
          },
          required: ['domain', 'targetMailbox']
        }
      },
      {
        name: 'get_email_raw',
        description: 'Get the raw RFC 2822 source of an email (full headers + MIME body) as base64-encoded data. Useful for debugging or export. Capped at 1 MB.',
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
        name: 'bulk_flag_by_sender',
        description: 'Flag or unflag all emails from a specific sender',
        inputSchema: {
          type: 'object',
          properties: {
            sender: { type: 'string', description: 'Sender email address' },
            flagged: { type: 'boolean', description: 'True to flag, false to unflag' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' }
          },
          required: ['sender', 'flagged']
        }
      },
      {
        name: 'archive_older_than',
        description: 'Safely move emails older than N days from a source mailbox to an archive folder. Uses the same safe copy-verify-delete pipeline as bulk_move. Use dryRun: true to preview.',
        inputSchema: {
          type: 'object',
          properties: {
            days: { type: 'number', description: 'Archive emails older than this many days' },
            targetMailbox: { type: 'string', description: 'Destination archive folder (e.g. Archive)' },
            sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' },
            dryRun: { type: 'boolean', description: 'If true, preview what would be moved without moving' }
          },
          required: ['days', 'targetMailbox']
        }
      },
      {
        name: 'get_storage_report',
        description: 'Estimate storage usage by size bucket and identify top senders by email size. Uses SEARCH LARGER queries for bucketing and samples large emails for sender analysis.',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox to analyze (default INBOX)' },
            sampleSize: { type: 'number', description: 'Max number of large emails to sample for sender analysis (default 100)' }
          }
        }
      },
      {
        name: 'get_thread',
        description: 'Find all emails in the same thread as a given email. Uses subject matching + References/In-Reply-To header filtering. Note: iCloud does not support server-side threading — results are approximate.',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID to find the thread for' },
            mailbox: { type: 'string', description: 'Mailbox to search (default INBOX)' }
          },
          required: ['uid']
        }
      },
      // ── Saved Rules ──
      {
        name: 'create_rule',
        description: 'Create a saved rule that applies a specific action to emails matching a set of filters. Rules are stored persistently and can be run on demand or all at once with run_all_rules.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique rule name (used to run or delete the rule)' },
            description: { type: 'string', description: 'Optional human-readable description of what the rule does' },
            filters: {
              type: 'object',
              description: 'Email filters (same as bulk_move/bulk_delete filters: sender, domain, subject, before, since, unread, flagged, larger, smaller)',
              properties: filtersSchema
            },
            action: {
              type: 'object',
              description: 'Action to apply to matching emails',
              properties: {
                type: { type: 'string', enum: ['move', 'delete', 'mark_read', 'mark_unread', 'flag', 'unflag'], description: 'Action type' },
                targetMailbox: { type: 'string', description: 'Destination folder (required for move)' },
                sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' }
              },
              required: ['type']
            }
          },
          required: ['name', 'filters', 'action']
        }
      },
      {
        name: 'list_rules',
        description: 'List all saved rules with their filters, actions, and run history.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'run_rule',
        description: 'Run a specific saved rule by name. Use dryRun: true to preview what would be affected without making changes.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Rule name to run' },
            dryRun: { type: 'boolean', description: 'If true, preview what would be affected without making changes' }
          },
          required: ['name']
        }
      },
      {
        name: 'delete_rule',
        description: 'Delete a saved rule by name.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Rule name to delete' }
          },
          required: ['name']
        }
      },
      {
        name: 'run_all_rules',
        description: 'Run all saved rules in sequence. Use dryRun: true to preview all rules without making changes.',
        inputSchema: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', description: 'If true, preview all rules without making changes' }
          }
        }
      },
      // ── SMTP / Email sending ──
      {
        name: 'compose_email',
        description: 'Compose and send a new email via iCloud SMTP. The From address is always your iCloud account. Supports plain text, HTML, or both (multipart/alternative).',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient email address(es), comma-separated or array' },
            subject: { type: 'string', description: 'Email subject' },
            body: { type: 'string', description: 'Plain text body (used as fallback when html is also provided)' },
            html: { type: 'string', description: 'HTML body. If provided without body, plain text is auto-generated. If provided with body, sends multipart/alternative.' },
            cc: { type: 'string', description: 'CC recipient(s), comma-separated or array' },
            bcc: { type: 'string', description: 'BCC recipient(s), comma-separated or array' },
            replyTo: { type: 'string', description: 'Reply-To address override' }
          },
          required: ['to', 'subject']
        }
      },
      {
        name: 'reply_to_email',
        description: 'Reply to an existing email. Automatically sets correct threading headers (In-Reply-To, References) and prefixes the subject with Re:. Supports plain text and/or HTML body.',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'UID of the email to reply to' },
            body: { type: 'string', description: 'Plain text reply body' },
            html: { type: 'string', description: 'HTML reply body (auto-generates plain text fallback if body not provided)' },
            mailbox: { type: 'string', description: 'Mailbox containing the original email (default INBOX)' },
            replyAll: { type: 'boolean', description: 'If true, reply to all recipients (To + Cc). Default false.' },
            cc: { type: 'string', description: 'Additional CC recipients for this reply' }
          },
          required: ['uid']
        }
      },
      {
        name: 'forward_email',
        description: 'Forward an existing email to one or more recipients. Fetches the original email body and includes it as a forwarded message block. Supports plain text and/or HTML note.',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'UID of the email to forward' },
            to: { type: 'string', description: 'Recipient(s) to forward to, comma-separated or array' },
            note: { type: 'string', description: 'Optional plain text note to prepend before the forwarded message' },
            html: { type: 'string', description: 'Optional HTML note to prepend (overrides plain text note for HTML rendering)' },
            mailbox: { type: 'string', description: 'Mailbox containing the original email (default INBOX)' },
            cc: { type: 'string', description: 'CC recipients' }
          },
          required: ['uid', 'to']
        }
      },
      {
        name: 'save_draft',
        description: 'Save a draft email to your iCloud Drafts folder without sending it. Supports plain text, HTML, or both. The draft can be edited and sent later from Mail.app or iCloud.com.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Intended recipient(s), comma-separated or array' },
            subject: { type: 'string', description: 'Email subject' },
            body: { type: 'string', description: 'Plain text body (used as fallback when html is also provided)' },
            html: { type: 'string', description: 'HTML body. If provided without body, plain text is auto-generated. If provided with body, saves multipart/alternative.' },
            cc: { type: 'string', description: 'CC recipient(s)' },
            bcc: { type: 'string', description: 'BCC recipient(s)' }
          },
          required: ['to', 'subject']
        }
      },
      // ── CardDAV / Contacts ──
      {
        name: 'list_contacts',
        description: 'List contacts from iCloud Contacts. Returns names, phones, emails, and other fields.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max contacts to return (default 50)' },
            offset: { type: 'number', description: 'Skip this many contacts (default 0, for pagination)' }
          }
        }
      },
      {
        name: 'search_contacts',
        description: 'Search iCloud Contacts by name, email address, or phone number.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to search for (matched against name, email, and phone)' }
          },
          required: ['query']
        }
      },
      {
        name: 'get_contact',
        description: 'Get full details for a specific contact by ID. Use list_contacts or search_contacts to find a contactId.',
        inputSchema: {
          type: 'object',
          properties: {
            contactId: { type: 'string', description: 'Contact ID (UUID from list_contacts or search_contacts)' }
          },
          required: ['contactId']
        }
      },
      {
        name: 'create_contact',
        description: 'Create a new contact in iCloud Contacts.',
        inputSchema: {
          type: 'object',
          properties: {
            firstName: { type: 'string', description: 'First name' },
            lastName: { type: 'string', description: 'Last name' },
            fullName: { type: 'string', description: 'Full display name (overrides firstName + lastName for FN field)' },
            org: { type: 'string', description: 'Organization / company name' },
            phone: { type: 'string', description: 'Primary phone number (shorthand for phones array)' },
            email: { type: 'string', description: 'Primary email address (shorthand for emails array)' },
            phones: { type: 'array', description: 'Array of phone objects: [{ number, type }] where type is cell/home/work/etc.' },
            emails: { type: 'array', description: 'Array of email objects: [{ email, type }] where type is home/work/etc.' },
            addresses: { type: 'array', description: 'Array of address objects: [{ street, city, state, zip, country, type }]' },
            birthday: { type: 'string', description: 'Birthday in YYYY-MM-DD format' },
            note: { type: 'string', description: 'Notes / free text' },
            url: { type: 'string', description: 'Website URL' }
          }
        }
      },
      {
        name: 'update_contact',
        description: 'Update an existing contact in iCloud Contacts. Only provided fields are changed; others are preserved.',
        inputSchema: {
          type: 'object',
          properties: {
            contactId: { type: 'string', description: 'Contact ID to update' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            fullName: { type: 'string' },
            org: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string' },
            phones: { type: 'array' },
            emails: { type: 'array' },
            addresses: { type: 'array' },
            birthday: { type: 'string' },
            note: { type: 'string' },
            url: { type: 'string' }
          },
          required: ['contactId']
        }
      },
      {
        name: 'delete_contact',
        description: 'Delete a contact from iCloud Contacts permanently.',
        inputSchema: {
          type: 'object',
          properties: {
            contactId: { type: 'string', description: 'Contact ID to delete' }
          },
          required: ['contactId']
        }
      },
      // ── CalDAV / Calendar ──
      {
        name: 'list_calendars',
        description: 'List all calendars in iCloud Calendar (e.g. Personal, Work, LSAT PREP). Returns calendarId, name, and supported event types.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'list_events',
        description: 'List events in a specific iCloud calendar within a date range. Use list_calendars first to get a calendarId.',
        inputSchema: {
          type: 'object',
          properties: {
            calendarId: { type: 'string', description: 'Calendar ID from list_calendars' },
            since: { type: 'string', description: 'Start of range (YYYY-MM-DD, default: 30 days ago)' },
            before: { type: 'string', description: 'End of range (YYYY-MM-DD, default: 30 days ahead)' },
            limit: { type: 'number', description: 'Max events to return (default 50)' }
          },
          required: ['calendarId']
        }
      },
      {
        name: 'get_event',
        description: 'Get full details of a specific calendar event by its ID.',
        inputSchema: {
          type: 'object',
          properties: {
            calendarId: { type: 'string', description: 'Calendar ID containing the event' },
            eventId: { type: 'string', description: 'Event ID (UUID from list_events or search_events)' }
          },
          required: ['calendarId', 'eventId']
        }
      },
      {
        name: 'create_event',
        description: 'Create a new event in an iCloud calendar. For all-day events use allDay:true and YYYY-MM-DD for start/end.',
        inputSchema: {
          type: 'object',
          properties: {
            calendarId: { type: 'string', description: 'Calendar ID to add the event to' },
            summary: { type: 'string', description: 'Event title' },
            start: { type: 'string', description: 'Start date/time — ISO 8601 (e.g. 2026-03-15T10:00:00) or YYYY-MM-DD for all-day' },
            end: { type: 'string', description: 'End date/time — ISO 8601 or YYYY-MM-DD. Defaults to 1 hour after start.' },
            timezone: { type: 'string', description: 'IANA timezone (e.g. America/New_York). Use "UTC" or omit for UTC.' },
            allDay: { type: 'boolean', description: 'True for all-day event (uses DATE values, no time)' },
            description: { type: 'string', description: 'Event description / notes' },
            location: { type: 'string', description: 'Event location' },
            recurrence: { type: 'string', description: 'iCal RRULE string (e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR)' },
            status: { type: 'string', description: 'Event status: CONFIRMED, TENTATIVE, or CANCELLED' },
            reminder: { type: 'number', description: 'Alert this many minutes before the event (default 30, set to 0 to disable)' }
          },
          required: ['calendarId', 'summary', 'start']
        }
      },
      {
        name: 'update_event',
        description: 'Update an existing calendar event. Only provided fields are changed; others are preserved.',
        inputSchema: {
          type: 'object',
          properties: {
            calendarId: { type: 'string', description: 'Calendar ID containing the event' },
            eventId: { type: 'string', description: 'Event ID to update' },
            summary: { type: 'string' },
            start: { type: 'string' },
            end: { type: 'string' },
            timezone: { type: 'string' },
            allDay: { type: 'boolean' },
            description: { type: 'string' },
            location: { type: 'string' },
            recurrence: { type: 'string' },
            status: { type: 'string' },
            reminder: { type: 'number', description: 'Alert minutes before event (0 to disable)' }
          },
          required: ['calendarId', 'eventId']
        }
      },
      {
        name: 'delete_event',
        description: 'Delete a calendar event permanently from iCloud Calendar.',
        inputSchema: {
          type: 'object',
          properties: {
            calendarId: { type: 'string', description: 'Calendar ID containing the event' },
            eventId: { type: 'string', description: 'Event ID to delete' }
          },
          required: ['calendarId', 'eventId']
        }
      },
      {
        name: 'search_events',
        description: 'Search for events by title/summary across all calendars within an optional date range.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to search for in event titles' },
            since: { type: 'string', description: 'Start of search range (YYYY-MM-DD, default: 1 year ago)' },
            before: { type: 'string', description: 'End of search range (YYYY-MM-DD, default: 1 year ahead)' }
          },
          required: ['query']
        }
      },
      // ── Smart extraction ──
      {
        name: 'suggest_event_from_email',
        description: 'Fetch an email and return its content formatted for calendar event extraction. After calling this tool, extract the event fields from the returned content (pay attention to _dateAnchor for resolving relative dates like "Tuesday"), present a summary to the user for confirmation, then call create_event. No API key required.',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID to extract event from' },
            mailbox: { type: 'string', description: 'Mailbox containing the email (default INBOX)' }
          },
          required: ['uid']
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      // ── Metadata tier (15s) ──
      if (name === 'get_inbox_summary') {
        result = await withTimeout('get_inbox_summary', TIMEOUT.METADATA, () => getInboxSummary(args.mailbox || 'INBOX'));
      } else if (name === 'get_mailbox_summary') {
        result = await withTimeout('get_mailbox_summary', TIMEOUT.METADATA, () => getMailboxSummary(args.mailbox));
      } else if (name === 'count_emails') {
        const { mailbox, ...filters } = args;
        result = await withTimeout('count_emails', TIMEOUT.METADATA, () => countEmails(filters, mailbox || 'INBOX'));
      } else if (name === 'list_mailboxes') {
        result = await withTimeout('list_mailboxes', TIMEOUT.METADATA, () => listMailboxes());
      } else if (name === 'create_mailbox') {
        result = await withTimeout('create_mailbox', TIMEOUT.METADATA, () => createMailbox(args.name));
      } else if (name === 'rename_mailbox') {
        result = await renameMailbox(args.oldName, args.newName); // already has its own 15s timeout
      } else if (name === 'delete_mailbox') {
        result = await deleteMailbox(args.name); // already has its own 15s timeout
      // ── Fetch tier (30s) ──
      } else if (name === 'read_inbox') {
        result = await withTimeout('read_inbox', TIMEOUT.FETCH, () => fetchEmails(args.mailbox || 'INBOX', args.limit || 10, args.onlyUnread || false, args.page || 1));
      } else if (name === 'get_email') {
        result = await withTimeout('get_email', TIMEOUT.FETCH, () => getEmailContent(args.uid, args.mailbox || 'INBOX', args.maxChars || 8000, args.includeHeaders || false));
      } else if (name === 'list_attachments') {
        result = await withTimeout('list_attachments', TIMEOUT.FETCH, () => listAttachments(args.uid, args.mailbox || 'INBOX'));
      } else if (name === 'get_attachment') {
        result = await withTimeout('get_attachment', TIMEOUT.FETCH, () => getAttachment(args.uid, args.partId, args.mailbox || 'INBOX', args.offset ?? null, args.length ?? null));
      } else if (name === 'get_unsubscribe_info') {
        result = await withTimeout('get_unsubscribe_info', TIMEOUT.FETCH, () => getUnsubscribeInfo(args.uid, args.mailbox || 'INBOX'));
      } else if (name === 'get_email_raw') {
        result = await withTimeout('get_email_raw', TIMEOUT.FETCH, () => getEmailRaw(args.uid, args.mailbox || 'INBOX'));
      } else if (name === 'get_thread') {
        result = await withTimeout('get_thread', TIMEOUT.FETCH, () => getThread(args.uid, args.mailbox || 'INBOX'));
      } else if (name === 'search_emails') {
        const { query, mailbox, limit, queryMode, subjectQuery, bodyQuery, fromQuery, includeSnippet, ...filters } = args;
        result = await withTimeout('search_emails', TIMEOUT.FETCH, () => searchEmails(query, mailbox || 'INBOX', limit || 10, filters, { queryMode, subjectQuery, bodyQuery, fromQuery, includeSnippet }));
      } else if (name === 'get_emails_by_sender') {
        result = await withTimeout('get_emails_by_sender', TIMEOUT.FETCH, () => getEmailsBySender(args.sender, args.mailbox || 'INBOX', args.limit || 10));
      } else if (name === 'get_emails_by_date_range') {
        result = await withTimeout('get_emails_by_date_range', TIMEOUT.FETCH, () => getEmailsByDateRange(args.startDate, args.endDate, args.mailbox || 'INBOX', args.limit || 10));
      // ── Scan tier (60s) ──
      } else if (name === 'get_top_senders') {
        result = await withTimeout('get_top_senders', TIMEOUT.SCAN, () => getTopSenders(args.mailbox || 'INBOX', args.sampleSize || 500, args.maxResults || 20));
      } else if (name === 'get_unread_senders') {
        result = await withTimeout('get_unread_senders', TIMEOUT.SCAN, () => getUnreadSenders(args.mailbox || 'INBOX', args.sampleSize || 500, args.maxResults || 20));
      } else if (name === 'get_storage_report') {
        result = await withTimeout('get_storage_report', TIMEOUT.SCAN, () => getStorageReport(args.mailbox || 'INBOX', args.sampleSize || 100));
      // ── Bulk operation tier (60s) ──
      } else if (name === 'bulk_delete_by_sender') {
        result = await withTimeout('bulk_delete_by_sender', TIMEOUT.BULK_OP, () => bulkDeleteBySender(args.sender, args.mailbox || 'INBOX'));
      } else if (name === 'bulk_delete_by_subject') {
        result = await withTimeout('bulk_delete_by_subject', TIMEOUT.BULK_OP, () => bulkDeleteBySubject(args.subject, args.mailbox || 'INBOX'));
      } else if (name === 'bulk_mark_read') {
        result = await withTimeout('bulk_mark_read', TIMEOUT.BULK_OP, () => bulkMarkRead(args.mailbox || 'INBOX', args.sender || null));
      } else if (name === 'bulk_mark_unread') {
        result = await withTimeout('bulk_mark_unread', TIMEOUT.BULK_OP, () => bulkMarkUnread(args.mailbox || 'INBOX', args.sender || null));
      } else if (name === 'bulk_flag') {
        const { flagged, mailbox, ...filters } = args;
        result = await withTimeout('bulk_flag', TIMEOUT.BULK_OP, () => bulkFlag(filters, flagged, mailbox || 'INBOX'));
      } else if (name === 'mark_older_than_read') {
        result = await withTimeout('mark_older_than_read', TIMEOUT.BULK_OP, () => markOlderThanRead(args.days, args.mailbox || 'INBOX'));
      } else if (name === 'bulk_flag_by_sender') {
        result = await withTimeout('bulk_flag_by_sender', TIMEOUT.BULK_OP, () => bulkFlagBySender(args.sender, args.flagged, args.mailbox || 'INBOX'));
      } else if (name === 'delete_older_than') {
        result = await withTimeout('delete_older_than', TIMEOUT.BULK_OP, () => deleteOlderThan(args.days, args.mailbox || 'INBOX'));
      } else if (name === 'empty_trash') {
        result = await withTimeout('empty_trash', TIMEOUT.BULK_OP, () => emptyTrash(args.dryRun || false));
      // ── No top-level timeout — chunked with internal timeouts ──
      } else if (name === 'bulk_move') {
        const { targetMailbox, sourceMailbox, dryRun, limit, ...filters } = args;
        result = await bulkMove(filters, targetMailbox, sourceMailbox || 'INBOX', dryRun || false, limit ?? null);
      } else if (name === 'bulk_move_by_sender') {
        result = await bulkMoveBySender(args.sender, args.targetMailbox, args.sourceMailbox || 'INBOX', args.dryRun || false);
      } else if (name === 'bulk_move_by_domain') {
        result = await bulkMoveByDomain(args.domain, args.targetMailbox, args.sourceMailbox || 'INBOX', args.dryRun || false);
      } else if (name === 'archive_older_than') {
        result = await archiveOlderThan(args.days, args.targetMailbox, args.sourceMailbox || 'INBOX', args.dryRun || false);
      } else if (name === 'bulk_delete') {
        // IMPROVEMENT 3: bulk_delete now has per-chunk timeouts internally
        const { sourceMailbox, dryRun, ...filters } = args;
        result = await bulkDelete(filters, sourceMailbox || 'INBOX', dryRun || false);
      // ── Single-email tier (15s) ──
      } else if (name === 'flag_email') {
        result = await withTimeout('flag_email', TIMEOUT.SINGLE, () => flagEmail(args.uid, args.flagged, args.mailbox || 'INBOX'));
      } else if (name === 'mark_as_read') {
        result = await withTimeout('mark_as_read', TIMEOUT.SINGLE, () => markAsRead(args.uid, args.seen, args.mailbox || 'INBOX'));
      } else if (name === 'delete_email') {
        result = await withTimeout('delete_email', TIMEOUT.SINGLE, () => deleteEmail(args.uid, args.mailbox || 'INBOX'));
      } else if (name === 'move_email') {
        result = await withTimeout('move_email', TIMEOUT.SINGLE, () => moveEmail(args.uid, args.targetMailbox, args.sourceMailbox || 'INBOX'));
      // ── Move status (synchronous, no timeout needed) ──
      } else if (name === 'get_move_status') {
        result = getMoveStatus();
      } else if (name === 'abandon_move') {
        result = abandonMove();
      // ── Session log (synchronous, no timeout needed) ──
      } else if (name === 'log_write') {
        result = logWrite(args.step);
      } else if (name === 'log_read') {
        result = logRead();
      } else if (name === 'log_clear') {
        result = logClear();
      // ── Saved rules (synchronous CRUD; run_rule/run_all_rules use internal chunk timeouts) ──
      } else if (name === 'create_rule') {
        result = createRule(args.name, args.filters || {}, args.action, args.description || '');
      } else if (name === 'list_rules') {
        result = listRules();
      } else if (name === 'delete_rule') {
        result = deleteRule(args.name);
      } else if (name === 'run_rule') {
        result = await runRule(args.name, args.dryRun || false);
      } else if (name === 'run_all_rules') {
        result = await runAllRules(args.dryRun || false);
      // ── SMTP (email sending — uses SCAN tier 60s for two-phase fetch+send) ──
      } else if (name === 'compose_email') {
        result = await withTimeout('compose_email', TIMEOUT.SCAN, () =>
          composeEmail(args.to, args.subject, args.body, { html: args.html, cc: args.cc, bcc: args.bcc, replyTo: args.replyTo })
        );
      } else if (name === 'reply_to_email') {
        const origEmail = await withTimeout('get_email_for_reply', TIMEOUT.FETCH, () =>
          getEmailContent(args.uid, args.mailbox || 'INBOX', 5000, true)
        );
        result = await withTimeout('reply_to_email', TIMEOUT.FETCH, () =>
          replyToEmail(origEmail, args.body, { html: args.html, replyAll: args.replyAll || false, cc: args.cc })
        );
      } else if (name === 'forward_email') {
        const origEmail = await withTimeout('get_email_for_forward', TIMEOUT.FETCH, () =>
          getEmailContent(args.uid, args.mailbox || 'INBOX', 5000, false)
        );
        result = await withTimeout('forward_email', TIMEOUT.FETCH, () =>
          forwardEmail(origEmail, args.to, args.note || '', { html: args.html, cc: args.cc })
        );
      } else if (name === 'save_draft') {
        result = await withTimeout('save_draft', TIMEOUT.FETCH, () =>
          saveDraft(args.to, args.subject, args.body, { html: args.html, cc: args.cc, bcc: args.bcc })
        );
      // ── CardDAV / Contacts (FETCH tier 30s) ──
      } else if (name === 'list_contacts') {
        result = await withTimeout('list_contacts', TIMEOUT.FETCH, () =>
          listContacts(args.limit || 50, args.offset || 0)
        );
      } else if (name === 'search_contacts') {
        result = await withTimeout('search_contacts', TIMEOUT.FETCH, () =>
          searchContacts(args.query)
        );
      } else if (name === 'get_contact') {
        result = await withTimeout('get_contact', TIMEOUT.FETCH, () =>
          getContact(args.contactId)
        );
      } else if (name === 'create_contact') {
        const { contactId: _ignore, ...fields } = args;
        result = await withTimeout('create_contact', TIMEOUT.FETCH, () =>
          createContact(fields)
        );
      } else if (name === 'update_contact') {
        const { contactId, ...fields } = args;
        result = await withTimeout('update_contact', TIMEOUT.FETCH, () =>
          updateContact(contactId, fields)
        );
      } else if (name === 'delete_contact') {
        result = await withTimeout('delete_contact', TIMEOUT.SINGLE, () =>
          deleteContact(args.contactId)
        );
      // ── CalDAV / Calendar (FETCH tier 30s) ──
      } else if (name === 'list_calendars') {
        result = await withTimeout('list_calendars', TIMEOUT.FETCH, () =>
          listCalendars()
        );
      } else if (name === 'list_events') {
        result = await withTimeout('list_events', TIMEOUT.FETCH, () =>
          listEvents(args.calendarId, args.since || null, args.before || null, args.limit || 50)
        );
      } else if (name === 'get_event') {
        result = await withTimeout('get_event', TIMEOUT.FETCH, () =>
          getEvent(args.calendarId, args.eventId)
        );
      } else if (name === 'create_event') {
        const { calendarId, ...fields } = args;
        result = await withTimeout('create_event', TIMEOUT.FETCH, () =>
          createEvent(calendarId, fields)
        );
      } else if (name === 'update_event') {
        const { calendarId, eventId, ...fields } = args;
        result = await withTimeout('update_event', TIMEOUT.FETCH, () =>
          updateEvent(calendarId, eventId, fields)
        );
      } else if (name === 'delete_event') {
        result = await withTimeout('delete_event', TIMEOUT.SINGLE, () =>
          deleteEvent(args.calendarId, args.eventId)
        );
      } else if (name === 'search_events') {
        result = await withTimeout('search_events', TIMEOUT.FETCH, () =>
          searchEvents(args.query, args.since || null, args.before || null)
        );
      // ── Smart extraction (SCAN tier 60s — LLM round-trip) ──
      } else if (name === 'suggest_event_from_email') {
        const email = await withTimeout('get_email_for_extraction', TIMEOUT.FETCH, () =>
          getEmailContent(args.uid, args.mailbox || 'INBOX', 10000, false)
        );
        result = formatEmailForExtraction(email);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
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
