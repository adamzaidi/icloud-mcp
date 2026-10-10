// Exact tool lists per ICLOUD_MCP_TOOL_PROFILE. No iCloud connections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const projectDir = fileURLToPath(new URL('../..', import.meta.url));
const dataRoot = mkdtempSync(join(tmpdir(), 'icloud-mcp-profile-'));
process.env.ICLOUD_MCP_DATA_DIR = dataRoot;

const { mailTools } = await import('../../lib/tools/mail.js');
const { contactTools } = await import('../../lib/tools/contacts.js');
const { calendarTools, suggestEventTools, handleCalendarTool } = await import('../../lib/tools/calendar.js');
const { reminderTools } = await import('../../lib/tools/reminders.js');
const { selectTools, prepareToolCall, hiddenRemoteSafeTools, resolveToolProfile } = await import('../../lib/tool-profile.js');
const { createEvent, setCalDavRequestForTests, setCalDavDiscoveryForTests } = await import('../../lib/caldav.js');

const allTools = [...mailTools, ...contactTools, ...calendarTools, ...reminderTools, ...suggestEventTools];

const FULL = [
  'list_accounts', 'get_inbox_summary', 'get_mailbox_summary', 'get_top_senders', 'get_unread_senders',
  'get_emails_by_sender', 'read_inbox', 'get_email', 'search_emails', 'count_emails',
  'bulk_move', 'bulk_delete', 'bulk_flag', 'bulk_delete_by_sender', 'bulk_move_by_sender',
  'bulk_delete_by_subject', 'bulk_mark_read', 'bulk_mark_unread', 'delete_older_than', 'get_emails_by_date_range',
  'flag_email', 'mark_as_read', 'delete_email', 'move_email', 'list_mailboxes',
  'create_mailbox', 'rename_mailbox', 'delete_mailbox', 'empty_trash', 'get_move_status',
  'abandon_move', 'log_write', 'log_read', 'log_clear', 'list_attachments',
  'get_attachment', 'get_unsubscribe_info', 'mark_older_than_read', 'bulk_move_by_domain', 'get_email_raw',
  'bulk_flag_by_sender', 'archive_older_than', 'get_storage_report', 'get_thread', 'create_rule',
  'list_rules', 'run_rule', 'delete_rule', 'run_all_rules', 'compose_email',
  'reply_to_email', 'forward_email', 'save_draft', 'get_digest_state', 'update_digest_state',
  'list_contacts', 'search_contacts', 'get_contact', 'create_contact', 'update_contact', 'delete_contact',
  'list_calendars', 'create_calendar', 'delete_calendar', 'list_events', 'get_event',
  'create_event', 'update_event', 'delete_event', 'search_events', 'bulk_update_events',
  'list_events_multi', 'bulk_create_events', 'bulk_delete_events', 'detect_conflicts',
  'list_reminder_lists', 'create_reminder_list', 'rename_reminder_list', 'delete_reminder_list', 'list_reminders',
  'get_reminder', 'create_reminder', 'update_reminder', 'complete_reminder', 'delete_reminder',
  'suggest_event_from_email',
];

const REMOTE_SAFE = [
  'list_accounts', 'get_inbox_summary', 'get_mailbox_summary', 'get_top_senders', 'get_unread_senders',
  'get_emails_by_sender', 'read_inbox', 'get_email', 'search_emails', 'count_emails',
  'get_emails_by_date_range', 'flag_email', 'mark_as_read', 'list_mailboxes', 'create_mailbox',
  'get_move_status', 'log_write', 'log_read', 'list_attachments', 'get_attachment',
  'get_unsubscribe_info', 'get_email_raw', 'get_storage_report', 'get_thread', 'save_draft',
  'get_digest_state', 'update_digest_state',
  'list_contacts', 'search_contacts', 'get_contact', 'create_contact', 'update_contact',
  'list_calendars', 'create_calendar', 'list_events', 'get_event', 'create_event', 'update_event',
  'search_events', 'bulk_update_events', 'list_events_multi', 'bulk_create_events', 'detect_conflicts',
  'list_reminder_lists', 'create_reminder_list', 'rename_reminder_list', 'list_reminders', 'get_reminder',
  'create_reminder', 'update_reminder', 'complete_reminder',
  'suggest_event_from_email',
];

function names(tools) {
  return tools.map((tool) => tool.name);
}

function serverEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('IMAP_') || key.startsWith('ICLOUD_MCP_')) delete env[key];
  }
  env.IMAP_USER = 'you@icloud.com';
  env.IMAP_PASSWORD = 'fake-app-password';
  env.ICLOUD_MCP_DATA_DIR = dataRoot;
  return { ...env, ...extra };
}

function runServer(extra, messages) {
  const child = spawn(process.execPath, ['index.js'], { cwd: projectDir, env: serverEnv(extra) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (messages) {
    child.stdin.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out\n${stderr.slice(0, 400)}\n${stdout.slice(0, 400)}`));
    }, 8000);
    const finish = (code) => {
      clearTimeout(timer);
      child.kill();
      const parsed = stdout.split('\n').filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line));
      resolve({ code, stderr, stdout, parsed });
    };
    if (!messages) {
      child.on('exit', (code) => finish(code));
      return;
    }
    child.stdout.on('data', () => {
      const lines = stdout.split('\n').slice(0, -1).filter((line) => line.trim().startsWith('{'));
      const parsed = lines.map((line) => JSON.parse(line));
      const needed = messages.filter((message) => message.id != null).map((message) => message.id);
      if (needed.every((id) => parsed.some((message) => message.id === id))) finish(0);
    });
  });
}

const init = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'profile-test', version: '1.0.0' } },
};

test('full is the default and remote-safe exposes an exact list', () => {
  assert.deepEqual(names(allTools), FULL);
  assert.equal(resolveToolProfile({}), 'full');
  assert.equal(resolveToolProfile({ ICLOUD_MCP_TOOL_PROFILE: '  ' }), 'full');
  assert.deepEqual(names(selectTools(allTools, {})), FULL);
  assert.deepEqual(names(selectTools(allTools, { ICLOUD_MCP_TOOL_PROFILE: 'full' })), FULL);
  assert.deepEqual(names(selectTools(allTools, { ICLOUD_MCP_TOOL_PROFILE: ' Remote-Safe ' })), REMOTE_SAFE);

  const hidden = FULL.filter((name) => !REMOTE_SAFE.includes(name)).sort();
  assert.deepEqual([...hiddenRemoteSafeTools(allTools)].sort(), hidden);
  const withNew = [...allTools, { name: 'export_everything', inputSchema: { type: 'object', properties: {} } }];
  assert.equal(names(selectTools(withNew, {})).includes('export_everything'), true);
  assert.equal(names(selectTools(withNew, { ICLOUD_MCP_TOOL_PROFILE: 'remote-safe' })).includes('export_everything'), false);
  assert.throws(
    () => prepareToolCall('export_everything', {}, { ICLOUD_MCP_TOOL_PROFILE: 'remote-safe' }),
    /not available in the remote-safe tool profile/
  );
  for (const name of ['compose_email', 'delete_email', 'bulk_delete', 'empty_trash', 'run_rule', 'delete_calendar', 'delete_reminder_list', 'log_clear']) {
    assert.equal(REMOTE_SAFE.includes(name), false, name);
  }
  for (const name of ['save_draft', 'search_emails', 'create_event', 'update_reminder', 'bulk_create_events', 'bulk_update_events']) {
    assert.equal(REMOTE_SAFE.includes(name), true, name);
  }
  assert.throws(() => resolveToolProfile({ ICLOUD_MCP_TOOL_PROFILE: 'yolo' }), /must be full or remote-safe/);
});

test('remote-safe forces dryRun on remaining bulk tools unless allowed', async () => {
  const env = { ICLOUD_MCP_TOOL_PROFILE: 'remote-safe' };
  const forced = prepareToolCall('bulk_create_events', {
    calendarId: 'cal',
    events: [{ summary: 'Fixture', start: '2030-01-02T15:00:00Z' }],
    dryRun: false,
  }, env);
  assert.equal(forced.dryRun, true);
  const omitted = prepareToolCall('bulk_update_events', { calendarId: 'cal', updates: [] }, env);
  assert.equal(omitted.dryRun, true);

  const allowedEnv = { ...env, ICLOUD_MCP_ALLOW_BULK: ' bulk_create_events , bulk_update_events ' };
  const allowed = prepareToolCall('bulk_create_events', {
    calendarId: 'cal',
    events: [{ summary: 'Fixture', start: '2030-01-02T15:00:00Z' }],
    dryRun: false,
  }, allowedEnv);
  assert.equal(allowed.dryRun, false);
  const allowedOmitted = prepareToolCall('bulk_update_events', { calendarId: 'cal', updates: [] }, allowedEnv);
  assert.equal(allowedOmitted.dryRun, undefined);

  assert.equal(prepareToolCall('create_event', { summary: 'One' }, env).dryRun, undefined);
  assert.equal(prepareToolCall('bulk_delete', { dryRun: false }, { ICLOUD_MCP_TOOL_PROFILE: 'full' }).dryRun, false);
  assert.throws(
    () => prepareToolCall('compose_email', { to: 'you@icloud.com' }, { ...env, ICLOUD_MCP_ALLOW_BULK: 'compose_email' }),
    /not available in the remote-safe tool profile/
  );

  const calls = [];
  setCalDavRequestForTests(async (method) => {
    calls.push(method);
    return { status: 201, etag: null, body: '' };
  });
  setCalDavDiscoveryForTests({ dataHost: 'https://caldav.example.test', calendarsPath: '/cal/' });
  try {
    const result = await handleCalendarTool('bulk_create_events', forced, {
      resolveCreds() { return { user: 'you@icloud.com', pass: 'fake-app-password' }; },
      resolveMailbox(name) { return name; },
      accounts: {},
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldCreate, 1);
    assert.deepEqual(calls, []);

    await handleCalendarTool('bulk_create_events', allowed, {
      resolveCreds() { return { user: 'you@icloud.com', pass: 'fake-app-password' }; },
      resolveMailbox(name) { return name; },
      accounts: {},
    });
    assert.deepEqual(calls, ['PUT']);
  } finally {
    setCalDavRequestForTests(null);
    setCalDavDiscoveryForTests(null);
  }
});

test('calendar text cannot inject ATTENDEE or ORGANIZER lines', async () => {
  const bodies = [];
  setCalDavRequestForTests(async (_method, _url, opts) => {
    bodies.push(opts.body);
    return { status: 201, etag: null, body: '' };
  });
  setCalDavDiscoveryForTests({ dataHost: 'https://caldav.example.test', calendarsPath: '/cal/' });
  try {
    await createEvent('cal', {
      summary: 'Meet\r\nATTENDEE:mailto:evil@example.com',
      description: 'Notes\nORGANIZER:mailto:evil@example.com',
      location: 'Room\r\nATTENDEE:mailto:evil@example.com',
      recurrence: 'FREQ=DAILY\r\nATTENDEE:mailto:evil@example.com',
      status: 'CONFIRMED\nORGANIZER:mailto:evil@example.com',
      timezone: 'UTC\r\nATTENDEE:mailto:evil@example.com',
      start: '2030-01-02T15:00:00Z',
      end: '2030-01-02T16:00:00Z',
    });
  } finally {
    setCalDavRequestForTests(null);
    setCalDavDiscoveryForTests(null);
  }
  assert.equal(bodies.length, 1);
  const lines = bodies[0].split(/\r\n/);
  assert.equal(lines.some((line) => line.startsWith('ATTENDEE')), false);
  assert.equal(lines.some((line) => line.startsWith('ORGANIZER')), false);
  assert.match(lines.find((line) => line.startsWith('SUMMARY:')), /\\nATTENDEE/);
  assert.match(lines.find((line) => line.startsWith('RRULE:')), /\\nATTENDEE/);
  const unfolded = bodies[0].replace(/\r\n/g, '\n');
  assert.equal(unfolded.includes('\nATTENDEE'), false);
  assert.equal(unfolded.includes('\nORGANIZER'), false);
  assert.equal(unfolded.includes('\r'), false);
});

test('stdio exposes the exact list for each profile and rejects hidden tools', async () => {
  const full = await runServer({}, [
    init,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  ]);
  const fullList = full.parsed.find((message) => message.id === 1);
  assert.deepEqual(fullList.result.tools.map((tool) => tool.name), FULL);

  const remote = await runServer({ ICLOUD_MCP_TOOL_PROFILE: 'remote-safe' }, [
    init,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  ]);
  const remoteList = remote.parsed.find((message) => message.id === 1);
  assert.deepEqual(remoteList.result.tools.map((tool) => tool.name), REMOTE_SAFE);

  const blocked = await runServer({ ICLOUD_MCP_TOOL_PROFILE: 'remote-safe' }, [
    init,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'empty_trash', arguments: {} } },
  ]);
  const call = blocked.parsed.find((message) => message.id === 1);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /empty_trash is not available in the remote-safe tool profile/);

  const kept = await runServer({ ICLOUD_MCP_TOOL_PROFILE: 'remote-safe' }, [
    init,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } },
  ]);
  const accounts = kept.parsed.find((message) => message.id === 1);
  assert.equal(accounts.result.isError, undefined);
  assert.match(accounts.result.content[0].text, /icloud/);

  const invalid = await runServer({ ICLOUD_MCP_TOOL_PROFILE: 'yolo' });
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /ICLOUD_MCP_TOOL_PROFILE must be full or remote-safe/);
});
