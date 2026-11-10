// update_event edits an event in place, calendar times keep their zone, and
// search text is escaped before it goes into a request body.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.IMAP_USER = 'you@icloud.com';
process.env.IMAP_PASSWORD = 'fake-app-password';

const {
  patchEventIcal, createEvent, updateEvent, getEvent, searchEvents, bulkUpdateEvents,
  setCalDavRequestForTests, setCalDavDiscoveryForTests,
} = await import('../../lib/caldav.js');
const { searchContacts, setCardDavRequestForTests, setCardDavDiscoveryForTests } = await import('../../lib/carddav.js');

const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// A weekly series with attendees, a deleted occurrence, two alarms, a folded
// description, an Apple map pin, a custom property, and one edited occurrence.
const SERIES = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//macOS 15.0//EN',
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:STANDARD',
  'DTSTART:20071104T020000',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:SERIES-1',
  'DTSTAMP:20260101T000000Z',
  'CREATED:20251201T120000Z',
  'SUMMARY:Weekly sync',
  'DTSTART;TZID=America/New_York:20260105T100000',
  'DTEND;TZID=America/New_York:20260105T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'EXDATE;TZID=America/New_York:20260112T100000',
  'ORGANIZER;CN=Fixture Owner:mailto:owner@example.com',
  'ATTENDEE;CN=Fixture Guest;PARTSTAT=ACCEPTED:mailto:guest@example.com',
  'DESCRIPTION:Agenda line one that is long enough to be folded by the serve',
  ' r onto a second physical line',
  'LOCATION:Old Room',
  'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Old Room:geo:1.0,2.0',
  'X-CUSTOM-FLAG:keep-me',
  'SEQUENCE:4',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder',
  'TRIGGER:-PT10M',
  'END:VALARM',
  'BEGIN:VALARM',
  'ACTION:AUDIO',
  'TRIGGER:-PT2H',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:SERIES-1',
  'RECURRENCE-ID;TZID=America/New_York:20260119T100000',
  'SUMMARY:Weekly sync (moved)',
  'DTSTART;TZID=America/New_York:20260119T150000',
  'DTEND;TZID=America/New_York:20260119T153000',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

function linesOf(ical) {
  return ical.split('\r\n');
}

function mockEvent(body = SERIES) {
  const calls = [];
  setCalDavRequestForTests(async (method, url, opts = {}) => {
    calls.push({ method, url, ...opts });
    if (method === 'GET') return { status: 200, etag: '"etag-1"', body };
    if (method === 'PUT') return { status: 204, etag: '"etag-2"', body: '' };
    return { status: 207, etag: null, body: '<multistatus xmlns="DAV:"></multistatus>' };
  });
  setCalDavDiscoveryForTests({ dataHost: 'https://cal.example.test', calendarsPath: '/calendars/' });
  return calls;
}

function restore() {
  setCalDavRequestForTests(null);
  setCalDavDiscoveryForTests(null);
  setCardDavRequestForTests(null);
  setCardDavDiscoveryForTests(null);
}

test('update_event changes only the requested field and keeps everything else', async () => {
  const calls = mockEvent();
  try {
    await updateEvent('cal-1', 'SERIES-1', { location: 'New Room' });
  } finally { restore(); }
  const put = calls.find((call) => call.method === 'PUT');
  assert.equal(put.etag, '"etag-1"');
  const out = linesOf(put.body);

  assert.ok(out.includes('LOCATION:New Room'));
  assert.ok(!out.includes('LOCATION:Old Room'));
  // The map pin belonged to the old location.
  assert.ok(!out.some((line) => line.startsWith('X-APPLE-STRUCTURED-LOCATION')));

  for (const kept of [
    'ORGANIZER;CN=Fixture Owner:mailto:owner@example.com',
    'ATTENDEE;CN=Fixture Guest;PARTSTAT=ACCEPTED:mailto:guest@example.com',
    'EXDATE;TZID=America/New_York:20260112T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO',
    'X-CUSTOM-FLAG:keep-me',
    'CREATED:20251201T120000Z',
    'DTSTART;TZID=America/New_York:20260105T100000',
    'DTEND;TZID=America/New_York:20260105T103000',
    'TRIGGER:-PT10M',
    'TRIGGER:-PT2H',
    'TZID:America/New_York',
    // The folded description is written back byte for byte.
    'DESCRIPTION:Agenda line one that is long enough to be folded by the serve',
    ' r onto a second physical line',
    // The edited occurrence is untouched.
    'RECURRENCE-ID;TZID=America/New_York:20260119T100000',
    'SUMMARY:Weekly sync (moved)',
    'DTSTART;TZID=America/New_York:20260119T150000',
    'SUMMARY:Weekly sync',
  ]) {
    assert.ok(out.includes(kept), `lost: ${kept}`);
  }
  assert.equal(out.filter((line) => line === 'BEGIN:VALARM').length, 2);
  assert.equal(out.filter((line) => line === 'BEGIN:VEVENT').length, 2);
  assert.ok(out.includes('SEQUENCE:5'));
  assert.equal(out.filter((line) => line.startsWith('SEQUENCE:')).length, 1);
  assert.ok(out.some((line) => /^LAST-MODIFIED:\d{8}T\d{6}Z$/.test(line)));
  assert.ok(put.body.endsWith('END:VCALENDAR\r\n'));
});

test('reading a series reports the master, not the edited occurrence', async () => {
  mockEvent();
  try {
    const event = await getEvent('cal-1', 'SERIES-1');
    assert.equal(event.summary, 'Weekly sync');
    assert.equal(event.start, '2026-01-05T10:00:00');
    assert.equal(event.recurrenceId, undefined);
    assert.equal(event.recurrence, 'FREQ=WEEKLY;BYDAY=MO');
  } finally { restore(); }
});

test('alarms change only when reminder is passed', () => {
  const untouched = linesOf(patchEventIcal(SERIES, { summary: 'Renamed' }));
  assert.equal(untouched.filter((line) => line === 'BEGIN:VALARM').length, 2);
  assert.ok(untouched.includes('SUMMARY:Renamed'));

  const replaced = linesOf(patchEventIcal(SERIES, { reminder: 45 }));
  assert.equal(replaced.filter((line) => line === 'BEGIN:VALARM').length, 1);
  assert.ok(replaced.includes('TRIGGER:-PT45M'));
  // The alarm stays inside the master event.
  assert.ok(replaced.indexOf('TRIGGER:-PT45M') < replaced.indexOf('RECURRENCE-ID;TZID=America/New_York:20260119T100000'));

  const removed = linesOf(patchEventIcal(SERIES, { reminder: 0 }));
  assert.equal(removed.filter((line) => line === 'BEGIN:VALARM').length, 0);
  assert.throws(() => patchEventIcal(SERIES, { reminder: 'soon' }), /reminder must be/);
});

test('a new start keeps the event length and its zone', () => {
  const moved = linesOf(patchEventIcal(SERIES, { start: '2026-01-05T14:00:00' }));
  assert.ok(moved.includes('DTSTART;TZID=America/New_York:20260105T140000'));
  assert.ok(moved.includes('DTEND;TZID=America/New_York:20260105T143000'));
  // Master, edited occurrence, and the VTIMEZONE rule: none duplicated.
  assert.equal(moved.filter((line) => line.startsWith('DTSTART')).length, 3);

  // An instant is converted into the event's zone, not this machine's.
  const fromUtc = linesOf(patchEventIcal(SERIES, { start: '2026-01-05T19:00:00Z' }));
  assert.ok(fromUtc.includes('DTSTART;TZID=America/New_York:20260105T140000'));

  const rezoned = linesOf(patchEventIcal(SERIES, { start: '2026-01-05T09:00:00', end: '2026-01-05T09:45:00', timezone: 'America/Los_Angeles' }));
  assert.ok(rezoned.includes('DTSTART;TZID=America/Los_Angeles:20260105T090000'));
  assert.ok(rezoned.includes('DTEND;TZID=America/Los_Angeles:20260105T094500'));

  const allDay = linesOf(patchEventIcal(SERIES, { allDay: true, start: '2026-01-05' }));
  assert.ok(allDay.includes('DTSTART;VALUE=DATE:20260105'));
  assert.ok(allDay.includes('DTEND;VALUE=DATE:20260106'));
});

test('clearing a field removes it; text cannot add a line', () => {
  const cleared = linesOf(patchEventIcal(SERIES, { location: '', recurrence: '' }));
  assert.ok(!cleared.some((line) => line.startsWith('LOCATION')));
  assert.ok(!cleared.some((line) => line.startsWith('RRULE')));

  const hostile = patchEventIcal(SERIES, { description: 'Notes\r\nATTENDEE:mailto:evil@example.com' });
  assert.equal(linesOf(hostile).filter((line) => line.startsWith('ATTENDEE')).length, 1);
  assert.throws(() => patchEventIcal(SERIES, { start: '2026-01-05T10:00:00', timezone: 'UTC\r\nATTENDEE:mailto:evil@example.com' }), /Unknown timezone/);
  assert.throws(() => patchEventIcal(SERIES, { start: 'next tuesday-ish' }), /Invalid start/);
});

test('a conflicting change on the server is reported, not overwritten', async () => {
  setCalDavRequestForTests(async (method) => (method === 'GET'
    ? { status: 200, etag: '"etag-1"', body: SERIES }
    : { status: 412, etag: null, body: '' }));
  setCalDavDiscoveryForTests({ dataHost: 'https://cal.example.test', calendarsPath: '/calendars/' });
  try {
    await assert.rejects(updateEvent('cal-1', 'SERIES-1', { summary: 'X' }), /changed on the server/);
    const bulk = await bulkUpdateEvents('cal-1', [{ eventId: 'SERIES-1', summary: 'X' }]);
    assert.equal(bulk.updated, 0);
    assert.match(bulk.errors[0].error, /changed on the server/);
  } finally { restore(); }
});

test('create_event writes times in the requested zone', async () => {
  const calls = mockEvent();
  try {
    // Wall time as typed, in the named zone.
    await createEvent('cal-1', { summary: 'A', start: '2026-07-01T09:00:00', timezone: 'America/Los_Angeles' });
    // An instant is converted into the named zone (09:00 PDT = 16:00Z).
    await createEvent('cal-1', { summary: 'B', start: '2026-07-01T16:00:00Z', end: '2026-07-01T17:30:00Z', timezone: 'America/Los_Angeles' });
    // An instant with no zone stays in UTC.
    await createEvent('cal-1', { summary: 'C', start: '2026-07-01T16:00:00Z' });
    // Plain local time with no zone is stored with this machine's zone so a
    // repeating event does not shift at a daylight-saving change.
    await createEvent('cal-1', { summary: 'D', start: '2026-07-01T09:00:00', recurrence: 'FREQ=WEEKLY' });
    await assert.rejects(createEvent('cal-1', { summary: 'E', start: 'not a date' }), /Invalid start/);
    await assert.rejects(createEvent('cal-1', { summary: 'F', start: '2026-07-01T09:00:00', timezone: 'Mars/Olympus' }), /Unknown timezone/);
  } finally { restore(); }
  const bodies = calls.filter((call) => call.method === 'PUT').map((call) => linesOf(call.body));
  assert.equal(bodies.length, 4);
  assert.ok(bodies[0].includes('DTSTART;TZID=America/Los_Angeles:20260701T090000'));
  assert.ok(bodies[0].includes('DTEND;TZID=America/Los_Angeles:20260701T100000'));
  assert.ok(bodies[1].includes('DTSTART;TZID=America/Los_Angeles:20260701T090000'));
  assert.ok(bodies[1].includes('DTEND;TZID=America/Los_Angeles:20260701T103000'));
  assert.ok(bodies[2].includes('DTSTART:20260701T160000Z'));
  assert.ok(bodies[2].includes('DTEND:20260701T170000Z'));
  const expected = SYSTEM_TZ === 'UTC' ? 'DTSTART:20260701T090000Z' : `DTSTART;TZID=${SYSTEM_TZ}:20260701T090000`;
  assert.ok(bodies[3].includes(expected), bodies[3].find((line) => line.startsWith('DTSTART')));
});

test('search text is escaped inside the request body', async () => {
  const calendarHome = '<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/calendars/cal-1/</href><propstat><prop>' +
    '<resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname>Personal</displayname>' +
    '<supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VEVENT"/></supported-calendar-component-set>' +
    '</prop></propstat></response></multistatus>';
  const bodies = [];
  setCalDavRequestForTests(async (method, url, opts = {}) => {
    if (method === 'PROPFIND') return { status: 207, body: calendarHome };
    bodies.push(opts.body);
    return { status: 207, body: '<multistatus xmlns="DAV:"></multistatus>' };
  });
  setCalDavDiscoveryForTests({ dataHost: 'https://cal.example.test', calendarsPath: '/calendars/' });
  setCardDavRequestForTests(async (_method, _url, opts = {}) => {
    bodies.push(opts.body);
    return { status: 207, body: '<multistatus xmlns="DAV:"></multistatus>' };
  });
  setCardDavDiscoveryForTests({ dataHost: 'https://card.example.test', homeSetPath: '/home/', addressBookPath: '/home/card/' });
  try {
    await searchEvents('R&D </C:text-match><x>');
    await searchContacts('Smith & "Sons" <x>');
  } finally { restore(); }
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].includes('>R&amp;D &lt;/C:text-match&gt;&lt;x&gt;</C:text-match>'));
  for (const body of bodies.slice(1)) {
    assert.ok(body.includes('>Smith &amp; &quot;Sons&quot; &lt;x&gt;</C:text-match>'));
  }
});
