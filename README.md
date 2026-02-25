# icloud-mcp

A Model Context Protocol (MCP) server that connects Claude Desktop to your iCloud Mail account. Manage, search, and organize your inbox directly through Claude.

## Features

- 📬 Read and paginate through your inbox
- 🔍 Search emails by keyword, sender, or date range
- 🗑️ Bulk delete emails by sender or subject
- 📁 Move emails between folders
- 📊 Analyze top senders to identify inbox clutter
- ✅ Mark emails as read/unread, flag/unflag
- 🗂️ List and create mailboxes

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

### 2. Install the server

```bash
git clone https://github.com/YOUR_USERNAME/icloud-mcp.git
cd icloud-mcp
npm install
```

### 3. Configure Claude Desktop

Open your Claude Desktop config file:

```bash
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Add the following under `mcpServers`:

```json
{
  "mcpServers": {
    "icloud-mail": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/icloud-mcp/index.js"],
      "env": {
        "IMAP_USER": "you@icloud.com",
        "IMAP_PASSWORD": "your-app-specific-password"
      }
    }
  }
}
```

> **Note:** Replace `/path/to/icloud-mcp` with the actual path where you cloned the repo, and `/opt/homebrew/bin/node` with the output of `which node`.

### 4. Restart Claude Desktop

Fully quit Claude Desktop (Cmd+Q) and reopen it. You should now be able to manage your iCloud inbox through Claude.

## Available Tools

| Tool | Description |
|------|-------------|
| `get_inbox_summary` | Total, unread, and recent email counts |
| `get_top_senders` | Top senders by volume from a sample of recent emails |
| `get_unread_senders` | Top senders of unread emails |
| `read_inbox` | Paginated inbox with sender, subject, date |
| `get_email` | Full content of a specific email by UID |
| `get_emails_by_sender` | All emails from a specific address |
| `get_emails_by_date_range` | Emails between two dates |
| `search_emails` | Search by keyword across subject, sender, and body |
| `flag_email` | Flag or unflag an email |
| `mark_as_read` | Mark an email as read or unread |
| `delete_email` | Move an email to Deleted Messages |
| `bulk_delete_by_sender` | Delete all emails from a sender |
| `bulk_delete_by_subject` | Delete all emails matching a subject keyword |
| `bulk_move_by_sender` | Move all emails from a sender to a folder |
| `bulk_mark_read` | Mark all emails (or all from a sender) as read |
| `delete_older_than` | Delete all emails older than N days |
| `move_email` | Move a single email to a folder |
| `list_mailboxes` | List all folders in your iCloud Mail |
| `create_mailbox` | Create a new folder |
| `empty_trash` | Permanently delete all emails in Deleted Messages |

## Example Usage

Once configured, you can ask Claude things like:

- *"Show me the top senders in my iCloud inbox"*
- *"Delete all emails from no-reply@instagram.com"*
- *"How many unread emails do I have?"*
- *"Move all emails from newsletters@substack.com to my newsletters folder"*
- *"Show me emails from the last week"*

## Running Tests

```bash
IMAP_USER="you@icloud.com" IMAP_PASSWORD="your-app-specific-password" /opt/homebrew/bin/node test.js
```

## Security

- Your credentials are stored only in your local Claude Desktop config file
- The server runs entirely on your machine — no data is sent to any third party
- App-specific passwords can be revoked at any time from [appleid.apple.com](https://appleid.apple.com)

## License

MIT
