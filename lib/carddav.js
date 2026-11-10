// ─── lib/carddav.js — iCloud CardDAV (Contacts) ──────────────────────────────
import { randomUUID } from 'crypto';

const CONTACTS_HOST = 'https://contacts.icloud.com';
const DAV_TIMEOUT_MS = 25_000;

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
  // A stuck request is aborted rather than left running after the tool call gives up.
  const res = await fetch(url, { method, headers, body: opts.body, signal: AbortSignal.timeout(DAV_TIMEOUT_MS) });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag'), body: text };
}

let davRequest = defaultDavRequest;

export function setCardDavRequestForTests(fn) {
  davRequest = fn || defaultDavRequest;
  _discoveryCache = null;
}

export function setCardDavDiscoveryForTests(cache) {
  _discoveryCache = cache;
}

function propfindBody(props) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<A:propfind xmlns:A="DAV:"><A:prop>${props}</A:prop></A:propfind>`;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

let _discoveryCache = null;

async function discover() {
  if (_discoveryCache) return _discoveryCache;

  // Step 1: well-known → current-user-principal
  const wk = await davRequest('PROPFIND', `${CONTACTS_HOST}/.well-known/carddav`, {
    depth: 0,
    contentType: 'application/xml; charset=utf-8',
    body: propfindBody('<A:current-user-principal/>'),
  });

  let principalPath = extractHrefIn(wk.body, 'current-user-principal');
  if (!principalPath) {
    const root = await davRequest('PROPFIND', `${CONTACTS_HOST}/`, {
      depth: 0,
      contentType: 'application/xml; charset=utf-8',
      body: propfindBody('<A:current-user-principal/>'),
    });
    principalPath = extractHrefIn(root.body, 'current-user-principal');
  }
  if (!principalPath) throw new Error('CardDAV: could not discover principal URL');

  // Step 2: principal → addressbook-home-set
  const principalUrl = toAbsolute(principalPath, CONTACTS_HOST);
  const principalResp = await davRequest('PROPFIND', principalUrl, {
    depth: 0,
    contentType: 'application/xml; charset=utf-8',
    body: propfindBody('<C:addressbook-home-set xmlns:C="urn:ietf:params:xml:ns:carddav"/>'),
  });

  const homeHref = extractHrefIn(principalResp.body, 'addressbook-home-set');
  if (!homeHref) throw new Error('CardDAV: could not find addressbook-home-set');

  const homeSetUrl = homeHref.startsWith('http') ? homeHref : null;
  // The home-set URL includes the partition host (e.g. p137-contacts.icloud.com)
  const dataHost = homeSetUrl ? new URL(homeSetUrl).origin : CONTACTS_HOST;
  const homeSetPath = homeHref.startsWith('http') ? new URL(homeHref).pathname : homeHref;

  // Step 3: list address books, find the main one (resourcetype = addressbook)
  const listing = await davRequest('PROPFIND', `${dataHost}${homeSetPath}`, {
    depth: 1,
    contentType: 'application/xml; charset=utf-8',
    body: propfindBody('<A:resourcetype/><A:displayname/>'),
  });

  const blocks = splitResponses(listing.body);
  let addressBookPath = null;
  for (const block of blocks) {
    if (block.includes('addressbook')) {
      const hrefMatch = block.match(/<[^>:]*:?href[^>]*>([^<]+)<\/[^>:]*:?href>/);
      if (hrefMatch) {
        const p = hrefMatch[1].startsWith('http') ? new URL(hrefMatch[1]).pathname : hrefMatch[1];
        if (!addressBookPath || p.includes('/card')) addressBookPath = p;
      }
    }
  }
  if (!addressBookPath) throw new Error('CardDAV: could not find address book');

  _discoveryCache = { dataHost, homeSetPath, addressBookPath };
  return _discoveryCache;
}

// ─── XML / text helpers ───────────────────────────────────────────────────────

// Caller text placed inside a request body. Without this a query containing
// & or < produces a malformed REPORT and the search fails.
function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toAbsolute(path, base) {
  return path.startsWith('http') ? path : `${base}${path}`;
}

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

// ─── vCard lines ──────────────────────────────────────────────────────────────
// A card is handled as a list of lines, not as a parsed object that is written
// back out. update_contact used to rebuild the card from the few fields this
// file understands, which deleted middle names, extra URLs and labels, moved
// custom labels onto the wrong entry, and marked every entry as preferred.
// Now only the lines for the fields a caller passes are edited; every other
// line is written back exactly as the server sent it.

function unescapeValue(text) {
  return String(text ?? '').replace(/\\([nN,;:\\])/g, (_, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

function escapeValue(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\;');
}

// For values that are not free text (phone numbers, email addresses, URLs,
// dates): no escaping, but nothing that could start a new line.
function cleanValue(text) {
  return String(text ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

// Splits on a separator that is not backslash-escaped.
function splitUnescaped(text, sep) {
  const parts = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) { current += text[i] + text[i + 1]; i++; continue; }
    if (text[i] === sep) { parts.push(current); current = ''; continue; }
    current += text[i];
  }
  parts.push(current);
  return parts;
}

// One logical line → { raw, group, name, params, value }. `raw` keeps the
// original (possibly folded) text.
function parseLine(raw, text) {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') inQuotes = !inQuotes;
    else if (text[i] === ':' && !inQuotes) { colon = i; break; }
  }
  if (colon < 0) return { raw, group: null, name: '', params: [], value: text };
  const headParts = text.slice(0, colon).split(';');
  let name = headParts[0];
  let group = null;
  const dot = name.indexOf('.');
  if (dot > 0) { group = name.slice(0, dot); name = name.slice(dot + 1); }
  const params = headParts.slice(1).map((part) => {
    const eq = part.indexOf('=');
    // vCard 2.1 style bare parameter (TEL;CELL) is a type.
    return eq < 0 ? { name: 'TYPE', value: part, bare: true } : { name: part.slice(0, eq).toUpperCase(), value: part.slice(eq + 1) };
  });
  return { raw, group, name: name.toUpperCase(), params, value: text.slice(colon + 1) };
}

function parseLines(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      const last = out[out.length - 1];
      last.raw += '\r\n' + line;
      last.text += line.slice(1);
    } else if (line !== '') {
      out.push({ raw: line, text: line });
    }
  }
  return out.map((entry) => parseLine(entry.raw, entry.text));
}

function makeLine(text) {
  return parseLine(text, text);
}

// Rebuilds a line's text from its parts (used when a parameter changes).
function renderLine(entry) {
  const params = entry.params.map((p) => (p.bare ? `;${p.value}` : `;${p.name === 'TYPE' ? 'type' : p.name}=${p.value}`)).join('');
  return `${entry.group ? `${entry.group}.` : ''}${entry.name}${params}:${entry.value}`;
}

function typesOf(entry) {
  return entry.params
    .filter((p) => p.name === 'TYPE')
    .flatMap((p) => p.value.replace(/^"|"$/g, '').split(','))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function isPreferred(entry) {
  return typesOf(entry).includes('pref') || entry.params.some((p) => p.name === 'PREF');
}

function setPreferred(entry, preferred) {
  if (isPreferred(entry) === preferred) return entry;
  let params = entry.params
    .map((p) => {
      if (p.name !== 'TYPE') return p;
      const kept = p.value.replace(/^"|"$/g, '').split(',').filter((t) => t.trim().toLowerCase() !== 'pref');
      return kept.length ? { ...p, value: kept.join(',') } : null;
    })
    .filter((p) => p && p.name !== 'PREF');
  if (preferred) params = [...params, { name: 'TYPE', value: 'pref' }];
  const next = { ...entry, params };
  next.raw = renderLine(next);
  return next;
}

// Properties that describe another property in the same group (item1.X-ABLabel
// labels item1.TEL). They are not entries in their own right. Apple also writes
// X-ABADR (an address's country code), which the old parser read as an address.
function isCompanion(entry) {
  return entry.group != null && (entry.name === 'X-ABLABEL' || entry.name === 'X-ABADR' || entry.name.startsWith('X-APPLE-'));
}

function companionsOf(entry, entries) {
  if (entry.group == null) return [];
  return entries.filter((other) => other !== entry && other.group === entry.group && isCompanion(other));
}

// "_$!<Work>!$_" is how Apple stores its built-in labels.
function readLabel(value) {
  const builtIn = String(value).match(/^_\$!<(.+)>!\$_$/);
  return builtIn ? builtIn[1].toLowerCase() : unescapeValue(value);
}

const IGNORED_TYPES = new Set(['pref', 'voice', 'internet']);

function entryType(entry, entries, fallback) {
  const label = companionsOf(entry, entries).find((c) => c.name === 'X-ABLABEL');
  if (label && readLabel(label.value).trim() !== '') return readLabel(label.value);
  const types = typesOf(entry).filter((t) => !IGNORED_TYPES.has(t));
  if (types.includes('fax')) return types.includes('home') ? 'home fax' : types.includes('work') ? 'work fax' : 'fax';
  if (types.includes('iphone')) return 'iphone';
  return types[0] || fallback;
}

function isGroupCard(entries) {
  return entries.some((e) => e.name === 'X-ADDRESSBOOKSERVER-KIND' && e.value.trim().toLowerCase() === 'group');
}

function birthdayText(entry) {
  const value = entry.value.trim();
  const m = value.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) return value;
  // Apple marks "no year" with a placeholder year in a parameter.
  if (entry.params.some((p) => p.name === 'X-APPLE-OMIT-YEAR')) return `--${m[2]}-${m[3]}`;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const digitsOf = (text) => String(text ?? '').replace(/\D/g, '');

// Two spellings of one phone number compare equal: punctuation is ignored, and
// so is a country code in front of a ten-digit number ("+1 555 555 0100" and
// "(555) 555-0100").
function phoneKey(text) {
  const digits = digitsOf(text);
  if (!digits) return String(text ?? '').trim().toLowerCase();
  return digits.length > 10 ? digits.slice(-10) : digits;
}

const HIDDEN_FROM_OTHER = new Set([
  'BEGIN', 'END', 'VERSION', 'PRODID', 'REV', 'UID', 'N', 'FN', 'NICKNAME', 'ORG', 'TITLE', 'BDAY', 'NOTE', 'URL',
  'TEL', 'EMAIL', 'ADR', 'PHOTO', 'LOGO', 'SOUND', 'KEY', 'X-IMAGEHASH', 'X-IMAGETYPE', 'X-SHARED-PHOTO-DISPLAY-PREF',
  'X-ABSHOWAS', 'X-ADDRESSING-GRAMMAR', 'X-ADDRESSBOOKSERVER-KIND', 'X-ADDRESSBOOKSERVER-MEMBER',
]);

// The view of a card that tools return. It never includes raw lines or photo
// data: one photo is tens of thousands of tokens.
function contactView(entries, { detail = false } = {}) {
  const first = (name) => entries.find((e) => e.name === name);
  const text = (name) => { const e = first(name); return e ? unescapeValue(e.value) : undefined; };

  const contact = {};
  const fn = text('FN');
  if (fn !== undefined) contact.fullName = fn;

  const n = first('N');
  const nameParts = n ? splitUnescaped(n.value, ';').map(unescapeValue) : [];
  contact.firstName = nameParts[1] || '';
  contact.lastName = nameParts[0] || '';
  if (nameParts[2]) contact.middleName = nameParts[2];
  if (nameParts[3]) contact.prefix = nameParts[3];
  if (nameParts[4]) contact.suffix = nameParts[4];

  const nickname = text('NICKNAME');
  if (nickname) contact.nickname = nickname;

  const org = first('ORG');
  if (org) {
    const parts = splitUnescaped(org.value, ';').map(unescapeValue);
    if (parts[0]) contact.org = parts[0];
    if (parts[1]) contact.department = parts[1];
  }
  const title = text('TITLE');
  if (title) contact.title = title;
  if ((first('X-ABSHOWAS')?.value || '').trim().toUpperCase() === 'COMPANY') contact.isCompany = true;

  const bday = first('BDAY');
  if (bday) contact.birthday = birthdayText(bday);
  const note = text('NOTE');
  if (note) contact.note = note;

  const urls = entries.filter((e) => e.name === 'URL').map((e) => cleanValue(unescapeValue(e.value)));
  if (urls.length) contact.url = urls[0];
  if (urls.length > 1) contact.urls = urls;

  contact.phones = entries.filter((e) => e.name === 'TEL').map((e) => ({
    type: entryType(e, entries, 'other'),
    number: e.value.trim(),
    ...(isPreferred(e) ? { preferred: true } : {}),
  }));
  contact.emails = entries.filter((e) => e.name === 'EMAIL').map((e) => ({
    type: entryType(e, entries, 'other'),
    email: e.value.trim(),
    ...(isPreferred(e) ? { preferred: true } : {}),
  }));
  contact.addresses = entries.filter((e) => e.name === 'ADR').map((e) => {
    const parts = splitUnescaped(e.value, ';').map(unescapeValue);
    return {
      type: entryType(e, entries, 'other'),
      street: parts[2] || '',
      city: parts[3] || '',
      state: parts[4] || '',
      zip: parts[5] || '',
      country: parts[6] || '',
    };
  });

  if (entries.some((e) => e.name === 'PHOTO')) contact.hasPhoto = true;
  const uid = first('UID');
  if (uid) contact.uid = uid.value.trim();
  const rev = first('REV');
  if (rev) contact.rev = rev.value.trim();

  if (detail) {
    // Everything else on the card (related names, social profiles, dates…),
    // so a caller can see it. These fields are kept on update but not editable.
    const other = entries
      .filter((e) => e.name && !HIDDEN_FROM_OTHER.has(e.name) && !isCompanion(e) && !e.name.startsWith('VND-'))
      .filter((e) => !e.params.some((p) => p.name === 'ENCODING'))
      .map((e) => {
        const label = companionsOf(e, entries).find((c) => c.name === 'X-ABLABEL');
        const value = unescapeValue(e.value);
        return {
          field: e.name.toLowerCase(),
          ...(label ? { label: readLabel(label.value) } : {}),
          value: value.length > 200 ? `${value.slice(0, 200)}…` : value,
        };
      });
    if (other.length) contact.other = other;
  }
  return contact;
}

// ─── Building lines ───────────────────────────────────────────────────────────

// "cell" and "mobile" are the same type, as are "fax" and "work fax"; they share
// one array so a caller using either name matches an existing entry.
const CELL = ['CELL', 'VOICE'];
const WORK_FAX = ['WORK', 'FAX'];
const PHONE_TYPES = {
  cell: CELL, mobile: CELL, iphone: ['IPHONE', 'CELL', 'VOICE'],
  home: ['HOME', 'VOICE'], work: ['WORK', 'VOICE'], main: ['MAIN'], pager: ['PAGER'],
  fax: WORK_FAX, 'work fax': WORK_FAX, 'home fax': ['HOME', 'FAX'],
};
const EMAIL_TYPES = { home: ['INTERNET', 'HOME'], work: ['INTERNET', 'WORK'] };
const ADDRESS_TYPES = { home: ['HOME'], work: ['WORK'] };

function nextGroup(entries) {
  let max = 0;
  for (const e of entries) {
    const m = e.group && e.group.match(/^item(\d+)$/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `item${max + 1}`;
}

// Lines for one phone, email or address. A type Apple has a parameter for is
// written as a parameter; anything else becomes a labelled group, which is how
// Contacts stores custom labels.
function buildEntry(name, value, type, standardTypes, defaultType, preferred, entries, extraParams = []) {
  const wanted = String(type ?? defaultType).trim().toLowerCase() || defaultType;
  const known = standardTypes[wanted];
  const pref = preferred ? ';type=pref' : '';
  if (known) {
    return [makeLine(`${name}${[...extraParams, ...known].filter((t, i, all) => all.indexOf(t) === i).map((t) => `;type=${t}`).join('')}${pref}:${value}`)];
  }
  const group = nextGroup(entries);
  const label = wanted === 'other' ? '_$!<Other>!$_' : escapeValue(String(type).trim());
  return [
    makeLine(`${group}.${name}${extraParams.map((t) => `;type=${t}`).join('')}${pref}:${value}`),
    makeLine(`${group}.X-ABLabel:${label}`),
  ];
}

function birthdayLine(value) {
  const text = cleanValue(value);
  const noYear = text.match(/^--(\d{2})-?(\d{2})$/);
  if (noYear) return `BDAY;X-APPLE-OMIT-YEAR=1604;value=date:1604-${noYear[1]}-${noYear[2]}`;
  const full = text.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!full) throw new Error(`Invalid birthday "${text.slice(0, 40)}". Use YYYY-MM-DD, or --MM-DD when the year is unknown.`);
  return `BDAY;value=date:${full[1]}-${full[2]}-${full[3]}`;
}

// ─── Editing a card in place ──────────────────────────────────────────────────

const given = (value) => value !== undefined && value !== null;

// Replaces the first `name` line with `line` (keeping its group) and drops any
// further ones; removes them all when line is null; appends when there is none.
function setSingle(entries, name, line) {
  const out = [];
  let placed = false;
  for (const entry of entries) {
    if (entry.name !== name) { out.push(entry); continue; }
    if (line != null && !placed) {
      out.push(makeLine(`${entry.group ? `${entry.group}.` : ''}${line}`));
      placed = true;
    }
  }
  if (line != null && !placed) out.push(makeLine(line));
  return out;
}

function composeName(parts) {
  return [parts[3], parts[1], parts[2], parts[0], parts[4]].filter(Boolean).join(' ');
}

function asList(value, label, key) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => {
    const obj = typeof item === 'string' ? { [key]: item } : item;
    if (!obj || typeof obj !== 'object') throw new Error(`Each entry in ${label} must be an object`);
    return obj;
  });
}

function addressValue(a, existingParts = []) {
  return [
    existingParts[0] ?? '', existingParts[1] ?? '',
    escapeValue(a.street ?? ''), escapeValue(a.city ?? ''), escapeValue(a.state ?? ''),
    escapeValue(a.zip ?? ''), escapeValue(a.country ?? ''),
  ].join(';');
}

const addressKey = (parts) => parts.slice(2, 7).map((p) => unescapeValue(p || '').trim().toLowerCase()).join('|');

const KINDS = {
  TEL: {
    key: 'number', fallback: 'other', defaultType: 'cell', standard: PHONE_TYPES, extra: [],
    value: (item) => {
      const number = cleanValue(item.number);
      if (!number) throw new Error('Each phone needs a number');
      return number;
    },
    matchKey: (value) => phoneKey(value),
  },
  EMAIL: {
    key: 'email', fallback: 'other', defaultType: 'home', standard: EMAIL_TYPES, extra: ['INTERNET'],
    value: (item) => {
      const email = cleanValue(item.email);
      if (!email || !email.includes('@') || /[\s;,]/.test(email)) throw new Error('Each email needs a valid address');
      return email;
    },
    matchKey: (value) => value.trim().toLowerCase(),
  },
  ADR: {
    key: 'street', fallback: 'other', defaultType: 'home', standard: ADDRESS_TYPES, extra: [],
    value: (item) => addressValue(item),
    matchKey: (value) => addressKey(splitUnescaped(value, ';')),
  },
};

// Replaces every `name` entry with `items`. An item that matches an existing
// entry (same number, address or email) keeps that entry's lines untouched, so
// reading a list, adding one item and writing it back does not disturb labels.
function replaceList(entries, name, items) {
  const kind = KINDS[name];
  const existing = entries.filter((e) => e.name === name);
  const used = new Set();
  let working = entries;
  const blocks = [];

  for (const item of items) {
    const value = kind.value(item);
    const match = existing.find((e) => !used.has(e) && kind.matchKey(e.value) === kind.matchKey(value));
    const wantedType = given(item.type) ? String(item.type).trim().toLowerCase() : null;
    if (match) {
      used.add(match);
      const currentType = entryType(match, entries, kind.fallback).trim().toLowerCase();
      const sameType = wantedType === null || wantedType === currentType
        || (kind.standard[wantedType] && kind.standard[wantedType] === kind.standard[currentType]);
      if (sameType) {
        const kept = given(item.preferred) ? setPreferred(match, !!item.preferred) : match;
        blocks.push([kept, ...companionsOf(match, entries)]);
        continue;
      }
    }
    const preferred = given(item.preferred) ? !!item.preferred : (match ? isPreferred(match) : false);
    const lineValue = name === 'ADR' && match
      ? addressValue(item, splitUnescaped(match.value, ';'))
      : value;
    const built = buildEntry(name, lineValue, item.type, kind.standard, kind.defaultType, preferred, [...working, ...blocks.flat()], kind.extra);
    blocks.push(built);
  }

  const removed = new Set(existing.flatMap((e) => [e, ...companionsOf(e, entries)]));
  const firstAt = working.findIndex((e) => removed.has(e));
  working = working.filter((e) => !removed.has(e));
  const flat = blocks.flat();
  if (firstAt < 0) return [...working, ...flat];
  const insertAt = Math.min(firstAt, working.length);
  return [...working.slice(0, insertAt), ...flat, ...working.slice(insertAt)];
}

// `phone` / `email`: make this the primary one. It is added when the contact
// does not have it; existing entries are kept, only their "preferred" mark moves.
function setPrimary(entries, name, rawValue) {
  const kind = KINDS[name];
  const value = kind.value({ [kind.key]: rawValue });
  const existing = entries.find((e) => e.name === name && kind.matchKey(e.value) === kind.matchKey(value));
  if (existing && isPreferred(existing)) return entries; // already the primary one
  let out = entries.map((e) => (e.name === name ? setPreferred(e, e === existing) : e));
  if (!existing) {
    const built = buildEntry(name, value, null, kind.standard, kind.defaultType, true, out, kind.extra);
    let lastAt = -1;
    out.forEach((e, i) => { if (e.name === name || (isCompanion(e) && out.some((o) => o.name === name && o.group === e.group))) lastAt = i; });
    out = lastAt < 0 ? [...out, ...built] : [...out.slice(0, lastAt + 1), ...built, ...out.slice(lastAt + 1)];
  }
  return out;
}

const TEXT_PROPS = [['nickname', 'NICKNAME'], ['title', 'TITLE'], ['note', 'NOTE']];

export function patchVCard(text, fields = {}) {
  const all = parseLines(text);
  const begin = all.findIndex((e) => e.name === 'BEGIN' && e.value.trim().toUpperCase() === 'VCARD');
  const end = all.findIndex((e, i) => i > begin && e.name === 'END' && e.value.trim().toUpperCase() === 'VCARD');
  if (begin < 0 || end < 0) throw new Error('This item is not a contact card');
  let entries = all.slice(begin + 1, end);
  if (isGroupCard(entries)) throw new Error('This item is a contact group, not a contact; it cannot be edited here');

  // Name
  const nameKeys = ['lastName', 'firstName', 'middleName', 'prefix', 'suffix'];
  const nameChanged = nameKeys.some((key) => given(fields[key]));
  if (nameChanged) {
    const current = entries.find((e) => e.name === 'N');
    const parts = current ? splitUnescaped(current.value, ';').map(unescapeValue) : [];
    while (parts.length < 5) parts.push('');
    nameKeys.forEach((key, i) => { if (given(fields[key])) parts[i] = String(fields[key]).trim(); });
    entries = setSingle(entries, 'N', `N:${parts.slice(0, 5).map(escapeValue).join(';')}`);
    if (!given(fields.fullName)) {
      const composed = composeName(parts);
      if (composed) entries = setSingle(entries, 'FN', `FN:${escapeValue(composed)}`);
    }
  }
  if (given(fields.fullName) && String(fields.fullName).trim() !== '') {
    entries = setSingle(entries, 'FN', `FN:${escapeValue(String(fields.fullName).trim())}`);
  }

  // Organization
  if (given(fields.org) || given(fields.department)) {
    const current = entries.find((e) => e.name === 'ORG');
    const parts = current ? splitUnescaped(current.value, ';').map(unescapeValue) : [];
    const org = given(fields.org) ? String(fields.org).trim() : (parts[0] || '');
    const dept = given(fields.department) ? String(fields.department).trim() : (parts[1] || '');
    entries = setSingle(entries, 'ORG', org || dept ? `ORG:${escapeValue(org)};${escapeValue(dept)}` : null);
  }

  for (const [key, name] of TEXT_PROPS) {
    if (!given(fields[key])) continue;
    const value = String(fields[key]);
    entries = setSingle(entries, name, value === '' ? null : `${name}:${escapeValue(value)}`);
  }

  if (given(fields.birthday)) {
    entries = setSingle(entries, 'BDAY', String(fields.birthday).trim() === '' ? null : birthdayLine(fields.birthday));
  }

  // `url` sets the first URL; any others stay.
  if (given(fields.url)) {
    const value = cleanValue(fields.url);
    const firstUrl = entries.find((e) => e.name === 'URL');
    if (firstUrl) {
      const replacement = value === '' ? null : makeLine(`${firstUrl.group ? `${firstUrl.group}.` : ''}URL${firstUrl.params.map((p) => (p.bare ? `;${p.value}` : `;${p.name === 'TYPE' ? 'type' : p.name}=${p.value}`)).join('')}:${value}`);
      const drop = replacement ? new Set() : new Set(companionsOf(firstUrl, entries));
      entries = entries.flatMap((e) => (e === firstUrl ? (replacement ? [replacement] : []) : (drop.has(e) ? [] : [e])));
    } else if (value !== '') {
      entries = [...entries, makeLine(`URL:${value}`)];
    }
  }

  if (given(fields.phones)) entries = replaceList(entries, 'TEL', asList(fields.phones, 'phones', 'number'));
  if (given(fields.emails)) entries = replaceList(entries, 'EMAIL', asList(fields.emails, 'emails', 'email'));
  if (given(fields.addresses)) entries = replaceList(entries, 'ADR', asList(fields.addresses, 'addresses', 'street'));
  if (given(fields.phone) && String(fields.phone).trim() !== '') entries = setPrimary(entries, 'TEL', fields.phone);
  if (given(fields.email) && String(fields.email).trim() !== '') entries = setPrimary(entries, 'EMAIL', fields.email);

  entries = setSingle(entries, 'REV', `REV:${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`);

  const out = [...all.slice(0, begin + 1), ...entries, ...all.slice(end)];
  return out.map((e) => e.raw).join('\r\n') + '\r\n';
}

// A new card is an empty card with the fields applied by the same code path.
function newVCard(fields, uid) {
  const skeleton = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//icloud-mcp//EN', 'N:;;;;', `UID:${uid}`, 'END:VCARD', ''].join('\r\n');
  let card = patchVCard(skeleton, fields);
  const entries = parseLines(card);
  if (!entries.some((e) => e.name === 'FN' && e.value.trim() !== '')) {
    // No personal name: show the company, as Contacts does for a business card.
    const org = given(fields.org) ? String(fields.org).trim() : '';
    const lines = card.split('\r\n').filter((line) => line !== '' && !/^FN:/i.test(line));
    const at = lines.findIndex((line) => /^N:/i.test(line)) + 1;
    lines.splice(at, 0, `FN:${escapeValue(org || 'Unknown')}`, ...(org ? ['X-ABShowAs:COMPANY'] : []));
    card = lines.join('\r\n') + '\r\n';
  }
  return card;
}

// ─── Parse REPORT response blocks ────────────────────────────────────────────

// iCloud returns card text entity-escaped inside <address-data>.
function xmlUnescape(text) {
  const cdata = text.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1];
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseContactBlocks(xml) {
  return splitResponses(xml).map(block => {
    const hrefMatch = block.match(/<[^>:]*:?href[^>]*>([^<]+)<\/[^>:]*:?href>/);
    const etagMatch = block.match(/<[^>:]*:?getetag[^>]*>"?([^"<]+)"?<\/[^>:]*:?getetag>/);
    const dataMatch = block.match(/<[^>:]*:?address-data[^>]*>([\s\S]*?)<\/[^>:]*:?address-data>/i);
    if (!hrefMatch || !dataMatch) return null;

    const filename = hrefMatch[1].split('/').pop();
    const contactId = filename.replace(/\.vcf$/i, '');
    const entries = parseLines(xmlUnescape(dataMatch[1]));
    // A contact group is stored as a card too. It is not a person.
    if (isGroupCard(entries)) return null;
    return { contactId, etag: etagMatch?.[1] || null, ...contactView(entries) };
  }).filter(Boolean);
}

function assertOk(resp, what) {
  if (resp.status === 207 || resp.status === 200) return;
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Contacts ${what} was refused (${resp.status}). Check that IMAP_PASSWORD is a current app-specific password.`);
  }
  throw new Error(`Contacts ${what} failed: HTTP ${resp.status}`);
}

function byName(a, b) {
  const name = (c) => (c.fullName || `${c.firstName} ${c.lastName}`).trim().toLowerCase();
  return name(a).localeCompare(name(b)) || String(a.contactId).localeCompare(String(b.contactId));
}

// ─── Public API ───────────────────────────────────────────────────────────────

// iCloud ignores both a result limit and a request for a subset of fields, so
// every listing reads the whole address book. Sorting by name here makes paging
// stable: before, offset sliced whatever order the server happened to return.
export async function listContacts(limit = 50, offset = 0) {
  const { dataHost, addressBookPath } = await discover();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:addressbook-query xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:A="DAV:">
  <A:prop><A:getetag/><C:address-data/></A:prop>
  <C:filter/>
</C:addressbook-query>`;

  const resp = await davRequest('REPORT', `${dataHost}${addressBookPath}`, {
    depth: 1,
    contentType: 'application/xml; charset=utf-8',
    body,
  });
  assertOk(resp, 'listing');

  const size = Math.max(1, Math.min(Number(limit) || 50, 500));
  const start = Math.max(0, Number(offset) || 0);
  const all = parseContactBlocks(resp.body).sort(byName);
  const contacts = all.slice(start, start + size);
  return { contacts, count: contacts.length, total: all.length, limit: size, offset: start, hasMore: start + contacts.length < all.length };
}

const SEARCH_PROPS = ['FN', 'EMAIL', 'TEL', 'ORG', 'NICKNAME', 'NOTE'];

function searchBody(filters) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<C:addressbook-query xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:A="DAV:">
  <A:prop><A:getetag/><C:address-data/></A:prop>
  <C:filter test="anyof">${filters.map(([prop, text]) => `
    <C:prop-filter name="${prop}">
      <C:text-match collation="i;unicode-casemap" match-type="contains">${xmlEscape(text)}</C:text-match>
    </C:prop-filter>`).join('')}
  </C:filter>
</C:addressbook-query>`;
}

export async function searchContacts(query, limit = 25) {
  const text = String(query ?? '').trim();
  if (!text) throw new Error('A search query is required');
  const { dataHost, addressBookPath } = await discover();
  const url = `${dataHost}${addressBookPath}`;
  const opts = { depth: 1, contentType: 'application/xml; charset=utf-8' };

  const resp = await davRequest('REPORT', url, { ...opts, body: searchBody(SEARCH_PROPS.map((prop) => [prop, text])) });
  assertOk(resp, 'search');
  const found = new Map(parseContactBlocks(resp.body).map((c) => [c.contactId, c]));

  // A phone number is stored in whatever format it was typed, so "5550100"
  // would not match "(555) 555-0100". Ask the server for the last four digits
  // and compare digits only.
  const digits = digitsOf(text);
  if (digits.length >= 4 && /^[\d\s()+.\-]+$/.test(text)) {
    const byTail = await davRequest('REPORT', url, { ...opts, body: searchBody([['TEL', digits.slice(-4)]]) });
    assertOk(byTail, 'search');
    for (const c of parseContactBlocks(byTail.body)) {
      if (c.phones.some((p) => digitsOf(p.number).includes(digits) || (digits.length >= 10 && digits.endsWith(digitsOf(p.number).slice(-10)) && digitsOf(p.number).length >= 7))) {
        found.set(c.contactId, c);
      }
    }
  }

  const size = Math.max(1, Math.min(Number(limit) || 25, 200));
  const all = [...found.values()].sort(byName);
  const contacts = all.slice(0, size);
  return { contacts, count: contacts.length, total: all.length, query: text, ...(all.length > contacts.length ? { truncated: true } : {}) };
}

export async function getContact(contactId) {
  const { dataHost, addressBookPath } = await discover();
  const url = `${dataHost}${addressBookPath}${contactId}.vcf`;
  const resp = await davRequest('GET', url);

  if (resp.status === 404) throw new Error(`Contact not found: ${contactId}`);
  if (resp.status >= 400) throw new Error(`CardDAV GET failed: ${resp.status}`);

  return { contactId, etag: resp.etag, ...contactView(parseLines(resp.body), { detail: true }) };
}

export async function createContact(fields) {
  const { dataHost, addressBookPath } = await discover();
  const named = ['firstName', 'lastName', 'fullName', 'org'].some((key) => given(fields?.[key]) && String(fields[key]).trim() !== '');
  if (!named) throw new Error('A new contact needs a name or an organization');
  const contactId = randomUUID().toUpperCase();
  const vcard = newVCard({ ...fields }, contactId);
  const url = `${dataHost}${addressBookPath}${contactId}.vcf`;

  const resp = await davRequest('PUT', url, {
    contentType: 'text/vcard; charset=utf-8',
    body: vcard,
  });

  if (resp.status !== 201 && resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CardDAV PUT failed: ${resp.status} — ${resp.body.slice(0, 200)}`);
  }

  return { created: true, contactId, etag: resp.etag };
}

export async function updateContact(contactId, fields) {
  const { dataHost, addressBookPath } = await discover();
  const url = `${dataHost}${addressBookPath}${contactId}.vcf`;

  const existing = await davRequest('GET', url);
  if (existing.status === 404) throw new Error(`Contact not found: ${contactId}`);
  if (existing.status >= 400) throw new Error(`CardDAV GET failed: ${existing.status}`);

  const vcard = patchVCard(existing.body, fields);

  // If-Match: a change made on another device since the GET is not overwritten.
  const resp = await davRequest('PUT', url, {
    contentType: 'text/vcard; charset=utf-8',
    etag: existing.etag,
    body: vcard,
  });

  if (resp.status === 412) {
    throw new Error('The contact changed on the server while it was being updated. Nothing was written; try again.');
  }
  if (resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CardDAV PUT (update) failed: ${resp.status} — ${resp.body.slice(0, 200)}`);
  }

  return { updated: true, contactId, etag: resp.etag };
}

export async function deleteContact(contactId, dryRun = false) {
  if (dryRun) {
    const contact = await getContact(contactId);
    return {
      dryRun: true,
      wouldDelete: true,
      contactId,
      changes: [{
        action: 'delete_contact',
        contactId,
        fullName: contact.fullName || null,
        emails: contact.emails || [],
        phones: contact.phones || [],
      }],
    };
  }
  const { dataHost, addressBookPath } = await discover();
  const url = `${dataHost}${addressBookPath}${contactId}.vcf`;

  const resp = await davRequest('DELETE', url);
  if (resp.status === 404) throw new Error(`Contact not found: ${contactId}`);
  if (resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CardDAV DELETE failed: ${resp.status}`);
  }

  return { deleted: true, contactId };
}
