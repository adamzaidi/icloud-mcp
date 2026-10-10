// ─── lib/caldav.js — iCloud CalDAV (Calendar) ────────────────────────────────
import { randomUUID } from 'crypto';

const CALDAV_HOST = 'https://caldav.icloud.com';
// Calendars to exclude from list_calendars (scheduling containers, not user calendars)
const EXCLUDED_NAMES = new Set(['inbox', 'outbox', 'notification', 'notification/']);

// ─── Credentials & HTTP ───────────────────────────────────────────────────────

function getCredentials() {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;
  if (!user || !pass) throw new Error('IMAP_USER and IMAP_PASSWORD are required');
  return { user, auth: Buffer.from(`${user}:${pass}`).toString('base64') };
}

async function defaultDavRequest(method, url, opts = {}) {
  const { auth } = getCredentials();
  const headers = {
    Authorization: `Basic ${auth}`,
    ...(opts.depth !== undefined ? { Depth: String(opts.depth) } : {}),
    ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}),
    ...(opts.etag ? { 'If-Match': opts.etag } : {}),
  };
  const res = await fetch(url, { method, headers, body: opts.body });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag'), body: text };
}

let davRequest = defaultDavRequest;

export function setCalDavRequestForTests(fn) {
  davRequest = fn || defaultDavRequest;
  _discoveryCache = null;
}

export function setCalDavDiscoveryForTests(cache) {
  _discoveryCache = cache;
}

function propfindBody(props) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<A:propfind xmlns:A="DAV:"><A:prop>${props}</A:prop></A:propfind>`;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

let _discoveryCache = null;

async function discover() {
  if (_discoveryCache) return _discoveryCache;

  // Step 1: well-known → principal
  const wk = await davRequest('PROPFIND', `${CALDAV_HOST}/.well-known/caldav`, {
    depth: 0,
    contentType: 'application/xml; charset=utf-8',
    body: propfindBody('<A:current-user-principal/>'),
  });

  let principalPath = extractHrefIn(wk.body, 'current-user-principal');
  if (!principalPath) {
    const root = await davRequest('PROPFIND', `${CALDAV_HOST}/`, {
      depth: 0,
      contentType: 'application/xml; charset=utf-8',
      body: propfindBody('<A:current-user-principal/>'),
    });
    principalPath = extractHrefIn(root.body, 'current-user-principal');
  }
  if (!principalPath) throw new Error('CalDAV: could not discover principal URL');

  // Step 2: principal → calendar-home-set
  const principalUrl = principalPath.startsWith('http')
    ? principalPath
    : `${CALDAV_HOST}${principalPath}`;

  const principalResp = await davRequest('PROPFIND', principalUrl, {
    depth: 0,
    contentType: 'application/xml; charset=utf-8',
    body: propfindBody('<C:calendar-home-set xmlns:C="urn:ietf:params:xml:ns:caldav"/>'),
  });

  const homeHref = extractHrefIn(principalResp.body, 'calendar-home-set');
  if (!homeHref) throw new Error('CalDAV: could not find calendar-home-set');

  // homeHref includes partition host (e.g. https://p137-caldav.icloud.com:443/dsid/calendars/)
  const dataHost = homeHref.startsWith('http') ? new URL(homeHref).origin : CALDAV_HOST;
  const calendarsPath = homeHref.startsWith('http')
    ? new URL(homeHref).pathname
    : homeHref;

  _discoveryCache = { dataHost, calendarsPath };
  return _discoveryCache;
}

// ─── XML helpers ──────────────────────────────────────────────────────────────

function extractHrefIn(xml, parentTag) {
  const re = new RegExp(
    `<[^>:]*:?${parentTag}[\\s\\S]*?>[\\s\\S]*?<[^>:]*:?href[^>]*>([^<]+)<\\/[^>:]*:?href>`,
    'i'
  );
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function splitResponses(xml) {
  return [...xml.matchAll(/<[^>:]*:?response[\s\S]*?<\/[^>:]*:?response>/g)].map(m => m[0]);
}

function xmlText(xml, tag) {
  const re = new RegExp(`<[^>:]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^>:]*:?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

// ─── iCal text escaping ───────────────────────────────────────────────────────
// iCal property values must not contain raw newlines — escape as \n (literal backslash-n)

function icalEscape(str) {
  if (!str) return str;
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, '\\n')
    .replace(/[\u0000-\u001F\u007F]/g, '');
}

function icalUnescape(str) {
  if (!str) return str;
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// ─── iCal date helpers ────────────────────────────────────────────────────────

function toIcalUtc(date) {
  // YYYYMMDDTHHMMSSZ
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function toIcalLocal(date) {
  // YYYYMMDDTHHMMSS (no Z, for use with TZID=...)
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parseIcalDate(val, fullKey = '') {
  if (fullKey.includes('VALUE=DATE')) {
    // YYYYMMDD → YYYY-MM-DD
    const m = val.match(/^(\d{4})(\d{2})(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : val;
  }
  // YYYYMMDDTHHMMSS[Z] → YYYY-MM-DDTHH:MM:SS[Z]
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return val;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}`;
}

// ─── iCal parsing ─────────────────────────────────────────────────────────────

function parseVEvent(ical) {
  // Unfold continuation lines
  const unfolded = ical.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  let inEvent = false;
  let subDepth = 0; // track nested components inside VEVENT (e.g. VALARM)
  const event = {};

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { inEvent = true; subDepth = 0; continue; }
    if (line === 'END:VEVENT') { inEvent = false; continue; }
    if (!inEvent) continue;
    // Skip lines inside nested sub-components (VALARM, etc.)
    if (line.startsWith('BEGIN:')) { subDepth++; continue; }
    if (line.startsWith('END:')) { subDepth--; continue; }
    if (subDepth > 0) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const fullKey = line.slice(0, colonIdx);
    const val = line.slice(colonIdx + 1);
    const key = fullKey.split(';')[0].toUpperCase();

    switch (key) {
      case 'UID': event.uid = val; break;
      case 'SUMMARY': event.summary = icalUnescape(val); break;
      case 'DESCRIPTION': event.description = icalUnescape(val); break;
      case 'LOCATION': event.location = icalUnescape(val); break;
      case 'STATUS': event.status = val; break;
      case 'RRULE': event.recurrence = val; break;
      case 'DTSTART': {
        event.start = parseIcalDate(val, fullKey);
        const tzM = fullKey.match(/TZID=([^;:]+)/);
        if (tzM) event.timezone = tzM[1];
        event.allDay = fullKey.includes('VALUE=DATE');
        break;
      }
      case 'DTEND': {
        event.end = parseIcalDate(val, fullKey);
        break;
      }
      case 'CREATED': event.created = parseIcalDate(val, fullKey); break;
      case 'LAST-MODIFIED': event.lastModified = parseIcalDate(val, fullKey); break;
      case 'ORGANIZER': event.organizer = val.replace(/^mailto:/i, ''); break;
      case 'ATTENDEE': {
        if (!event.attendees) event.attendees = [];
        const cn = fullKey.match(/CN=([^;:]+)/i)?.[1];
        const email = val.replace(/^mailto:/i, '');
        event.attendees.push(cn ? `${cn} <${email}>` : email);
        break;
      }
      case 'EXDATE': {
        if (!event.exDates) event.exDates = [];
        event.exDates.push(parseIcalDate(val, fullKey));
        break;
      }
    }
  }

  return event;
}

// ─── iCal serialization ───────────────────────────────────────────────────────

function serializeVEvent(fields, uid = null) {
  const id = icalEscape(uid || randomUUID().toUpperCase());
  const now = new Date();
  const dtstamp = toIcalUtc(now);

  const lines = [
    'BEGIN:VCALENDAR',
    'CALSCALE:GREGORIAN',
    'PRODID:-//icloud-mcp//EN',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `DTSTAMP:${dtstamp}`,
    `CREATED:${dtstamp}`,
    `UID:${id}`,
    `SUMMARY:${icalEscape(fields.summary || '(No title)')}`,
  ];

  if (fields.allDay) {
    const start = (fields.start || '').replace(/-/g, '').slice(0, 8);
    const end = (fields.end || fields.start || '').replace(/-/g, '').slice(0, 8);
    lines.push(`DTSTART;VALUE=DATE:${start}`);
    lines.push(`DTEND;VALUE=DATE:${end}`);
  } else {
    const tz = icalEscape(fields.timezone || 'UTC');
    const startDate = fields.start ? new Date(fields.start) : now;
    const endDate = fields.end ? new Date(fields.end) : new Date(startDate.getTime() + 3600_000);

    if (tz === 'UTC') {
      lines.push(`DTSTART:${toIcalUtc(startDate)}`);
      lines.push(`DTEND:${toIcalUtc(endDate)}`);
    } else {
      lines.push(`DTSTART;TZID=${tz}:${toIcalLocal(startDate)}`);
      lines.push(`DTEND;TZID=${tz}:${toIcalLocal(endDate)}`);
    }
  }

  if (fields.description) lines.push(`DESCRIPTION:${icalEscape(fields.description)}`);
  if (fields.location) lines.push(`LOCATION:${icalEscape(fields.location)}`);
  if (fields.recurrence) lines.push(`RRULE:${icalEscape(fields.recurrence)}`);
  if (fields.status) lines.push(`STATUS:${icalEscape(fields.status)}`);

  // VALARM — reminder N minutes before (default: 30 min if not specified, 0 to disable)
  const reminderMins = fields.reminder !== undefined ? Number(fields.reminder) : 30;
  if (reminderMins > 0) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      `TRIGGER:-PT${reminderMins}M`,
      'END:VALARM'
    );
  }

  lines.push('SEQUENCE:0', 'END:VEVENT', 'END:VCALENDAR');
  return { ical: lines.join('\r\n') + '\r\n', uid: id };
}

// ─── Parse REPORT response blocks ────────────────────────────────────────────

function parseEventBlocks(xml) {
  return splitResponses(xml).map(block => {
    const hrefMatch = block.match(/<[^>:]*:?href[^>]*>([^<]+)<\/[^>:]*:?href>/);
    const etagMatch = block.match(/<[^>:]*:?getetag[^>]*>"?([^"<]+)"?<\/[^>:]*:?getetag>/);

    // Extract calendar-data — may be in CDATA or as plain text
    let icalText = null;
    const cdataMatch = block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdataMatch) {
      icalText = cdataMatch[1];
    } else {
      const dataMatch = block.match(/<[^>:]*:?calendar-data[^>]*>([\s\S]*?)<\/[^>:]*:?calendar-data>/i);
      if (dataMatch) icalText = dataMatch[1];
    }

    if (!hrefMatch || !icalText) return null;

    const href = hrefMatch[1];
    const parts = href.split('/').filter(Boolean);
    const filename = parts[parts.length - 1];
    const eventId = filename.replace(/\.ics$/i, '');
    // calendarId is the UUID segment before the filename
    const calendarId = parts[parts.length - 2] || null;

    const event = parseVEvent(icalText);
    return { eventId, calendarId, etag: etagMatch?.[1] || null, href, ...event };
  }).filter(Boolean);
}

function parseCalendarBlocks(xml) {
  return splitResponses(xml).map(block => {
    const hrefMatch = block.match(/<[^>:]*:?href[^>]*>([^<]+)<\/[^>:]*:?href>/);
    if (!hrefMatch) return null;

    const href = hrefMatch[1];
    const parts = href.split('/').filter(Boolean);
    const last = parts[parts.length - 1];

    // Skip scheduling/system containers
    if (EXCLUDED_NAMES.has(last)) return null;

    // Must have resourcetype = calendar
    if (!block.includes('calendar') || !block.includes('collection')) return null;
    // Skip the home-set itself (no calendar element, just collection)
    const resourceBlock = xmlText(block, 'resourcetype') || '';
    if (!resourceBlock.includes('calendar')) return null;

    const displayName = xmlText(block, 'displayname') || last;
    const syncToken = xmlText(block, 'sync-token') || null;

    // supported component types
    const compMatches = [...block.matchAll(/comp\s+name=['"]([^'"]+)['"]/g)].map(m => m[1]);

    // calendarId is the last non-empty path segment
    const calendarId = last.replace(/\/$/, '');

    return { calendarId, name: displayName, href, supportedTypes: compMatches, syncToken };
  }).filter(Boolean);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function listCalendars() {
  const { dataHost, calendarsPath } = await discover();

  const body = propfindBody(`
    <A:resourcetype/>
    <A:displayname/>
    <A:sync-token/>
    <C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav"/>
  `);

  const resp = await davRequest('PROPFIND', `${dataHost}${calendarsPath}`, {
    depth: 1,
    contentType: 'application/xml; charset=utf-8',
    body,
  });

  const calendars = parseCalendarBlocks(resp.body);
  return { calendars, count: calendars.length };
}

// Resolve a calendar by exact name or calendarId. Refuses ambiguous names so a
// destructive call never guesses between two calendars with the same title.
async function findCalendar({ name, calendarId }) {
  if (!name && !calendarId) throw new Error('Pass a calendar name or calendarId');
  const { calendars } = await listCalendars();
  const matches = calendarId
    ? calendars.filter(c => c.calendarId === calendarId)
    : calendars.filter(c => c.name === name);
  if (matches.length === 0) throw new Error(`Calendar not found: ${calendarId || name}`);
  if (matches.length > 1) throw new Error(`More than one calendar is named "${name}"; pass its calendarId instead`);
  return matches[0];
}

// Counts every event resource in the collection, past and future, not just a date range.
async function countCalendarItems(calendarId) {
  const { dataHost, calendarsPath } = await discover();
  const resp = await davRequest('PROPFIND', `${dataHost}${calendarsPath}${calendarId}/`, {
    depth: 1,
    contentType: 'application/xml; charset=utf-8',
    body: propfindBody('<A:getetag/>'),
  });
  if (resp.status === 404) throw new Error(`Calendar not found: ${calendarId}`);
  return splitResponses(resp.body).filter(block => /\.ics</i.test(block)).length;
}

export async function createCalendar(name) {
  if (!name || !name.trim()) throw new Error('Calendar name is required');
  const { calendars } = await listCalendars();
  if (calendars.some(c => c.name === name)) throw new Error(`A calendar named "${name}" already exists`);

  const { dataHost, calendarsPath } = await discover();
  const calendarId = randomUUID().toUpperCase();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:mkcalendar xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <A:set><A:prop>
    <A:displayname>${name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</A:displayname>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
  </A:prop></A:set>
</C:mkcalendar>`;
  const resp = await davRequest('MKCALENDAR', `${dataHost}${calendarsPath}${calendarId}/`, {
    contentType: 'application/xml; charset=utf-8',
    body,
  });
  if (resp.status !== 201) throw new Error(`CalDAV MKCALENDAR failed: ${resp.status}`);
  return { created: true, calendarId, name };
}

// Deletes an empty event calendar. Refuses calendars that still hold events
// (delete those first with bulk_delete_events) and Reminders lists (VTODO).
export async function deleteCalendar({ name, calendarId }, dryRun = false) {
  const cal = await findCalendar({ name, calendarId });
  if (!cal.supportedTypes.includes('VEVENT')) {
    throw new Error(`"${cal.name}" is not an event calendar; use delete_reminder_list for Reminders lists`);
  }
  const eventCount = await countCalendarItems(cal.calendarId);
  if (dryRun) {
    return {
      dryRun: true,
      wouldDelete: eventCount === 0,
      eventCount,
      changes: [{ action: 'delete_calendar', calendarId: cal.calendarId, name: cal.name, eventCount }],
    };
  }
  if (eventCount > 0) {
    throw new Error(`Calendar "${cal.name}" still has ${eventCount} event(s); delete them first`);
  }
  const { dataHost, calendarsPath } = await discover();
  const resp = await davRequest('DELETE', `${dataHost}${calendarsPath}${cal.calendarId}/`);
  if (resp.status !== 204 && resp.status !== 200) throw new Error(`CalDAV DELETE failed: ${resp.status}`);
  return { deleted: true, calendarId: cal.calendarId, name: cal.name };
}

export async function listEvents(calendarId, since = null, before = null, limit = 50) {
  const { dataHost, calendarsPath } = await discover();

  const sinceDate = since ? new Date(since) : new Date(Date.now() - 30 * 86400_000);
  const beforeDate = before ? new Date(before) : new Date(Date.now() + 30 * 86400_000);

  const start = toIcalUtc(sinceDate);
  const end = toIcalUtc(beforeDate);

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="DAV:">
  <A:prop><A:getetag/><C:calendar-data/></A:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${start}" end="${end}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const url = `${dataHost}${calendarsPath}${calendarId}/`;
  const resp = await davRequest('REPORT', url, {
    depth: 1,
    contentType: 'application/xml; charset=utf-8',
    body,
  });

  if (resp.status === 403 || resp.status === 404) {
    throw new Error(`Calendar not found or access denied: ${calendarId} (${resp.status})`);
  }

  const events = parseEventBlocks(resp.body).slice(0, limit);
  return { events, count: events.length, calendarId, since: sinceDate.toISOString(), before: beforeDate.toISOString() };
}

export async function getEvent(calendarId, eventId) {
  const { dataHost, calendarsPath } = await discover();
  const url = `${dataHost}${calendarsPath}${calendarId}/${eventId}.ics`;
  const resp = await davRequest('GET', url);

  if (resp.status === 404) throw new Error(`Event not found: ${calendarId}/${eventId}`);
  if (resp.status >= 400) throw new Error(`CalDAV GET failed: ${resp.status}`);

  const event = parseVEvent(resp.body);
  return { eventId, calendarId, etag: resp.etag, ...event };
}

export async function createEvent(calendarId, fields) {
  const { dataHost, calendarsPath } = await discover();
  const { ical, uid } = serializeVEvent(fields);
  const eventId = uid;
  const url = `${dataHost}${calendarsPath}${calendarId}/${eventId}.ics`;

  const resp = await davRequest('PUT', url, {
    contentType: 'text/calendar; charset=utf-8',
    body: ical,
  });

  if (resp.status !== 201 && resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CalDAV PUT failed: ${resp.status} — ${resp.body.slice(0, 200)}`);
  }

  return { created: true, eventId, calendarId, etag: resp.etag };
}

export async function updateEvent(calendarId, eventId, fields) {
  const { dataHost, calendarsPath } = await discover();
  const url = `${dataHost}${calendarsPath}${calendarId}/${eventId}.ics`;

  // Fetch current to get etag and existing fields
  const existing = await davRequest('GET', url);
  if (existing.status === 404) throw new Error(`Event not found: ${calendarId}/${eventId}`);

  const current = parseVEvent(existing.body);
  const merged = { ...current, ...fields };
  const { ical } = serializeVEvent(merged, eventId);

  const resp = await davRequest('PUT', url, {
    contentType: 'text/calendar; charset=utf-8',
    etag: existing.etag,
    body: ical,
  });

  if (resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CalDAV PUT (update) failed: ${resp.status} — ${resp.body.slice(0, 200)}`);
  }

  return { updated: true, eventId, calendarId, etag: resp.etag };
}

export async function deleteEvent(calendarId, eventId, dryRun = false) {
  if (dryRun) {
    const event = await getEvent(calendarId, eventId);
    return {
      dryRun: true,
      wouldDelete: true,
      calendarId,
      eventId,
      changes: [{
        action: 'delete_event',
        calendarId,
        eventId,
        summary: event.summary ?? null,
        start: event.start ?? null,
        end: event.end ?? null,
      }],
    };
  }
  const { dataHost, calendarsPath } = await discover();
  const url = `${dataHost}${calendarsPath}${calendarId}/${eventId}.ics`;

  const resp = await davRequest('DELETE', url);
  if (resp.status === 404) throw new Error(`Event not found: ${calendarId}/${eventId}`);
  if (resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CalDAV DELETE failed: ${resp.status}`);
  }

  return { deleted: true, eventId, calendarId };
}

// ─── Bulk operations ──────────────────────────────────────────────────────────

export async function bulkUpdateEvents(calendarId, updates, dryRun = false) {
  if (dryRun) {
    const changes = [];
    const missing = [];
    for (let i = 0; i < updates.length; i++) {
      const { eventId, ...fields } = updates[i];
      try {
        const current = await getEvent(calendarId, eventId);
        changes.push({
          action: 'update_event',
          index: i,
          calendarId,
          eventId,
          summary: current.summary ?? null,
          fields,
        });
      } catch (err) {
        missing.push({ index: i, eventId, error: err.message });
      }
    }
    return {
      dryRun: true,
      wouldUpdate: changes.length,
      calendarId,
      changes,
      ...(missing.length > 0 ? { missing } : {}),
    };
  }
  const { dataHost, calendarsPath } = await discover();
  let updated = 0;
  const failed = [];

  for (let i = 0; i < updates.length; i++) {
    const { eventId, ...fields } = updates[i];
    try {
      const url = `${dataHost}${calendarsPath}${calendarId}/${eventId}.ics`;
      const existing = await davRequest('GET', url);
      if (existing.status === 404) {
        failed.push({ index: i, eventId, error: 'not found' });
        continue;
      }
      const current = parseVEvent(existing.body);
      const merged = { ...current, ...fields };
      const { ical } = serializeVEvent(merged, eventId);
      const resp = await davRequest('PUT', url, {
        contentType: 'text/calendar; charset=utf-8',
        etag: existing.etag,
        body: ical,
      });
      if (resp.status !== 204 && resp.status !== 200) {
        failed.push({ index: i, eventId, error: `HTTP ${resp.status}` });
      } else {
        updated++;
      }
    } catch (err) {
      failed.push({ index: i, eventId, error: err.message });
    }
  }

  return { updated, failed: failed.length, total: updates.length, calendarId, ...(failed.length > 0 ? { errors: failed } : {}) };
}

export async function listEventsMulti(calendarIds, since = null, before = null, limit = 50) {
  const results = {};
  let totalCount = 0;

  for (const calendarId of calendarIds) {
    try {
      const data = await listEvents(calendarId, since, before, limit);
      results[calendarId] = data.events;
      totalCount += data.count;
    } catch (err) {
      results[calendarId] = { error: err.message };
    }
  }

  return { calendars: results, totalCount };
}

export async function bulkCreateEvents(calendarId, events, dryRun = false) {
  if (dryRun) {
    return {
      dryRun: true,
      wouldCreate: events.length,
      calendarId,
      changes: events.map((event, index) => ({
        action: 'create_event',
        index,
        calendarId,
        summary: event.summary,
        start: event.start,
        end: event.end ?? null,
        allDay: !!event.allDay,
      })),
    };
  }
  const { dataHost, calendarsPath } = await discover();
  let created = 0;
  const failed = [];

  for (let i = 0; i < events.length; i++) {
    try {
      const { ical, uid } = serializeVEvent(events[i]);
      const url = `${dataHost}${calendarsPath}${calendarId}/${uid}.ics`;
      const resp = await davRequest('PUT', url, {
        contentType: 'text/calendar; charset=utf-8',
        body: ical,
      });
      if (resp.status !== 201 && resp.status !== 204 && resp.status !== 200) {
        failed.push({ index: i, summary: events[i].summary, error: `HTTP ${resp.status}` });
      } else {
        created++;
      }
    } catch (err) {
      failed.push({ index: i, summary: events[i].summary, error: err.message });
    }
  }

  return { created, failed: failed.length, total: events.length, calendarId, ...(failed.length > 0 ? { errors: failed } : {}) };
}

export async function bulkDeleteEvents(calendarId, eventIds, dryRun = false) {
  if (dryRun) {
    const changes = [];
    const missing = [];
    for (const eventId of eventIds) {
      try {
        const event = await getEvent(calendarId, eventId);
        changes.push({
          action: 'delete_event',
          calendarId,
          eventId,
          summary: event.summary ?? null,
          start: event.start ?? null,
          end: event.end ?? null,
        });
      } catch (err) {
        missing.push({ eventId, error: err.message });
      }
    }
    return {
      dryRun: true,
      wouldDelete: changes.length,
      calendarId,
      changes,
      ...(missing.length > 0 ? { missing } : {}),
    };
  }
  const { dataHost, calendarsPath } = await discover();
  let deleted = 0;
  const failed = [];

  for (let i = 0; i < eventIds.length; i++) {
    try {
      const url = `${dataHost}${calendarsPath}${calendarId}/${eventIds[i]}.ics`;
      const resp = await davRequest('DELETE', url);
      if (resp.status === 404) {
        failed.push({ eventId: eventIds[i], error: 'not found' });
      } else if (resp.status !== 204 && resp.status !== 200) {
        failed.push({ eventId: eventIds[i], error: `HTTP ${resp.status}` });
      } else {
        deleted++;
      }
    } catch (err) {
      failed.push({ eventId: eventIds[i], error: err.message });
    }
  }

  return { deleted, failed: failed.length, total: eventIds.length, calendarId, ...(failed.length > 0 ? { errors: failed } : {}) };
}

export async function detectConflicts(calendarIds, since = null, before = null, minBuffer = 0) {
  const sinceStr = since || new Date().toISOString().slice(0, 10);
  const beforeStr = before || new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);

  // Fetch all events from all calendars
  const allEvents = [];
  for (const calendarId of calendarIds) {
    try {
      const data = await listEvents(calendarId, sinceStr, beforeStr, 200);
      for (const ev of data.events) {
        if (ev.allDay) continue; // skip all-day events
        allEvents.push({ ...ev, calendarId });
      }
    } catch (err) {
      // skip calendars that fail
    }
  }

  // Group by date
  const byDate = {};
  for (const ev of allEvents) {
    const date = ev.start.slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(ev);
  }

  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const conflicts = [];
  const tightGaps = [];

  for (const [date, events] of Object.entries(byDate)) {
    if (events.length < 2) continue;
    // Sort by start time
    events.sort((a, b) => a.start.localeCompare(b.start));

    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const a = events[i];
        const b = events[j];
        // Same calendar events aren't conflicts we care about
        if (a.calendarId === b.calendarId) continue;

        const aStart = toMin(a.start.slice(11, 16));
        const aEnd = toMin(a.end.slice(11, 16));
        const bStart = toMin(b.start.slice(11, 16));
        const bEnd = toMin(b.end.slice(11, 16));

        if (aStart < bEnd && bStart < aEnd) {
          conflicts.push({
            date,
            event1: { summary: a.summary, start: a.start.slice(11, 16), end: a.end.slice(11, 16), calendarId: a.calendarId },
            event2: { summary: b.summary, start: b.start.slice(11, 16), end: b.end.slice(11, 16), calendarId: b.calendarId },
          });
        } else if (minBuffer > 0) {
          // Check gap between a.end and b.start (b starts after a)
          const gap = bStart - aEnd;
          if (gap > 0 && gap < minBuffer) {
            tightGaps.push({
              date,
              gapMinutes: gap,
              event1: { summary: a.summary, start: a.start.slice(11, 16), end: a.end.slice(11, 16), calendarId: a.calendarId },
              event2: { summary: b.summary, start: b.start.slice(11, 16), end: b.end.slice(11, 16), calendarId: b.calendarId },
            });
          }
          // Also check gap between b.end and a.start (a starts after b) — shouldn't happen since sorted, but safe
          const gap2 = aStart - bEnd;
          if (gap2 > 0 && gap2 < minBuffer) {
            tightGaps.push({
              date,
              gapMinutes: gap2,
              event1: { summary: b.summary, start: b.start.slice(11, 16), end: b.end.slice(11, 16), calendarId: b.calendarId },
              event2: { summary: a.summary, start: a.start.slice(11, 16), end: a.end.slice(11, 16), calendarId: a.calendarId },
            });
          }
        }
      }
    }
  }

  conflicts.sort((a, b) => a.date.localeCompare(b.date));
  tightGaps.sort((a, b) => a.date.localeCompare(b.date));

  return {
    conflicts,
    tightGaps: minBuffer > 0 ? tightGaps : undefined,
    conflictCount: conflicts.length,
    tightGapCount: minBuffer > 0 ? tightGaps.length : undefined,
    range: { since: sinceStr, before: beforeStr },
    calendarsChecked: calendarIds.length,
  };
}

// ─── VTODO (Reminders) ────────────────────────────────────────────────────────

const PRIORITY_TO_ICAL = { high: '1', medium: '5', low: '9', none: '0' };
const PRIORITY_FROM_ICAL = { '1': 'high', '2': 'high', '3': 'high', '4': 'high', '5': 'medium', '6': 'low', '7': 'low', '8': 'low', '9': 'low', '0': 'none' };

function parseVTodo(ical) {
  const unfolded = ical.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  let inTodo = false;
  let subDepth = 0;
  const todo = {};

  for (const line of lines) {
    if (line === 'BEGIN:VTODO') { inTodo = true; subDepth = 0; continue; }
    if (line === 'END:VTODO') { inTodo = false; continue; }
    if (!inTodo) continue;
    if (line.startsWith('BEGIN:')) { subDepth++; continue; }
    if (line.startsWith('END:')) { subDepth--; continue; }
    if (subDepth > 0) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const fullKey = line.slice(0, colonIdx);
    const val = line.slice(colonIdx + 1);
    const key = fullKey.split(';')[0].toUpperCase();

    switch (key) {
      case 'UID': todo.uid = val; break;
      case 'SUMMARY': todo.title = icalUnescape(val); break;
      case 'DESCRIPTION': todo.notes = icalUnescape(val); break;
      case 'STATUS': todo.status = val; break;
      case 'PRIORITY': todo.priority = PRIORITY_FROM_ICAL[val] || 'none'; break;
      case 'DUE': {
        todo.due = parseIcalDate(val, fullKey);
        todo.allDay = fullKey.includes('VALUE=DATE');
        const tzM = fullKey.match(/TZID=([^;:]+)/);
        if (tzM) todo.timezone = tzM[1];
        break;
      }
      case 'COMPLETED': todo.completedAt = parseIcalDate(val, fullKey); break;
      case 'CREATED': todo.created = parseIcalDate(val, fullKey); break;
      case 'LAST-MODIFIED': todo.lastModified = parseIcalDate(val, fullKey); break;
      case 'PERCENT-COMPLETE': todo.percentComplete = parseInt(val, 10); break;
    }
  }

  todo.completed = todo.status === 'COMPLETED';
  return todo;
}

function serializeVTodo(fields, uid = null) {
  const id = icalEscape(uid || randomUUID().toUpperCase());
  const now = new Date();
  const dtstamp = toIcalUtc(now);

  const lines = [
    'BEGIN:VCALENDAR',
    'CALSCALE:GREGORIAN',
    'PRODID:-//icloud-mcp//EN',
    'VERSION:2.0',
    'BEGIN:VTODO',
    `DTSTAMP:${dtstamp}`,
    `CREATED:${dtstamp}`,
    `UID:${id}`,
    `SUMMARY:${icalEscape(fields.title || '(No title)')}`,
    `STATUS:${icalEscape(fields.completed ? 'COMPLETED' : (fields.status || 'NEEDS-ACTION'))}`,
  ];

  if (fields.notes) lines.push(`DESCRIPTION:${icalEscape(fields.notes)}`);

  const priority = PRIORITY_TO_ICAL[fields.priority] || '0';
  if (priority !== '0') lines.push(`PRIORITY:${priority}`);

  if (fields.due) {
    if (fields.allDay) {
      const dateStr = fields.due.replace(/-/g, '').slice(0, 8);
      lines.push(`DUE;VALUE=DATE:${dateStr}`);
    } else {
      const tz = fields.timezone || 'America/New_York';
      const dueDate = new Date(fields.due);
      if (tz === 'UTC') {
        lines.push(`DUE:${toIcalUtc(dueDate)}`);
      } else {
        lines.push(`DUE;TZID=${tz}:${toIcalLocal(dueDate)}`);
      }
    }
  }

  if (fields.completed || fields.status === 'COMPLETED') {
    const completedAt = fields.completedAt ? new Date(fields.completedAt) : now;
    lines.push(`COMPLETED:${toIcalUtc(completedAt)}`);
    lines.push('PERCENT-COMPLETE:100');
  }

  lines.push('SEQUENCE:0', 'END:VTODO', 'END:VCALENDAR');
  return { ical: lines.join('\r\n') + '\r\n', uid: id };
}

function parseReminderBlocks(xml) {
  return splitResponses(xml).map(block => {
    const hrefMatch = block.match(/<[^>:]*:?href[^>]*>([^<]+)<\/[^>:]*:?href>/);
    const etagMatch = block.match(/<[^>:]*:?getetag[^>]*>"?([^"<]+)"?<\/[^>:]*:?getetag>/);

    let icalText = null;
    const cdataMatch = block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdataMatch) {
      icalText = cdataMatch[1];
    } else {
      const dataMatch = block.match(/<[^>:]*:?calendar-data[^>]*>([\s\S]*?)<\/[^>:]*:?calendar-data>/i);
      if (dataMatch) icalText = dataMatch[1];
    }

    if (!hrefMatch || !icalText) return null;

    const href = hrefMatch[1];
    const parts = href.split('/').filter(Boolean);
    const filename = parts[parts.length - 1];
    const reminderId = filename.replace(/\.ics$/i, '');
    const calendarId = parts[parts.length - 2] || null;

    const todo = parseVTodo(icalText);
    return { reminderId, calendarId, etag: etagMatch?.[1] || null, href, ...todo };
  }).filter(Boolean);
}

export async function listReminderLists() {
  const cals = await listCalendars();
  const lists = cals.calendars.filter(c => c.supportedTypes.includes('VTODO'));
  return { lists, count: lists.length };
}

export async function listReminders(calendarId = null, includeCompleted = false, limit = 50) {
  const { dataHost, calendarsPath } = await discover();

  if (!calendarId) {
    const { lists } = await listReminderLists();
    if (!lists.length) throw new Error('No Reminders lists found');
    calendarId = lists[0].calendarId;
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="DAV:">
  <A:prop><A:getetag/><C:calendar-data/></A:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VTODO"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const url = `${dataHost}${calendarsPath}${calendarId}/`;
  const resp = await davRequest('REPORT', url, {
    depth: 1,
    contentType: 'application/xml; charset=utf-8',
    body,
  });

  if (resp.status === 403 || resp.status === 404) {
    throw new Error(`Reminders list not found or access denied: ${calendarId} (${resp.status})`);
  }

  let reminders = parseReminderBlocks(resp.body);
  if (!includeCompleted) reminders = reminders.filter(r => !r.completed);
  reminders = reminders.slice(0, limit);

  return { reminders, count: reminders.length, calendarId, includeCompleted };
}

export async function getReminder(calendarId, reminderId) {
  const { dataHost, calendarsPath } = await discover();
  const url = `${dataHost}${calendarsPath}${calendarId}/${reminderId}.ics`;
  const resp = await davRequest('GET', url);

  if (resp.status === 404) throw new Error(`Reminder not found: ${calendarId}/${reminderId}`);
  if (resp.status >= 400) throw new Error(`CalDAV GET failed: ${resp.status}`);

  const todo = parseVTodo(resp.body);
  return { reminderId, calendarId, etag: resp.etag, ...todo };
}

export async function createReminder(calendarId, fields) {
  const { dataHost, calendarsPath } = await discover();

  if (!calendarId) {
    const { lists } = await listReminderLists();
    if (!lists.length) throw new Error('No Reminders lists found');
    calendarId = lists[0].calendarId;
  }

  const { ical, uid } = serializeVTodo(fields);
  const reminderId = uid;
  const url = `${dataHost}${calendarsPath}${calendarId}/${reminderId}.ics`;

  const resp = await davRequest('PUT', url, {
    contentType: 'text/calendar; charset=utf-8',
    body: ical,
  });

  if (resp.status !== 201 && resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CalDAV PUT failed: ${resp.status} — ${resp.body.slice(0, 200)}`);
  }

  return { created: true, reminderId, calendarId, etag: resp.etag };
}

export async function updateReminder(calendarId, reminderId, fields) {
  const { dataHost, calendarsPath } = await discover();
  const url = `${dataHost}${calendarsPath}${calendarId}/${reminderId}.ics`;

  const existing = await davRequest('GET', url);
  if (existing.status === 404) throw new Error(`Reminder not found: ${calendarId}/${reminderId}`);

  const current = parseVTodo(existing.body);
  const merged = { ...current, ...fields };
  const { ical } = serializeVTodo(merged, reminderId);

  const resp = await davRequest('PUT', url, {
    contentType: 'text/calendar; charset=utf-8',
    etag: existing.etag,
    body: ical,
  });

  if (resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CalDAV PUT (update) failed: ${resp.status} — ${resp.body.slice(0, 200)}`);
  }

  return { updated: true, reminderId, calendarId, etag: resp.etag };
}

export async function completeReminder(calendarId, reminderId) {
  return updateReminder(calendarId, reminderId, {
    completed: true,
    status: 'COMPLETED',
    completedAt: new Date().toISOString(),
  });
}

export async function deleteReminder(calendarId, reminderId) {
  const { dataHost, calendarsPath } = await discover();
  const url = `${dataHost}${calendarsPath}${calendarId}/${reminderId}.ics`;

  const resp = await davRequest('DELETE', url);
  if (resp.status === 404) throw new Error(`Reminder not found: ${calendarId}/${reminderId}`);
  if (resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CalDAV DELETE failed: ${resp.status}`);
  }

  return { deleted: true, reminderId, calendarId };
}

export async function searchEvents(query, since = null, before = null) {
  const { dataHost, calendarsPath } = await discover();

  const sinceDate = since ? new Date(since) : new Date(Date.now() - 365 * 86400_000);
  const beforeDate = before ? new Date(before) : new Date(Date.now() + 365 * 86400_000);
  const start = toIcalUtc(sinceDate);
  const end = toIcalUtc(beforeDate);

  // First list all calendars to search across all of them
  const cals = await listCalendars();
  const veventCals = cals.calendars.filter(c => c.supportedTypes.includes('VEVENT'));

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="DAV:">
  <A:prop><A:getetag/><C:calendar-data/></A:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${start}" end="${end}"/>
        <C:prop-filter name="SUMMARY">
          <C:text-match collation="i;unicode-casemap" match-type="contains">${query}</C:text-match>
        </C:prop-filter>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const results = await Promise.allSettled(
    veventCals.map(cal =>
      davRequest('REPORT', `${dataHost}${calendarsPath}${cal.calendarId}/`, {
        depth: 1,
        contentType: 'application/xml; charset=utf-8',
        body,
      })
    )
  );

  const events = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.status === 207) {
      events.push(...parseEventBlocks(r.value.body));
    }
  }

  return { events, count: events.length, query };
}
