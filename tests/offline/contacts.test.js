// update_contact edits a card in place, reads never return photo data, a failed
// request is an error, and lists are sorted and complete. Every request here
// goes to a fake server; nothing in this file touches a real address book.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.IMAP_USER = 'you@icloud.com';
process.env.IMAP_PASSWORD = 'fake-app-password';

const {
  patchVCard, listContacts, searchContacts, getContact, createContact, updateContact,
  setCardDavRequestForTests, setCardDavDiscoveryForTests,
} = await import('../../lib/carddav.js');

// A card as an iPhone writes it: full name parts, a custom label on an email,
// a labelled second phone, an address with Apple's country-code companion, a
// year-less birthday, two URLs, a related name, a social profile and a photo.
const CARD_LINES = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//iOS 18.0//EN',
  'N:Smith;Jane;Marie;Dr.;Jr.',
  'FN:Dr. Jane Marie Smith Jr.',
  'NICKNAME:JJ',
  'ORG:AT&T;Research',
  'TITLE:Director',
  'item1.EMAIL;type=INTERNET;type=pref:jane@work.example',
  'item1.X-ABLabel:Assistant',
  'EMAIL;type=INTERNET;type=HOME:jane@home.example',
  'TEL;type=CELL;type=VOICE;type=pref:+1 (555) 555-0100',
  'item2.TEL:+1-555-555-0111',
  'item2.X-ABLabel:Lab',
  'item3.ADR;type=HOME;type=pref:;;1 Main St\\, Apt 2;Baltimore;MD;21201;United States',
  'item3.X-ABADR:us',
  'BDAY;X-APPLE-OMIT-YEAR=1604;value=date:1604-01-15',
  'URL;type=WORK:https://work.example',
  'URL;type=HOME:https://home.example',
  'item4.X-ABRELATEDNAMES:Sam Smith',
  'item4.X-ABLabel:_$!<Spouse>!$_',
  'X-SOCIALPROFILE;type=linkedin:https://linkedin.example/jane',
  `PHOTO;ENCODING=b;TYPE=JPEG:${'/9j/4AAQSkZJRg'.repeat(4)}`,
  ` ${'AAAA'.repeat(15)}`,
  'NOTE:Met at conference',
  'REV:2026-01-01T00:00:00Z',
  'UID:ABC-123',
  'END:VCARD',
];
const CARD = CARD_LINES.join('\r\n') + '\r\n';

const linesOf = (text) => text.split('\r\n').filter(Boolean);
const withoutRev = (lines) => lines.filter((line) => !line.startsWith('REV:'));

// What changed between the fixture and a patched card, ignoring REV.
function diff(patched) {
  const before = withoutRev(CARD_LINES);
  const after = withoutRev(linesOf(patched));
  return {
    removed: before.filter((line) => !after.includes(line)),
    added: after.filter((line) => !before.includes(line)),
  };
}

function multistatus(cards) {
  const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\r/g, '&#13;');
  return `<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${cards.map(([id, text]) =>
    `<response><href>/book/${id}.vcf</href><propstat><prop><getetag>"e-${id}"</getetag><C:address-data>${esc(text)}</C:address-data></prop></propstat></response>`).join('')}</multistatus>`;
}

function simpleCard(name, extra = []) {
  const [first, last] = name.split(' ');
  return ['BEGIN:VCARD', 'VERSION:3.0', `N:${last};${first};;;`, `FN:${name}`, ...extra, 'END:VCARD', ''].join('\r\n');
}

function mock(handler) {
  const calls = [];
  setCardDavRequestForTests(async (method, url, opts = {}) => {
    calls.push({ method, url, ...opts });
    return handler(method, url, opts);
  });
  setCardDavDiscoveryForTests({ dataHost: 'https://card.example.test', homeSetPath: '/home/', addressBookPath: '/book/' });
  return calls;
}

function restore() {
  setCardDavRequestForTests(null);
  setCardDavDiscoveryForTests(null);
}

test('a no-op update writes the card back unchanged', () => {
  assert.deepEqual(diff(patchVCard(CARD, {})), { removed: [], added: [] });
  const out = linesOf(patchVCard(CARD, {}));
  assert.equal(out.filter((line) => line.startsWith('REV:')).length, 1);
  assert.notEqual(out.find((line) => line.startsWith('REV:')), 'REV:2026-01-01T00:00:00Z');
  // The folded photo line survives byte for byte.
  assert.ok(out.includes(CARD_LINES[23]));
  assert.ok(patchVCard(CARD, {}).includes(`\r\n${CARD_LINES[23]}\r\n`));
});

test('changing the note changes only the note', async () => {
  const calls = mock((method) => (method === 'GET'
    ? { status: 200, etag: '"e1"', body: CARD }
    : { status: 204, etag: '"e2"', body: '' }));
  try {
    const result = await updateContact('ABC-123', { note: 'Met at conference, follow up; soon' });
    assert.deepEqual(result, { updated: true, contactId: 'ABC-123', etag: '"e2"' });
  } finally { restore(); }
  const put = calls.find((call) => call.method === 'PUT');
  assert.equal(put.etag, '"e1"');
  assert.deepEqual(diff(put.body), {
    removed: ['NOTE:Met at conference'],
    added: ['NOTE:Met at conference\\, follow up\; soon'],
  });
});

test('name parts are kept when one changes', () => {
  assert.deepEqual(diff(patchVCard(CARD, { lastName: 'Jones' })), {
    removed: ['N:Smith;Jane;Marie;Dr.;Jr.', 'FN:Dr. Jane Marie Smith Jr.'],
    added: ['N:Jones;Jane;Marie;Dr.;Jr.', 'FN:Dr. Jane Marie Jones Jr.'],
  });
  // A display name on its own leaves the name parts alone.
  assert.deepEqual(diff(patchVCard(CARD, { fullName: 'Jane S.' })), {
    removed: ['FN:Dr. Jane Marie Smith Jr.'], added: ['FN:Jane S.'],
  });
});

test('phone adds a number and makes it primary without touching the others', () => {
  const { removed, added } = diff(patchVCard(CARD, { phone: '+1-555-555-0199' }));
  assert.deepEqual(removed, ['TEL;type=CELL;type=VOICE;type=pref:+1 (555) 555-0100']);
  assert.deepEqual(added.sort(), [
    'TEL;type=CELL;type=VOICE:+1 (555) 555-0100',
    'TEL;type=CELL;type=VOICE;type=pref:+1-555-555-0199',
  ].sort());

  // A number the contact already has, in another format, is not added twice.
  assert.deepEqual(diff(patchVCard(CARD, { phone: '15555550100' })), { removed: [], added: [] });
  const promoted = diff(patchVCard(CARD, { phone: '(555) 555-0111' }));
  assert.deepEqual(promoted.added.sort(), ['TEL;type=CELL;type=VOICE:+1 (555) 555-0100', 'item2.TEL;type=pref:+1-555-555-0111'].sort());

  const email = diff(patchVCard(CARD, { email: 'jane@new.example' }));
  assert.deepEqual(email.removed, ['item1.EMAIL;type=INTERNET;type=pref:jane@work.example']);
  assert.deepEqual(email.added.sort(), [
    'EMAIL;type=INTERNET;type=HOME;type=pref:jane@new.example',
    'item1.EMAIL;type=INTERNET:jane@work.example',
  ].sort());
});

test('a phones list keeps matching entries and their labels, and drops the rest', () => {
  // Read, add one, write back: nothing existing is disturbed.
  const appended = diff(patchVCard(CARD, {
    phones: [
      { type: 'cell', number: '+1 (555) 555-0100', preferred: true },
      { type: 'Lab', number: '+1-555-555-0111' },
      { type: 'work', number: '+1-555-555-0122' },
    ],
  }));
  assert.deepEqual(appended, { removed: [], added: ['TEL;type=WORK;type=VOICE:+1-555-555-0122'] });

  // Dropping the labelled number removes its label line too, and nothing else.
  const dropped = diff(patchVCard(CARD, { phones: [{ number: '+1 (555) 555-0100' }] }));
  assert.deepEqual(dropped, { removed: ['item2.TEL:+1-555-555-0111', 'item2.X-ABLabel:Lab'], added: [] });

  // A custom label becomes a labelled group with a number no other line uses.
  const custom = diff(patchVCard(CARD, { phones: [{ number: '+1 (555) 555-0100' }, { number: '555-0133', type: 'Ski house' }] }));
  assert.deepEqual(custom.added, ['item5.TEL:555-0133', 'item5.X-ABLabel:Ski house']);

  // The email label is still on the email.
  const out = linesOf(patchVCard(CARD, { phones: [] }));
  assert.ok(out.includes('item1.EMAIL;type=INTERNET;type=pref:jane@work.example'));
  assert.ok(out.includes('item1.X-ABLabel:Assistant'));
  assert.equal(out.filter((line) => /(^|\.)TEL[;:]/.test(line)).length, 0);
});

test('addresses replace cleanly and the country-code line is not an address', () => {
  const same = diff(patchVCard(CARD, {
    addresses: [{ type: 'home', street: '1 Main St, Apt 2', city: 'Baltimore', state: 'MD', zip: '21201', country: 'United States' }],
  }));
  assert.deepEqual(same, { removed: [], added: [] });

  const moved = diff(patchVCard(CARD, { addresses: [{ type: 'work', street: '2 Side St', city: 'Columbia', state: 'MD', zip: '21044' }] }));
  assert.deepEqual(moved.removed, [
    'item3.ADR;type=HOME;type=pref:;;1 Main St\\, Apt 2;Baltimore;MD;21201;United States',
    'item3.X-ABADR:us',
  ]);
  assert.deepEqual(moved.added, ['ADR;type=WORK:;;2 Side St;Columbia;MD;21044;']);
});

test('single fields set, clear, and reject bad input', () => {
  assert.deepEqual(diff(patchVCard(CARD, { url: 'https://new.example' })), {
    removed: ['URL;type=WORK:https://work.example'], added: ['URL;type=WORK:https://new.example'],
  });
  assert.deepEqual(diff(patchVCard(CARD, { title: '', nickname: '', department: '' })), {
    removed: ['NICKNAME:JJ', 'ORG:AT&T;Research', 'TITLE:Director'], added: ['ORG:AT&T;'],
  });
  assert.deepEqual(diff(patchVCard(CARD, { birthday: '1990-01-15' })), {
    removed: ['BDAY;X-APPLE-OMIT-YEAR=1604;value=date:1604-01-15'], added: ['BDAY;value=date:1990-01-15'],
  });
  assert.throws(() => patchVCard(CARD, { birthday: 'sometime in May' }), /Invalid birthday/);
  assert.throws(() => patchVCard(CARD, { emails: [{ email: 'not an address' }] }), /valid address/);
  assert.throws(() => patchVCard(CARD, { phones: 'nope' }), /must be an array/);

  // Text cannot start a new line in the card.
  const hostile = linesOf(patchVCard(CARD, {
    note: 'x\r\nTEL:+1-900-555-0000', phone: '555-0144\r\nEMAIL:evil@example.com', firstName: 'A\nORG:Evil',
  }));
  assert.equal(hostile.filter((line) => /(^|\.)TEL[;:]/.test(line)).length, 3);
  assert.equal(hostile.filter((line) => /(^|\.)EMAIL[;:]/.test(line)).length, 2);
  assert.equal(hostile.filter((line) => line.startsWith('ORG')).length, 1);
});

test('a contact group is refused', () => {
  const group = ['BEGIN:VCARD', 'VERSION:3.0', 'N:Friends;;;;', 'FN:Friends', 'X-ADDRESSBOOKSERVER-KIND:group', 'UID:G1', 'END:VCARD', ''].join('\r\n');
  assert.throws(() => patchVCard(group, { note: 'x' }), /contact group/);
  assert.throws(() => patchVCard('not a card', { note: 'x' }), /not a contact card/);
});

test('a change made elsewhere is reported, not overwritten', async () => {
  mock((method) => (method === 'GET' ? { status: 200, etag: '"e1"', body: CARD } : { status: 412, etag: null, body: '' }));
  try {
    await assert.rejects(updateContact('ABC-123', { note: 'x' }), /changed on the server/);
  } finally { restore(); }
});

test('get_contact shows every field and no photo data', async () => {
  mock(() => ({ status: 200, etag: '"e1"', body: CARD }));
  let contact;
  try { contact = await getContact('ABC-123'); } finally { restore(); }
  const text = JSON.stringify(contact);
  assert.ok(!text.includes('/9j/'));
  assert.ok(!text.includes('_rawLines'));
  assert.equal(contact.hasPhoto, true);
  assert.deepEqual(
    { fullName: contact.fullName, firstName: contact.firstName, lastName: contact.lastName, middleName: contact.middleName, prefix: contact.prefix, suffix: contact.suffix },
    { fullName: 'Dr. Jane Marie Smith Jr.', firstName: 'Jane', lastName: 'Smith', middleName: 'Marie', prefix: 'Dr.', suffix: 'Jr.' }
  );
  assert.equal(contact.org, 'AT&T');
  assert.equal(contact.department, 'Research');
  assert.equal(contact.birthday, '--01-15');
  assert.deepEqual(contact.urls, ['https://work.example', 'https://home.example']);
  assert.deepEqual(contact.phones, [
    { type: 'cell', number: '+1 (555) 555-0100', preferred: true },
    { type: 'Lab', number: '+1-555-555-0111' },
  ]);
  assert.deepEqual(contact.emails, [
    { type: 'Assistant', email: 'jane@work.example', preferred: true },
    { type: 'home', email: 'jane@home.example' },
  ]);
  // One address, with its comma unescaped; the country-code line is not a second one.
  assert.deepEqual(contact.addresses, [
    { type: 'home', street: '1 Main St, Apt 2', city: 'Baltimore', state: 'MD', zip: '21201', country: 'United States' },
  ]);
  assert.deepEqual(contact.other, [
    { field: 'x-abrelatednames', label: 'spouse', value: 'Sam Smith' },
    { field: 'x-socialprofile', value: 'https://linkedin.example/jane' },
  ]);
});

test('list_contacts is sorted, paged, decoded, and leaves out groups', async () => {
  const cards = [
    ['c3', simpleCard('Zed Young')],
    ['c1', simpleCard('Amy Adams', ['ORG:R&D <Labs>;'])],
    ['g1', ['BEGIN:VCARD', 'VERSION:3.0', 'N:Team;;;;', 'FN:Team', 'X-ADDRESSBOOKSERVER-KIND:group', 'END:VCARD', ''].join('\r\n')],
    ['c2', simpleCard('Bo Baker')],
  ];
  const calls = mock(() => ({ status: 207, body: multistatus(cards) }));
  try {
    const first = await listContacts(2, 0);
    assert.deepEqual(first.contacts.map((c) => c.fullName), ['Amy Adams', 'Bo Baker']);
    assert.deepEqual({ count: first.count, total: first.total, hasMore: first.hasMore }, { count: 2, total: 3, hasMore: true });
    assert.equal(first.contacts[0].org, 'R&D <Labs>');
    assert.equal(first.contacts[0].contactId, 'c1');
    assert.equal(first.contacts[0].etag, 'e-c1');
    const second = await listContacts(2, 2);
    assert.deepEqual(second.contacts.map((c) => c.fullName), ['Zed Young']);
    assert.equal(second.hasMore, false);
  } finally { restore(); }
  assert.ok(calls.every((call) => call.method === 'REPORT'));
});

test('a refused or failed request is an error, not an empty address book', async () => {
  mock(() => ({ status: 401, body: 'Unauthorized' }));
  try {
    await assert.rejects(listContacts(), /refused \(401\)/);
    await assert.rejects(searchContacts('amy'), /refused \(401\)/);
  } finally { restore(); }
  mock(() => ({ status: 503, body: '' }));
  try {
    await assert.rejects(listContacts(), /HTTP 503/);
  } finally { restore(); }
});

test('search covers company and notes, and matches phones in any format', async () => {
  const cards = [
    ['c1', simpleCard('Amy Adams', ['TEL;type=CELL:(555) 555-0100'])],
    ['c2', simpleCard('Bo Baker', ['TEL;type=CELL:+1 444 555 0100'])],
  ];
  const calls = mock(() => ({ status: 207, body: multistatus(cards) }));
  try {
    const byName = await searchContacts('adams', 1);
    assert.equal(calls.length, 1);
    for (const prop of ['FN', 'EMAIL', 'TEL', 'ORG', 'NICKNAME', 'NOTE']) {
      assert.ok(calls[0].body.includes(`<C:prop-filter name="${prop}">`), prop);
    }
    assert.ok(calls[0].body.includes('<C:filter test="anyof">'));
    assert.deepEqual({ count: byName.count, total: byName.total, truncated: byName.truncated }, { count: 1, total: 2, truncated: true });
    await assert.rejects(searchContacts('   '), /query is required/);
  } finally { restore(); }

  // The fake server returns nothing for the text query, then both cards for the
  // last-four-digits query; only the one whose digits match is kept.
  const phoneCalls = mock((_method, _url, opts) => ({
    status: 207,
    body: opts.body.includes('>0100<') ? multistatus(cards) : multistatus([]),
  }));
  try {
    const found = await searchContacts('555.555.0100');
    assert.equal(phoneCalls.length, 2);
    assert.deepEqual(found.contacts.map((c) => c.fullName), ['Amy Adams']);
  } finally { restore(); }
});

test('create_contact writes a clean card', async () => {
  const calls = mock(() => ({ status: 201, etag: '"new"', body: '' }));
  try {
    const result = await createContact({
      firstName: 'Ravi', lastName: 'Okafor, Jr', org: 'Example; Inc', title: 'Engineer',
      phones: [{ number: '555-0150', type: 'mobile' }, { number: '555-0151', type: 'Desk' }],
      email: 'ravi@example.com', birthday: '--03-09', note: 'Line one\nLine two',
      addresses: [{ street: '9 Elm St', city: 'Laurel', state: 'MD', zip: '20707', country: 'USA' }],
    });
    assert.equal(result.created, true);
    await createContact({ org: 'Example Bakery', phone: '555-0160' });
    await assert.rejects(createContact({ phone: '555-0170' }), /needs a name or an organization/);
  } finally { restore(); }
  assert.equal(calls.length, 2);
  const person = withoutRev(linesOf(calls[0].body));
  assert.deepEqual(person, [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//icloud-mcp//EN',
    'N:Okafor\\, Jr;Ravi;;;',
    person[4], // UID
    'FN:Ravi Okafor\\, Jr',
    'ORG:Example\; Inc;',
    'TITLE:Engineer',
    'NOTE:Line one\\nLine two',
    'BDAY;X-APPLE-OMIT-YEAR=1604;value=date:1604-03-09',
    'TEL;type=CELL;type=VOICE:555-0150',
    'item1.TEL:555-0151',
    'item1.X-ABLabel:Desk',
    'ADR;type=HOME:;;9 Elm St;Laurel;MD;20707;USA',
    'EMAIL;type=INTERNET;type=HOME;type=pref:ravi@example.com',
    'END:VCARD',
  ]);
  assert.match(person[4], /^UID:[0-9A-F-]{36}$/);
  const company = linesOf(calls[1].body);
  assert.ok(company.includes('FN:Example Bakery'));
  assert.ok(company.includes('X-ABShowAs:COMPANY'));
  assert.ok(company.includes('TEL;type=CELL;type=VOICE;type=pref:555-0160'));
});
