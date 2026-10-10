// Digest helpers refer to one Reminders list. The historical default is "claude".
export const DEFAULT_REMINDER_LIST = 'claude';

export function reminderListName(env = process.env) {
  const name = String(env.ICLOUD_MCP_REMINDER_LIST ?? '').trim();
  return name || DEFAULT_REMINDER_LIST;
}
