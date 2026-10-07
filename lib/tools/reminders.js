// iCloud Reminders (JXA) tools.
import {
  listReminderLists, listReminders, getReminder, createReminder, updateReminder, completeReminder, deleteReminder,
  createReminderList, deleteReminderList,
} from '../reminders.js';


export const reminderTools = [
  // ── Reminders (JXA — real iCloud Reminders, not legacy CalDAV) ──
  {
    name: 'list_reminder_lists',
    description: 'List all Reminders lists in iCloud Reminders (e.g. "Reminders", "Work", "Shopping"). Returns name, id, and count per list.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_reminder_list',
    description: 'Create a new Reminders list in iCloud Reminders. Fails if a list with that name already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the new list' }
      },
      required: ['name']
    }
  },
  {
    name: 'delete_reminder_list',
    description: 'Delete a Reminders list. The list must be empty first, and the name must match exactly one list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact name of the list to delete' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
      },
      required: ['name']
    }
  },
  {
    name: 'list_reminders',
    description: 'List reminders from iCloud Reminders. Omit listName to fetch from all lists.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: { type: 'string', description: 'List name from list_reminder_lists (omit for all lists)' },
        includeCompleted: { type: 'boolean', description: 'Include completed reminders (default false)' },
        limit: { type: 'number', description: 'Max reminders to return (default 50)' }
      }
    }
  },
  {
    name: 'get_reminder',
    description: 'Get full details of a specific reminder by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: { type: 'string', description: 'List name containing the reminder' },
        reminderId: { type: 'string', description: 'Reminder ID from list_reminders' }
      },
      required: ['listName', 'reminderId']
    }
  },
  {
    name: 'create_reminder',
    description: 'Create a new reminder in iCloud Reminders.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: { type: 'string', description: 'List name to add the reminder to (required)' },
        title: { type: 'string', description: 'Reminder title' },
        notes: { type: 'string', description: 'Notes / description' },
        due: { type: 'string', description: 'Due date/time — ISO 8601 (e.g. 2026-03-20T09:00:00)' },
        priority: { type: 'string', description: 'Priority: high, medium, low, or none (default none)' }
      },
      required: ['listName', 'title']
    }
  },
  {
    name: 'update_reminder',
    description: 'Update an existing reminder. Only provided fields are changed; others are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: { type: 'string', description: 'List name containing the reminder' },
        reminderId: { type: 'string', description: 'Reminder ID to update' },
        title: { type: 'string' },
        notes: { type: 'string' },
        due: { type: 'string' },
        priority: { type: 'string', description: 'high, medium, low, or none' }
      },
      required: ['listName', 'reminderId']
    }
  },
  {
    name: 'complete_reminder',
    description: 'Mark a reminder as completed in iCloud Reminders.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: { type: 'string', description: 'List name containing the reminder' },
        reminderId: { type: 'string', description: 'Reminder ID to mark as completed' }
      },
      required: ['listName', 'reminderId']
    }
  },
  {
    name: 'delete_reminder',
    description: 'Delete a reminder from iCloud Reminders permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: { type: 'string', description: 'List name containing the reminder' },
        reminderId: { type: 'string', description: 'Reminder ID to delete' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
      },
      required: ['listName', 'reminderId']
    }
  },
];

const _reminderTools_NAMES = new Set(reminderTools.map((tool) => tool.name));

export async function handleReminderTool(name, args, ctx) {
  if (!_reminderTools_NAMES.has(name)) return undefined;
  const { resolveCreds, resolveMailbox, accounts: ACCOUNTS } = ctx;
  let result;
  if (name === 'list_reminder_lists') {
    result = listReminderLists();
  } else if (name === 'create_reminder_list') {
    result = createReminderList(args.name);
  } else if (name === 'delete_reminder_list') {
    result = deleteReminderList(args.name, args.dryRun || false);
  } else if (name === 'list_reminders') {
    result = listReminders(args.listName || null, args.includeCompleted || false, args.limit || 50);
  } else if (name === 'get_reminder') {
    result = getReminder(args.listName, args.reminderId);
  } else if (name === 'create_reminder') {
    const { listName, ...fields } = args;
    result = createReminder(listName, fields);
  } else if (name === 'update_reminder') {
    const { listName, reminderId, ...fields } = args;
    result = updateReminder(listName, reminderId, fields);
  } else if (name === 'complete_reminder') {
    result = completeReminder(args.listName, args.reminderId);
  } else if (name === 'delete_reminder') {
    result = deleteReminder(args.listName, args.reminderId, args.dryRun || false);
  // ── Smart extraction (SCAN tier 60s — LLM round-trip) ──
  }
  return result;
}

