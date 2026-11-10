// MCP tool annotations. Clients use these to decide what can run without asking
// (read-only tools) and what deserves a confirmation (destructive tools).
// Every tool must be named in exactly one list; a test fails when a new tool is
// added without being classified, so nothing defaults to "safe".

// Reads only. Nothing on the mail server, calendar, contacts, reminders, or in
// local state changes.
export const READ_ONLY_TOOLS = [
  'list_accounts', 'get_inbox_summary', 'get_mailbox_summary', 'get_top_senders', 'get_unread_senders',
  'get_emails_by_sender', 'read_inbox', 'get_email', 'search_emails', 'count_emails',
  'get_emails_by_date_range', 'list_mailboxes', 'get_move_status', 'log_read', 'list_attachments',
  'get_attachment', 'get_unsubscribe_info', 'get_email_raw', 'get_storage_report', 'get_thread',
  'list_rules', 'get_digest_state',
  'list_contacts', 'search_contacts', 'get_contact',
  'list_calendars', 'list_events', 'get_event', 'search_events', 'list_events_multi', 'detect_conflicts',
  'list_reminder_lists', 'list_reminders', 'get_reminder',
  'suggest_event_from_email',
];

// Removes data, or can (a rule may delete; abandon_move discards recovery state).
export const DESTRUCTIVE_TOOLS = [
  'delete_email', 'bulk_delete', 'bulk_delete_by_sender', 'bulk_delete_by_subject', 'delete_older_than',
  'empty_trash', 'delete_mailbox', 'abandon_move', 'log_clear', 'delete_rule', 'run_rule', 'run_all_rules',
  'delete_contact', 'delete_calendar', 'delete_event', 'bulk_delete_events',
  'delete_reminder', 'delete_reminder_list',
];

// Sends mail to other people: the one place a call reaches outside the account.
export const SEND_TOOLS = ['compose_email', 'reply_to_email', 'forward_email'];

// Changes data without removing any: moves, flags, creates, updates.
export const WRITE_TOOLS = [
  'bulk_move', 'bulk_flag', 'bulk_move_by_sender', 'bulk_mark_read', 'bulk_mark_unread',
  'flag_email', 'mark_as_read', 'move_email', 'create_mailbox', 'rename_mailbox',
  'log_write', 'mark_older_than_read', 'bulk_move_by_domain', 'bulk_flag_by_sender', 'archive_older_than',
  'create_rule', 'save_draft', 'update_digest_state',
  'create_contact', 'update_contact',
  'create_calendar', 'create_event', 'update_event', 'bulk_update_events', 'bulk_create_events',
  'create_reminder_list', 'rename_reminder_list', 'create_reminder', 'update_reminder', 'complete_reminder',
];

const READ_ONLY = new Set(READ_ONLY_TOOLS);
const DESTRUCTIVE = new Set(DESTRUCTIVE_TOOLS);
const SEND = new Set(SEND_TOOLS);
const WRITE = new Set(WRITE_TOOLS);

export function annotationsFor(name) {
  if (READ_ONLY.has(name)) return { readOnlyHint: true, openWorldHint: false };
  if (DESTRUCTIVE.has(name)) return { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  if (SEND.has(name)) return { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  if (WRITE.has(name)) return { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  // Unclassified: describe it as the riskiest kind until someone lists it.
  return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
}

export function withAnnotations(tools) {
  return tools.map((tool) => ({ ...tool, annotations: { ...annotationsFor(tool.name), ...(tool.annotations || {}) } }));
}
