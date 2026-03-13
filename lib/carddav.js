// ─── lib/carddav.js — iCloud CardDAV (Contacts) ──────────────────────────────
import { randomUUID } from 'crypto';

const CONTACTS_HOST = 'https://contacts.icloud.com';

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

// ─── VCARD value escaping ─────────────────────────────────────────────────────

// VCARD 3.0: newlines in values must be \n (backslash-n), not actual newlines
function vcardEscape(str) {
  if (!str) return str;
  return str.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '');
}

function vcardUnescape(str) {
  if (!str) return str;
  return str.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// ─── VCARD parsing ────────────────────────────────────────────────────────────

function parseVCard(text) {
  // Unfold continuation lines (CRLF + SPACE/TAB)
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/).filter(l => l && l !== 'BEGIN:VCARD' && l !== 'END:VCARD');

  const contact = { phones: [], emails: [], addresses: [], _rawLines: [] };

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const fullKey = line.slice(0, colonIdx);
    const val = line.slice(colonIdx + 1);
    const key = fullKey.split(';')[0].toUpperCase();

    switch (key) {
      case 'VERSION': break;
      case 'PRODID': break;
      case 'FN': contact.fullName = val; break;
      case 'UID': contact.uid = val; break;
      case 'ORG': contact.org = val.replace(/;$/, '').trim(); break;
      case 'BDAY': contact.birthday = val; break;
      case 'REV': contact.rev = val; break;
      case 'NOTE': contact.note = vcardUnescape(val); break;
      case 'URL': contact.url = vcardUnescape(val); break;
      case 'N': {
        const parts = val.split(';');
        contact.lastName = parts[0] || '';
        contact.firstName = parts[1] || '';
        break;
      }
      default: {
        if (key.includes('TEL')) {
          const typeMatch = fullKey.match(/type=([^;:]+)/i);
          const rawType = typeMatch?.[1]?.toLowerCase() || 'phone';
          // Skip 'pref' as the type label, use the next type if available
          const types = fullKey.match(/type=([^;:]+)/gi)?.map(t => t.split('=')[1].toLowerCase()) || [];
          const type = types.find(t => t !== 'pref') || rawType;
          contact.phones.push({ type, number: val });
        } else if (key.includes('EMAIL')) {
          const types = fullKey.match(/type=([^;:]+)/gi)?.map(t => t.split('=')[1].toLowerCase()) || [];
          const type = types.find(t => !['internet', 'pref'].includes(t)) || 'home';
          contact.emails.push({ type, email: val });
        } else if (key.includes('ADR')) {
          const parts = val.split(';');
          const types = fullKey.match(/type=([^;:]+)/gi)?.map(t => t.split('=')[1].toLowerCase()) || [];
          const type = types.find(t => t !== 'pref') || 'home';
          contact.addresses.push({
            type,
            street: parts[2] || '',
            city: parts[3] || '',
            state: parts[4] || '',
            zip: parts[5] || '',
            country: parts[6] || '',
          });
        } else {
          // Preserve unknown lines: PHOTO, X-*, item*.X-ABLabel, TITLE, etc.
          contact._rawLines.push(line);
        }
      }
    }
  }

  return contact;
}

// ─── VCARD serialization ──────────────────────────────────────────────────────

function serializeVCard(fields, uid = null) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//icloud-mcp//EN',
  ];
  const vcardUid = uid || randomUUID().toUpperCase();

  const fn = fields.fullName ||
    [fields.firstName, fields.lastName].filter(Boolean).join(' ') ||
    fields.org || 'Unknown';

  lines.push(`N:${fields.lastName || ''};${fields.firstName || ''};;;`);
  lines.push(`FN:${fn}`);

  if (fields.org) lines.push(`ORG:${fields.org};`);
  if (fields.birthday) lines.push(`BDAY:${fields.birthday}`);
  if (fields.note) lines.push(`NOTE:${vcardEscape(fields.note)}`);
  if (fields.url) lines.push(`URL:${vcardEscape(fields.url)}`);

  const phones = normalizeArray(fields.phones, fields.phone ? { number: fields.phone, type: 'cell' } : null);
  phones.forEach((p, i) => {
    lines.push(`item${i + 1}.TEL;type=${(p.type || 'cell').toLowerCase()};type=pref:${p.number}`);
  });

  const emails = normalizeArray(fields.emails, fields.email ? { email: fields.email, type: 'home' } : null);
  emails.forEach(e => {
    lines.push(`EMAIL;type=INTERNET;type=${(e.type || 'home').toLowerCase()};type=pref:${e.email}`);
  });

  const addresses = Array.isArray(fields.addresses) ? fields.addresses : [];
  addresses.forEach(a => {
    lines.push(`ADR;type=${(a.type || 'home').toLowerCase()};type=pref:;;${a.street || ''};${a.city || ''};${a.state || ''};${a.zip || ''};${a.country || ''}`);
  });

  // Preserve unknown fields from the original VCARD (PHOTO, X-*, item*.X-ABLabel, etc.)
  if (Array.isArray(fields._rawLines)) {
    for (const rawLine of fields._rawLines) lines.push(rawLine);
  }

  lines.push(`UID:${vcardUid}`);
  const rev = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  lines.push(`REV:${rev}`);
  lines.push('END:VCARD');

  return lines.join('\r\n') + '\r\n';
}

function normalizeArray(arr, fallback) {
  if (Array.isArray(arr) && arr.length) return arr;
  if (fallback) return [fallback];
  return [];
}

// ─── Parse REPORT response blocks ────────────────────────────────────────────

function parseContactBlocks(xml) {
  return splitResponses(xml).map(block => {
    const hrefMatch = block.match(/<[^>:]*:?href[^>]*>([^<]+)<\/[^>:]*:?href>/);
    const etagMatch = block.match(/<[^>:]*:?getetag[^>]*>"?([^"<]+)"?<\/[^>:]*:?getetag>/);
    const dataMatch = block.match(/<[^>:]*:?address-data[^>]*>([\s\S]*?)<\/[^>:]*:?address-data>/i);
    if (!hrefMatch || !dataMatch) return null;

    const href = hrefMatch[1];
    const filename = href.split('/').pop();
    const contactId = filename.replace(/\.vcf$/i, '');
    const vcard = dataMatch[1].replace(/&#13;/g, '\r');
    const contact = parseVCard(vcard);

    return { contactId, etag: etagMatch?.[1] || null, href, ...contact };
  }).filter(Boolean);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function listContacts(limit = 50, offset = 0) {
  const { dataHost, addressBookPath } = await discover();

  const fetchLimit = limit + offset;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:addressbook-query xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:A="DAV:">
  <A:prop><A:getetag/><C:address-data/></A:prop>
  <C:filter/>
  <C:limit><C:nresults>${fetchLimit}</C:nresults></C:limit>
</C:addressbook-query>`;

  const resp = await davRequest('REPORT', `${dataHost}${addressBookPath}`, {
    depth: 1,
    contentType: 'application/xml; charset=utf-8',
    body,
  });

  const contacts = parseContactBlocks(resp.body).slice(offset, offset + limit);
  return { contacts, count: contacts.length, limit, offset };
}

export async function searchContacts(query) {
  const { dataHost, addressBookPath } = await discover();

  // Search FN, EMAIL, TEL — run three queries and merge
  const makeQuery = (propName) => `<?xml version="1.0" encoding="UTF-8"?>
<C:addressbook-query xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:A="DAV:">
  <A:prop><A:getetag/><C:address-data/></A:prop>
  <C:filter>
    <C:prop-filter name="${propName}">
      <C:text-match collation="i;unicode-casemap" match-type="contains">${query}</C:text-match>
    </C:prop-filter>
  </C:filter>
</C:addressbook-query>`;

  const url = `${dataHost}${addressBookPath}`;
  const opts = { depth: 1, contentType: 'application/xml; charset=utf-8' };

  const [fnResp, emailResp, telResp] = await Promise.all([
    davRequest('REPORT', url, { ...opts, body: makeQuery('FN') }),
    davRequest('REPORT', url, { ...opts, body: makeQuery('EMAIL') }),
    davRequest('REPORT', url, { ...opts, body: makeQuery('TEL') }),
  ]);

  // Merge and deduplicate by contactId
  const seen = new Set();
  const results = [];
  for (const resp of [fnResp, emailResp, telResp]) {
    for (const c of parseContactBlocks(resp.body)) {
      if (!seen.has(c.contactId)) {
        seen.add(c.contactId);
        results.push(c);
      }
    }
  }

  return { contacts: results, count: results.length, query };
}

export async function getContact(contactId) {
  const { dataHost, addressBookPath } = await discover();
  const url = `${dataHost}${addressBookPath}${contactId}.vcf`;
  const resp = await davRequest('GET', url);

  if (resp.status === 404) throw new Error(`Contact not found: ${contactId}`);
  if (resp.status >= 400) throw new Error(`CardDAV GET failed: ${resp.status}`);

  const contact = parseVCard(resp.body);
  return { contactId, etag: resp.etag, ...contact };
}

export async function createContact(fields) {
  const { dataHost, addressBookPath } = await discover();
  const contactId = randomUUID().toUpperCase();
  const vcard = serializeVCard({ ...fields }, contactId);
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

  // Fetch existing to get etag and merge fields
  const existing = await davRequest('GET', url);
  if (existing.status === 404) throw new Error(`Contact not found: ${contactId}`);

  const current = parseVCard(existing.body);

  // Merge: new fields override, but keep arrays from existing if not overridden
  const merged = { ...current, ...fields };
  // Preserve the original VCARD UID (which may differ from the filename UUID)
  const vcard = serializeVCard(merged, current.uid || contactId);

  const resp = await davRequest('PUT', url, {
    contentType: 'text/vcard; charset=utf-8',
    etag: existing.etag,
    body: vcard,
  });

  if (resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CardDAV PUT (update) failed: ${resp.status} — ${resp.body.slice(0, 200)}`);
  }

  return { updated: true, contactId, etag: resp.etag };
}

export async function deleteContact(contactId) {
  const { dataHost, addressBookPath } = await discover();
  const url = `${dataHost}${addressBookPath}${contactId}.vcf`;

  const resp = await davRequest('DELETE', url);
  if (resp.status === 404) throw new Error(`Contact not found: ${contactId}`);
  if (resp.status !== 204 && resp.status !== 200) {
    throw new Error(`CardDAV DELETE failed: ${resp.status}`);
  }

  return { deleted: true, contactId };
}
