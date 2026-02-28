# icloud-mcp

A Model Context Protocol (MCP) server that connects Claude Desktop to your iCloud Mail account. Manage, search, and organize your inbox directly through Claude.

## Features

- 📬 Read and paginate through your inbox
- 🔍 Search emails by keyword, sender, date range, and more
- 🗑️ Bulk delete emails by any combination of filters
- 📁 Bulk move emails between folders with flexible filtering
- 📊 Analyze top senders to identify inbox clutter
- 🔢 Count emails matching any filter before taking action
- ✅ Mark emails as read/unread, flag/unflag in bulk or individually
- 🗂️ List, create, rename, and delete mailboxes
- 🔄 Dry run mode for bulk operations — preview before committing
- 🔐 Safe move — emails are fingerprinted and verified in the destination before being removed from the source
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

## Available Tools

| Tool | Description |
|------|-------------|
| `get_inbox_summary` | Total, unread, and recent email counts for INBOX |
| `get_mailbox_summary` | Total, unread, and recent email counts for any folder |
| `get_top_senders` | Top senders by volume from a sample of recent emails (supports `sampleSize` and `maxResults`) |
| `get_unread_senders` | Top senders of unread emails (supports `sampleSize` and `maxResults`) |
| `read_inbox` | Paginated inbox with sender, subject, date |
| `get_email` | Full content of a specific email by UID |
| `get_emails_by_sender` | All emails from a specific address |
| `get_emails_by_date_range` | Emails between two dates |
| `search_emails` | Search by keyword with optional filters (date, unread, domain, etc.) |
| `count_emails` | Count emails matching any combination of filters without modifying them |
| `bulk_move` | Move emails matching any combination of filters between folders (supports `dryRun`) |
| `bulk_delete` | Delete emails matching any combination of filters (supports `dryRun`) |
| `bulk_flag` | Flag or unflag emails matching any combination of filters |
| `bulk_mark_read` | Mark all emails (or all from a sender) as read |
| `bulk_mark_unread` | Mark all emails (or all from a sender) as unread |
| `bulk_delete_by_sender` | Delete all emails from a sender |
| `bulk_delete_by_subject` | Delete all emails matching a subject keyword |
| `bulk_move_by_sender` | Move all emails from a sender to a folder |
| `flag_email` | Flag or unflag a single email |
| `mark_as_read` | Mark a single email as read or unread |
| `delete_email` | Move an email to Deleted Messages |
| `move_email` | Move a single email to a folder |
| `delete_older_than` | Delete all emails older than N days |
| `list_mailboxes` | List all folders in your iCloud Mail |
| `create_mailbox` | Create a new folder |
| `rename_mailbox` | Rename an existing folder |
| `delete_mailbox` | Delete a folder (must be empty first) |
| `empty_trash` | Permanently delete all emails in Deleted Messages |
| `get_move_status` | Check the status of the current or most recent bulk move operation |
| `abandon_move` | Abandon an in-progress move operation so a new one can start |
| `log_write` | Write a step to the session log |
| `log_read` | Read the session log to see what has been done so far |
| `log_clear` | Clear the session log and start fresh |

## Bulk Move, Delete & Flag Filters

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
| `hasAttachment` | boolean | Only emails with attachments |

## Dry Run Mode

Pass `dryRun: true` to `bulk_move` or `bulk_delete` to preview how many emails would be affected without making any changes:

> *"How many emails would be deleted if I removed everything from linkedin.com before 2022?"*

## Safe Move

All bulk move operations use a copy-verify-delete approach. Emails are fingerprinted before copying, confirmed present in the destination, and only then removed from the source. A persistent manifest at `~/.icloud-mcp-move-manifest.json` tracks progress across chunks so that a crash or connection drop mid-operation never results in data loss. Use `get_move_status` to inspect any operation and `abandon_move` to clear a stuck one.

## Session Log

The session log persists to `~/.icloud-mcp-session.json` on your Mac — outside Claude's context window — so progress is never lost during long operations. Claude can write its plan at the start, log each completed step, and read the log back at any point to reorient itself.

## Example Usage

Once configured, you can ask Claude things like:

- *"Show me the top senders in my iCloud inbox"*
- *"How many unread emails do I have from substack.com?"*
- *"How many emails would be moved if I archived everything from linkedin.com before 2022?"*
- *"Move all emails from substack.com older than 2023 to my Newsletters folder"*
- *"Delete all unread emails from linkedin.com before 2022"*
- *"Move everything in my old_folders/college folder to Archive"*
- *"How many emails do I have with attachments larger than 5MB?"*
- *"Flag all unread emails from my bank"*
- *"Rename my Newsletters folder to Old Newsletters"*
- *"Show me emails from the last week"*

## Security

- Your credentials are stored only in your local Claude Desktop config file
- The server runs entirely on your machine — no data is sent to any third party
- App-specific passwords can be revoked at any time from [appleid.apple.com](https://appleid.apple.com)

## License

MIT
