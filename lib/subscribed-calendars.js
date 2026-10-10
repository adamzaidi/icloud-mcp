// ─── lib/subscribed-calendars.js — read-only ICS/webcal subscriptions ────────
// iCloud lists a subscribed calendar over CalDAV but returns no events for it,
// so this module reads the feed from its source URL instead. It is opt-in
// (ICLOUD_MCP_SUBSCRIBED_CALENDARS=on) and read-only.
//
// Feed URLs are secrets. They stay inside this module: not in tool output,
// not in thrown errors, not on stderr. Errors name the calendar, never the URL.
import { chmodSync, closeSync, existsSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import { AUDIT_FILE_MODE, ensureDirectory, stateRoot } from './audit.js';
import { keychainServiceName, passwordLookupArgs, runKeychainCommand } from './keychain.js';
import {
  parseIcs, expandEvents, looksLikeIcs, IcsBudgetError, IcsTooManyEventsError, DEFAULT_MAX_FEED_EVENTS,
} from './ics.js';

export const SUBSCRIBED_ID_PREFIX = 'subscribed-';
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CACHE_MS = 5 * 60_000;
const MAX_REDIRECTS = 3;

// ─── Toggle ───────────────────────────────────────────────────────────────────

export function resolveSubscribedCalendarsSetting(env = process.env) {
  const raw = env.ICLOUD_MCP_SUBSCRIBED_CALENDARS;
  if (raw == null || String(raw).trim() === '') return 'off';
  const value = String(raw).trim().toLowerCase();
  if (value !== 'on' && value !== 'off') {
    throw new Error('ICLOUD_MCP_SUBSCRIBED_CALENDARS must be on or off');
  }
  return value;
}

export function subscribedCalendarsEnabled(env = process.env) {
  return resolveSubscribedCalendarsSetting(env) === 'on';
}

export function assertValidSubscribedCalendarsSetting(env = process.env) {
  resolveSubscribedCalendarsSetting(env);
}

export function isSubscribedCalendarId(calendarId) {
  return typeof calendarId === 'string' && calendarId.startsWith(SUBSCRIBED_ID_PREFIX);
}

// ─── Config file ──────────────────────────────────────────────────────────────

export function subscribedCalendarsConfigPath(env = process.env) {
  const override = String(env.ICLOUD_MCP_SUBSCRIBED_CALENDARS_FILE ?? '').trim();
  if (override) return override;
  return join(stateRoot(env), '.icloud-mcp', 'subscribed-calendars.json');
}

function createEmptyConfig(file) {
  ensureDirectory(dirname(file));
  const fd = openSync(file, 'wx', AUDIT_FILE_MODE);
  try {
    writeSync(fd, '{}\n');
  } finally {
    closeSync(fd);
  }
  chmodSync(file, AUDIT_FILE_MODE);
}

function slugify(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'calendar';
}

export function calendarIdForName(name) {
  return `${SUBSCRIBED_ID_PREFIX}${slugify(name)}`;
}

let keychainRunner = (args) => runKeychainCommand(args);

export function setSubscribedKeychainForTests(fn) {
  keychainRunner = fn || ((args) => runKeychainCommand(args));
}

function configError(name, reason) {
  return new Error(`Subscribed calendar "${name}" is misconfigured: ${reason}`);
}

// Turns the configured value into a URL object. Accepts https://, webcal://
// (rewritten to https://), or keychain:<account>, whose Keychain item holds
// one of the first two. The returned URL must never leave this module.
export function resolveSourceUrl(name, value, env = process.env) {
  let text = String(value ?? '').trim();
  if (!text) throw configError(name, 'the URL is empty');
  if (/^keychain:/i.test(text)) {
    const account = text.slice('keychain:'.length).trim();
    if (!account) throw configError(name, 'keychain: needs an account name');
    let secret;
    try {
      secret = String(keychainRunner(passwordLookupArgs(keychainServiceName(env), account)) ?? '').replace(/\r?\n$/, '').trim();
    } catch {
      throw configError(name, 'the Keychain lookup failed');
    }
    if (!secret) throw configError(name, 'the Keychain item is empty');
    if (/^keychain:/i.test(secret)) throw configError(name, 'the Keychain item must hold a URL');
    text = secret;
  }
  text = text.replace(/^webcal:\/\//i, 'https://');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw configError(name, 'the URL does not parse');
  }
  if (url.protocol !== 'https:') throw configError(name, 'only https:// and webcal:// URLs are allowed');
  if (url.username || url.password) throw configError(name, 'credentials in the URL are not allowed');
  if (!url.hostname) throw configError(name, 'the URL has no host');
  if (!portAllowed(url, env)) throw configError(name, 'the port is not allowed (set ICLOUD_MCP_SUBSCRIBED_CALENDARS_PORTS to permit it)');
  return url;
}

let warnedLooseFile = false;

export function resetSubscribedWarningsForTests() {
  warnedLooseFile = false;
}

// Says so once, on stderr, without the path or any URL.
function warnIfLoose(file) {
  if (warnedLooseFile) return;
  let mode;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    return;
  }
  if ((mode & 0o077) === 0) return;
  warnedLooseFile = true;
  process.stderr.write('[subscribed-calendars] the subscribed calendars file is readable by other users; run chmod 600 on it\n');
}

// Reads the config file. Returns [{ calendarId, name, url }] with `url` a URL
// object. Creates an empty file (mode 0600, directory 0700) when missing.
export function loadSubscribedCalendars(env = process.env) {
  const file = subscribedCalendarsConfigPath(env);
  if (!existsSync(file)) {
    createEmptyConfig(file);
    return [];
  }
  warnIfLoose(file);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('The subscribed calendars file is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The subscribed calendars file must be a JSON object of name to URL');
  }
  const out = [];
  const seen = new Map();
  for (const [name, value] of Object.entries(raw)) {
    const label = String(name).trim();
    if (!label) throw new Error('A subscribed calendar has an empty name');
    const url = resolveSourceUrl(label, typeof value === 'object' && value !== null ? value.url : value, env);
    const calendarId = calendarIdForName(label);
    if (seen.has(calendarId)) {
      throw new Error(`Subscribed calendars "${seen.get(calendarId)}" and "${label}" would share the id ${calendarId}; rename one`);
    }
    seen.set(calendarId, label);
    out.push({ calendarId, name: label, url });
  }
  return out;
}

// ─── SSRF checks ──────────────────────────────────────────────────────────────

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function expandIpv6(ip) {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  let embeddedV4 = null;
  const v4 = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    embeddedV4 = v4[1];
    const n = ipv4ToInt(embeddedV4);
    text = text.slice(0, -embeddedV4.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  const groups = [...head, ...Array(Math.max(0, halves.length > 1 ? fill : 0)).fill('0'), ...tail].map((g) => parseInt(g || '0', 16));
  return { groups, embeddedV4 };
}

export function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED_V4.some(([base, bits]) => inCidr4(ip, base, bits));
  if (family !== 6) return true;
  const { groups, embeddedV4 } = expandIpv6(ip);
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return true;
  const allZeroPrefix = (n) => groups.slice(0, n).every((g) => g === 0);
  if (groups.every((g) => g === 0)) return true; // ::
  if (allZeroPrefix(7) && groups[7] === 1) return true; // ::1
  if (allZeroPrefix(5) && groups[5] === 0xffff) { // ::ffff:a.b.c.d
    const v4 = embeddedV4 || `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedAddress(v4);
  }
  if (allZeroPrefix(6)) return true; // ::a.b.c.d deprecated compatible range
  if (groups[0] === 0x64 && groups[1] === 0xff9b) { // 64:ff9b::/96 NAT64
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedAddress(v4);
  }
  if (allZeroPrefix(4) && groups[4] === 0xffff && groups[5] === 0) { // ::ffff:0:a.b.c.d SIIT
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedAddress(v4);
  }
  if (groups[0] === 0x2002) { // 2002::/16 6to4 carries the IPv4 in the next 32 bits
    const v4 = `${groups[1] >> 8}.${groups[1] & 0xff}.${groups[2] >> 8}.${groups[2] & 0xff}`;
    return isBlockedAddress(v4);
  }
  if (groups[0] === 0x2001 && groups[1] === 0) return true; // 2001::/32 Teredo tunnels
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((groups[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site local
  if ((groups[0] & 0xff00) === 0xff00) return true; // multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  return false;
}

// Only 443 unless ICLOUD_MCP_SUBSCRIBED_CALENDARS_PORTS lists more ports.
export function allowedPorts(env = process.env) {
  const ports = new Set([443]);
  for (const part of String(env.ICLOUD_MCP_SUBSCRIBED_CALENDARS_PORTS ?? '').split(',')) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.add(n);
  }
  return ports;
}

function portAllowed(url, env) {
  const port = url.port ? Number(url.port) : 443;
  return allowedPorts(env).has(port);
}

let lookupFn = (host) => dnsLookup(host, { all: true });

export function setSubscribedLookupForTests(fn) {
  lookupFn = fn || ((host) => dnsLookup(host, { all: true }));
}

async function assertPublicHost(name, hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw fetchError(name, 'the address is not allowed');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw fetchError(name, 'the address is not allowed');
    return;
  }
  let records;
  try {
    records = await lookupFn(host);
  } catch {
    throw fetchError(name, 'the host could not be resolved');
  }
  const addresses = (Array.isArray(records) ? records : [records]).map((r) => (typeof r === 'string' ? r : r?.address)).filter(Boolean);
  if (!addresses.length) throw fetchError(name, 'the host could not be resolved');
  if (addresses.some((address) => isBlockedAddress(address))) throw fetchError(name, 'the address is not allowed');
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

class SubscribedFetchError extends Error {}

function fetchError(name, reason) {
  return new SubscribedFetchError(`Subscribed calendar "${name}" could not be read: ${reason}`);
}

let fetcher = (url, init) => fetch(url, init);
const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
  maxBytes: DEFAULT_MAX_BYTES,
  cacheMs: DEFAULT_CACHE_MS,
  maxEvents: DEFAULT_MAX_FEED_EVENTS,
  expand: null, // ics.js DEFAULT_EXPAND_LIMITS
});
let limits = { ...DEFAULT_LIMITS };
const cache = new Map();

export function setSubscribedFetcherForTests(fn) {
  fetcher = fn || ((url, init) => fetch(url, init));
  cache.clear();
}

export function setSubscribedLimitsForTests(overrides) {
  limits = { ...DEFAULT_LIMITS, ...(overrides || {}) };
}

export function clearSubscribedCacheForTests() {
  cache.clear();
}

async function readBodyCapped(res, name, controller) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limits.maxBytes) throw fetchError(name, 'the feed is larger than the size limit');
  const chunks = [];
  let total = 0;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        controller.abort();
        throw fetchError(name, 'the feed is larger than the size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > limits.maxBytes) throw fetchError(name, 'the feed is larger than the size limit');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Follows up to MAX_REDIRECTS hops, re-checking scheme and address each hop.
async function fetchFeedText(name, url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:') throw fetchError(name, 'a redirect left https');
    if (current.username || current.password) throw fetchError(name, 'a redirect added credentials');
    if (!portAllowed(current, process.env)) throw fetchError(name, 'the port is not allowed');
    await assertPublicHost(name, current.hostname);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.timeoutMs);
    try {
      let res;
      try {
        res = await fetcher(current.href, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'text/calendar, */*;q=0.5', 'User-Agent': 'icloud-mcp' },
        });
      } catch (error) {
        if (timedOut || error?.name === 'AbortError') throw fetchError(name, 'the request timed out');
        const code = typeof error?.cause?.code === 'string' && /^[A-Z_]+$/.test(error.cause.code) ? ` (${error.cause.code})` : '';
        throw fetchError(name, `the request failed${code}`);
      }
      const status = Number(res?.status);
      if (status >= 300 && status < 400) {
        const location = res.headers?.get?.('location');
        if (!location) throw fetchError(name, `HTTP ${status} without a location`);
        try {
          current = new URL(location, current);
        } catch {
          throw fetchError(name, 'a redirect target does not parse');
        }
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
        continue;
      }
      if (status !== 200) throw fetchError(name, `HTTP ${status}`);
      let text;
      try {
        text = await readBodyCapped(res, name, controller);
      } catch (error) {
        if (error instanceof SubscribedFetchError) throw error;
        if (timedOut || error?.name === 'AbortError') throw fetchError(name, 'the request timed out');
        throw fetchError(name, 'the response could not be read');
      }
      if (!looksLikeIcs(text)) throw fetchError(name, 'the response is not an iCalendar feed');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
  throw fetchError(name, 'too many redirects');
}

async function loadFeed(cal) {
  const key = cal.url.href;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < limits.cacheMs) return hit.parsed;
  const text = await fetchFeedText(cal.name, cal.url);
  let parsed;
  try {
    parsed = parseIcs(text, { maxEvents: limits.maxEvents });
  } catch (error) {
    if (error instanceof IcsTooManyEventsError) throw fetchError(cal.name, 'the feed has too many events');
    throw fetchError(cal.name, 'the feed could not be parsed');
  }
  cache.set(key, { at: now, parsed });
  return parsed;
}

// Expansion has a step, occurrence, and wall-clock budget. Blowing it is a
// generic error so a hostile feed neither stalls the server nor names itself.
function expandFeed(name, parsed, range) {
  try {
    return expandEvents(parsed, { ...range, limits: limits.expand });
  } catch (error) {
    if (error instanceof IcsBudgetError) throw fetchError(name, 'the feed is too large to expand');
    throw fetchError(name, 'the feed could not be expanded');
  }
}

// ─── Public API used by caldav.js ─────────────────────────────────────────────

export function listSubscribedCalendars(env = process.env) {
  if (!subscribedCalendarsEnabled(env)) return [];
  return loadSubscribedCalendars(env).map(({ calendarId, name }) => ({
    calendarId,
    name,
    href: null,
    supportedTypes: ['VEVENT'],
    syncToken: null,
    readOnly: true,
    subscribed: true,
  }));
}

function findSubscribedCalendar(calendarId, env) {
  if (!subscribedCalendarsEnabled(env)) {
    throw new Error(`Calendar not found: ${calendarId} (subscribed calendars are off; set ICLOUD_MCP_SUBSCRIBED_CALENDARS=on)`);
  }
  const cal = loadSubscribedCalendars(env).find((entry) => entry.calendarId === calendarId);
  if (!cal) throw new Error(`Calendar not found: ${calendarId}`);
  return cal;
}

function publicEvent(record, calendarId) {
  const { _startMs, _endMs, ...rest } = record;
  // Title, notes, and location come from a third-party feed: data, not instructions.
  return { calendarId, etag: null, ...rest, readOnly: true, source: 'subscribed', untrusted: true };
}

export async function listSubscribedEvents(calendarId, since = null, before = null, limit = 50, env = process.env) {
  const cal = findSubscribedCalendar(calendarId, env);
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 30 * 86400_000);
  const beforeDate = before ? new Date(before) : new Date(Date.now() + 30 * 86400_000);
  if (Number.isNaN(sinceDate.getTime()) || Number.isNaN(beforeDate.getTime())) throw new Error('since and before must be dates');
  const parsed = await loadFeed(cal);
  const events = expandFeed(cal.name, parsed, { since: sinceDate, before: beforeDate })
    .slice(0, limit)
    .map((record) => publicEvent(record, calendarId));
  return {
    events,
    count: events.length,
    calendarId,
    since: sinceDate.toISOString(),
    before: beforeDate.toISOString(),
    readOnly: true,
    source: 'subscribed',
  };
}

export async function getSubscribedEvent(calendarId, eventId, env = process.env) {
  const cal = findSubscribedCalendar(calendarId, env);
  const parsed = await loadFeed(cal);
  const id = String(eventId ?? '');
  const window = (centerMs) => ({ since: new Date(centerMs - 2 * 86400_000), before: new Date(centerMs + 3 * 86400_000) });

  // A single (non-recurring) event is addressed by its UID.
  const master = parsed.events.find((ev) => ev.fields.uid === id && !ev.recurrenceId);
  if (master) {
    const start = new Date(master.fields.start.length === 10 ? `${master.fields.start}T00:00:00Z` : master.fields.start);
    const found = expandFeed(cal.name, { events: [master], timezones: parsed.timezones }, window(start.getTime()))
      .find((record) => record.eventId === id);
    if (found) return publicEvent(found, calendarId);
  }

  // An occurrence is addressed by <uid>_<recurrence stamp>.
  const stampMatch = id.match(/^(.*)_(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?$/);
  if (stampMatch) {
    const center = Date.UTC(Number(stampMatch[2]), Number(stampMatch[3]) - 1, Number(stampMatch[4]));
    const found = expandFeed(cal.name, parsed, window(center)).find((record) => record.eventId === id);
    if (found) return publicEvent(found, calendarId);
  }
  throw new Error(`Event not found: ${calendarId}/${eventId}`);
}

// Case-insensitive title match across every configured subscribed calendar.
// A feed that fails is reported per calendar and does not fail the search.
export async function searchSubscribedEvents(query, since = null, before = null, env = process.env) {
  if (!subscribedCalendarsEnabled(env)) return { events: [], errors: [] };
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 365 * 86400_000);
  const beforeDate = before ? new Date(before) : new Date(Date.now() + 365 * 86400_000);
  const needle = String(query ?? '').toLowerCase();
  const events = [];
  const errors = [];
  let calendars;
  try {
    calendars = loadSubscribedCalendars(env);
  } catch (error) {
    return { events, errors: [{ calendarId: null, error: error.message }] };
  }
  for (const cal of calendars) {
    try {
      const parsed = await loadFeed(cal);
      for (const record of expandFeed(cal.name, parsed, { since: sinceDate, before: beforeDate })) {
        if (String(record.summary ?? '').toLowerCase().includes(needle)) events.push(publicEvent(record, cal.calendarId));
      }
    } catch (error) {
      errors.push({ calendarId: cal.calendarId, error: error.message });
    }
  }
  return { events, errors };
}
