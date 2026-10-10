// Mail, rules, SMTP, digest, and session-log tools.
import {
  TIMEOUT, withTimeout,
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
} from '../imap.js';
import { logRead, logWrite, logClear } from '../session.js';
import { composeEmail, replyToEmail, forwardEmail, saveDraft } from '../smtp.js';
import { getDigestState, updateDigestState } from '../digest.js';
import { reminderListName } from '../reminder-list-name.js';

const reminderList = reminderListName();

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
  hasAttachment: { type: 'boolean', description: 'Only emails with attachments (client-side BODYSTRUCTURE scan — must be combined with other filters that narrow results to under 500 emails first)' },
  account: { type: 'string', description: "Account name to use (e.g. 'icloud', 'gmail'). Defaults to first configured account. Use list_accounts to see available accounts." }
};
const accountSchema = filtersSchema.account;


export const mailTools = [

  {
    name: 'list_accounts',
    description: 'List all configured email accounts (names and IMAP hosts). Use the account name in any mail tool\'s account parameter.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_inbox_summary',
    description: 'Get a summary of a mailbox including total, unread, and recent email counts',
    inputSchema: { type: 'object', properties: { mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' }, account: accountSchema } }
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
    description: 'Read emails from an inbox with pagination. Supports multiple accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of emails per page (default 10)' },
        page: { type: 'number', description: 'Page number (default 1)' },
        onlyUnread: { type: 'boolean', description: 'Only fetch unread emails' },
        mailbox: { type: 'string', description: 'Mailbox to read (default INBOX)' },
        account: { type: 'string', description: 'Account name to read from (e.g. "work", "personal", "school", "icloud"). Omit for default iCloud account.' }
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
    description: 'Delete emails matching any combination of filters. Processes in chunks of 500 with per-chunk timeouts for reliability. Use dryRun: true to preview without making changes.',
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
        ...filtersSchema,
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
        mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
        mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
        sender: { type: 'string', description: 'Optional: only mark emails from this sender as read' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
        sender: { type: 'string', description: 'Optional: only mark emails from this sender as unread' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
        mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
        mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
        sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
      properties: {
        name: { type: 'string', description: 'Mailbox path to delete' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
      },
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
        mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
        mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
        name: { type: 'string', description: 'Rule name to delete' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
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
        bcc: { type: 'string', description: 'BCC recipient(s)' },
        inReplyTo: { type: 'string', description: 'Message-ID of the email being replied to — sets In-Reply-To header for threading' },
        references: { type: 'string', description: 'Space-separated Message-IDs for the References header — enables full thread linking' },
        account: { type: 'string', description: 'Account whose Drafts folder to save into (e.g. "work", "personal", "school"). Defaults to iCloud.' }
      },
      required: ['to', 'subject']
    }
  },
  // ── Digest State ──
  {
    name: 'get_digest_state',
    description: 'Get the current inbox digest state — last run timestamp, processed email UIDs (to skip on next run), pending actions, and per-sender skip counts for smart unsubscribe.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'update_digest_state',
    description: 'Update the digest state after a run. Merges new processed UIDs into the existing list, updates lastRun, replaces pendingActions, and accumulates per-sender skip counts.',
    inputSchema: {
      type: 'object',
      properties: {
        lastRun: { type: 'string', description: 'ISO timestamp of this run' },
        processedUids: { type: 'array', items: { type: 'number' }, description: 'Email UIDs processed in this run — merged with existing and capped at 5000' },
        pendingActions: { type: 'array', description: 'Full replacement list of pending action items to track across runs (deadlines, waiting-for-reply, etc.). Each item: { type, subject, to/from, dueDate?, notes? }' },
        skipCounts: { type: 'object', description: 'Map of sender address to skip count increment for this run, e.g. { "news@example.com": 3 }. Accumulated across runs for smart unsubscribe.' },
        dismissedReminders: { type: 'array', description: `Full replacement list of reminders the user has deleted from the "${reminderList}" list (treated as "not interested"). Each: { title, notes?, dismissedAt (ISO) }. Entries older than 30 days are pruned automatically. Capped at 500.` },
        seenReminders: { type: 'array', description: `Snapshot of all active reminders in the "${reminderList}" list at end of this run — used next run to detect which ones the user deleted. Each: { id, title, notes? }.` }
      }
    }
  },
];

const _mailTools_NAMES = new Set(mailTools.map((tool) => tool.name));

export async function handleMailTool(name, args, ctx) {
  if (!_mailTools_NAMES.has(name)) return undefined;
  const { resolveCreds, resolveMailbox, accounts: ACCOUNTS } = ctx;
  let result;
  if (name === 'list_accounts') {
    result = Object.entries(ACCOUNTS).map(([n, c]) => ({ name: n, host: c.host, smtpHost: c.smtpHost }));
  // ── Metadata tier (15s) ──
  } else if (name === 'get_inbox_summary') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_inbox_summary', TIMEOUT.METADATA, () => getInboxSummary(resolveMailbox(args.mailbox || 'INBOX', creds), creds));
  } else if (name === 'get_mailbox_summary') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_mailbox_summary', TIMEOUT.METADATA, () => getMailboxSummary(resolveMailbox(args.mailbox, creds), creds));
  } else if (name === 'get_top_senders') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_top_senders', TIMEOUT.SCAN, () => getTopSenders(resolveMailbox(args.mailbox || 'INBOX', creds), args.sampleSize || 500, args.maxResults || 20, creds));
  } else if (name === 'get_unread_senders') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_unread_senders', TIMEOUT.SCAN, () => getUnreadSenders(resolveMailbox(args.mailbox || 'INBOX', creds), args.sampleSize || 500, args.maxResults || 20, creds));
  } else if (name === 'get_emails_by_sender') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_emails_by_sender', TIMEOUT.FETCH, () => getEmailsBySender(args.sender, resolveMailbox(args.mailbox || 'INBOX', creds), args.limit || 10, creds));
  } else if (name === 'read_inbox') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('read_inbox', TIMEOUT.FETCH, () => fetchEmails(resolveMailbox(args.mailbox || 'INBOX', creds), args.limit || 10, args.onlyUnread || false, args.page || 1, creds));
  } else if (name === 'get_email') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_email', TIMEOUT.FETCH, () => getEmailContent(args.uid, resolveMailbox(args.mailbox || 'INBOX', creds), args.maxChars || 8000, args.includeHeaders || false, creds));
  } else if (name === 'search_emails') {
    const { query, mailbox, limit, queryMode, subjectQuery, bodyQuery, fromQuery, includeSnippet, account, ...filters } = args;
    const creds = resolveCreds(account);
    result = await withTimeout('search_emails', TIMEOUT.FETCH, () => searchEmails(query, resolveMailbox(mailbox || 'INBOX', creds), limit || 10, filters, { queryMode, subjectQuery, bodyQuery, fromQuery, includeSnippet }, creds));
  } else if (name === 'count_emails') {
    const { mailbox, account, ...filters } = args;
    const creds = resolveCreds(account);
    result = await withTimeout('count_emails', TIMEOUT.METADATA, () => countEmails(filters, resolveMailbox(mailbox || 'INBOX', creds), creds));
  } else if (name === 'bulk_move') {
    const { targetMailbox, sourceMailbox, dryRun, limit, account, ...filters } = args;
    const creds = resolveCreds(account);
    result = await bulkMove(filters, resolveMailbox(targetMailbox, creds), resolveMailbox(sourceMailbox || 'INBOX', creds), dryRun || false, limit ?? null, creds);
  } else if (name === 'bulk_delete') {
    const { sourceMailbox, dryRun, account, ...filters } = args;
    const creds = resolveCreds(account);
    result = await bulkDelete(filters, resolveMailbox(sourceMailbox || 'INBOX', creds), dryRun || false, creds);
  // ── Single-email tier (15s) ──
  } else if (name === 'bulk_flag') {
    const { flagged, mailbox, account, dryRun, ...filters } = args;
    const creds = resolveCreds(account);
    result = await withTimeout('bulk_flag', TIMEOUT.BULK_OP, () => bulkFlag(filters, flagged, resolveMailbox(mailbox || 'INBOX', creds), creds, dryRun || false));
  } else if (name === 'bulk_delete_by_sender') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('bulk_delete_by_sender', TIMEOUT.BULK_OP, () => bulkDeleteBySender(args.sender, resolveMailbox(args.mailbox || 'INBOX', creds), creds, args.dryRun || false));
  } else if (name === 'bulk_move_by_sender') {
    const creds = resolveCreds(args.account);
    result = await bulkMoveBySender(args.sender, resolveMailbox(args.targetMailbox, creds), resolveMailbox(args.sourceMailbox || 'INBOX', creds), args.dryRun || false, creds);
  } else if (name === 'bulk_delete_by_subject') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('bulk_delete_by_subject', TIMEOUT.BULK_OP, () => bulkDeleteBySubject(args.subject, resolveMailbox(args.mailbox || 'INBOX', creds), creds, args.dryRun || false));
  } else if (name === 'bulk_mark_read') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('bulk_mark_read', TIMEOUT.BULK_OP, () => bulkMarkRead(resolveMailbox(args.mailbox || 'INBOX', creds), args.sender || null, creds, args.dryRun || false));
  } else if (name === 'bulk_mark_unread') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('bulk_mark_unread', TIMEOUT.BULK_OP, () => bulkMarkUnread(resolveMailbox(args.mailbox || 'INBOX', creds), args.sender || null, creds, args.dryRun || false));
  } else if (name === 'delete_older_than') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('delete_older_than', TIMEOUT.BULK_OP, () => deleteOlderThan(args.days, resolveMailbox(args.mailbox || 'INBOX', creds), creds, args.dryRun || false));
  } else if (name === 'get_emails_by_date_range') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_emails_by_date_range', TIMEOUT.FETCH, () => getEmailsByDateRange(args.startDate, args.endDate, resolveMailbox(args.mailbox || 'INBOX', creds), args.limit || 10, creds));
  // ── Scan tier (60s) ──
  } else if (name === 'flag_email') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('flag_email', TIMEOUT.SINGLE, () => flagEmail(args.uid, args.flagged, resolveMailbox(args.mailbox || 'INBOX', creds), creds));
  } else if (name === 'mark_as_read') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('mark_as_read', TIMEOUT.SINGLE, () => markAsRead(args.uid, args.seen, resolveMailbox(args.mailbox || 'INBOX', creds), creds));
  } else if (name === 'delete_email') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('delete_email', TIMEOUT.SINGLE, () => deleteEmail(args.uid, resolveMailbox(args.mailbox || 'INBOX', creds), creds, args.dryRun || false));
  } else if (name === 'move_email') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('move_email', TIMEOUT.SINGLE, () => moveEmail(args.uid, resolveMailbox(args.targetMailbox, creds), resolveMailbox(args.sourceMailbox || 'INBOX', creds), creds, args.dryRun || false));
  // ── Move status (synchronous, no timeout needed) ──
  } else if (name === 'list_mailboxes') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('list_mailboxes', TIMEOUT.METADATA, () => listMailboxes(creds));
  } else if (name === 'create_mailbox') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('create_mailbox', TIMEOUT.METADATA, () => createMailbox(args.name, creds));
  } else if (name === 'rename_mailbox') {
    const creds = resolveCreds(args.account);
    result = await renameMailbox(args.oldName, args.newName, creds); // already has its own 15s timeout
  } else if (name === 'delete_mailbox') {
    const creds = resolveCreds(args.account);
    result = await deleteMailbox(args.name, creds, args.dryRun || false); // already has its own 15s timeout
  // ── Fetch tier (30s) ──
  } else if (name === 'empty_trash') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('empty_trash', TIMEOUT.BULK_OP, () => emptyTrash(args.dryRun || false, creds));
  // ── No top-level timeout — chunked with internal timeouts ──
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
  // ── Digest state (synchronous, no timeout needed) ──
  } else if (name === 'list_attachments') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('list_attachments', TIMEOUT.FETCH, () => listAttachments(args.uid, resolveMailbox(args.mailbox || 'INBOX', creds), creds));
  } else if (name === 'get_attachment') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_attachment', TIMEOUT.FETCH, () => getAttachment(args.uid, args.partId, resolveMailbox(args.mailbox || 'INBOX', creds), args.offset ?? null, args.length ?? null, creds));
  } else if (name === 'get_unsubscribe_info') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_unsubscribe_info', TIMEOUT.FETCH, () => getUnsubscribeInfo(args.uid, resolveMailbox(args.mailbox || 'INBOX', creds), creds));
  } else if (name === 'mark_older_than_read') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('mark_older_than_read', TIMEOUT.BULK_OP, () => markOlderThanRead(args.days, resolveMailbox(args.mailbox || 'INBOX', creds), creds, args.dryRun || false));
  } else if (name === 'bulk_move_by_domain') {
    const creds = resolveCreds(args.account);
    result = await bulkMoveByDomain(args.domain, resolveMailbox(args.targetMailbox, creds), resolveMailbox(args.sourceMailbox || 'INBOX', creds), args.dryRun || false, creds);
  } else if (name === 'get_email_raw') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_email_raw', TIMEOUT.FETCH, () => getEmailRaw(args.uid, resolveMailbox(args.mailbox || 'INBOX', creds), creds));
  } else if (name === 'bulk_flag_by_sender') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('bulk_flag_by_sender', TIMEOUT.BULK_OP, () => bulkFlagBySender(args.sender, args.flagged, resolveMailbox(args.mailbox || 'INBOX', creds), creds, args.dryRun || false));
  } else if (name === 'archive_older_than') {
    const creds = resolveCreds(args.account);
    result = await archiveOlderThan(args.days, resolveMailbox(args.targetMailbox, creds), resolveMailbox(args.sourceMailbox || 'INBOX', creds), args.dryRun || false, creds);
  } else if (name === 'get_storage_report') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_storage_report', TIMEOUT.SCAN, () => getStorageReport(resolveMailbox(args.mailbox || 'INBOX', creds), args.sampleSize || 100, creds));
  // ── Bulk operation tier (60s) ──
  } else if (name === 'get_thread') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('get_thread', TIMEOUT.FETCH, () => getThread(args.uid, resolveMailbox(args.mailbox || 'INBOX', creds), creds));
  } else if (name === 'create_rule') {
    result = createRule(args.name, args.filters || {}, args.action, args.description || '');
  } else if (name === 'list_rules') {
    result = listRules();
  } else if (name === 'run_rule') {
    result = await runRule(args.name, args.dryRun || false);
  } else if (name === 'delete_rule') {
    result = deleteRule(args.name, args.dryRun || false);
  } else if (name === 'run_all_rules') {
    result = await runAllRules(args.dryRun || false);
  // ── SMTP (email sending — uses SCAN tier 60s for two-phase fetch+send) ──
  } else if (name === 'compose_email') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('compose_email', TIMEOUT.SCAN, () =>
      composeEmail(args.to, args.subject, args.body, { html: args.html, cc: args.cc, bcc: args.bcc, replyTo: args.replyTo }, creds)
    );
  } else if (name === 'reply_to_email') {
    const creds = resolveCreds(args.account);
    const origEmail = await withTimeout('get_email_for_reply', TIMEOUT.FETCH, () =>
      getEmailContent(args.uid, resolveMailbox(args.mailbox || 'INBOX', creds), 5000, true, creds)
    );
    result = await withTimeout('reply_to_email', TIMEOUT.FETCH, () =>
      replyToEmail(origEmail, args.body, { html: args.html, replyAll: args.replyAll || false, cc: args.cc }, creds)
    );
  } else if (name === 'forward_email') {
    const creds = resolveCreds(args.account);
    const origEmail = await withTimeout('get_email_for_forward', TIMEOUT.FETCH, () =>
      getEmailContent(args.uid, resolveMailbox(args.mailbox || 'INBOX', creds), 5000, false, creds)
    );
    result = await withTimeout('forward_email', TIMEOUT.FETCH, () =>
      forwardEmail(origEmail, args.to, args.note || '', { html: args.html, cc: args.cc }, creds)
    );
  } else if (name === 'save_draft') {
    const creds = resolveCreds(args.account);
    result = await withTimeout('save_draft', TIMEOUT.FETCH, () =>
      saveDraft(args.to, args.subject, args.body, { html: args.html, cc: args.cc, bcc: args.bcc, inReplyTo: args.inReplyTo, references: args.references }, creds)
    );
  // ── CardDAV / Contacts (FETCH tier 30s) ──
  } else if (name === 'get_digest_state') {
    result = getDigestState();
  } else if (name === 'update_digest_state') {
    result = updateDigestState({
      lastRun: args.lastRun,
      processedUids: args.processedUids,
      pendingActions: args.pendingActions,
      skipCounts: args.skipCounts,
      dismissedReminders: args.dismissedReminders,
      seenReminders: args.seenReminders
    });
  // ── Saved rules (synchronous CRUD; run_rule/run_all_rules use internal chunk timeouts) ──
  }
  return result;
}

