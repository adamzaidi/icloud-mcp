import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const dataRoot = mkdtempSync(join(tmpdir(), 'icloud-mcp-test-'));
process.env.ICLOUD_MCP_DATA_DIR = dataRoot;

const { dataDir, dataFile } = await import('../lib/data-paths.js');
const { setImapClientFactory, createRateLimitedClient } = await import('../lib/imap.js');
const { handleMailTool, mailTools } = await import('../lib/tools/mail.js');
const { handleContactTool, contactTools } = await import('../lib/tools/contacts.js');
const { handleCalendarTool, calendarTools, suggestEventTools } = await import('../lib/tools/calendar.js');
const { handleReminderTool, reminderTools } = await import('../lib/tools/reminders.js');
const { setCardDavRequestForTests, setCardDavDiscoveryForTests } = await import('../lib/carddav.js');
const { setCalDavRequestForTests, setCalDavDiscoveryForTests } = await import('../lib/caldav.js');
const { setJxaRunnerForTests, asArray } = await import('../lib/reminders.js');
const { attachImapErrorHandler } = await import('../lib/smtp.js');

const FIXTURE_UIDS = [101, 202];
const MUTATIONS = new Set(['messageDelete', 'messageMove', 'flagsAdd', 'flagsRemove', 'mailboxDelete', 'mailboxCreate', 'mailboxRename']);

function mockClient(state) {
  return {
    async connect() { state.calls.push('connect'); },
    async logout() { state.calls.push('logout'); },
    close() { state.calls.push('close'); },
    async mailboxOpen(name) { state.calls.push(['open', name]); },
    async mailboxCreate(name) { state.calls.push(['mailboxCreate', name]); },
    async mailboxDelete(name) { state.calls.push(['mailboxDelete', name]); },
    async mailboxRename(from, to) { state.calls.push(['mailboxRename', from, to]); },
    async status(name) {
      state.calls.push(['status', name]);
      return { messages: 2, unseen: 1, recent: 0 };
    },
    async search(query) {
      state.calls.push('search');
      state.lastSearch = query;
      return [...FIXTURE_UIDS];
    },
    async messageDelete(uids) { state.calls.push(['messageDelete', uids]); },
    async messageMove(uid, target) { state.calls.push(['messageMove', uid, target]); },
    async messageFlagsAdd() { state.calls.push('flagsAdd'); },
    async messageFlagsRemove() { state.calls.push('flagsRemove'); },
    async fetchOne(uid) {
      state.calls.push(['fetchOne', uid]);
      return {
        envelope: { subject: 'Fixture note', from: [{ address: 'sender@example.com' }] },
        flags: new Set(),
      };
    },
  };
}

const state = { calls: [] };
const ctx = {
  accounts: {
    icloud: { user: 'you@icloud.com', pass: 'fake-app-password', host: 'imap.example.test', smtpHost: 'smtp.example.test' },
  },
  resolveCreds() { return ctx.accounts.icloud; },
  resolveMailbox(name) { return name; },
};

function resetImap() {
  state.calls = [];
  setImapClientFactory(() => mockClient(state));
  for (const name of ['.icloud-mcp-rules.json', '.icloud-mcp-move-manifest.json', '.icloud-mcp-session.json', '.icloud-mcp-digest.json']) {
    const path = dataFile(name);
    if (existsSync(path)) rmSync(path);
  }
}

function assertNoMutation() {
  const bad = state.calls.filter((call) => MUTATIONS.has(Array.isArray(call) ? call[0] : call));
  assert.deepEqual(bad, [], `dryRun mutated: ${JSON.stringify(bad)}`);
}

function assertUidChanges(result, action, extra = {}) {
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.uids, FIXTURE_UIDS);
  assert.deepEqual(result.changes.map((change) => change.uid), FIXTURE_UIDS);
  for (const change of result.changes) {
    assert.equal(change.action, action);
    for (const [key, value] of Object.entries(extra)) assert.equal(change[key], value);
  }
  assertNoMutation();
}

const DESTRUCTIVE = [
  'delete_email', 'move_email', 'bulk_move', 'bulk_delete', 'bulk_delete_by_sender',
  'bulk_move_by_sender', 'bulk_delete_by_subject', 'bulk_mark_read', 'bulk_mark_unread',
  'delete_older_than', 'delete_mailbox', 'empty_trash', 'mark_older_than_read',
  'bulk_move_by_domain', 'bulk_flag_by_sender', 'archive_older_than', 'bulk_flag',
  'run_rule', 'delete_rule', 'run_all_rules', 'delete_contact', 'delete_event',
  'bulk_update_events', 'bulk_create_events', 'bulk_delete_events', 'delete_reminder',
  'delete_reminder_list', 'rename_reminder_list',
];

function listToolsOverStdio() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('IMAP_')) delete env[key];
  }
  env.IMAP_USER = 'you@icloud.com';
  env.IMAP_PASSWORD = 'fake-app-password';
  env.ICLOUD_MCP_DATA_DIR = dataRoot;

  const child = spawn(process.execPath, ['index.js'], { cwd: projectDir, env });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });

  const messages = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dry-run-test', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  ];
  child.stdin.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out waiting for tools/list\n${stdout.slice(0, 500)}`));
    }, 8000);
    child.stdout.on('data', () => {
      // The tools/list reply is large and arrives in several chunks; the text after
      // the last newline may be a partial line, so only parse complete lines.
      const lines = stdout.split('\n').slice(0, -1).filter((line) => line.trim().startsWith('{'));
      const messages = lines.map((line) => JSON.parse(line));
      const init = messages.find((message) => message.id === 0);
      const listed = messages.find((message) => message.id === 1);
      if (!init || !listed) return;
      clearTimeout(timer);
      child.kill();
      resolve({ init, listed });
    });
    child.on('exit', (code) => {
      if (code && code !== 0 && !stdout.includes('"id":1')) {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}`));
      }
    });
  });
}

const FAKE_VCARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Fake Person',
  'N:Person;Fake;;;',
  'EMAIL;type=INTERNET:fake.person@example.com',
  'TEL;type=cell:+1-555-0100',
  'END:VCARD',
].join('\r\n');

const FAKE_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'SUMMARY:Fixture meeting',
  'DTSTART:20260102T150000Z',
  'DTEND:20260102T160000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('offline dry-run, registration, and privacy paths', async (t) => {
  await t.test('local data defaults outside the repo and is configurable', () => {
    const previous = process.env.ICLOUD_MCP_DATA_DIR;
    delete process.env.ICLOUD_MCP_DATA_DIR;
    try {
      assert.equal(dataDir(), homedir());
      assert.notEqual(dataDir(), process.cwd());
      assert.equal(dataFile('.icloud-mcp-rules.json'), join(homedir(), '.icloud-mcp-rules.json'));
    } finally {
      process.env.ICLOUD_MCP_DATA_DIR = previous;
    }
    assert.equal(dataDir(), dataRoot);
    assert.ok(!dataFile('.icloud-mcp-rules.json').startsWith(projectDir));
  });

  await t.test('tool list matches package version and every destructive tool has dryRun', async () => {
    const { version } = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
    const { init, listed } = await listToolsOverStdio();
    assert.equal(init.result.serverInfo.version, version);
    assert.equal(init.result.serverInfo.name, 'icloud-mail');
    const tools = listed.result.tools;
    assert.equal(tools.length, 84);
    assert.equal(tools[0].name, 'list_accounts');
    assert.equal(tools.at(-1).name, 'suggest_event_from_email');
    const readme = readFileSync(join(projectDir, 'README.md'), 'utf8');
    assert.match(readme, new RegExp(version.replace(/\./g, '\\.')));
    for (const tool of tools) {
      assert.ok(readme.includes(`\`${tool.name}\``), `README missing ${tool.name}`);
      if (DESTRUCTIVE.includes(tool.name)) {
        assert.equal(tool.inputSchema.properties.dryRun.type, 'boolean', `${tool.name} dryRun`);
      }
    }
    assert.equal(mailTools.length + contactTools.length + calendarTools.length + reminderTools.length + suggestEventTools.length, 84);
  });

  await t.test('IMAP client errors are handled, not thrown', () => {
    // A socket timeout emits 'error' on the client; with no listener Node throws
    // it and the server process exits mid-operation.
    setImapClientFactory(null);
    const client = createRateLimitedClient({ user: 'nobody@example.invalid', pass: 'x' });
    assert.ok(client.listenerCount('error') > 0);
    assert.doesNotThrow(() => client.emit('error', new Error('Socket timeout')));
  });

  await t.test('save_draft IMAP errors are handled, not thrown', () => {
    const smtp = readFileSync(join(projectDir, 'lib/smtp.js'), 'utf8');
    assert.match(smtp, /attachImapErrorHandler\(client\)/);
    const client = new EventEmitter();
    attachImapErrorHandler(client);
    assert.equal(client.listenerCount('error'), 1);
    const lines = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      assert.doesNotThrow(() => client.emit('error', new Error('Socket timeout')));
    } finally {
      process.stderr.write = write;
    }
    assert.match(lines.join(''), /\[imap\] connection error: Socket timeout/);
  });

  await t.test('delete_email dryRun reports the message and does not delete', async () => {
    resetImap();
    const result = await handleMailTool('delete_email', { uid: 101, mailbox: 'INBOX', dryRun: true }, ctx);
    assert.equal(result.wouldDelete, 1);
    assert.deepEqual(result.changes, [{
      action: 'delete', uid: 101, mailbox: 'INBOX', subject: 'Fixture note', from: 'sender@example.com',
    }]);
    assertNoMutation();
  });

  await t.test('delete_email without dryRun does delete', async () => {
    resetImap();
    const result = await handleMailTool('delete_email', { uid: 101, mailbox: 'INBOX' }, ctx);
    assert.equal(result, true);
    assert.ok(state.calls.some((call) => Array.isArray(call) && call[0] === 'messageDelete'));
  });

  await t.test('move_email dryRun reports source and destination', async () => {
    resetImap();
    const result = await handleMailTool('move_email', {
      uid: 101, sourceMailbox: 'INBOX', targetMailbox: 'Archive', dryRun: true,
    }, ctx);
    assert.equal(result.wouldMove, 1);
    assert.deepEqual(result.changes[0], {
      action: 'move', uid: 101, sourceMailbox: 'INBOX', targetMailbox: 'Archive',
      subject: 'Fixture note', from: 'sender@example.com',
    });
    assertNoMutation();
  });

  await t.test('bulk_move dryRun lists every uid', async () => {
    resetImap();
    const result = await handleMailTool('bulk_move', {
      sender: 'sender@example.com', sourceMailbox: 'INBOX', targetMailbox: 'Archive', dryRun: true,
    }, ctx);
    assert.equal(result.wouldMove, 2);
    assertUidChanges(result, 'move', { sourceMailbox: 'INBOX', targetMailbox: 'Archive' });
  });

  await t.test('bulk_delete dryRun lists every uid', async () => {
    resetImap();
    const result = await handleMailTool('bulk_delete', { sender: 'sender@example.com', dryRun: true }, ctx);
    assert.equal(result.wouldDelete, 2);
    assertUidChanges(result, 'delete', { mailbox: 'INBOX' });
  });

  await t.test('bulk_delete_by_sender dryRun', async () => {
    resetImap();
    const result = await handleMailTool('bulk_delete_by_sender', { sender: 'sender@example.com', dryRun: true }, ctx);
    assert.equal(result.wouldDelete, 2);
    assertUidChanges(result, 'delete', { mailbox: 'INBOX', sender: 'sender@example.com' });
  });

  await t.test('bulk_delete_by_subject dryRun', async () => {
    resetImap();
    const result = await handleMailTool('bulk_delete_by_subject', { subject: 'Fixture', dryRun: true }, ctx);
    assert.equal(result.wouldDelete, 2);
    assertUidChanges(result, 'delete', { mailbox: 'INBOX', subject: 'Fixture' });
  });

  await t.test('delete_older_than dryRun', async () => {
    resetImap();
    const result = await handleMailTool('delete_older_than', { days: 30, dryRun: true }, ctx);
    assert.equal(result.wouldDelete, 2);
    assertUidChanges(result, 'delete', { mailbox: 'INBOX' });
    assert.match(result.olderThan, /^\d{4}-\d{2}-\d{2}T/);
  });

  await t.test('bulk_move_by_sender dryRun', async () => {
    resetImap();
    const result = await handleMailTool('bulk_move_by_sender', {
      sender: 'sender@example.com', targetMailbox: 'Newsletters', dryRun: true,
    }, ctx);
    assert.equal(result.wouldMove, 2);
    assertUidChanges(result, 'move', { sourceMailbox: 'INBOX', targetMailbox: 'Newsletters', sender: 'sender@example.com' });
  });

  await t.test('bulk_move_by_domain dryRun', async () => {
    resetImap();
    const result = await handleMailTool('bulk_move_by_domain', {
      domain: 'example.com', targetMailbox: 'Newsletters', dryRun: true,
    }, ctx);
    assert.equal(result.wouldMove, 2);
    assert.equal(result.domain, 'example.com');
    // iCloud misses some senders with the bare domain alone, so both forms are searched.
    assert.deepEqual(state.lastSearch, { or: [{ from: 'example.com' }, { from: '@example.com' }] });
    assertUidChanges(result, 'move', { sourceMailbox: 'INBOX', targetMailbox: 'Newsletters' });
  });

  await t.test('archive_older_than dryRun', async () => {
    resetImap();
    const result = await handleMailTool('archive_older_than', { days: 365, targetMailbox: 'Archive', dryRun: true }, ctx);
    assert.equal(result.wouldMove, 2);
    assertUidChanges(result, 'move', { sourceMailbox: 'INBOX', targetMailbox: 'Archive' });
  });

  await t.test('bulk_mark_read dryRun', async () => {
    resetImap();
    const result = await handleMailTool('bulk_mark_read', { sender: 'sender@example.com', dryRun: true }, ctx);
    assert.equal(result.wouldMarkRead, 2);
    assertUidChanges(result, 'mark_read', { mailbox: 'INBOX', sender: 'sender@example.com' });
  });

  await t.test('bulk_mark_unread dryRun', async () => {
    resetImap();
    const result = await handleMailTool('bulk_mark_unread', { dryRun: true }, ctx);
    assert.equal(result.wouldMarkUnread, 2);
    assertUidChanges(result, 'mark_unread', { mailbox: 'INBOX', sender: 'all' });
  });

  await t.test('mark_older_than_read dryRun', async () => {
    resetImap();
    const result = await handleMailTool('mark_older_than_read', { days: 14, dryRun: true }, ctx);
    assert.equal(result.wouldMarkRead, 2);
    assertUidChanges(result, 'mark_read', { mailbox: 'INBOX' });
  });

  await t.test('bulk_flag dryRun keeps dryRun out of the filter', async () => {
    resetImap();
    const result = await handleMailTool('bulk_flag', { flagged: true, subject: 'Fixture', dryRun: true }, ctx);
    assert.equal(result.wouldFlag, 2);
    assert.equal(result.filters.dryRun, undefined);
    assert.equal(result.filters.subject, 'Fixture');
    assertUidChanges(result, 'flag', { mailbox: 'INBOX' });
  });

  await t.test('bulk_flag_by_sender dryRun', async () => {
    resetImap();
    const result = await handleMailTool('bulk_flag_by_sender', { sender: 'sender@example.com', flagged: false, dryRun: true }, ctx);
    assert.equal(result.wouldUnflag, 2);
    assertUidChanges(result, 'unflag', { mailbox: 'INBOX', sender: 'sender@example.com' });
  });

  await t.test('empty_trash dryRun', async () => {
    resetImap();
    const result = await handleMailTool('empty_trash', { dryRun: true }, ctx);
    assert.equal(result.wouldDelete, 2);
    assert.equal(result.mailbox, 'Deleted Messages');
    assertUidChanges(result, 'delete', { mailbox: 'Deleted Messages' });
  });

  await t.test('delete_mailbox dryRun reports the folder and does not delete it', async () => {
    resetImap();
    const result = await handleMailTool('delete_mailbox', { name: 'mcp-test-folder', dryRun: true }, ctx);
    assert.equal(result.wouldDelete, true);
    assert.deepEqual(result.changes, [{ action: 'delete_mailbox', mailbox: 'mcp-test-folder', messageCount: 2 }]);
    assertNoMutation();
  });

  await t.test('delete_rule dryRun leaves the rule in place', async () => {
    resetImap();
    await handleMailTool('create_rule', {
      name: 'fixture-rule',
      filters: { sender: 'nobody@example.com' },
      action: { type: 'delete' },
    }, ctx);
    const preview = await handleMailTool('delete_rule', { name: 'fixture-rule', dryRun: true }, ctx);
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.changes[0].ruleAction, { type: 'delete' });
    assert.equal(preview.changes[0].filters.sender, 'nobody@example.com');
    const listed = await handleMailTool('list_rules', {}, ctx);
    assert.equal(listed.rules.length, 1);
    assert.equal(listed.rules[0].name, 'fixture-rule');
  });

  await t.test('run_rule dryRun does not change mail or runCount', async () => {
    resetImap();
    await handleMailTool('create_rule', {
      name: 'fixture-run',
      filters: { sender: 'nobody@example.com' },
      action: { type: 'delete', sourceMailbox: 'INBOX' },
    }, ctx);
    const result = await handleMailTool('run_rule', { name: 'fixture-run', dryRun: true }, ctx);
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldDelete, 2);
    assert.equal(result.action, 'delete');
    assertUidChanges(result, 'delete', { mailbox: 'INBOX' });
    const listed = await handleMailTool('list_rules', {}, ctx);
    assert.equal(listed.rules[0].runCount, 0);
    assert.equal(listed.rules[0].lastRun, null);
  });

  await t.test('run_all_rules dryRun previews each rule', async () => {
    resetImap();
    await handleMailTool('create_rule', {
      name: 'fixture-all',
      filters: { domain: 'example.com' },
      action: { type: 'move', targetMailbox: 'Archive' },
    }, ctx);
    const result = await handleMailTool('run_all_rules', { dryRun: true }, ctx);
    assert.equal(result.ran, 1);
    assert.equal(result.results[0].dryRun, true);
    assert.equal(result.results[0].wouldMove, 2);
    assert.deepEqual(result.results[0].changes.map((change) => change.uid), FIXTURE_UIDS);
    assert.equal(result.results[0].changes[0].action, 'move');
    assert.equal(result.results[0].changes[0].targetMailbox, 'Archive');
    assertNoMutation();
    const listed = await handleMailTool('list_rules', {}, ctx);
    assert.equal(listed.rules[0].runCount, 0);
  });

  await t.test('delete_contact dryRun fetches the card and does not delete it', async () => {
    const methods = [];
    setCardDavRequestForTests(async (method) => {
      methods.push(method);
      if (method !== 'GET') throw new Error(`unexpected CardDAV ${method}`);
      return { status: 200, etag: 'W/"fixture"', body: FAKE_VCARD };
    });
    setCardDavDiscoveryForTests({ dataHost: 'https://contacts.example.test', addressBookPath: '/book/' });
    const result = await handleContactTool('delete_contact', { contactId: 'FAKE-CONTACT', dryRun: true }, ctx);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.changes[0], {
      action: 'delete_contact',
      contactId: 'FAKE-CONTACT',
      fullName: 'Fake Person',
      emails: [{ type: 'home', email: 'fake.person@example.com' }],
      phones: [{ type: 'cell', number: '+1-555-0100' }],
    });
    assert.deepEqual(methods, ['GET']);
  });

  await t.test('delete_event dryRun', async () => {
    const methods = [];
    setCalDavRequestForTests(async (method) => {
      methods.push(method);
      if (method !== 'GET') throw new Error(`unexpected CalDAV ${method}`);
      return { status: 200, etag: 'W/"evt"', body: FAKE_ICS };
    });
    setCalDavDiscoveryForTests({ dataHost: 'https://cal.example.test', calendarsPath: '/calendars/' });
    const result = await handleCalendarTool('delete_event', { calendarId: 'cal-1', eventId: 'evt-1', dryRun: true }, ctx);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.changes[0], {
      action: 'delete_event', calendarId: 'cal-1', eventId: 'evt-1',
      summary: 'Fixture meeting', start: '2026-01-02T15:00:00Z', end: '2026-01-02T16:00:00Z',
    });
    assert.deepEqual(methods, ['GET']);
  });

  await t.test('bulk_delete_events dryRun', async () => {
    const methods = [];
    setCalDavRequestForTests(async (method) => {
      methods.push(method);
      if (method !== 'GET') throw new Error(`unexpected CalDAV ${method}`);
      return { status: 200, etag: 'W/"evt"', body: FAKE_ICS };
    });
    setCalDavDiscoveryForTests({ dataHost: 'https://cal.example.test', calendarsPath: '/calendars/' });
    const result = await handleCalendarTool('bulk_delete_events', {
      calendarId: 'cal-1', eventIds: ['evt-1', 'evt-2'], dryRun: true,
    }, ctx);
    assert.equal(result.wouldDelete, 2);
    assert.deepEqual(result.changes.map((change) => change.eventId), ['evt-1', 'evt-2']);
    assert.ok(result.changes.every((change) => change.action === 'delete_event' && change.summary === 'Fixture meeting'));
    assert.deepEqual(methods, ['GET', 'GET']);
  });

  await t.test('bulk_update_events dryRun reports fields and does not PUT', async () => {
    const methods = [];
    setCalDavRequestForTests(async (method) => {
      methods.push(method);
      if (method !== 'GET') throw new Error(`unexpected CalDAV ${method}`);
      return { status: 200, etag: 'W/"evt"', body: FAKE_ICS };
    });
    setCalDavDiscoveryForTests({ dataHost: 'https://cal.example.test', calendarsPath: '/calendars/' });
    const result = await handleCalendarTool('bulk_update_events', {
      calendarId: 'cal-1',
      updates: [{ eventId: 'evt-1', summary: 'Updated fixture', location: 'Example Hall' }],
      dryRun: true,
    }, ctx);
    assert.equal(result.wouldUpdate, 1);
    assert.equal(result.changes[0].action, 'update_event');
    assert.equal(result.changes[0].summary, 'Fixture meeting');
    assert.deepEqual(result.changes[0].fields, { summary: 'Updated fixture', location: 'Example Hall' });
    assert.deepEqual(methods, ['GET']);
  });

  await t.test('bulk_create_events dryRun does not write', async () => {
    const methods = [];
    setCalDavRequestForTests(async (method) => {
      methods.push(method);
      throw new Error(`unexpected CalDAV ${method}`);
    });
    const result = await handleCalendarTool('bulk_create_events', {
      calendarId: 'cal-1',
      events: [
        { summary: 'Fixture one', start: '2026-04-01T10:00:00' },
        { summary: 'Fixture two', start: '2026-04-02', allDay: true, end: '2026-04-03' },
      ],
      dryRun: true,
    }, ctx);
    assert.equal(result.wouldCreate, 2);
    assert.deepEqual(result.changes, [
      { action: 'create_event', index: 0, calendarId: 'cal-1', summary: 'Fixture one', start: '2026-04-01T10:00:00', end: null, allDay: false },
      { action: 'create_event', index: 1, calendarId: 'cal-1', summary: 'Fixture two', start: '2026-04-02', end: '2026-04-03', allDay: true },
    ]);
    assert.deepEqual(methods, []);
  });

  await t.test('delete_reminder dryRun reads the reminder and does not delete it', async () => {
    const scripts = [];
    setJxaRunnerForTests((script) => {
      scripts.push(script);
      if (script.includes('app.delete')) throw new Error('reminder delete ran during dryRun');
      return JSON.stringify({
        id: 'rem-fake-1', title: 'Fixture reminder', notes: 'example only', completed: false,
        due: null, completedAt: null, priority: 'none', listName: 'Example', listId: 'list-1',
        createdAt: null, modifiedAt: null,
      });
    });
    const result = await handleReminderTool('delete_reminder', {
      listName: 'Example', reminderId: 'rem-fake-1', dryRun: true,
    }, ctx);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.changes[0], {
      action: 'delete_reminder', listName: 'Example', reminderId: 'rem-fake-1',
      title: 'Fixture reminder', notes: 'example only', due: null,
    });
    assert.equal(scripts.length, 1);
    assert.ok(!scripts[0].includes('app.delete'));
    setJxaRunnerForTests(null);
  });

  await t.test('rename_reminder_list dryRun does not rename', async () => {
    const scripts = [];
    setJxaRunnerForTests((script) => {
      scripts.push(script);
      return JSON.stringify({ dryRun: true, changes: [{ action: 'rename_reminder_list', id: 'list-1', from: 'Old', to: 'New' }] });
    });
    const result = await handleReminderTool('rename_reminder_list', { oldName: 'Old', newName: 'New', dryRun: true }, ctx);
    assert.equal(result.changes[0].to, 'New');
    assert.equal(scripts.length, 1);
    assert.ok(scripts[0].includes('const dryRun = true'));
    setJxaRunnerForTests(null);
  });

  await t.test('delete_reminder_list dryRun does not delete the list', async () => {
    const scripts = [];
    setJxaRunnerForTests((script) => {
      scripts.push(script);
      return JSON.stringify({
        dryRun: true, wouldDelete: true, reminderCount: 0,
        changes: [{ action: 'delete_reminder_list', name: 'Example', id: 'list-1', reminderCount: 0 }],
      });
    });
    const result = await handleReminderTool('delete_reminder_list', { name: 'Example', dryRun: true }, ctx);
    assert.equal(result.dryRun, true);
    assert.equal(result.changes[0].action, 'delete_reminder_list');
    assert.equal(scripts.length, 1);
    assert.ok(scripts[0].includes('const dryRun = true'));
    setJxaRunnerForTests(null);
  });

  await t.test('reminder lookups and listings batch their Apple Events', async () => {
    const scripts = [];
    setJxaRunnerForTests((script) => {
      scripts.push(script);
      return JSON.stringify({ reminders: [], count: 0, listName: 'Example', includeCompleted: false, updated: true, id: 'r' });
    });
    await handleReminderTool('list_reminders', { listName: 'Example' }, ctx);
    await handleReminderTool('complete_reminder', { listName: 'Example', reminderId: 'r' }, ctx);
    assert.ok(scripts[0].includes('asArray(spec.name())'), 'list_reminders should read names in one batch');
    assert.ok(!scripts[0].includes('r.name()'), 'list_reminders should not read per reminder');
    assert.ok(scripts[1].includes('asArray(list.reminders.whose({ id: id })())'), 'findReminder should coerce whose()');
    assert.ok(scripts[0].includes(asArray.toString()));
    assert.ok(scripts[1].includes(asArray.toString()));
    assert.deepEqual(asArray(undefined), []);
    assert.deepEqual(asArray(null), []);
    assert.deepEqual(asArray('only-id'), ['only-id']);
    assert.deepEqual(asArray(['a', 'b']), ['a', 'b']);
    setJxaRunnerForTests(null);
  });
});
