// Live destructive suite: creates dummy contacts, reminder lists, reminders, and
// emails on a real iCloud account, then deletes them with the server's own delete
// tools and checks that exactly the dummy data (and nothing else) went away.
//
// Safety rules this file follows:
// - Never sends email. Dummy emails are written straight into a temp folder with
//   IMAP APPEND; no SMTP tool is called.
// - Every email delete is scoped to a fresh mcp-test-dummy-* folder that only this
//   run has written to. The one exception is the trash check, which deletes only
//   messages whose subject carries this suite's tag.
// - Every delete runs as a dryRun first. If the dry run would touch anything other
//   than the exact dummy UIDs/IDs this run created, the real delete is skipped.
// - empty_trash is only ever called with dryRun: true.
// - Rules and the move manifest are written to a temp ICLOUD_MCP_DATA_DIR, so the
//   real ~/.icloud-mcp-*.json files are never read or changed.
// - Calendar dummies go on the calendar named by LIVE_CALENDAR (required; calendar
//   tests skip when it is unset), in January 2030, with alerts off.
//
// Run with:  ICLOUD_MCP_LIVE=1 IMAP_USER=... IMAP_PASSWORD=... npm run test:live
// Optional:  LIVE_CALENDAR=<disposable calendar name> (required for calendar tests),
//            MASS_COUNT=600 (dummy emails in the bulk_delete batch; default crosses
//            the 500-message chunk boundary), --verbose for server stderr.

import { spawnSync } from 'child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { ImapFlow } from 'imapflow';

const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD;

if (process.env.ICLOUD_MCP_LIVE !== '1' || !IMAP_USER || !IMAP_PASSWORD) {
  console.log('Skipping live destructive suite (set ICLOUD_MCP_LIVE=1, IMAP_USER, and IMAP_PASSWORD to run it).');
  process.exit(0);
}

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const MASS_COUNT = Number(process.env.MASS_COUNT || 600);

const RUN = Date.now();
const TAG = `mcp-test-dummy-${RUN}`;            // appears in every dummy subject
const TAG_PREFIX = 'mcp-test-dummy-';
const FOLDER = TAG;                              // temp mail folder for this run
const DUMMY_SENDER = `${TAG}@example.invalid`;   // .invalid can never be a real address
const CONTACT_PREFIX = 'MCP Test Dummy';
const LIST_PREFIX = 'mcp-test-list-';
const LIST_NAME = `${LIST_PREFIX}${RUN}`;
const TRASH = 'Deleted Messages';
const SRC = `${TAG}-src`;                       // move/flag/rule tests
const DST = `${TAG}-dst`;
const CALENDAR_NAME = (process.env.LIVE_CALENDAR || '').trim();
const CAL_SINCE = '2030-01-01';
const CAL_BEFORE = '2030-02-01';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'icloud-mcp-live-'));
const STATE_FILES = ['.icloud-mcp-rules.json', '.icloud-mcp-move-manifest.json'];
const repoStateBefore = STATE_FILES.filter((f) => existsSync(join(projectDir, f)));

// ─── Harness ──────────────────────────────────────────────────────────────────

function callTool(name, args = {}, timeout = 600000) {
  const input = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-test', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';

  const result = spawnSync(process.execPath, ['index.js'], {
    cwd: projectDir, input, encoding: 'utf8', timeout, env: { ...process.env, ICLOUD_MCP_DATA_DIR: DATA_DIR },
  });
  if (VERBOSE && result.stderr?.trim()) console.log(result.stderr.trim().replace(/^/gm, '     '));
  if (result.error) throw new Error(`Spawn error: ${result.error.message}`);

  const response = (result.stdout || '').split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((r) => r?.id === 1);
  if (!response) throw new Error(`No response for ${name}: ${(result.stderr || '').trim().slice(0, 300)}`);
  const text = response.result?.content?.[0]?.text;
  if (response.result?.isError) throw new Error(`Tool error: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

let passed = 0;
let failed = 0;
let skipped = 0;

class Skip extends Error {}

async function test(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    const note = await fn();
    console.log(`passed${note ? ` (${note})` : ''}`);
    passed++;
  } catch (err) {
    if (err instanceof Skip) {
      console.log(`SKIPPED: ${err.message}`);
      skipped++;
    } else {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameSet(a, b) {
  const sa = new Set(a);
  return sa.size === new Set(b).size && [...b].every((x) => sa.has(x));
}

// Refuse the real delete unless the dry run named exactly the dummies we created.
function guardDryRun(result, expected, label) {
  assert(result.dryRun === true, `${label}: dryRun flag missing`);
  const named = result.uids ?? result.changes.map((c) => c.uid);
  if (!sameSet(named, expected)) {
    throw new Skip(`${label} dry run named ${named.length} item(s), expected exactly ${expected.length} dummies; real delete NOT run`);
  }
}

// ─── Direct IMAP helpers (seeding and independent verification) ──────────────

async function withImap(fn) {
  const client = new ImapFlow({
    host: 'imap.mail.me.com', port: 993, secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD }, logger: false,
  });
  client.on('error', () => {}); // a dropped socket rejects the pending command; don't crash the run
  await client.connect();
  try { return await fn(client); } finally { await client.logout().catch(() => client.close()); }
}

function rawMessage({ subject, from = DUMMY_SENDER, date = new Date() }) {
  return [
    `From: MCP Dummy <${from}>`,
    `To: ${IMAP_USER}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${RUN}.${Math.random().toString(36).slice(2)}@example.invalid>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Dummy message created by the icloud-mcp live test suite. Safe to delete.',
    '',
  ].join('\r\n');
}

// Appends `count` dummy messages and returns their UIDs. Reconnects and resumes
// if iCloud drops the connection partway through a large batch.
async function seed(count, { label, from, date, mailbox = FOLDER, flags = ['\\Seen'] } = {}) {
  const uids = [];
  for (let attempt = 1; uids.length < count; attempt++) {
    try {
      await seedFrom(uids, count, { label, from, date, mailbox, flags });
    } catch (err) {
      if (attempt >= 3) throw err;
      process.stdout.write(`[reconnect after ${err.message}] `);
    }
  }
  return uids;
}

async function seedFrom(uids, count, { label, from, date, mailbox, flags }) {
  return withImap(async (client) => {
    for (let i = uids.length; i < count; i++) {
      const subject = `[${TAG}] ${label} ${i + 1}`;
      const res = await client.append(mailbox, rawMessage({ subject, from, date }), flags, date || new Date());
      if (!res?.uid) throw new Error('APPEND did not return a UID (server lacks UIDPLUS?)');
      uids.push(res.uid);
    }
  });
}

async function uidsIn(mailbox, query) {
  return withImap(async (client) => {
    await client.mailboxOpen(mailbox);
    return (await client.search(query, { uid: true })) || [];
  });
}

// ─── Pre-flight: clear leftovers from crashed runs ────────────────────────────

console.log(`\niCloud MCP live destructive suite v${version}`);
console.log(`run tag: ${TAG}\n`);
console.log('Pre-flight cleanup');

try {
  const boxes = callTool('list_mailboxes');
  for (const box of boxes.filter((b) => b.path.startsWith(TAG_PREFIX))) {
    const subjects = await withImap(async (client) => {
      await client.mailboxOpen(box.path);
      const all = (await client.search({ all: true }, { uid: true })) || [];
      if (all.length === 0) return [];
      const msgs = [];
      for await (const m of client.fetch(all, { envelope: true }, { uid: true })) msgs.push(m.envelope?.subject || '');
      return msgs;
    });
    if (subjects.some((s) => !s.includes(TAG_PREFIX))) {
      console.log(`  ${box.path} holds non-dummy mail; leaving it alone`);
      continue;
    }
    const expected = await uidsIn(box.path, { all: true });
    if (expected.length) {
      let dry;
      try {
        dry = callTool('bulk_delete', { sourceMailbox: box.path, dryRun: true });
      } catch (err) {
        console.log(`  ${box.path} dry run failed (${err.message}); leaving it alone`);
        continue;
      }
      const named = dry?.uids ?? dry?.changes?.map((c) => c.uid) ?? [];
      if (dry?.dryRun !== true || !sameSet(named, expected)) {
        console.log(`  ${box.path} dry run did not match the folder UIDs; leaving it alone`);
        continue;
      }
      callTool('bulk_delete', { sourceMailbox: box.path });
    }
    callTool('delete_mailbox', { name: box.path });
    console.log(`  removed leftover folder ${box.path} (${subjects.length} dummies)`);
  }
} catch (err) {
  console.log(`  mail cleanup failed: ${err.message}`);
}

try {
  const found = callTool('search_contacts', { query: CONTACT_PREFIX });
  for (const c of found.contacts.filter((c) => (c.fullName || '').startsWith(CONTACT_PREFIX))) {
    callTool('delete_contact', { contactId: c.contactId });
    console.log(`  removed leftover contact ${c.fullName}`);
  }
} catch (err) {
  console.log(`  contact cleanup failed: ${err.message}`);
}

try {
  const { lists } = callTool('list_reminder_lists');
  for (const list of lists.filter((l) => l.name.startsWith(LIST_PREFIX))) {
    const { reminders } = callTool('list_reminders', { listName: list.name, includeCompleted: true, limit: 500 });
    for (const r of reminders) callTool('delete_reminder', { listName: list.name, reminderId: r.id });
    callTool('delete_reminder_list', { name: list.name });
    console.log(`  removed leftover reminder list ${list.name}`);
  }
} catch (err) {
  console.log(`  reminder cleanup failed: ${err.message}`);
}

let calendarId = null;
if (!CALENDAR_NAME) {
  console.log('  calendar cleanup skipped (set LIVE_CALENDAR to a disposable calendar)');
} else {
  try {
    const { calendars } = callTool('list_calendars');
    calendarId = calendars.find((c) => c.name === CALENDAR_NAME)?.calendarId ?? null;
    if (calendarId) {
      const { events } = callTool('list_events', { calendarId, since: CAL_SINCE, before: CAL_BEFORE, limit: 500 });
      const stale = events.filter((e) => (e.summary || '').includes(TAG_PREFIX));
      if (stale.length) {
        callTool('bulk_delete_events', { calendarId, eventIds: stale.map((e) => e.eventId) });
        console.log(`  removed ${stale.length} leftover dummy events`);
      }
    }
  } catch (err) {
    console.log(`  calendar cleanup failed: ${err.message}`);
  }
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

console.log('\nContacts');
const contactName = `${CONTACT_PREFIX} ${RUN}`;
let contactId = null;

await test('create_contact (dummy)', () => {
  const res = callTool('create_contact', {
    firstName: 'MCP Test', lastName: `Dummy ${RUN}`, fullName: contactName,
    email: DUMMY_SENDER, phone: '+1 555 0100', note: 'Created by the icloud-mcp live test suite.',
  });
  assert(res.created === true && res.contactId, 'no contactId returned');
  contactId = res.contactId;
  return contactId;
});

await test('get_contact returns the dummy', () => {
  const c = callTool('get_contact', { contactId });
  assert(c.fullName === contactName, `fullName was ${c.fullName}`);
});

await test('search_contacts finds the dummy', () => {
  const res = callTool('search_contacts', { query: String(RUN) });
  assert(res.contacts.some((c) => c.contactId === contactId), 'dummy not in search results');
});

await test('update_contact changes org', () => {
  callTool('update_contact', { contactId, org: 'MCP Test Org' });
  const c = callTool('get_contact', { contactId });
  assert(c.org === 'MCP Test Org', `org was ${c.org}`);
  assert(c.fullName === contactName, 'update dropped fullName');
});

await test('delete_contact dryRun leaves the contact in place', () => {
  const res = callTool('delete_contact', { contactId, dryRun: true });
  assert(res.dryRun === true && res.changes[0].fullName === contactName, 'dry run named the wrong contact');
  callTool('get_contact', { contactId }); // throws if it was deleted
});

await test('delete_contact removes the dummy', () => {
  const res = callTool('delete_contact', { contactId });
  assert(res.deleted === true, 'deleted flag missing');
  let gone = false;
  try { callTool('get_contact', { contactId }); } catch (err) { gone = /not found/i.test(err.message); }
  assert(gone, 'contact still readable after delete');
  contactId = null;
});

if (contactId) {
  try { callTool('delete_contact', { contactId }); console.log('  (cleanup) deleted dummy contact'); } catch {}
}

// ─── Reminders ────────────────────────────────────────────────────────────────

console.log('\nReminders');
let listCreated = false;
const reminderIds = [];

await test('create_reminder_list (dummy list)', () => {
  const res = callTool('create_reminder_list', { name: LIST_NAME });
  assert(res.created === true && res.name === LIST_NAME, 'list not created');
  listCreated = true;
});

await test('create_reminder_list rejects a duplicate name', () => {
  let rejected = false;
  try { callTool('create_reminder_list', { name: LIST_NAME }); } catch (err) { rejected = /already exists/.test(err.message); }
  assert(rejected, 'duplicate list was allowed');
});

await test('create_reminder x5 in the dummy list', () => {
  if (!listCreated) throw new Skip('no dummy list');
  for (let i = 1; i <= 5; i++) {
    const res = callTool('create_reminder', {
      listName: LIST_NAME, title: `[${TAG}] reminder ${i}`,
      notes: 'Created by the icloud-mcp live test suite.',
      ...(i === 1 ? { due: '2030-01-01T09:00:00', priority: 'high' } : {}),
    });
    assert(res.created === true && res.id, `reminder ${i} not created`);
    reminderIds.push(res.id);
  }
  const { reminders } = callTool('list_reminders', { listName: LIST_NAME, includeCompleted: true });
  assert(reminders.length === 5, `list has ${reminders.length} reminders, expected 5`);
});

await test('create 20 more and list all 25 well under the 30s script limit', () => {
  if (reminderIds.length < 5) throw new Skip('reminders not created');
  for (let i = 6; i <= 25; i++) {
    const res = callTool('create_reminder', { listName: LIST_NAME, title: `[${TAG}] reminder ${i}` });
    reminderIds.push(res.id);
  }
  const t0 = Date.now();
  const { reminders } = callTool('list_reminders', { listName: LIST_NAME, includeCompleted: true, limit: 100 });
  const secs = (Date.now() - t0) / 1000;
  assert(reminders.length === 25, `listed ${reminders.length}, expected 25`);
  assert(secs < 20, `listing took ${secs}s`);
  const first = reminders.find((r) => r.id === reminderIds[0]);
  assert(first?.priority === 'high', `priority came back as ${first?.priority}`);
  assert(first?.due?.startsWith('2030-01-01'), `due came back as ${first?.due}`);
  assert(first?.notes?.includes('live test suite'), 'notes missing from batched read');
  return `${secs.toFixed(1)}s`;
});

await test('complete_reminder hides it from the default listing', () => {
  if (reminderIds.length < 5) throw new Skip('reminders not created');
  callTool('complete_reminder', { listName: LIST_NAME, reminderId: reminderIds[0] });
  const open = callTool('list_reminders', { listName: LIST_NAME, limit: 100 });
  const all = callTool('list_reminders', { listName: LIST_NAME, includeCompleted: true, limit: 100 });
  const n = reminderIds.length;
  assert(open.count === n - 1 && all.count === n, `open ${open.count}, all ${all.count}, expected ${n - 1}/${n}`);
  assert(!open.reminders.some((r) => r.id === reminderIds[0]), 'completed reminder still in open listing');
});

await test('delete_reminder_list refuses a non-empty list', () => {
  if (!listCreated) throw new Skip('no dummy list');
  const dry = callTool('delete_reminder_list', { name: LIST_NAME, dryRun: true });
  assert(dry.wouldDelete === false && dry.reminderCount === reminderIds.length, `dry run said wouldDelete=${dry.wouldDelete}, count=${dry.reminderCount}`);
  let refused = false;
  try { callTool('delete_reminder_list', { name: LIST_NAME }); } catch (err) { refused = /still has/.test(err.message); }
  assert(refused, 'non-empty list was deleted');
});

await test('delete_reminder dryRun leaves the reminder in place', () => {
  if (!reminderIds.length) throw new Skip('no reminders');
  const res = callTool('delete_reminder', { listName: LIST_NAME, reminderId: reminderIds[1], dryRun: true });
  assert(res.dryRun === true && res.changes[0].title === `[${TAG}] reminder 2`, 'dry run named the wrong reminder');
  callTool('get_reminder', { listName: LIST_NAME, reminderId: reminderIds[1] });
});

await test('delete_reminder removes every dummy (incl. completed)', () => {
  if (!reminderIds.length) throw new Skip('no reminders');
  while (reminderIds.length) {
    const id = reminderIds[0];
    const res = callTool('delete_reminder', { listName: LIST_NAME, reminderId: id });
    process.stdout.write('.');
    assert(res.deleted === true, `reminder ${id} not deleted`);
    reminderIds.shift();
  }
  const { count } = callTool('list_reminders', { listName: LIST_NAME, includeCompleted: true, limit: 100 });
  assert(count === 0, `${count} reminders left in the list`);
});

const RENAMED = `${LIST_NAME}-renamed`;
let currentList = LIST_NAME;

await test('rename_reminder_list dryRun leaves the name alone', () => {
  if (!listCreated) throw new Skip('no dummy list');
  const dry = callTool('rename_reminder_list', { oldName: LIST_NAME, newName: RENAMED, dryRun: true });
  assert(dry.dryRun === true && dry.changes[0].to === RENAMED, 'bad dry run');
  const names = callTool('list_reminder_lists').lists.map((l) => l.name);
  assert(names.includes(LIST_NAME) && !names.includes(RENAMED), 'dry run renamed the list');
});

await test('rename_reminder_list rejects a name already in use', () => {
  if (!listCreated) throw new Skip('no dummy list');
  const other = `${LIST_NAME}-other`;
  callTool('create_reminder_list', { name: other });
  try {
    let rejected = false;
    try { callTool('rename_reminder_list', { oldName: LIST_NAME, newName: other }); } catch (err) { rejected = /already exists/.test(err.message); }
    assert(rejected, 'rename onto an existing name was allowed');
    assert(callTool('list_reminder_lists').lists.some((l) => l.name === LIST_NAME), 'list name changed anyway');
  } finally {
    callTool('delete_reminder_list', { name: other });
  }
});

await test('rename_reminder_list renames the dummy list', () => {
  if (!listCreated) throw new Skip('no dummy list');
  let res;
  try {
    res = callTool('rename_reminder_list', { oldName: LIST_NAME, newName: RENAMED });
  } finally {
    // A Reminders timeout can land after the rename was applied; track the real name.
    const names = callTool('list_reminder_lists').lists.map((l) => l.name);
    if (names.includes(RENAMED)) currentList = RENAMED;
  }
  assert(res.renamed === true && res.to === RENAMED, 'rename not reported');
  const names = callTool('list_reminder_lists').lists.map((l) => l.name);
  assert(names.includes(RENAMED) && !names.includes(LIST_NAME), `lists now: ${names.filter((n) => n.startsWith(LIST_PREFIX)).join(', ')}`);
});

await test('delete_reminder_list removes the empty dummy list', () => {
  if (!listCreated) throw new Skip('no dummy list');
  const dry = callTool('delete_reminder_list', { name: currentList, dryRun: true });
  assert(dry.wouldDelete === true, 'dry run says it would not delete');
  callTool('delete_reminder_list', { name: currentList });
  const { lists } = callTool('list_reminder_lists');
  assert(!lists.some((l) => l.name === currentList), 'list still exists');
  listCreated = false;
});

if (listCreated) {
  try {
    for (const id of reminderIds) callTool('delete_reminder', { listName: currentList, reminderId: id });
    callTool('delete_reminder_list', { name: currentList });
    console.log('  (cleanup) removed dummy reminder list');
  } catch (err) {
    console.log(`  (cleanup) could not remove ${LIST_NAME}: ${err.message}`);
  }
}

// ─── Mail ─────────────────────────────────────────────────────────────────────
// Each deletion technique gets its own batch of dummies, plus "keeper" dummies in
// the same folder that must survive every targeted delete.

console.log('\nMail (dummy emails in a temp folder; nothing is sent)');
let folderReady = false;
let keepers = [];

await test(`create_mailbox ${FOLDER}`, () => {
  callTool('create_mailbox', { name: FOLDER });
  folderReady = true;
});

await test('seed 5 keeper dummies', async () => {
  if (!folderReady) throw new Skip('no temp folder');
  keepers = await seed(5, { label: 'keeper', from: `keeper-${TAG}@example.invalid` });
});

async function assertKeepersIntact() {
  const left = await uidsIn(FOLDER, { subject: 'keeper' });
  assert(sameSet(left, keepers), `keepers changed: ${left.length}/${keepers.length} remain`);
}

await test('delete_email (single dummy)', async () => {
  if (!folderReady) throw new Skip('no temp folder');
  const [uid] = await seed(1, { label: 'single' });
  const dry = callTool('delete_email', { uid, mailbox: FOLDER, dryRun: true });
  assert(dry.changes[0].uid === uid && dry.changes[0].subject.includes(TAG), 'dry run named the wrong message');
  assert((await uidsIn(FOLDER, { uid: String(uid) })).length === 1, 'dry run removed the message');
  callTool('delete_email', { uid, mailbox: FOLDER });
  assert((await uidsIn(FOLDER, { subject: 'single' })).length === 0, 'message still present');
  await assertKeepersIntact();
});

await test('bulk_delete_by_subject (25 dummies)', async () => {
  if (!folderReady) throw new Skip('no temp folder');
  const uids = await seed(25, { label: 'subject-batch' });
  guardDryRun(callTool('bulk_delete_by_subject', { subject: 'subject-batch', mailbox: FOLDER, dryRun: true }), uids, 'bulk_delete_by_subject');
  const res = callTool('bulk_delete_by_subject', { subject: 'subject-batch', mailbox: FOLDER });
  assert(res.deleted === 25, `deleted ${res.deleted}`);
  assert((await uidsIn(FOLDER, { subject: 'subject-batch' })).length === 0, 'batch still present');
  await assertKeepersIntact();
});

await test('bulk_delete_by_sender (25 dummies)', async () => {
  if (!folderReady) throw new Skip('no temp folder');
  const sender = `sender-batch-${TAG}@example.invalid`;
  const uids = await seed(25, { label: 'sender-batch', from: sender });
  guardDryRun(callTool('bulk_delete_by_sender', { sender, mailbox: FOLDER, dryRun: true }), uids, 'bulk_delete_by_sender');
  const res = callTool('bulk_delete_by_sender', { sender, mailbox: FOLDER });
  assert(res.deleted === 25, `deleted ${res.deleted}`);
  assert((await uidsIn(FOLDER, { from: sender })).length === 0, 'batch still present');
  await assertKeepersIntact();
});

await test('delete_older_than (10 back-dated dummies)', async () => {
  if (!folderReady) throw new Skip('no temp folder');
  const old = new Date(Date.now() - 400 * 86400000);
  const uids = await seed(10, { label: 'old-batch', date: old });
  guardDryRun(callTool('delete_older_than', { days: 365, mailbox: FOLDER, dryRun: true }), uids, 'delete_older_than');
  const res = callTool('delete_older_than', { days: 365, mailbox: FOLDER });
  assert(res.deleted === 10, `deleted ${res.deleted}`);
  assert((await uidsIn(FOLDER, { subject: 'old-batch' })).length === 0, 'batch still present');
  await assertKeepersIntact();
});

await test(`bulk_delete with filters (${MASS_COUNT} dummies, crosses 500 chunk)`, async () => {
  if (!folderReady) throw new Skip('no temp folder');
  process.stdout.write(`seeding ${MASS_COUNT}... `);
  const uids = await seed(MASS_COUNT, { label: 'mass-batch' });
  guardDryRun(callTool('bulk_delete', { sourceMailbox: FOLDER, subject: 'mass-batch', dryRun: true }), uids, 'bulk_delete');
  const res = callTool('bulk_delete', { sourceMailbox: FOLDER, subject: 'mass-batch' });
  assert(!res.error, res.error);
  assert(res.deleted === MASS_COUNT, `deleted ${res.deleted}`);
  assert((await uidsIn(FOLDER, { subject: 'mass-batch' })).length === 0, 'batch still present');
  await assertKeepersIntact();
});

await test('bulk_delete with no filters empties the temp folder', async () => {
  if (!folderReady) throw new Skip('no temp folder');
  guardDryRun(callTool('bulk_delete', { sourceMailbox: FOLDER, dryRun: true }), keepers, 'bulk_delete (wipe)');
  const res = callTool('bulk_delete', { sourceMailbox: FOLDER });
  assert(res.deleted === keepers.length, `deleted ${res.deleted}`);
  assert((await uidsIn(FOLDER, { all: true })).length === 0, 'folder not empty');
});

await test('deleted dummies did not pile up in Deleted Messages', async () => {
  const inTrash = await uidsIn(TRASH, { subject: TAG });
  if (inTrash.length === 0) return 'trash clean';
  // iCloud copied them to trash; remove only this run's tagged dummies from it.
  guardDryRun(callTool('bulk_delete_by_subject', { subject: TAG, mailbox: TRASH, dryRun: true }), inTrash, 'trash cleanup');
  callTool('bulk_delete_by_subject', { subject: TAG, mailbox: TRASH });
  const left = await uidsIn(TRASH, { subject: TAG });
  assert(left.length === 0, `${left.length} dummies stuck in trash`);
  return `${inTrash.length} dummies had landed in trash; removed`;
});

await test('empty_trash dryRun only (never run for real here)', () => {
  const res = callTool('empty_trash', { dryRun: true });
  assert(res.dryRun === true && Array.isArray(res.changes), 'bad dry run shape');
  return `would delete ${res.wouldDelete}; not run`;
});

await test('delete_mailbox removes the empty temp folder', () => {
  if (!folderReady) throw new Skip('no temp folder');
  const dry = callTool('delete_mailbox', { name: FOLDER, dryRun: true });
  assert(dry.messageCount === 0, `folder still has ${dry.messageCount} messages`);
  callTool('delete_mailbox', { name: FOLDER });
  const boxes = callTool('list_mailboxes');
  assert(!boxes.some((b) => b.path === FOLDER), 'folder still listed');
  folderReady = false;
});

if (folderReady) console.log(`  (cleanup) ${FOLDER} was left behind; the next run's pre-flight removes it`);

// ─── Mail: moves, flags, read state, rules ───────────────────────────────────
// Two temp folders. Each tool runs dryRun first (must touch exactly the batch and
// change nothing), then for real. Keeper dummies in SRC must stay put throughout.

console.log('\nMail moves, flags, and rules (temp folders only)');
let movesReady = false;
let srcKeepers = [];

async function flaggedIn(mailbox, uids) {
  return withImap(async (client) => {
    await client.mailboxOpen(mailbox);
    const flagged = (await client.search({ flagged: true }, { uid: true })) || [];
    const seen = (await client.search({ seen: true }, { uid: true })) || [];
    return {
      flagged: uids.filter((u) => flagged.includes(u)).length,
      seen: uids.filter((u) => seen.includes(u)).length,
    };
  });
}

async function srcKeepersIntact() {
  const left = await uidsIn(SRC, { subject: 'src-keeper' });
  assert(sameSet(left, srcKeepers), `SRC keepers changed: ${left.length}/${srcKeepers.length}`);
}

await test(`create ${SRC} and ${DST}, seed 3 keepers`, async () => {
  callTool('create_mailbox', { name: SRC });
  callTool('create_mailbox', { name: DST });
  movesReady = true;
  srcKeepers = await seed(3, { label: 'src-keeper', mailbox: SRC, from: `keeper-${TAG}@example.invalid` });
});

function needMoves() { if (!movesReady) throw new Skip('no temp folders'); }

await test('move_email: dryRun leaves it, real move lands it in DST', async () => {
  needMoves();
  const [uid] = await seed(1, { label: 'move-one', mailbox: SRC });
  const dry = callTool('move_email', { uid, sourceMailbox: SRC, targetMailbox: DST, dryRun: true });
  assert(dry.changes[0].uid === uid && dry.changes[0].subject.includes('move-one'), 'dry run named the wrong message');
  assert((await uidsIn(SRC, { subject: 'move-one' })).length === 1, 'dry run moved it');
  callTool('move_email', { uid, sourceMailbox: SRC, targetMailbox: DST });
  assert((await uidsIn(SRC, { subject: 'move-one' })).length === 0, 'still in SRC');
  assert((await uidsIn(DST, { subject: 'move-one' })).length === 1, 'not in DST');
  await srcKeepersIntact();
});

await test('bulk_move (30): dryRun, then safe move with fingerprint verify', async () => {
  needMoves();
  const uids = await seed(30, { label: 'bulk-move', mailbox: SRC });
  guardDryRun(callTool('bulk_move', { sourceMailbox: SRC, targetMailbox: DST, subject: 'bulk-move', dryRun: true }), uids, 'bulk_move');
  assert((await uidsIn(DST, { subject: 'bulk-move' })).length === 0, 'dry run copied to DST');
  const res = callTool('bulk_move', { sourceMailbox: SRC, targetMailbox: DST, subject: 'bulk-move' });
  assert(res.status === 'complete' && res.moved === 30, `status ${res.status}, moved ${res.moved}`);
  assert((await uidsIn(SRC, { subject: 'bulk-move' })).length === 0, 'left in SRC');
  assert((await uidsIn(DST, { subject: 'bulk-move' })).length === 30, 'not all in DST');
  const status = callTool('get_move_status');
  assert(!status.current || status.current.status !== 'in_progress', 'manifest still in progress');
  await srcKeepersIntact();
});

await test('bulk_move_by_sender (15)', async () => {
  needMoves();
  const sender = `mover-${TAG}@example.invalid`;
  const uids = await seed(15, { label: 'sender-move', mailbox: SRC, from: sender });
  guardDryRun(callTool('bulk_move_by_sender', { sender, sourceMailbox: SRC, targetMailbox: DST, dryRun: true }), uids, 'bulk_move_by_sender');
  const res = callTool('bulk_move_by_sender', { sender, sourceMailbox: SRC, targetMailbox: DST });
  assert(res.moved === 15, `moved ${res.moved}`);
  assert((await uidsIn(DST, { from: sender })).length === 15, 'not all in DST');
  await srcKeepersIntact();
});

await test('bulk_move_by_domain (12)', async () => {
  needMoves();
  // Fails (as a skip, via the dry-run guard) until the domain filter searches
  // "@domain" as well as the bare domain: iCloud's FROM search misses this sender
  // with the bare form alone.
  const domain = `mcpdom${RUN}.invalid`;
  const uids = await seed(12, { label: 'domain-move', mailbox: SRC, from: `someone@${domain}` });
  guardDryRun(callTool('bulk_move_by_domain', { domain, sourceMailbox: SRC, targetMailbox: DST, dryRun: true }), uids, 'bulk_move_by_domain');
  const res = callTool('bulk_move_by_domain', { domain, sourceMailbox: SRC, targetMailbox: DST });
  assert(res.moved === 12, `moved ${res.moved}`);
  assert((await uidsIn(DST, { from: domain })).length === 12, 'not all in DST');
  await srcKeepersIntact();
});

await test('archive_older_than (8 back-dated)', async () => {
  needMoves();
  const uids = await seed(8, { label: 'archive-old', mailbox: SRC, date: new Date(Date.now() - 400 * 86400000) });
  guardDryRun(callTool('archive_older_than', { days: 365, sourceMailbox: SRC, targetMailbox: DST, dryRun: true }), uids, 'archive_older_than');
  const res = callTool('archive_older_than', { days: 365, sourceMailbox: SRC, targetMailbox: DST });
  assert(res.moved === 8, `moved ${res.moved}`);
  assert((await uidsIn(DST, { subject: 'archive-old' })).length === 8, 'not all in DST');
  await srcKeepersIntact();
});

const flagSender = `flagger-${TAG}@example.invalid`;
let flagUids = [];

await test('bulk_flag: dryRun changes nothing, real flags then unflags 10', async () => {
  needMoves();
  flagUids = await seed(10, { label: 'flag-batch', mailbox: SRC, from: flagSender });
  guardDryRun(callTool('bulk_flag', { flagged: true, mailbox: SRC, subject: 'flag-batch', dryRun: true }), flagUids, 'bulk_flag');
  assert((await flaggedIn(SRC, flagUids)).flagged === 0, 'dry run flagged messages');
  callTool('bulk_flag', { flagged: true, mailbox: SRC, subject: 'flag-batch' });
  assert((await flaggedIn(SRC, flagUids)).flagged === 10, 'not all flagged');
  callTool('bulk_flag', { flagged: false, mailbox: SRC, subject: 'flag-batch' });
  assert((await flaggedIn(SRC, flagUids)).flagged === 0, 'not all unflagged');
  assert((await flaggedIn(SRC, srcKeepers)).flagged === 0, 'keepers got flagged');
});

await test('bulk_flag_by_sender: dryRun changes nothing, real flags 10', async () => {
  needMoves();
  guardDryRun(callTool('bulk_flag_by_sender', { sender: flagSender, flagged: true, mailbox: SRC, dryRun: true }), flagUids, 'bulk_flag_by_sender');
  assert((await flaggedIn(SRC, flagUids)).flagged === 0, 'dry run flagged messages');
  callTool('bulk_flag_by_sender', { sender: flagSender, flagged: true, mailbox: SRC });
  assert((await flaggedIn(SRC, flagUids)).flagged === 10, 'not all flagged');
});

await test('bulk_mark_unread / bulk_mark_read by sender', async () => {
  needMoves();
  guardDryRun(callTool('bulk_mark_unread', { sender: flagSender, mailbox: SRC, dryRun: true }), flagUids, 'bulk_mark_unread');
  assert((await flaggedIn(SRC, flagUids)).seen === 10, 'dry run changed read state');
  callTool('bulk_mark_unread', { sender: flagSender, mailbox: SRC });
  assert((await flaggedIn(SRC, flagUids)).seen === 0, 'not all unread');
  guardDryRun(callTool('bulk_mark_read', { sender: flagSender, mailbox: SRC, dryRun: true }), flagUids, 'bulk_mark_read');
  assert((await flaggedIn(SRC, flagUids)).seen === 0, 'dry run changed read state');
  callTool('bulk_mark_read', { sender: flagSender, mailbox: SRC });
  assert((await flaggedIn(SRC, flagUids)).seen === 10, 'not all read');
  assert((await flaggedIn(SRC, srcKeepers)).seen === srcKeepers.length, 'keepers read state changed');
});

await test('mark_older_than_read (5 back-dated unread)', async () => {
  needMoves();
  const uids = await seed(5, { label: 'old-unread', mailbox: SRC, flags: [], date: new Date(Date.now() - 400 * 86400000) });
  guardDryRun(callTool('mark_older_than_read', { days: 365, mailbox: SRC, dryRun: true }), uids, 'mark_older_than_read');
  assert((await flaggedIn(SRC, uids)).seen === 0, 'dry run marked them read');
  const res = callTool('mark_older_than_read', { days: 365, mailbox: SRC });
  assert(res.marked === 5, `marked ${res.marked}`);
  assert((await flaggedIn(SRC, uids)).seen === 5, 'not all read');
});

const RULE = `${TAG}-rule`;
await test('rules: create, run_rule/run_all_rules dryRun, run for real, delete_rule', async () => {
  needMoves();
  const uids = await seed(7, { label: 'rule-batch', mailbox: SRC });
  callTool('create_rule', { name: RULE, filters: { subject: 'rule-batch' }, action: { type: 'delete', sourceMailbox: SRC } });
  guardDryRun(callTool('run_rule', { name: RULE, dryRun: true }), uids, 'run_rule');
  const all = callTool('run_all_rules', { dryRun: true });
  assert(all.ran === 1 && all.results[0].rule === RULE, `run_all_rules saw ${all.ran} rule(s); expected only the temp one`);
  assert((await uidsIn(SRC, { subject: 'rule-batch' })).length === 7, 'dry runs deleted messages');
  const res = callTool('run_rule', { name: RULE });
  assert(res.deleted === 7, `rule deleted ${res.deleted}`);
  assert((await uidsIn(SRC, { subject: 'rule-batch' })).length === 0, 'batch still present');
  await srcKeepersIntact();
  const listed = callTool('list_rules').rules.find((r) => r.name === RULE);
  assert(listed?.runCount === 1, `runCount ${listed?.runCount}`);
  const dry = callTool('delete_rule', { name: RULE, dryRun: true });
  assert(dry.dryRun === true && callTool('list_rules').rules.some((r) => r.name === RULE), 'dry run removed the rule');
  callTool('delete_rule', { name: RULE });
  assert(!callTool('list_rules').rules.some((r) => r.name === RULE), 'rule still listed');
});

await test('state files went to ICLOUD_MCP_DATA_DIR, not the repo', () => {
  const written = readdirSync(DATA_DIR);
  assert(written.includes('.icloud-mcp-move-manifest.json'), `move manifest not in data dir (found: ${written.join(', ') || 'nothing'})`);
  assert(written.includes('.icloud-mcp-rules.json'), 'rules file not in data dir');
  const inRepo = STATE_FILES.filter((f) => existsSync(join(projectDir, f)) && !repoStateBefore.includes(f));
  assert(inRepo.length === 0, `new state files in repo: ${inRepo.join(', ')}`);
});

await test('wipe and delete both temp folders', async () => {
  needMoves();
  for (const box of [SRC, DST]) {
    const all = await uidsIn(box, { all: true });
    const tagged = await uidsIn(box, { subject: TAG });
    assert(sameSet(all, tagged), `${box} holds non-dummy mail; not wiping`);
    if (all.length) {
      guardDryRun(callTool('bulk_delete', { sourceMailbox: box, dryRun: true }), all, `wipe ${box}`);
      callTool('bulk_delete', { sourceMailbox: box });
    }
    callTool('delete_mailbox', { name: box });
  }
  const boxes = callTool('list_mailboxes').map((b) => b.path);
  assert(!boxes.includes(SRC) && !boxes.includes(DST), 'temp folders still listed');
  movesReady = false;
});

// ─── Calendar ─────────────────────────────────────────────────────────────────

console.log(CALENDAR_NAME
  ? `\nCalendar (dummy events on "${CALENDAR_NAME}", Jan 2030, no alerts)`
  : '\nCalendar (skipped: set LIVE_CALENDAR to a disposable calendar name)');
let eventIds = [];

function taggedEvents() {
  const { events } = callTool('list_events', { calendarId, since: CAL_SINCE, before: CAL_BEFORE, limit: 500 });
  return events.filter((e) => (e.summary || '').includes(TAG));
}
function needCal() {
  if (!CALENDAR_NAME) throw new Skip('LIVE_CALENDAR is not set');
  if (!calendarId) throw new Skip(`no calendar named "${CALENDAR_NAME}"`);
}

const dummyEvents = Array.from({ length: 5 }, (_, i) => ({
  summary: `[${TAG}] event ${i + 1}`,
  start: `2030-01-${String(10 + i).padStart(2, '0')}T15:00:00`,
  end: `2030-01-${String(10 + i).padStart(2, '0')}T16:00:00`,
  timezone: 'America/New_York',
  reminder: 0,
}));

await test('bulk_create_events dryRun creates nothing', () => {
  needCal();
  const dry = callTool('bulk_create_events', { calendarId, events: dummyEvents, dryRun: true });
  assert(dry.wouldCreate === 5 && dry.changes.length === 5, 'bad dry run');
  assert(taggedEvents().length === 0, 'dry run created events');
});

await test('bulk_create_events creates 5 dummies', () => {
  needCal();
  const res = callTool('bulk_create_events', { calendarId, events: dummyEvents });
  assert(res.created === 5 && res.failed === 0, `created ${res.created}, failed ${res.failed}`);
  eventIds = taggedEvents().map((e) => e.eventId);
  assert(eventIds.length === 5, `found ${eventIds.length} dummies`);
});

await test('update_event changes one dummy', () => {
  needCal();
  callTool('update_event', { calendarId, eventId: eventIds[0], location: 'MCP Test Room' });
  const ev = callTool('get_event', { calendarId, eventId: eventIds[0] });
  assert(ev.location === 'MCP Test Room', `location ${ev.location}`);
  assert(ev.summary.includes(TAG), 'update lost the summary');
});

await test('bulk_update_events: dryRun changes nothing, real renames 2', () => {
  needCal();
  const updates = eventIds.slice(1, 3).map((eventId) => ({ eventId, summary: `[${TAG}] renamed` }));
  const dry = callTool('bulk_update_events', { calendarId, updates, dryRun: true });
  assert(dry.wouldUpdate === 2 && !dry.missing, 'bad dry run');
  assert(!taggedEvents().some((e) => e.summary.endsWith('renamed')), 'dry run renamed events');
  const res = callTool('bulk_update_events', { calendarId, updates });
  assert(res.updated === 2, `updated ${res.updated}`);
  assert(taggedEvents().filter((e) => e.summary.endsWith('renamed')).length === 2, 'rename not visible');
});

await test('delete_event: dryRun keeps it, real delete removes it', () => {
  needCal();
  const dry = callTool('delete_event', { calendarId, eventId: eventIds[0], dryRun: true });
  assert(dry.changes[0].summary.includes(TAG), 'dry run named the wrong event');
  callTool('get_event', { calendarId, eventId: eventIds[0] });
  callTool('delete_event', { calendarId, eventId: eventIds[0] });
  let gone = false;
  try { callTool('get_event', { calendarId, eventId: eventIds[0] }); } catch { gone = true; }
  assert(gone, 'event still readable');
  eventIds.shift();
});

await test('bulk_delete_events: dryRun keeps 4, real delete removes all', () => {
  needCal();
  const dry = callTool('bulk_delete_events', { calendarId, eventIds, dryRun: true });
  assert(dry.wouldDelete === 4 && dry.changes.every((c) => c.summary.includes(TAG)), 'bad dry run');
  assert(taggedEvents().length === 4, 'dry run deleted events');
  const res = callTool('bulk_delete_events', { calendarId, eventIds });
  assert(res.deleted === 4 && res.failed === 0, `deleted ${res.deleted}, failed ${res.failed}`);
  assert(taggedEvents().length === 0, 'dummies still on the calendar');
  eventIds = [];
});

if (calendarId && eventIds.length) {
  try { callTool('bulk_delete_events', { calendarId, eventIds }); console.log('  (cleanup) removed dummy events'); } catch {}
}
if (movesReady) console.log(`  (cleanup) ${SRC}/${DST} left behind; the next run's pre-flight removes them`);
rmSync(DATA_DIR, { recursive: true, force: true });

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(40));
console.log(`Passed:  ${passed}`);
console.log(`Failed:  ${failed}`);
console.log(`Skipped: ${skipped}\n`);
process.exit(failed ? 1 : 0);
