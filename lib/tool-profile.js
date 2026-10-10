// ICLOUD_MCP_TOOL_PROFILE=full (default) | remote-safe.
// remote-safe is an allowlist: a tool is omitted from tools/list unless it is
// named here. A tool added later stays hidden until someone adds it.
// Calls to a hidden tool throw before any handler runs. Bulk tools that remain
// run as a dry run unless the tool name is listed in ICLOUD_MCP_ALLOW_BULK.

const PROFILES = ['full', 'remote-safe'];

export const REMOTE_SAFE_TOOLS = [
  'list_accounts', 'get_inbox_summary', 'get_mailbox_summary', 'get_top_senders', 'get_unread_senders',
  'get_emails_by_sender', 'read_inbox', 'get_email', 'search_emails', 'count_emails',
  'get_emails_by_date_range', 'flag_email', 'mark_as_read', 'list_mailboxes', 'create_mailbox',
  'get_move_status', 'log_write', 'log_read', 'list_attachments', 'get_attachment',
  'get_unsubscribe_info', 'get_email_raw', 'get_storage_report', 'get_thread', 'save_draft',
  'get_digest_state', 'update_digest_state',
  'list_contacts', 'search_contacts', 'get_contact', 'create_contact', 'update_contact',
  'list_calendars', 'create_calendar', 'list_events', 'get_event', 'create_event', 'update_event',
  'search_events', 'bulk_update_events', 'list_events_multi', 'bulk_create_events', 'detect_conflicts',
  'list_reminder_lists', 'create_reminder_list', 'rename_reminder_list', 'list_reminders', 'get_reminder',
  'create_reminder', 'update_reminder', 'complete_reminder',
  'suggest_event_from_email',
];

const REMOTE_SAFE_ALLOW = new Set(REMOTE_SAFE_TOOLS);

export function hiddenRemoteSafeTools(tools) {
  return tools.map((tool) => tool.name).filter((name) => !REMOTE_SAFE_ALLOW.has(name));
}

export function resolveToolProfile(env = process.env) {
  const raw = env.ICLOUD_MCP_TOOL_PROFILE;
  if (raw == null || String(raw).trim() === '') return 'full';
  const profile = String(raw).trim().toLowerCase();
  if (!PROFILES.includes(profile)) {
    throw new Error('ICLOUD_MCP_TOOL_PROFILE must be full or remote-safe');
  }
  return profile;
}

export function assertValidToolProfile(env = process.env) {
  resolveToolProfile(env);
}

export function selectTools(tools, env = process.env) {
  const profile = resolveToolProfile(env);
  if (profile === 'full') return tools;
  return tools.filter((tool) => REMOTE_SAFE_ALLOW.has(tool.name));
}

function isBulkMutating(name) {
  return name.startsWith('bulk_')
    || name === 'archive_older_than'
    || name === 'delete_older_than'
    || name === 'mark_older_than_read'
    || name === 'empty_trash'
    || name === 'run_rule'
    || name === 'run_all_rules';
}

function isBulkAllowed(name, env) {
  return String(env.ICLOUD_MCP_ALLOW_BULK ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(name);
}

// Returns the arguments the handler should see. In remote-safe, a remaining
// bulk mutation runs as a dry run unless ICLOUD_MCP_ALLOW_BULK names it.
export function prepareToolCall(name, args = {}, env = process.env) {
  const profile = resolveToolProfile(env);
  if (profile === 'remote-safe' && !REMOTE_SAFE_ALLOW.has(name)) {
    throw new Error(`Tool ${name} is not available in the remote-safe tool profile.`);
  }
  if (profile === 'remote-safe' && isBulkMutating(name) && !isBulkAllowed(name, env)) {
    return { ...args, dryRun: true };
  }
  return args;
}
