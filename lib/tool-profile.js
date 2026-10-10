// ICLOUD_MCP_TOOL_PROFILE=full (default) | remote-safe.
// remote-safe removes tools from tools/list. Calls to a removed tool throw
// before any handler runs. Bulk tools that remain run as a dry run unless
// the tool name is listed in ICLOUD_MCP_ALLOW_BULK.

const PROFILES = ['full', 'remote-safe'];

// Hidden from remote clients. Not merely rejected after they show up in the list.
const HIDDEN_REMOTE_SAFE = new Set([
  // Sending
  'compose_email',
  'reply_to_email',
  'forward_email',
  // Delete, bulk mailbox changes, and moves
  'bulk_move',
  'bulk_delete',
  'bulk_flag',
  'bulk_delete_by_sender',
  'bulk_move_by_sender',
  'bulk_delete_by_subject',
  'bulk_mark_read',
  'bulk_mark_unread',
  'delete_older_than',
  'delete_email',
  'move_email',
  'rename_mailbox',
  'delete_mailbox',
  'empty_trash',
  'abandon_move',
  'mark_older_than_read',
  'bulk_move_by_domain',
  'bulk_flag_by_sender',
  'archive_older_than',
  // Rules
  'create_rule',
  'list_rules',
  'run_rule',
  'delete_rule',
  'run_all_rules',
  // Local destructive session reset
  'log_clear',
  // Contact, calendar, and reminder deletion
  'delete_contact',
  'delete_calendar',
  'delete_event',
  'bulk_delete_events',
  'delete_reminder_list',
  'delete_reminder',
]);

export function hiddenRemoteSafeTools() {
  return [...HIDDEN_REMOTE_SAFE];
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
  return tools.filter((tool) => !HIDDEN_REMOTE_SAFE.has(tool.name));
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
  if (profile === 'remote-safe' && HIDDEN_REMOTE_SAFE.has(name)) {
    throw new Error(`Tool ${name} is not available in the remote-safe tool profile.`);
  }
  if (profile === 'remote-safe' && isBulkMutating(name) && !isBulkAllowed(name, env)) {
    return { ...args, dryRun: true };
  }
  return args;
}
