// iCloud Calendar (CalDAV) tools, including email-to-event suggestion.
import { TIMEOUT, withTimeout, getEmailContent } from '../imap.js';
import { formatEmailForExtraction } from '../event-extractor.js';
import {
  listCalendars, listEvents, getEvent, createEvent, updateEvent, deleteEvent, searchEvents,
  bulkCreateEvents, bulkDeleteEvents, bulkUpdateEvents, listEventsMulti, detectConflicts,
} from '../caldav.js';


export const calendarTools = [
  // ── CalDAV / Calendar ──
  {
    name: 'list_calendars',
    description: 'List all calendars in iCloud Calendar (e.g. Personal, Work, School). Returns calendarId, name, and supported event types.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_events',
    description: 'List events in a specific iCloud calendar within a date range. Use list_calendars first to get a calendarId.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID from list_calendars' },
        since: { type: 'string', description: 'Start of range (YYYY-MM-DD, default: 30 days ago)' },
        before: { type: 'string', description: 'End of range (YYYY-MM-DD, default: 30 days ahead)' },
        limit: { type: 'number', description: 'Max events to return (default 50)' }
      },
      required: ['calendarId']
    }
  },
  {
    name: 'get_event',
    description: 'Get full details of a specific calendar event by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID containing the event' },
        eventId: { type: 'string', description: 'Event ID (UUID from list_events or search_events)' }
      },
      required: ['calendarId', 'eventId']
    }
  },
  {
    name: 'create_event',
    description: 'Create a new event in an iCloud calendar. For all-day events use allDay:true and YYYY-MM-DD for start/end.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID to add the event to' },
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start date/time — ISO 8601 (e.g. 2026-03-15T10:00:00) or YYYY-MM-DD for all-day' },
        end: { type: 'string', description: 'End date/time — ISO 8601 or YYYY-MM-DD. Defaults to 1 hour after start.' },
        timezone: { type: 'string', description: 'IANA timezone (e.g. America/New_York). Use "UTC" or omit for UTC.' },
        allDay: { type: 'boolean', description: 'True for all-day event (uses DATE values, no time)' },
        description: { type: 'string', description: 'Event description / notes' },
        location: { type: 'string', description: 'Event location' },
        recurrence: { type: 'string', description: 'iCal RRULE string (e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR)' },
        status: { type: 'string', description: 'Event status: CONFIRMED, TENTATIVE, or CANCELLED' },
        reminder: { type: 'number', description: 'Alert this many minutes before the event (default 30, set to 0 to disable)' }
      },
      required: ['calendarId', 'summary', 'start']
    }
  },
  {
    name: 'update_event',
    description: 'Update an existing calendar event. Only provided fields are changed; others are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID containing the event' },
        eventId: { type: 'string', description: 'Event ID to update' },
        summary: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        timezone: { type: 'string' },
        allDay: { type: 'boolean' },
        description: { type: 'string' },
        location: { type: 'string' },
        recurrence: { type: 'string' },
        status: { type: 'string' },
        reminder: { type: 'number', description: 'Alert minutes before event (0 to disable)' }
      },
      required: ['calendarId', 'eventId']
    }
  },
  {
    name: 'delete_event',
    description: 'Delete a calendar event permanently from iCloud Calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID containing the event' },
        eventId: { type: 'string', description: 'Event ID to delete' },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
      },
      required: ['calendarId', 'eventId']
    }
  },
  {
    name: 'search_events',
    description: 'Search for events by title/summary across all calendars within an optional date range.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for in event titles' },
        since: { type: 'string', description: 'Start of search range (YYYY-MM-DD, default: 1 year ago)' },
        before: { type: 'string', description: 'End of search range (YYYY-MM-DD, default: 1 year ahead)' }
      },
      required: ['query']
    }
  },
  {
    name: 'bulk_update_events',
    description: 'Update multiple calendar events in one call. Each update object must include eventId and only the fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID containing the events' },
        updates: {
          type: 'array',
          description: 'Array of update objects, each with eventId (required) plus any fields to change: summary, start, end, timezone, allDay, description, location, recurrence, status, reminder',
          items: {
            type: 'object',
            properties: {
              eventId: { type: 'string' },
              summary: { type: 'string' },
              start: { type: 'string' },
              end: { type: 'string' },
              timezone: { type: 'string' },
              allDay: { type: 'boolean' },
              description: { type: 'string' },
              location: { type: 'string' },
              recurrence: { type: 'string' },
              status: { type: 'string' },
              reminder: { type: 'number' }
            },
            required: ['eventId']
          }
        },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
      },
      required: ['calendarId', 'updates']
    }
  },
  {
    name: 'list_events_multi',
    description: 'List events from multiple calendars in one call. Returns events grouped by calendar ID.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarIds: {
          type: 'array',
          description: 'Array of calendar IDs to fetch events from',
          items: { type: 'string' }
        },
        since: { type: 'string', description: 'Start of date range (YYYY-MM-DD, default: 30 days ago)' },
        before: { type: 'string', description: 'End of date range (YYYY-MM-DD, default: 30 days ahead)' },
        limit: { type: 'number', description: 'Max events per calendar (default 50)' }
      },
      required: ['calendarIds']
    }
  },
  {
    name: 'bulk_create_events',
    description: 'Create multiple calendar events in one call. Much more efficient than calling create_event repeatedly. Each event in the array uses the same fields as create_event.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID to add all events to' },
        events: {
          type: 'array',
          description: 'Array of event objects, each with: summary (required), start (required), end, timezone, allDay, description, location, recurrence, status, reminder',
          items: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              start: { type: 'string' },
              end: { type: 'string' },
              timezone: { type: 'string' },
              allDay: { type: 'boolean' },
              description: { type: 'string' },
              location: { type: 'string' },
              recurrence: { type: 'string' },
              status: { type: 'string' },
              reminder: { type: 'number' }
            },
            required: ['summary', 'start']
          }
        },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
      },
      required: ['calendarId', 'events']
    }
  },
  {
    name: 'bulk_delete_events',
    description: 'Delete multiple calendar events in one call. Much more efficient than calling delete_event repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID containing the events' },
        eventIds: {
          type: 'array',
          description: 'Array of event IDs to delete',
          items: { type: 'string' }
        },
        dryRun: { type: 'boolean', description: 'If true, report exactly what would change and do not modify anything' },
      },
      required: ['calendarId', 'eventIds']
    }
  },
  {
    name: 'detect_conflicts',
    description: 'Detect scheduling conflicts and tight gaps between events across multiple calendars. Compares all non-all-day events on the same date from different calendars.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarIds: {
          type: 'array',
          description: 'Array of calendar IDs to check for conflicts',
          items: { type: 'string' }
        },
        since: { type: 'string', description: 'Start of range (YYYY-MM-DD, default: today)' },
        before: { type: 'string', description: 'End of range (YYYY-MM-DD, default: 90 days ahead)' },
        minBuffer: { type: 'number', description: 'Minimum buffer minutes between events to flag tight gaps (default 0 = no gap check)' }
      },
      required: ['calendarIds']
    }
  },
];

export const suggestEventTools = [
  // ── Smart extraction ──
  {
    name: 'suggest_event_from_email',
    description: 'Fetch an email and return its content formatted for calendar event extraction. After calling this tool, extract the event fields from the returned content (pay attention to _dateAnchor for resolving relative dates like "Tuesday"), present a summary to the user for confirmation, then call create_event. No API key required.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'number', description: 'Email UID to extract event from' },
        mailbox: { type: 'string', description: 'Mailbox containing the email (default INBOX)' }
      },
      required: ['uid']
    }
  }
];

const _calendarTools_NAMES = new Set([...calendarTools, ...suggestEventTools].map((tool) => tool.name));

export async function handleCalendarTool(name, args, ctx) {
  if (!_calendarTools_NAMES.has(name)) return undefined;
  const { resolveCreds, resolveMailbox, accounts: ACCOUNTS } = ctx;
  let result;
  if (name === 'list_calendars') {
    result = await withTimeout('list_calendars', TIMEOUT.FETCH, () =>
      listCalendars()
    );
  } else if (name === 'list_events') {
    result = await withTimeout('list_events', TIMEOUT.FETCH, () =>
      listEvents(args.calendarId, args.since || null, args.before || null, args.limit || 50)
    );
  } else if (name === 'get_event') {
    result = await withTimeout('get_event', TIMEOUT.FETCH, () =>
      getEvent(args.calendarId, args.eventId)
    );
  } else if (name === 'create_event') {
    const { calendarId, ...fields } = args;
    result = await withTimeout('create_event', TIMEOUT.FETCH, () =>
      createEvent(calendarId, fields)
    );
  } else if (name === 'update_event') {
    const { calendarId, eventId, ...fields } = args;
    result = await withTimeout('update_event', TIMEOUT.FETCH, () =>
      updateEvent(calendarId, eventId, fields)
    );
  } else if (name === 'delete_event') {
    result = await withTimeout('delete_event', TIMEOUT.SINGLE, () =>
      deleteEvent(args.calendarId, args.eventId, args.dryRun || false)
    );
  } else if (name === 'search_events') {
    result = await withTimeout('search_events', TIMEOUT.FETCH, () =>
      searchEvents(args.query, args.since || null, args.before || null)
    );
  } else if (name === 'bulk_update_events') {
    result = await bulkUpdateEvents(args.calendarId, args.updates, args.dryRun || false);
  } else if (name === 'list_events_multi') {
    result = await listEventsMulti(args.calendarIds, args.since || null, args.before || null, args.limit || 50);
  } else if (name === 'bulk_create_events') {
    result = await bulkCreateEvents(args.calendarId, args.events, args.dryRun || false);
  } else if (name === 'bulk_delete_events') {
    result = await bulkDeleteEvents(args.calendarId, args.eventIds, args.dryRun || false);
  } else if (name === 'detect_conflicts') {
    result = await detectConflicts(args.calendarIds, args.since || null, args.before || null, args.minBuffer || 0);
  // ── Reminders / JXA (synchronous osascript — no timeout needed) ──
  } else if (name === 'suggest_event_from_email') {
    const creds = resolveCreds(args.account);
    const email = await withTimeout('get_email_for_extraction', TIMEOUT.FETCH, () =>
      getEmailContent(args.uid, resolveMailbox(args.mailbox || 'INBOX', creds), 10000, false, creds)
    );
    result = formatEmailForExtraction(email);
  }
  return result;
}

