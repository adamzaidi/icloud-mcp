# icloud-mcp

A Model Context Protocol (MCP) server that connects Claude Desktop to your iCloud Mail account. Manage, search, organize, and analyze your inbox directly through Claude.

## Features

- 📬 Read and paginate through any mailbox
- 🔍 Search emails by keyword, sender, subject, body, date range, and more
- 🧵 Find email threads by References/In-Reply-To chain
- 🗑️ Bulk delete emails by any combination of filters
- 📁 Bulk move emails between folders with safe copy-verify-delete
- 📦 Archive emails older than N days to any folder
- 📊 Analyze top senders and storage usage to identify inbox clutter
- 🔢 Count emails matching any filter before taking action
- ✅ Mark emails as read/unread, flag/unflag in bulk or individually
- 📎 List and download email attachments (supports paginated byte-range fetching for large files)
- 🔗 Extract List-Unsubscribe links for AI-assisted cleanup
- 🗂️ List, create, rename, and delete mailboxes
- 🔄 Dry run mode for bulk operations — preview before committing
- 🔐 Safe move — emails are fingerprinted and verified in the destination before removal from source
- 📝 Session logging — Claude tracks progress across long multi-step operations

## Prerequisites

- [Claude Desktop](https://claude.ai/download)
- Node.js v20 or higher
- An iCloud account with an app-specific password

## Setup

### 1. Generate an Apple App-Specific Password

1. Go to [appleid.apple.com](https://appleid.apple.com)
2. Sign in and navigate to **Sign-In and Security → App-Specific Passwords**
3. Click **+** to generate a new password
4. Label it something like `Claude MCP` and save the generated password

### 2. Install the package

```bash
npm install -g icloud-mcp
```

Then find the install location:

```bash
npm root -g
```

The path varies by setup:

| Setup | Typical path |
|-------|-------------|
| Mac with Homebrew Node | `/opt/homebrew/lib/node_modules` |
| Mac with system Node | `/usr/local/lib/node_modules` |
| nvm | `~/.nvm/versions/node/v20.x.x/lib/node_modules` |

### 3. Verify your setup

Before configuring Claude Desktop, run the doctor command to confirm everything is working:

```bash
IMAP_USER="you@icloud.com" IMAP_PASSWORD="your-app-specific-password" node $(npm root -g)/icloud-mcp/index.js --doctor
```

You should see:

```
icloud-mcp doctor
─────────────────────────────
✅ IMAP_USER is set
✅ IMAP_PASSWORD is set
✅ IMAP_USER looks like an email address
✅ Connected to imap.mail.me.com:993
✅ Authenticated as you@icloud.com
✅ INBOX opened (12453 messages)
─────────────────────────────
All checks passed. Ready to use with Claude Desktop.
```

If any step fails, a plain-English explanation and suggested fix will be shown.

### 4. Configure Claude Desktop

Open your Claude Desktop config file:

```bash
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Add the following under `mcpServers`, replacing the path with your npm root from step 2:

```json
{
  "mcpServers": {
    "icloud-mail": {
      "command": "node",
      "args": ["/opt/homebrew/lib/node_modules/icloud-mcp/index.js"],
      "env": {
        "IMAP_USER": "you@icloud.com",
        "IMAP_PASSWORD": "your-app-specific-password"
      }
    }
  }
}
```

### 5. Add Custom Instructions (Recommended)

For large inbox operations, add the following to Claude Desktop's custom instructions to ensure Claude stays on track and checks in with you regularly. Go to **Claude Desktop → Settings → Custom Instructions** and add:

```
When using icloud-mail tools:
1. Before starting any multi-step operation, call log_clear then log_write with your full plan
2. After every single tool call, call log_write with what you did and the result
3. After every 3 tool calls, stop and summarize progress to the user and wait for confirmation before continuing
4. Never assume a bulk operation succeeded — always verify with count_emails after
5. If you are ever unsure what you have done so far, call log_read before proceeding
```

### 6. Restart Claude Desktop

Fully quit Claude Desktop (Cmd+Q) and reopen it. You should now be able to manage your iCloud inbox through Claude.

## Available Tools (46)

### Read & Search

| Tool | Description |
|------|-------------|
| `get_inbox_summary` | Total, unread, and recent email counts for INBOX |
| `get_mailbox_summary` | Total, unread, and recent email counts for any folder |
| `list_mailboxes` | List all folders in your iCloud Mail |
| `read_inbox` | Paginated inbox with sender, subject, date (supports unread filter) |
| `get_email` | Full email content by UID — MIME-aware, returns body + attachments list; supports `maxChars`, `includeHeaders` |
| `get_email_raw` | Raw RFC 2822 source as base64 (headers + MIME body, 1 MB cap) |
| `get_emails_by_sender` | All emails from a specific address |
| `get_emails_by_date_range` | Emails between two dates |
| `search_emails` | Search by keyword with filters; supports `subjectQuery`, `bodyQuery`, `fromQuery`, `queryMode` (and/or), `includeSnippet` |
| `get_thread` | Find all emails in the same thread (subject + References/In-Reply-To matching) |
| `count_emails` | Count emails matching any combination of filters |
| `get_top_senders` | Top senders by volume from a sample of recent emails |
| `get_unread_senders` | Top senders of unread emails |
| `get_storage_report` | Estimate storage usage by size bucket and identify top large-email senders |
| `get_unsubscribe_info` | Extract List-Unsubscribe links (email + URL) from an email |
| `list_attachments` | List all attachments in an email (filename, MIME type, size, partId) |
| `get_attachment` | Download an attachment as base64 (max 20 MB); supports `offset`/`length` for paginated byte-range fetching |

### Write

| Tool | Description |
|------|-------------|
| `flag_email` | Flag or unflag a single email |
| `mark_as_read` | Mark a single email as read or unread |
| `delete_email` | Move an email to Deleted Messages |
| `move_email` | Move a single email to any folder |

### Bulk Operations

| Tool | Description |
|------|-------------|
| `bulk_move` | Move emails matching any combination of filters (safe copy-verify-delete); supports `dryRun`, `limit` |
| `bulk_move_by_sender` | Move all emails from a sender to a folder; supports `dryRun` |
| `bulk_move_by_domain` | Move all emails from a domain to a folder; supports `dryRun` |
| `archive_older_than` | Safely move emails older than N days to an archive folder; supports `dryRun` |
| `bulk_delete` | Delete emails matching any combination of filters; supports `dryRun` |
| `bulk_delete_by_sender` | Delete all emails from a sender |
| `bulk_delete_by_subject` | Delete all emails matching a subject keyword |
| `delete_older_than` | Delete all emails older than N days |
| `bulk_mark_read` | Mark all (or all from a sender) as read |
| `bulk_mark_unread` | Mark all (or all from a sender) as unread |
| `mark_older_than_read` | Mark all unread emails older than N days as read |
| `bulk_flag` | Flag or unflag emails matching any combination of filters |
| `bulk_flag_by_sender` | Flag or unflag all emails from a specific sender |
| `empty_trash` | Permanently delete all emails in trash; supports `dryRun` |

### Mailbox Management

| Tool | Description |
|------|-------------|
| `create_mailbox` | Create a new folder |
| `rename_mailbox` | Rename an existing folder |
| `delete_mailbox` | Delete a folder (must be empty first) |

### Move Tracking

| Tool | Description |
|------|-------------|
| `get_move_status` | Check the status of the current or most recent bulk move; includes stale warning for operations >24h old |
| `abandon_move` | Abandon an in-progress move so a new one can start |

### Session Log

| Tool | Description |
|------|-------------|
| `log_write` | Write a step to the session log |
| `log_read` | Read the session log |
| `log_clear` | Clear the session log and start fresh |

## Filters

`bulk_move`, `bulk_delete`, `bulk_flag`, `search_emails`, and `count_emails` all accept any combination of these filters:

| Filter | Type | Description |
|--------|------|-------------|
| `sender` | string | Match exact sender email address |
| `domain` | string | Match any sender from this domain (e.g. `substack.com`) |
| `subject` | string | Keyword to match in subject |
| `before` | string | Only emails before this date (YYYY-MM-DD) |
| `since` | string | Only emails since this date (YYYY-MM-DD) |
| `unread` | boolean | `true` for unread only, `false` for read only |
| `flagged` | boolean | `true` for flagged only, `false` for unflagged only |
| `larger` | number | Only emails larger than this size in KB |
| `smaller` | number | Only emails smaller than this size in KB |
| `hasAttachment` | boolean | Only emails with attachments (requires narrow pre-filters — scans up to 500 candidates) |

## Safe Move

All bulk move operations (`bulk_move`, `bulk_move_by_sender`, `bulk_move_by_domain`, `archive_older_than`) use a three-phase copy-verify-delete approach:

1. **Copy** — all emails are copied to the destination in chunks
2. **Verify** — every email is fingerprinted and confirmed present in the destination
3. **Delete** — source emails are removed in a single EXPUNGE only after verification passes

A persistent manifest at `~/.icloud-mcp-move-manifest.json` tracks progress so a crash or dropped connection never results in data loss. Use `get_move_status` to inspect any operation and `abandon_move` to clear a stuck one.

## Example Usage

Once configured, you can ask Claude things like:

- *"Show me the top senders in my iCloud inbox"*
- *"What's eating the most storage in my inbox?"*
- *"How many unread emails do I have from substack.com?"*
- *"Find all emails in this thread and summarize the conversation"*
- *"Move all emails from substack.com older than 2023 to my Newsletters folder"*
- *"Archive everything in my inbox older than 1 year"*
- *"Delete all unread emails from linkedin.com before 2022"*
- *"What's the unsubscribe link for this newsletter?"*
- *"Show me the 3 largest attachments in my inbox this month"*
- *"Flag all unread emails from my bank"*
- *"How many emails would be moved if I archived everything older than 6 months?"*

## Security

- Your credentials are stored only in your local Claude Desktop config file
- The server runs entirely on your machine — no data is sent to any third party
- App-specific passwords can be revoked at any time from [appleid.apple.com](https://appleid.apple.com)

## License

MIT
