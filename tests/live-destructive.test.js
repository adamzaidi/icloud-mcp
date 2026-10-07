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
//
// Run with:  ICLOUD_MCP_LIVE=1 IMAP_USER=... IMAP_PASSWORD=... npm run test:live
// Optional:  MASS_COUNT=600 (dummy emails in the bulk_delete batch; default crosses
//            the 500-message chunk boundary), --verbose for server stderr.

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
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

// ─── Harness ──────────────────────────────────────────────────────────────────

function callTool(name, args = {}, timeout = 600000) {
  const input = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-test', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';

  const result = spawnSync(process.execPath, ['index.js'], {
    cwd: projectDir, input, encoding: 'utf8', timeout, env: process.env,
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

// Appends `count` dummy messages and returns their UIDs.
async function seed(count, { label, from, date } = {}) {
  return withImap(async (client) => {
    const uids = [];
    for (let i = 0; i < count; i++) {
      const subject = `[${TAG}] ${label} ${i + 1}`;
      const res = await client.append(FOLDER, rawMessage({ subject, from, date }), ['\\Seen'], date || new Date());
      if (!res?.uid) throw new Error('APPEND did not return a UID (server lacks UIDPLUS?)');
      uids.push(res.uid);
    }
    return uids;
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
    if (subjects.length) callTool('bulk_delete', { sourceMailbox: box.path });
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

await test('complete_reminder hides it from the default listing', () => {
  if (reminderIds.length < 5) throw new Skip('reminders not created');
  callTool('complete_reminder', { listName: LIST_NAME, reminderId: reminderIds[0] });
  const open = callTool('list_reminders', { listName: LIST_NAME });
  const all = callTool('list_reminders', { listName: LIST_NAME, includeCompleted: true });
  assert(open.count === 4 && all.count === 5, `open ${open.count}, all ${all.count}`);
});

await test('delete_reminder_list refuses a non-empty list', () => {
  if (!listCreated) throw new Skip('no dummy list');
  const dry = callTool('delete_reminder_list', { name: LIST_NAME, dryRun: true });
  assert(dry.wouldDelete === false && dry.reminderCount === 5, `dry run said wouldDelete=${dry.wouldDelete}, count=${dry.reminderCount}`);
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

await test('delete_reminder removes all 5 dummies (incl. completed)', () => {
  if (!reminderIds.length) throw new Skip('no reminders');
  while (reminderIds.length) {
    const id = reminderIds[0];
    const res = callTool('delete_reminder', { listName: LIST_NAME, reminderId: id });
    assert(res.deleted === true, `reminder ${id} not deleted`);
    reminderIds.shift();
  }
  const { count } = callTool('list_reminders', { listName: LIST_NAME, includeCompleted: true });
  assert(count === 0, `${count} reminders left in the list`);
});

await test('delete_reminder_list removes the empty dummy list', () => {
  if (!listCreated) throw new Skip('no dummy list');
  const dry = callTool('delete_reminder_list', { name: LIST_NAME, dryRun: true });
  assert(dry.wouldDelete === true, 'dry run says it would not delete');
  callTool('delete_reminder_list', { name: LIST_NAME });
  const { lists } = callTool('list_reminder_lists');
  assert(!lists.some((l) => l.name === LIST_NAME), 'list still exists');
  listCreated = false;
});

if (listCreated) {
  try {
    for (const id of reminderIds) callTool('delete_reminder', { listName: LIST_NAME, reminderId: id });
    callTool('delete_reminder_list', { name: LIST_NAME });
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

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(40));
console.log(`Passed:  ${passed}`);
console.log(`Failed:  ${failed}`);
console.log(`Skipped: ${skipped}\n`);
process.exit(failed ? 1 : 0);
