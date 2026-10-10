// ─── lib/ics.js — iCalendar feed parsing and recurrence expansion ───────────
// Used for read-only subscribed calendars. A feed may hold many VEVENTs, a
// VTIMEZONE per TZID, recurring masters with RRULE/RDATE/EXDATE, and
// RECURRENCE-ID overrides. Everything here is pure: no network, no disk.
//
// Wall-clock times are carried as a Date whose UTC fields hold the local
// fields of the zone ("wall Date"). An instant is a real epoch Date.

const DAY_MS = 86400_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_PERIODS = 20000;
export const DEFAULT_MAX_FEED_EVENTS = 2000;

export class IcsTooManyEventsError extends Error {
  constructor() {
    super('The calendar feed has too many events');
    this.name = 'IcsTooManyEventsError';
  }
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

export function icalUnescape(str) {
  if (!str) return str;
  return str
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function unfold(text) {
  return String(text || '').replace(/^\uFEFF/, '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

// NAME;PARAM=value;OTHER="quoted:value":content → { name, params, value }
function parseContentLine(line) {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = [];
  let current = '';
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ';' && !inQuotes) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  const name = parts[0].toUpperCase();
  const params = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { name, params, value };
}

// Splits the stream into components. Returns top-level VEVENTs and VTIMEZONEs
// as { props: [...], children: [...] }.
function parseComponents(lines) {
  const root = { name: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const line of lines) {
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:')) {
      const comp = { name: upper.slice(6).trim(), props: [], children: [] };
      stack[stack.length - 1].children.push(comp);
      stack.push(comp);
      continue;
    }
    if (upper.startsWith('END:')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const prop = parseContentLine(line);
    if (prop) stack[stack.length - 1].props.push(prop);
  }
  return root;
}

function collect(component, name, out = []) {
  for (const child of component.children) {
    if (child.name === name) out.push(child);
    else collect(child, name, out);
  }
  return out;
}

// ─── Time zones ───────────────────────────────────────────────────────────────

const tzFormatCache = new Map();

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  if (tzFormatCache.has(tz)) return tzFormatCache.get(tz) !== null;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    tzFormatCache.set(tz, fmt);
    return true;
  } catch {
    tzFormatCache.set(tz, null);
    return false;
  }
}

function wallFromInstantInZone(instantMs, tz) {
  if (!isValidTimeZone(tz)) return instantMs;
  const fmt = tzFormatCache.get(tz);
  const parts = {};
  for (const part of fmt.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
}

// Offset (ms) such that wall = instant + offset.
function zoneOffsetAt(zone, instantMs) {
  if (!zone) return 0;
  if (typeof zone === 'object') return zone.fixedOffsetMs;
  return wallFromInstantInZone(instantMs, zone) - instantMs;
}

export function wallToInstant(wallMs, zone) {
  if (!zone) return wallMs;
  if (typeof zone === 'object') return wallMs - zone.fixedOffsetMs;
  // Two passes handle the DST edges well enough for calendar data.
  let offset = zoneOffsetAt(zone, wallMs);
  let instant = wallMs - offset;
  offset = zoneOffsetAt(zone, instant);
  return wallMs - offset;
}

export function instantToWall(instantMs, zone) {
  return instantMs + zoneOffsetAt(zone, instantMs);
}

function parseUtcOffset(text) {
  const m = String(text || '').trim().match(/^([+-])(\d{2})(\d{2})(\d{2})?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] || 0)) * 1000);
}

// Maps a TZID from the feed to an IANA zone name, a fixed offset, or null
// (floating). Tries the raw id, then a trailing Area/City in a prefixed id
// (e.g. /some.vendor/America/New_York), then X-LIC-LOCATION and finally the
// STANDARD offset from the feed's VTIMEZONE.
export function resolveZone(tzid, vtimezones = {}) {
  if (!tzid) return null;
  const trimmed = String(tzid).trim().replace(/^"|"$/g, '');
  if (!trimmed) return null;
  if (/^(UTC|GMT|Z|Etc\/UTC|Etc\/GMT)$/i.test(trimmed)) return 'UTC';
  if (isValidTimeZone(trimmed)) return trimmed;
  const segments = trimmed.split('/').filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    const candidate = segments.slice(i).join('/');
    if (isValidTimeZone(candidate)) return candidate;
  }
  const vt = vtimezones[trimmed];
  if (vt) {
    if (vt.location && isValidTimeZone(vt.location)) return vt.location;
    if (vt.standardOffsetMs != null) return { fixedOffsetMs: vt.standardOffsetMs };
  }
  const fixed = parseUtcOffset(trimmed.replace(/^UTC|^GMT/i, ''));
  if (fixed != null) return { fixedOffsetMs: fixed };
  return null;
}

function parseVTimezones(root) {
  const zones = {};
  for (const comp of collect(root, 'VTIMEZONE')) {
    const tzid = comp.props.find((p) => p.name === 'TZID')?.value?.trim();
    if (!tzid) continue;
    const location = comp.props.find((p) => p.name === 'X-LIC-LOCATION')?.value?.trim() || null;
    const standard = comp.children.find((c) => c.name === 'STANDARD') || comp.children[0];
    const offsetText = standard?.props.find((p) => p.name === 'TZOFFSETTO')?.value;
    zones[tzid] = { location, standardOffsetMs: parseUtcOffset(offsetText) };
  }
  return zones;
}

// ─── Date values ──────────────────────────────────────────────────────────────

// Returns { wall, kind, tzid } where kind is date | utc | floating | tzid.
export function parseDateValue(value, params = {}) {
  const raw = String(value || '').trim();
  const dateOnly = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly || params.VALUE === 'DATE') {
    const m = dateOnly || raw.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { wall: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), kind: 'date', tzid: null };
  }
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  if (m[7] === 'Z') return { wall, kind: 'utc', tzid: null };
  if (params.TZID) return { wall, kind: 'tzid', tzid: params.TZID.replace(/^"|"$/g, '') };
  return { wall, kind: 'floating', tzid: null };
}

function pad(n) { return String(n).padStart(2, '0'); }

function wallParts(wallMs) {
  const d = new Date(wallMs);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(), wd: d.getUTCDay(),
  };
}

// Same text shape as the CalDAV event fields: YYYY-MM-DD for all-day,
// YYYY-MM-DDTHH:MM:SSZ for UTC, YYYY-MM-DDTHH:MM:SS for zoned or floating.
export function formatWall(wallMs, kind) {
  const p = wallParts(wallMs);
  const date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  if (kind === 'date') return date;
  return `${date}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}${kind === 'utc' ? 'Z' : ''}`;
}

export function compactStamp(wallMs, kind) {
  const p = wallParts(wallMs);
  const date = `${p.y}${pad(p.m)}${pad(p.d)}`;
  if (kind === 'date') return date;
  return `${date}T${pad(p.hh)}${pad(p.mm)}${pad(p.ss)}${kind === 'utc' ? 'Z' : ''}`;
}

function zoneFor(dv, vtimezones) {
  if (!dv) return null;
  if (dv.kind === 'utc') return 'UTC';
  if (dv.kind === 'tzid') return resolveZone(dv.tzid, vtimezones);
  return null;
}

function toInstant(dv, vtimezones) {
  return wallToInstant(dv.wall, zoneFor(dv, vtimezones));
}

function parseDuration(text) {
  const m = String(text || '').trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const ms = (Number(m[2] || 0) * 7 * 86400 + Number(m[3] || 0) * 86400
    + Number(m[4] || 0) * 3600 + Number(m[5] || 0) * 60 + Number(m[6] || 0)) * 1000;
  return sign * ms;
}

// ─── VEVENT ───────────────────────────────────────────────────────────────────

function parseVEventComponent(comp) {
  const ev = { fields: {}, dtstart: null, dtend: null, duration: null, rrule: null, rdates: [], exdates: [], recurrenceId: null };
  const f = ev.fields;
  for (const { name, params, value } of comp.props) {
    switch (name) {
      case 'UID': f.uid = value; break;
      case 'SUMMARY': f.summary = icalUnescape(value); break;
      case 'DESCRIPTION': f.description = icalUnescape(value); break;
      case 'LOCATION': f.location = icalUnescape(value); break;
      case 'STATUS': f.status = value; break;
      case 'RRULE': f.recurrence = value; ev.rrule = value; break;
      case 'DTSTART': {
        ev.dtstart = parseDateValue(value, params);
        if (ev.dtstart) {
          f.start = formatWall(ev.dtstart.wall, ev.dtstart.kind);
          if (ev.dtstart.tzid) f.timezone = ev.dtstart.tzid;
          f.allDay = ev.dtstart.kind === 'date';
        }
        break;
      }
      case 'DTEND': {
        ev.dtend = parseDateValue(value, params);
        if (ev.dtend) f.end = formatWall(ev.dtend.wall, ev.dtend.kind);
        break;
      }
      case 'DURATION': ev.duration = parseDuration(value); break;
      case 'CREATED': { const dv = parseDateValue(value, params); if (dv) f.created = formatWall(dv.wall, dv.kind); break; }
      case 'LAST-MODIFIED': { const dv = parseDateValue(value, params); if (dv) f.lastModified = formatWall(dv.wall, dv.kind); break; }
      case 'ORGANIZER': f.organizer = value.replace(/^mailto:/i, ''); break;
      case 'ATTENDEE': {
        if (!f.attendees) f.attendees = [];
        const email = value.replace(/^mailto:/i, '');
        f.attendees.push(params.CN ? `${params.CN} <${email}>` : email);
        break;
      }
      case 'EXDATE': {
        for (const part of value.split(',')) {
          const dv = parseDateValue(part, params);
          if (!dv) continue;
          ev.exdates.push(dv);
          if (!f.exDates) f.exDates = [];
          f.exDates.push(formatWall(dv.wall, dv.kind));
        }
        break;
      }
      case 'RDATE': {
        if (params.VALUE === 'PERIOD') break;
        for (const part of value.split(',')) {
          const dv = parseDateValue(part, params);
          if (dv) ev.rdates.push(dv);
        }
        break;
      }
      case 'RECURRENCE-ID': ev.recurrenceId = parseDateValue(value, params); break;
    }
  }
  return ev;
}

// Returns { events, timezones }. `events` are raw component records; use
// expandEvents() to get occurrences in a range. A feed with more than
// `maxEvents` VEVENTs is refused before any of them is parsed.
export function parseIcs(text, { maxEvents = DEFAULT_MAX_FEED_EVENTS } = {}) {
  const root = parseComponents(unfold(text));
  const timezones = parseVTimezones(root);
  const components = collect(root, 'VEVENT');
  if (maxEvents != null && components.length > maxEvents) throw new IcsTooManyEventsError();
  const events = components.map(parseVEventComponent).filter((ev) => ev.dtstart);
  return { events, timezones };
}

export function looksLikeIcs(text) {
  return /^\s*BEGIN:VCALENDAR/i.test(String(text || '').replace(/^\uFEFF/, ''));
}

// ─── RRULE ────────────────────────────────────────────────────────────────────

function parseRRule(text) {
  const rule = { freq: null, interval: 1, count: null, until: null, byday: [], bymonthday: [], bymonth: [], bysetpos: [], wkst: 1 };
  for (const part of String(text || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1).trim();
    switch (key) {
      case 'FREQ': rule.freq = val.toUpperCase(); break;
      case 'INTERVAL': rule.interval = Math.max(1, parseInt(val, 10) || 1); break;
      case 'COUNT': rule.count = Math.max(0, parseInt(val, 10) || 0); break;
      case 'UNTIL': rule.until = parseDateValue(val); break;
      case 'WKST': rule.wkst = Math.max(0, WEEKDAYS.indexOf(val.toUpperCase())); break;
      case 'BYDAY':
        rule.byday = val.split(',').map((item) => {
          const m = item.trim().toUpperCase().match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
          return m ? { ord: m[1] ? parseInt(m[1], 10) : 0, day: WEEKDAYS.indexOf(m[2]) } : null;
        }).filter(Boolean);
        break;
      case 'BYMONTHDAY': rule.bymonthday = val.split(',').map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n !== 0); break;
      case 'BYMONTH': rule.bymonth = val.split(',').map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= 12); break;
      case 'BYSETPOS': rule.bysetpos = val.split(',').map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n !== 0); break;
    }
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) return null;
  return rule;
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function dateMs(y, m, d) { return Date.UTC(y, m - 1, d); }
function weekdayOf(ms) { return new Date(ms).getUTCDay(); }

// Day ordinals (0-based) in [y, m] matching one BYDAY entry, honoring ±n.
function monthDaysForByDay(y, m, { ord, day }) {
  const n = daysInMonth(y, m);
  const matches = [];
  for (let d = 1; d <= n; d++) if (weekdayOf(dateMs(y, m, d)) === day) matches.push(d);
  if (ord === 0) return matches;
  const picked = ord > 0 ? matches[ord - 1] : matches[matches.length + ord];
  return picked ? [picked] : [];
}

function yearDaysForByDay(y, { ord, day }) {
  const matches = [];
  for (let ms = dateMs(y, 1, 1); ms < dateMs(y + 1, 1, 1); ms += DAY_MS) {
    if (weekdayOf(ms) === day) matches.push(ms);
  }
  if (ord === 0) return matches;
  const picked = ord > 0 ? matches[ord - 1] : matches[matches.length + ord];
  return picked != null ? [picked] : [];
}

function applySetPos(list, bysetpos) {
  if (!bysetpos.length) return list;
  const out = new Set();
  for (const pos of bysetpos) {
    const item = pos > 0 ? list[pos - 1] : list[list.length + pos];
    if (item != null) out.add(item);
  }
  return [...out].sort((a, b) => a - b);
}

// Candidate day values (UTC-midnight ms of the wall date) for one period.
function candidatesForPeriod(rule, periodStartMs, start) {
  const p = wallParts(periodStartMs);
  const sp = wallParts(start.wall);
  const monthOk = (m) => !rule.bymonth.length || rule.bymonth.includes(m);
  const dayOk = (ms) => !rule.byday.length || rule.byday.some((b) => b.day === weekdayOf(ms));
  const monthDayOk = (ms) => {
    if (!rule.bymonthday.length) return true;
    const q = wallParts(ms);
    const n = daysInMonth(q.y, q.m);
    return rule.bymonthday.some((d) => (d > 0 ? d : n + 1 + d) === q.d);
  };

  if (rule.freq === 'DAILY') {
    return monthOk(p.m) && dayOk(periodStartMs) && monthDayOk(periodStartMs) ? [periodStartMs] : [];
  }
  if (rule.freq === 'WEEKLY') {
    const days = rule.byday.length ? rule.byday.map((b) => b.day) : [sp.wd];
    const out = [];
    for (let i = 0; i < 7; i++) {
      const ms = periodStartMs + i * DAY_MS;
      if (days.includes(weekdayOf(ms)) && monthOk(wallParts(ms).m)) out.push(ms);
    }
    return out;
  }
  if (rule.freq === 'MONTHLY') {
    if (!monthOk(p.m)) return [];
    const n = daysInMonth(p.y, p.m);
    let days;
    if (rule.bymonthday.length) {
      days = rule.bymonthday.map((d) => (d > 0 ? d : n + 1 + d)).filter((d) => d >= 1 && d <= n);
      if (rule.byday.length) days = days.filter((d) => dayOk(dateMs(p.y, p.m, d)));
    } else if (rule.byday.length) {
      days = rule.byday.flatMap((b) => monthDaysForByDay(p.y, p.m, b));
    } else {
      days = sp.d <= n ? [sp.d] : [];
    }
    const list = [...new Set(days)].sort((a, b) => a - b).map((d) => dateMs(p.y, p.m, d));
    return applySetPos(list, rule.bysetpos);
  }
  // YEARLY
  const months = rule.bymonth.length ? rule.bymonth : [sp.m];
  let list;
  if (rule.bymonthday.length) {
    list = months.flatMap((m) => {
      const n = daysInMonth(p.y, m);
      return rule.bymonthday.map((d) => (d > 0 ? d : n + 1 + d)).filter((d) => d >= 1 && d <= n).map((d) => dateMs(p.y, m, d));
    });
    if (rule.byday.length) list = list.filter(dayOk);
  } else if (rule.byday.length) {
    list = rule.bymonth.length
      ? months.flatMap((m) => rule.byday.flatMap((b) => monthDaysForByDay(p.y, m, b).map((d) => dateMs(p.y, m, d))))
      : rule.byday.flatMap((b) => yearDaysForByDay(p.y, b));
  } else {
    list = months.filter((m) => sp.d <= daysInMonth(p.y, m)).map((m) => dateMs(p.y, m, sp.d));
  }
  list = [...new Set(list)].sort((a, b) => a - b);
  return applySetPos(list, rule.bysetpos);
}

function periodStart(rule, wallMs) {
  const p = wallParts(wallMs);
  if (rule.freq === 'DAILY') return dateMs(p.y, p.m, p.d);
  if (rule.freq === 'WEEKLY') {
    const back = (p.wd - rule.wkst + 7) % 7;
    return dateMs(p.y, p.m, p.d) - back * DAY_MS;
  }
  if (rule.freq === 'MONTHLY') return dateMs(p.y, p.m, 1);
  return dateMs(p.y, 1, 1);
}

function advancePeriod(rule, periodMs) {
  const p = wallParts(periodMs);
  if (rule.freq === 'DAILY') return periodMs + rule.interval * DAY_MS;
  if (rule.freq === 'WEEKLY') return periodMs + rule.interval * 7 * DAY_MS;
  if (rule.freq === 'MONTHLY') return Date.UTC(p.y, p.m - 1 + rule.interval, 1);
  return Date.UTC(p.y + rule.interval, 0, 1);
}

// The latest period in the rule's own sequence (DTSTART's period plus a
// multiple of INTERVAL) that starts at or before `targetWall`. Lets a rule
// without COUNT skip straight to the query window instead of walking from
// DTSTART. A rule with COUNT cannot skip: the count is taken from the start.
function alignedPeriodAtOrBefore(rule, firstPeriod, targetWall) {
  if (targetWall <= firstPeriod) return firstPeriod;
  const a = wallParts(firstPeriod);
  const t = wallParts(periodStart(rule, targetWall));
  let units;
  if (rule.freq === 'DAILY') units = Math.floor((periodStart(rule, targetWall) - firstPeriod) / DAY_MS);
  else if (rule.freq === 'WEEKLY') units = Math.floor((periodStart(rule, targetWall) - firstPeriod) / (7 * DAY_MS));
  else if (rule.freq === 'MONTHLY') units = (t.y - a.y) * 12 + (t.m - a.m);
  else units = t.y - a.y;
  const aligned = Math.floor(units / rule.interval) * rule.interval;
  if (rule.freq === 'DAILY') return firstPeriod + aligned * DAY_MS;
  if (rule.freq === 'WEEKLY') return firstPeriod + aligned * 7 * DAY_MS;
  if (rule.freq === 'MONTHLY') return Date.UTC(a.y, a.m - 1 + aligned, 1);
  return Date.UTC(a.y + aligned, 0, 1);
}

// Shared work budget for one expandEvents call: candidate steps, emitted
// occurrences, and a wall-clock deadline. Exceeding any of them throws so a
// hostile feed cannot stall the single-process server.
export class IcsBudgetError extends Error {
  constructor() {
    super('The calendar feed is too large to expand');
    this.name = 'IcsBudgetError';
  }
}

export const DEFAULT_EXPAND_LIMITS = Object.freeze({
  maxOccurrences: 5000,
  maxSteps: 400_000,
  deadlineMs: 2000,
});

function makeBudget(limits) {
  const merged = { ...DEFAULT_EXPAND_LIMITS, ...(limits || {}) };
  return {
    steps: 0,
    occurrences: 0,
    maxSteps: merged.maxSteps,
    maxOccurrences: merged.maxOccurrences,
    deadline: Date.now() + merged.deadlineMs,
  };
}

function spend(budget, steps = 1) {
  budget.steps += steps;
  if (budget.steps > budget.maxSteps) throw new IcsBudgetError();
  if ((budget.steps & 1023) === 0 && Date.now() > budget.deadline) throw new IcsBudgetError();
}

// Yields wall start times (ms) for the rule, beginning with DTSTART. Stops at
// COUNT, UNTIL, or once an occurrence starts at or after `stopWallMs`.
// Occurrences before `seekWallMs` are not produced unless COUNT needs them.
function* rruleWalls(ruleText, start, zone, stopWallMs, seekWallMs, budget) {
  const rule = parseRRule(ruleText);
  yield start.wall;
  if (!rule) return;
  const timeOfDay = start.wall - dateMs(wallParts(start.wall).y, wallParts(start.wall).m, wallParts(start.wall).d);
  let untilWall = null;
  if (rule.until) {
    untilWall = rule.until.kind === 'date'
      ? rule.until.wall + DAY_MS - 1
      : instantToWall(toInstant(rule.until, {}), zone);
    if (untilWall < stopWallMs) stopWallMs = untilWall + 1;
  }
  let emitted = 1;
  const firstPeriod = periodStart(rule, start.wall);
  let period = firstPeriod;
  if (rule.count == null && seekWallMs != null) {
    period = alignedPeriodAtOrBefore(rule, firstPeriod, seekWallMs);
  }
  for (let steps = 0; steps < MAX_PERIODS; steps++) {
    if (rule.count != null && emitted >= rule.count) return;
    spend(budget);
    for (const dayMs of candidatesForPeriod(rule, period, start)) {
      spend(budget);
      const wall = dayMs + timeOfDay;
      if (wall <= start.wall) continue;
      if (untilWall != null && wall > untilWall) return;
      if (wall >= stopWallMs) return;
      emitted++;
      if (seekWallMs == null || wall >= seekWallMs) yield wall;
      if (rule.count != null && emitted >= rule.count) return;
    }
    period = advancePeriod(rule, period);
    if (period >= stopWallMs + 366 * DAY_MS) return;
  }
}

// ─── Expansion ────────────────────────────────────────────────────────────────

function durationOf(ev, timezones) {
  if (ev.dtend) {
    const startInstant = toInstant(ev.dtstart, timezones);
    const endInstant = toInstant(ev.dtend, timezones);
    return Math.max(0, endInstant - startInstant);
  }
  if (ev.duration != null) return Math.max(0, ev.duration);
  return ev.dtstart.kind === 'date' ? DAY_MS : 0;
}

export function overlapsRange(startMs, endMs, sinceMs, beforeMs) {
  if (beforeMs != null && startMs >= beforeMs) return false;
  if (sinceMs != null) {
    if (endMs > startMs) return endMs > sinceMs;
    return startMs >= sinceMs;
  }
  return true;
}

function occurrenceRecord(ev, startWall, instant, durationMs, zone, timezones, recurrenceStamp) {
  const kind = ev.dtstart.kind;
  const endInstant = instant + durationMs;
  const endWall = kind === 'date' || kind === 'floating' ? startWall + durationMs : instantToWall(endInstant, zone);
  const { exDates, ...fields } = ev.fields;
  const record = {
    ...fields,
    start: formatWall(startWall, kind),
    end: formatWall(endWall, kind),
    _startMs: instant,
    _endMs: endInstant,
  };
  if (recurrenceStamp) record.recurrenceId = recurrenceStamp;
  return record;
}

// Returns occurrences overlapping [since, before). Each record keeps the
// CalDAV event text fields plus _startMs/_endMs for sorting. Overrides
// (RECURRENCE-ID) replace the matching generated instance.
export function expandEvents(parsed, { since = null, before = null, limits = null } = {}) {
  const { events, timezones } = parsed;
  const sinceMs = since ? new Date(since).getTime() : null;
  const beforeMs = before ? new Date(before).getTime() : null;
  const budget = makeBudget(limits);
  const out = [];
  const emit = (record) => {
    out.push(record);
    budget.occurrences++;
    if (budget.occurrences > budget.maxOccurrences) throw new IcsBudgetError();
  };
  const byUid = new Map();
  for (const ev of events) {
    spend(budget);
    const uid = ev.fields.uid || `no-uid-${byUid.size}`;
    if (!byUid.has(uid)) byUid.set(uid, { master: null, overrides: [] });
    const group = byUid.get(uid);
    if (ev.recurrenceId) group.overrides.push(ev);
    else if (!group.master) group.master = ev;
  }

  for (const [uid, group] of byUid) {
    const { master, overrides } = group;
    const consumed = new Set();
    if (master) {
      const zone = zoneFor(master.dtstart, timezones);
      const durationMs = durationOf(master, timezones);
      const recurring = Boolean(master.rrule) || master.rdates.length > 0;
      if (!recurring) {
        const instant = toInstant(master.dtstart, timezones);
        if (overlapsRange(instant, instant + durationMs, sinceMs, beforeMs)) {
          emit({ eventId: uid, ...occurrenceRecord(master, master.dtstart.wall, instant, durationMs, zone, timezones, null) });
        }
      } else {
        const exInstants = new Set(master.exdates.map((dv) => toInstant(dv, timezones)));
        const overrideByInstant = new Map(overrides.map((ov) => [toInstant(ov.recurrenceId, timezones), ov]));
        const stopWall = beforeMs != null ? instantToWall(beforeMs, zone) + DAY_MS : Number.POSITIVE_INFINITY;
        // An occurrence can only overlap the window if it starts after
        // since minus its duration; one day of slack covers zone offsets.
        const seekWall = sinceMs != null ? instantToWall(sinceMs, zone) - durationMs - DAY_MS : null;
        const walls = new Set();
        for (const wall of rruleWalls(master.rrule, master.dtstart, zone, stopWall, seekWall, budget)) walls.add(wall);
        for (const rd of master.rdates) {
          spend(budget);
          const rdZone = zoneFor(rd, timezones);
          walls.add(rdZone === zone ? rd.wall : instantToWall(toInstant(rd, timezones), zone));
        }
        const sorted = [...walls].sort((a, b) => a - b);
        for (const wall of sorted) {
          spend(budget);
          const instant = wallToInstant(wall, zone);
          if (exInstants.has(instant)) continue;
          const stamp = compactStamp(wall, master.dtstart.kind);
          const override = overrideByInstant.get(instant);
          if (override) {
            consumed.add(override);
            const ovZone = zoneFor(override.dtstart, timezones);
            const ovInstant = toInstant(override.dtstart, timezones);
            const ovDuration = durationOf(override, timezones);
            if (!overlapsRange(ovInstant, ovInstant + ovDuration, sinceMs, beforeMs)) continue;
            emit({
              eventId: `${uid}_${stamp}`,
              ...occurrenceRecord({ ...override, fields: { ...master.fields, ...override.fields } }, override.dtstart.wall, ovInstant, ovDuration, ovZone, timezones, stamp),
            });
            continue;
          }
          if (!overlapsRange(instant, instant + durationMs, sinceMs, beforeMs)) continue;
          emit({ eventId: `${uid}_${stamp}`, ...occurrenceRecord(master, wall, instant, durationMs, zone, timezones, stamp) });
        }
      }
    }
    for (const override of overrides) {
      spend(budget);
      if (consumed.has(override)) continue;
      const ovZone = zoneFor(override.dtstart, timezones);
      const instant = toInstant(override.dtstart, timezones);
      const durationMs = durationOf(override, timezones);
      if (!overlapsRange(instant, instant + durationMs, sinceMs, beforeMs)) continue;
      const stamp = compactStamp(override.recurrenceId.wall, override.recurrenceId.kind);
      const fields = master ? { ...master.fields, ...override.fields } : override.fields;
      emit({ eventId: `${uid}_${stamp}`, ...occurrenceRecord({ ...override, fields }, override.dtstart.wall, instant, durationMs, ovZone, timezones, stamp) });
    }
  }

  out.sort((a, b) => a._startMs - b._startMs || String(a.eventId).localeCompare(String(b.eventId)));
  return out;
}

// Range check for an already-parsed CalDAV event record (start/end strings).
// Anything recurring is kept (RRULE, RDATE, or a RECURRENCE-ID override): the
// server matched one of its occurrences. An event in a zone this process
// cannot resolve is kept too, since its instant is unknown.
export function eventRecordOverlaps(event, sinceMs, beforeMs, vtimezones = {}) {
  if (!event || !event.start) return true;
  if (event.recurrence || event.recurrenceId || (Array.isArray(event.rDates) && event.rDates.length > 0)) return true;
  let zone = null;
  if (event.timezone) {
    zone = resolveZone(event.timezone, vtimezones);
    if (zone == null) return true;
  }
  const toMs = (text) => {
    const dv = parseDateValue(String(text).replace(/[-:]/g, ''));
    if (!dv) return null;
    return wallToInstant(dv.wall, dv.kind === 'utc' ? 'UTC' : dv.kind === 'date' ? null : zone);
  };
  const startMs = toMs(event.start);
  if (startMs == null) return true;
  let endMs = event.end ? toMs(event.end) : null;
  if (endMs == null) endMs = event.allDay ? startMs + DAY_MS : startMs;
  return overlapsRange(startMs, endMs, sinceMs, beforeMs);
}
