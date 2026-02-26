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

This will return a path like `/opt/homebrew/lib/node_modules` or `/usr/local/lib/node_modules`.

### 3. Configure Claude Desktop

Open your Claude Desktop config file:

```bash
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Add the following under `mcpServers`, replacing the path with your npm root path from the previous step:

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

> **Note:** If your `npm root -g` returned a different path, replace `/opt/homebrew/lib/node_modules` with that path.

### 4. Restart Claude Desktop

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

### Dry Run Mode

Pass `dryRun: true` to `bulk_move` or `bulk_delete` to preview how many emails would be affected without making any changes:

> *"How many emails would be deleted if I removed everything from linkedin.com before 2022?"*

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
