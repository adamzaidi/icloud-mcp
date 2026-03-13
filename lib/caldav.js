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

async function davRequest(method, url, opts = {}) {
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
  return str
    .replace(/\\/g, '\\\\')   // backslash → \\
    .replace(/\n/g, '\\n')    // newline → \n (literal)
    .replace(/\r/g, '');      // strip carriage returns
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
  const event = {};

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { inEvent = true; continue; }
    if (line === 'END:VEVENT') { inEvent = false; continue; }
    if (!inEvent) continue;

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
  const id = uid || randomUUID().toUpperCase();
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
    const tz = fields.timezone || 'UTC';
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
  if (fields.recurrence) lines.push(`RRULE:${fields.recurrence}`);
  if (fields.status) lines.push(`STATUS:${fields.status}`);

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

export async function deleteEvent(calendarId, eventId) {
  const { dataHost, calendarsPath } = await discover();
  const url = `${dataHost}${calendarsPath}${calendarId}/${eventId}.ics`;

  const resp = await davRequest('DELETE', url);
  if (resp.status === 404) throw new Error(`Event not found: ${calendarId}/${eventId}`);
  if (resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CalDAV DELETE failed: ${resp.status}`);
  }

  return { deleted: true, eventId, calendarId };
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
