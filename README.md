# icloud-mcp

Maintained Model Context Protocol (MCP) server for iCloud Mail, Contacts, Calendar, and Reminders. Version **2.7.0** (86 tools).

## Features

- Read, search, and paginate any mailbox, including threads, attachments, and unsubscribe links
- Send, reply, forward, and save drafts over SMTP
- Bulk move, delete, flag, and mark-read, with a safe copy-verify-delete pipeline for moves
- Saved rules, digest state, and a session log for long cleanups
- Contacts over CardDAV, calendars over CalDAV (including bulk create/update/delete and conflict checks), and Reminders
- `dryRun` on every delete, every move that removes the original, and every bulk operation. A dry run reports a `changes` list of exactly what would be affected and does not modify anything

## Prerequisites

- Node.js 20 or newer
- Claude Desktop or Claude Code
- An iCloud account with an app-specific password

## Install

Install from npm:

```bash
npm install -g icloud-mcp
```

Or skip the install and let `npx` fetch it on demand (the configs below use this).

Confirm the server can reach iCloud:

```bash
IMAP_USER="you@icloud.com" IMAP_PASSWORD="your-app-specific-password" npx -y icloud-mcp --doctor
```

### Claude Desktop

```json
{
  "mcpServers": {
    "icloud-mail": {
      "command": "npx",
      "args": ["-y", "icloud-mcp"],
      "env": {
        "IMAP_USER": "you@icloud.com",
        "IMAP_PASSWORD": "your-app-specific-password"
      }
    }
  }
}
```

If Claude Desktop cannot find `npx`, use its full path (`which npx`). With a global install, `"command": "icloud-mcp"` and no `args` also works. Quit Claude Desktop completely and reopen it.

### Claude Code

```bash
claude mcp add icloud-mail \
  --scope user \
  -e IMAP_USER=you@icloud.com \
  -e IMAP_PASSWORD=your-app-specific-password \
  -- npx -y icloud-mcp
```

### From source

```bash
git clone https://github.com/adamzaidi/icloud-mcp.git
cd icloud-mcp
npm install
```

Point the configs above at `node /absolute/path/to/icloud-mcp/index.js` instead of `npx -y icloud-mcp`. To run from a checkout, copy `.mcp.json.example` to `.mcp.json` (that file is gitignored) and export `ICLOUD_EMAIL` and `ICLOUD_APP_PASSWORD` in your shell.

Additional IMAP accounts use `IMAP_ACCOUNT_N_USER`, `IMAP_ACCOUNT_N_PASSWORD`, `IMAP_ACCOUNT_N_HOST`, `IMAP_ACCOUNT_N_SMTP_HOST`, and `IMAP_ACCOUNT_N_NAME`.

If `IMAP_USER` or `IMAP_PASSWORD` is unset, the server fills the missing value from the macOS Keychain via `security find-generic-password`. The service name defaults to `icloud-mcp` and can be changed with `ICLOUD_MCP_KEYCHAIN_SERVICE`. When both variables are already set, Keychain is not read. `IMAP_PASS` is used only when `IMAP_PASSWORD` is unset. The password is not written to the log. `node mcp-call.mjs` loads a `.env` file in the checkout when one exists, and keeps working from the process environment when it does not.

`ICLOUD_MCP_REMINDER_LIST` is the Reminders list name mentioned by the digest tools. The default is `claude`.

## Local data

Rules, the move manifest, digest state, the session log, and the audit log are written outside the repository, in your home directory:

- `~/.icloud-mcp-rules.json`
- `~/.icloud-mcp-move-manifest.json`
- `~/.icloud-mcp-digest.json`
- `~/.icloud-mcp-session.json`
- `~/.icloud-mcp-audit.log`

The audit log is append-only. The file is created mode `0600`, and the directory that contains it is set to `0700`, including when either already exists. Each line is one JSON object with a fixed set of fields: tool name, timestamp, status (`ok` or `error`), duration, and one integer count. That count is an array length, or a number taken from a fixed list of result fields such as `total` or `wouldDelete`. Keys on the result are never copied, so a sender address used as a key is not written. Arguments, error text, message bodies, and subjects are not written either. When the file reaches 1 MiB it is rotated through `.1`, `.2`, and `.3`. `ICLOUD_MCP_AUDIT_LOG_MAX_BYTES` changes that size. Set `ICLOUD_MCP_AUDIT_LOG` to move the file. Set `ICLOUD_MCP_DATA_DIR` to store the whole set somewhere else. Do not point it at the git checkout. Contact exports, CRM notes, `.env`, and digest output belong outside the repo; `.gitignore` already excludes the usual local folders.

## Available tools (86)

`dryRun: true` returns `{ dryRun: true, changes: [...] }` plus the existing count fields (`wouldDelete`, `wouldMove`, and so on). Omitted or false performs the change.

### Tool profiles

`ICLOUD_MCP_TOOL_PROFILE` defaults to `full`, which is the list below. `remote-safe` is an allowlist: only the read, search, draft, and calendar or reminder create and edit tools named in that list are exposed, including `flag_email` and `mark_as_read`. A tool that is not on the list is hidden, including tools added later. `bulk_create_events` and `bulk_update_events` are on the list, and in `remote-safe` they run as a dry run unless that tool name is listed in `ICLOUD_MCP_ALLOW_BULK` (comma-separated). A hidden tool still throws if something calls it.

### Mail

| Tool | Description | dryRun |
|------|-------------|--------|
| `list_accounts` | List all configured email accounts (names and IMAP hosts). Use the account name in any mail tool's account parameter. |  |
| `get_inbox_summary` | Get a summary of a mailbox including total, unread, and recent email counts |  |
| `get_mailbox_summary` | Get total, unread, and recent email counts for any specific mailbox/folder |  |
| `get_top_senders` | Get the top senders by email count from a sample of the inbox |  |
| `get_unread_senders` | Get top senders of unread emails |  |
| `get_emails_by_sender` | Get all emails from a specific sender |  |
| `read_inbox` | Read emails from an inbox with pagination. Supports multiple accounts. |  |
| `get_email` | Get full content of a specific email by UID |  |
| `search_emails` | Search emails by keyword or targeted field queries, with optional filters for date, read status, domain, and more |  |
| `count_emails` | Count how many emails match a set of filters without moving or deleting them. Use this before bulk_move or bulk_delete to preview how many emails will be affected. |  |
| `bulk_move` | Move emails matching any combination of filters from one mailbox to another. Uses safe copy-verify-delete with fingerprint verification and a persistent manifest. Use dryRun: true to preview without making changes. | yes |
| `bulk_delete` | Delete emails matching any combination of filters. Processes in chunks of 500 with per-chunk timeouts for reliability. Use dryRun: true to preview without making changes. | yes |
| `bulk_flag` | Flag or unflag emails matching any combination of filters in bulk | yes |
| `bulk_delete_by_sender` | Delete all emails from a specific sender | yes |
| `bulk_move_by_sender` | Move all emails from a specific sender to a folder | yes |
| `bulk_delete_by_subject` | Delete all emails matching a subject pattern | yes |
| `bulk_mark_read` | Mark all emails as read, optionally filtered by sender | yes |
| `bulk_mark_unread` | Mark all emails as unread, optionally filtered by sender | yes |
| `delete_older_than` | Delete all emails older than a certain number of days | yes |
| `get_emails_by_date_range` | Get emails between two dates |  |
| `flag_email` | Flag or unflag a single email |  |
| `mark_as_read` | Mark a single email as read or unread |  |
| `delete_email` | Delete a single email | yes |
| `move_email` | Move a single email to a different mailbox/folder | yes |
| `list_mailboxes` | List all mailboxes/folders in iCloud Mail |  |
| `create_mailbox` | Create a new mailbox/folder |  |
| `rename_mailbox` | Rename an existing mailbox/folder |  |
| `delete_mailbox` | Delete a mailbox/folder. The folder must be empty first. | yes |
| `empty_trash` | Permanently delete all emails in the trash (Deleted Messages or Trash folder). Use dryRun: true to preview first. | yes |
| `get_move_status` | Check the status of the current or most recent bulk move operation. Shows progress, chunk statuses, and any failures. Call this to monitor a long-running move or inspect a failed one. |  |
| `abandon_move` | Abandon an in-progress move operation so a new one can start. Only use if you are certain the operation should not be resumed. Emails already moved will not be returned to source. |  |
| `log_write` | Write a step to the session log. Use this to record your plan before starting, and after each completed step. Helps maintain progress across long operations. |  |
| `log_read` | Read the current session log to see what has been done so far. |  |
| `log_clear` | Clear the session log and start fresh. Use this at the start of a new task. |  |
| `list_attachments` | List all attachments in an email without downloading them. Returns filename, MIME type, size, and IMAP part ID for each attachment. |  |
| `get_attachment` | Download a specific attachment from an email. Returns the file content as base64-encoded data. Use list_attachments first to get the partId. Maximum 20 MB per request; use offset+length for larger files. |  |
| `get_unsubscribe_info` | Get the List-Unsubscribe header from an email, parsed into email and URL components. Useful for AI-assisted inbox cleanup. |  |
| `mark_older_than_read` | Mark all unread emails older than N days as read. Useful for bulk triage of a cluttered inbox. | yes |
| `bulk_move_by_domain` | Move all emails from a specific domain to a folder. Convenience wrapper around bulk_move with a domain filter. | yes |
| `get_email_raw` | Get the raw RFC 2822 source of an email (full headers + MIME body) as base64-encoded data. Useful for debugging or export. Capped at 1 MB. |  |
| `bulk_flag_by_sender` | Flag or unflag all emails from a specific sender | yes |
| `archive_older_than` | Safely move emails older than N days from a source mailbox to an archive folder. Uses the same safe copy-verify-delete pipeline as bulk_move. Use dryRun: true to preview. | yes |
| `get_storage_report` | Estimate storage usage by size bucket and identify top senders by email size. Uses SEARCH LARGER queries for bucketing and samples large emails for sender analysis. |  |
| `get_thread` | Find all emails in the same thread as a given email. Uses subject matching + References/In-Reply-To header filtering. Note: iCloud does not support server-side threading — results are approximate. |  |
| `create_rule` | Create a saved rule that applies a specific action to emails matching a set of filters. Rules are stored persistently and can be run on demand or all at once with run_all_rules. |  |
| `list_rules` | List all saved rules with their filters, actions, and run history. |  |
| `run_rule` | Run a specific saved rule by name. Use dryRun: true to preview what would be affected without making changes. | yes |
| `delete_rule` | Delete a saved rule by name. | yes |
| `run_all_rules` | Run all saved rules in sequence. Use dryRun: true to preview all rules without making changes. | yes |
| `compose_email` | Compose and send a new email via iCloud SMTP. The From address is always your iCloud account. Supports plain text, HTML, or both (multipart/alternative). |  |
| `reply_to_email` | Reply to an existing email. Automatically sets correct threading headers (In-Reply-To, References) and prefixes the subject with Re:. Supports plain text and/or HTML body. |  |
| `forward_email` | Forward an existing email to one or more recipients. Fetches the original email body and includes it as a forwarded message block. Supports plain text and/or HTML note. |  |
| `save_draft` | Save a draft email to your iCloud Drafts folder without sending it. Supports plain text, HTML, or both. The draft can be edited and sent later from Mail.app or iCloud.com. |  |
| `get_digest_state` | Get the current inbox digest state — last run timestamp, processed email UIDs (to skip on next run), pending actions, and per-sender skip counts for smart unsubscribe. |  |
| `update_digest_state` | Update the digest state after a run. Merges new processed UIDs into the existing list, updates lastRun, replaces pendingActions, and accumulates per-sender skip counts. |  |

### Contacts

| Tool | Description | dryRun |
|------|-------------|--------|
| `list_contacts` | List contacts from iCloud Contacts. Returns names, phones, emails, and other fields. |  |
| `search_contacts` | Search iCloud Contacts by name, email address, or phone number. |  |
| `get_contact` | Get full details for a specific contact by ID. Use list_contacts or search_contacts to find a contactId. |  |
| `create_contact` | Create a new contact in iCloud Contacts. |  |
| `update_contact` | Update an existing contact in iCloud Contacts. Only provided fields are changed; others are preserved. |  |
| `delete_contact` | Delete a contact from iCloud Contacts permanently. | yes |

### Calendar

| Tool | Description | dryRun |
|------|-------------|--------|
| `list_calendars` | List all calendars in iCloud Calendar (e.g. Personal, Work, School). Returns calendarId, name, and supported event types. |  |
| `create_calendar` | Create a new event calendar in iCloud Calendar. Fails if a calendar with that name already exists. |  |
| `delete_calendar` | Delete an iCloud event calendar by exact name or calendarId. The calendar must have no events (past or future); delete them first with bulk_delete_events. Will not delete Reminders lists. | yes |
| `list_events` | List events in a specific iCloud calendar within a date range. Use list_calendars first to get a calendarId. |  |
| `get_event` | Get full details of a specific calendar event by its ID. |  |
| `create_event` | Create a new event in an iCloud calendar. For all-day events use allDay:true and YYYY-MM-DD for start/end. |  |
| `update_event` | Update an existing calendar event. Only provided fields are changed; others are preserved. |  |
| `delete_event` | Delete a calendar event permanently from iCloud Calendar. | yes |
| `search_events` | Search for events by title/summary across all calendars within an optional date range. |  |
| `bulk_update_events` | Update multiple calendar events in one call. Each update object must include eventId and only the fields to change. | yes |
| `list_events_multi` | List events from multiple calendars in one call. Returns events grouped by calendar ID. |  |
| `bulk_create_events` | Create multiple calendar events in one call. Much more efficient than calling create_event repeatedly. Each event in the array uses the same fields as create_event. | yes |
| `bulk_delete_events` | Delete multiple calendar events in one call. Much more efficient than calling delete_event repeatedly. | yes |
| `detect_conflicts` | Detect scheduling conflicts and tight gaps between events across multiple calendars. Compares all non-all-day events on the same date from different calendars. |  |

### Reminders

| Tool | Description | dryRun |
|------|-------------|--------|
| `list_reminder_lists` | List all Reminders lists in iCloud Reminders (e.g. "Reminders", "Work", "Shopping"). Returns name, id, and count per list. |  |
| `create_reminder_list` | Create a new Reminders list in iCloud Reminders. Fails if a list with that name already exists. |  |
| `rename_reminder_list` | Rename a Reminders list. The old name must match exactly one list, and the new name must not already be in use. | yes |
| `delete_reminder_list` | Delete a Reminders list. The list must be empty first, and the name must match exactly one list. | yes |
| `list_reminders` | List reminders from iCloud Reminders. Omit listName to fetch from all lists. |  |
| `get_reminder` | Get full details of a specific reminder by ID. |  |
| `create_reminder` | Create a new reminder in iCloud Reminders. |  |
| `update_reminder` | Update an existing reminder. Only provided fields are changed; others are preserved. |  |
| `complete_reminder` | Mark a reminder as completed in iCloud Reminders. |  |
| `delete_reminder` | Delete a reminder from iCloud Reminders permanently. | yes |

Listing reminders reads each property for the whole list in one batch. A list of zero or one reminder is coerced to an array before it is indexed. If Reminders.app stalls, the tool says the script timed out after 90 seconds instead of reporting an iCloud network timeout. A timed-out create, update, or delete may still have been applied.

### Email to calendar

| Tool | Description | dryRun |
|------|-------------|--------|
| `suggest_event_from_email` | Fetch an email and return its content formatted for calendar event extraction. After calling this tool, extract the event fields from the returned content (pay attention to _dateAnchor for resolving relative dates like "Tuesday"), present a summary to the user for confirmation, then call create_event. No API key required. |  |

## Filters

`bulk_move`, `bulk_delete`, `bulk_flag`, `search_emails`, `count_emails`, and rules accept any combination of: `sender`, `domain`, `subject`, `before`, `since`, `unread`, `flagged`, `larger`, `smaller`, `hasAttachment`, and `account`.

A `domain` filter searches both the bare domain and `@domain`. iCloud's FROM search misses some senders when given only the bare domain. Subdomains are not matched: a filter of `example.com` does not find mail from `someone@mail.example.com`. When a keyword and a domain are both set, `search_emails` keeps both conditions.

## Safe move

`bulk_move`, `bulk_move_by_sender`, `bulk_move_by_domain`, and `archive_older_than` copy, verify fingerprints in the destination, then remove the source. `get_move_status` and `abandon_move` inspect or clear the manifest.

## Connections

An idle iCloud IMAP connection times out after 60 seconds of silence. The server logs the error and that tool call fails. The process stays up. Saving a draft uses its own IMAP connection and attaches the same handler.

## HTTP transport

Stdio is still the default. `icloud-mcp --http` (or `node index.js --http`) also serves the same tools over MCP Streamable HTTP. The process listens on `127.0.0.1` only. `ICLOUD_MCP_HTTP_PORT` chooses the port (default `8787`).

HTTP mode refuses to start unless both of these are true:

- Authentication is configured. Either set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `ICLOUD_MCP_ALLOWED_EMAILS` for a Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`, checked against the team JWKS), or set `ICLOUD_MCP_BEARER_TOKEN` for a static bearer token used in local tests. When both are set, either one is accepted.
- `ICLOUD_MCP_SEND_MODE` is `off`, `drafts`, or `self-only`. The default `on` is refused.
- `ICLOUD_MCP_TOOL_PROFILE` is `remote-safe`. `full` is refused.

Host and Origin are checked before a request is handled, which blocks DNS rebinding. Loopback names (`localhost`, `127.0.0.1`, `::1`) are always allowed. A tunnel hostname belongs in `ICLOUD_MCP_ALLOWED_HOSTS` (comma-separated). A browser `Origin` must be a loopback origin for this port, or a value in `ICLOUD_MCP_ALLOWED_ORIGINS`, or `http`/`https` on an allowed host. A missing Origin header is allowed so non-browser clients can connect. The Origin value `null` is rejected. Authenticated requests are limited per identity (`ICLOUD_MCP_RATE_LIMIT_PER_MINUTE`, default 60). Requests with no credentials, and requests that fail authentication, have a separate limit of 10. That limit is per socket address. When the socket is loopback and Cloudflare Access is configured, the key is `Cf-Connecting-Ip` if the header is an IP address, so callers behind the tunnel do not share one bucket. Otherwise the header is ignored. An unknown or expired `mcp-session-id` is rejected with 404. A request with no session id that is not `initialize` is rejected with 400. Each session is tied to the identity that created it, dropped after 30 minutes idle, and new sessions stop once 100 are open. Logs record a reason code, not tokens or message contents.

`IMAP_USER` and `IMAP_PASSWORD` are still required to start. The send-mode values themselves are enforced by the SMTP layer when that gate is installed; this transport only refuses to listen while the mode is `on`.

## Tests

`npm test` runs the offline suite only. It mocks IMAP, CardDAV, CalDAV, and Reminders, and it does not contact iCloud or send mail.

`npm run test:live` runs the dummy-data suite in `tests/live-destructive.test.js`. It stays skipped unless `ICLOUD_MCP_LIVE=1`, `IMAP_USER`, and `IMAP_PASSWORD` are all set. It creates dummy contacts, reminders, calendar events, and messages appended into a temp folder, then deletes those dummies. It does not send mail. Set `LIVE_CALENDAR` to the calendar that should receive the dummy events. Calendar tests are skipped when that variable is unset. Delete tools run as a dry run first and skip the real delete unless that preview names exactly the dummies from this run.

`npm run test:send` runs `tests/test.js`. It stays skipped unless `ICLOUD_MCP_SEND=1`, `IMAP_USER`, and `IMAP_PASSWORD` are all set. Every message it sends goes only to the account in `IMAP_USER`. Reply, reply-all, and forward act on a seed that account just sent to itself, never on other inbox mail. Before each send, a guard checks every To, Cc, and Bcc recipient (case and surrounding whitespace ignored) and aborts the run if any address is anyone else.

`dryRun: true` on a delete, a move that removes the original, or a bulk change returns `{ dryRun: true, changes: [...] }` and does not write. Omit it, or pass false, to perform the change.

## Remote access

Stdio stays the default and is the right transport for a local client. A phone, Grok Bot, or a Claude custom connector should use the loopback HTTP listener behind Cloudflare Tunnel and Cloudflare Access. Do not expose port 8787 on the LAN or the public internet.

### Cloudflare Tunnel and Access

1. Start `icloud-mcp --http` (or `node index.js --http`). The process binds to `127.0.0.1` only. `ICLOUD_MCP_HTTP_PORT` defaults to `8787`.
2. Create a Cloudflare Tunnel that routes one hostname to `http://127.0.0.1:8787`.
3. Put a Cloudflare Access application on that hostname and use Managed OAuth, so the connector signs in with an identity provider instead of a shared Mac password.
4. Set `CF_ACCESS_TEAM_DOMAIN` to the team domain (no scheme), `CF_ACCESS_AUD` to the application's AUD tag, and `ICLOUD_MCP_ALLOWED_EMAILS` to the comma-separated addresses that may call the server.
5. The tunnel forwards `Cf-Access-Jwt-Assertion`. The server checks that JWT against the team JWKS at `https://<team-domain>/cdn-cgi/access/certs`, then requires the token email to be on the allow list.
6. Put the public hostname in `ICLOUD_MCP_ALLOWED_HOSTS`. Loopback names are already allowed. This is the DNS-rebinding check.

`ICLOUD_MCP_BEARER_TOKEN` is a static bearer token for a local test client. It is not the remote credential. When Access and the bearer token are both set, either one is accepted.

HTTP mode refuses to start unless authentication is configured, `ICLOUD_MCP_SEND_MODE` is `off`, `drafts`, or `self-only`, and `ICLOUD_MCP_TOOL_PROFILE` is `remote-safe`. The default send mode `on` and the `full` profile are refused. A missing Origin header is allowed. The Origin value `null`, and any other Origin that is not on the allow list, are rejected. Authenticated requests are limited per identity. Requests that have no credentials use a separate limit of 10 per address, so an unauthenticated flood does not consume the caller's budget.

### macOS LaunchAgent

Reminders uses JavaScript for Automation and needs a logged-in GUI session. Run the server as a LaunchAgent in `~/Library/LaunchAgents`, not as a LaunchDaemon. A daemon starts outside that session and cannot talk to Reminders.

Store the app-specific password in the macOS Keychain (service `icloud-mcp`, or `ICLOUD_MCP_KEYCHAIN_SERVICE`) instead of in the plist. `IMAP_PASS` is only a fallback when `IMAP_PASSWORD` is unset. `node mcp-call.mjs` loads a `.env` file when one exists and otherwise uses the process environment.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.icloud-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/icloud-mcp/index.js</string>
    <string>--http</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>IMAP_USER</key>
    <string>you@icloud.com</string>
    <key>ICLOUD_MCP_SEND_MODE</key>
    <string>drafts</string>
    <key>ICLOUD_MCP_TOOL_PROFILE</key>
    <string>remote-safe</string>
    <key>CF_ACCESS_TEAM_DOMAIN</key>
    <string>team.cloudflareaccess.com</string>
    <key>CF_ACCESS_AUD</key>
    <string>access-aud-tag</string>
    <key>ICLOUD_MCP_ALLOWED_EMAILS</key>
    <string>you@example.com</string>
    <key>ICLOUD_MCP_ALLOWED_HOSTS</key>
    <string>mail.example.com</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

### Recommended environment

Use `ICLOUD_MCP_SEND_MODE=off` or `drafts` for a remote connector. `off` blocks `compose_email`, `reply_to_email`, and `forward_email`. `drafts` saves a draft instead of sending. `self-only` sends only when every To, Cc, and Bcc is the authenticated account. Unset means `on`, which is the local stdio default and is refused in HTTP mode.

Use `ICLOUD_MCP_TOOL_PROFILE=remote-safe`. That profile is an allowlist of read, search, draft, and calendar or reminder create and edit tools. A tool that is not on the list is hidden, including tools added later. Leave `ICLOUD_MCP_ALLOW_BULK` unset so any bulk tool that is on the list runs as a dry run.

### Prompt injection

Message bodies, subjects, and addresses are untrusted data. A sender can put instructions in a message that a model may follow. Read tool output as data, not as a new task. Send mode `off` or `drafts`, plus the `remote-safe` profile, limits what those instructions can cause. They do not make the text trustworthy.

### Environment variables

| Variable | Default | Role |
|----------|---------|------|
| `ICLOUD_MCP_SEND_MODE` | `on` | `off`, `drafts`, `self-only`, or `on`. Enforced in the SMTP send path. |
| `ICLOUD_MCP_TOOL_PROFILE` | `full` | `full` or `remote-safe`. `remote-safe` is an allowlist. Tools that are not on it stay hidden. |
| `ICLOUD_MCP_ALLOW_BULK` | unset | Comma-separated tool names that may mutate in `remote-safe`. Hidden tools stay hidden. |
| `ICLOUD_MCP_HTTP_PORT` | `8787` | Loopback port for `--http`. |
| `CF_ACCESS_TEAM_DOMAIN` | unset | Cloudflare Access team domain. Required for JWT auth. |
| `CF_ACCESS_AUD` | unset | Access application AUD tag. |
| `ICLOUD_MCP_ALLOWED_EMAILS` | unset | Comma-separated emails allowed to present an Access JWT. |
| `ICLOUD_MCP_BEARER_TOKEN` | unset | Static bearer token for local HTTP tests. |
| `ICLOUD_MCP_ALLOWED_HOSTS` | loopback | Extra Host values, such as the tunnel hostname. |
| `ICLOUD_MCP_ALLOWED_ORIGINS` | loopback | Extra browser Origin values. A missing Origin is allowed. The value `null` is rejected. |
| `ICLOUD_MCP_RATE_LIMIT_PER_MINUTE` | `60` | Per-identity limit after authentication. Unauthenticated requests use a separate limit of 10 per address. |
| `ICLOUD_MCP_KEYCHAIN_SERVICE` | `icloud-mcp` | `security` service name used when `IMAP_USER` or `IMAP_PASSWORD` is missing. |
| `IMAP_PASS` | unset | Copied to `IMAP_PASSWORD` only when `IMAP_PASSWORD` is unset. |
| `ICLOUD_MCP_REMINDER_LIST` | `claude` | Reminders list name used by the digest tools. |
| `ICLOUD_MCP_AUDIT_LOG` | `~/.icloud-mcp-audit.log` | Audit file, mode `0600`. The directory that contains it is mode `0700`. |
| `ICLOUD_MCP_AUDIT_LOG_MAX_BYTES` | `1048576` | Rotate the audit file after it reaches this size. Three older files are kept. |
| `ICLOUD_MCP_DATA_DIR` | home directory | Directory for rules, the move manifest, digest state, the session log, and the audit log. |

## Security

Credentials stay in your local MCP client config. The server runs on your machine. Revoke an app-specific password at [appleid.apple.com](https://appleid.apple.com).

## Send mode

`ICLOUD_MCP_SEND_MODE` controls SMTP sending. Leave it unset for local stdio: the default is `on`, and `compose_email`, `reply_to_email`, and `forward_email` send mail as before. The check lives in the SMTP functions, so those tools cannot skip it.

| Value | Behavior |
|-------|----------|
| `on` | Send. This is the default. |
| `off` | Refuse every send with an error. Nothing is handed to SMTP. `save_draft` still saves a draft. |
| `drafts` | Do not send. `compose_email`, `reply_to_email`, and `forward_email` append a draft instead and return `sent: false`, `drafted: true`. |
| `self-only` | Send only when every To, Cc, and Bcc mailbox is the authenticated account. Addresses are parsed with the same parser nodemailer uses, then those objects are what gets sent. Case is ignored. |

Any other value is an error and nothing is sent. Recipient groups, addresses that do not parse to a single mailbox, and a CR, LF, or other control character in a header field are refused in every mode. The refusal does not include the address. A subject copied from the original message has CR, LF, and tab runs collapsed to a space, and other controls removed, before that check. A subject the caller supplies is still refused when it contains a control character.

## License

MIT
