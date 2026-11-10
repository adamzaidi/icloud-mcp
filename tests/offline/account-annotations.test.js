// Every mail tool that reaches a mail server declares `account` and uses it,
// rules run against the account they were created with, and every tool carries
// read-only / destructive annotations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.ICLOUD_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'icloud-mcp-acct-'));

const { setImapClientFactory } = await import('../../lib/imap.js');
const { mailTools, handleMailTool, TOOLS_WITHOUT_ACCOUNT } = await import('../../lib/tools/mail.js');
const { contactTools } = await import('../../lib/tools/contacts.js');
const { calendarTools, suggestEventTools, handleCalendarTool } = await import('../../lib/tools/calendar.js');
const { reminderTools } = await import('../../lib/tools/reminders.js');
const {
  READ_ONLY_TOOLS, DESTRUCTIVE_TOOLS, SEND_TOOLS, WRITE_TOOLS, annotationsFor, withAnnotations,
} = await import('../../lib/tool-annotations.js');

const allTools = [...mailTools, ...contactTools, ...calendarTools, ...reminderTools, ...suggestEventTools];

test('every tool is classified exactly once', () => {
  const classified = [...READ_ONLY_TOOLS, ...DESTRUCTIVE_TOOLS, ...SEND_TOOLS, ...WRITE_TOOLS];
  assert.equal(new Set(classified).size, classified.length, 'a tool is in two lists');
  assert.deepEqual([...classified].sort(), allTools.map((tool) => tool.name).sort());
});

test('annotations describe what a tool can do', () => {
  assert.deepEqual(annotationsFor('get_email'), { readOnlyHint: true, openWorldHint: false });
  assert.equal(annotationsFor('delete_email').destructiveHint, true);
  assert.equal(annotationsFor('empty_trash').destructiveHint, true);
  assert.equal(annotationsFor('run_all_rules').destructiveHint, true);
  assert.deepEqual(annotationsFor('bulk_move'), { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  assert.equal(annotationsFor('compose_email').openWorldHint, true);
  assert.equal(annotationsFor('save_draft').openWorldHint, false);
  // A tool nobody classified is described as the riskiest kind.
  assert.deepEqual(annotationsFor('some_new_tool'), { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  for (const tool of withAnnotations(allTools)) {
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
  }
  // No read-only tool takes dryRun: a preview flag means the tool can write.
  for (const tool of allTools) {
    if (READ_ONLY_TOOLS.includes(tool.name)) assert.equal(tool.inputSchema.properties.dryRun, undefined, tool.name);
  }
});

test('mail tools declare account and pass it to the credential lookup', async () => {
  const withAccount = mailTools.filter((tool) => !TOOLS_WITHOUT_ACCOUNT.has(tool.name));
  assert.equal(withAccount.length, mailTools.length - TOOLS_WITHOUT_ACCOUNT.size);
  for (const tool of mailTools) {
    const declared = tool.inputSchema.properties.account !== undefined;
    assert.equal(declared, !TOOLS_WITHOUT_ACCOUNT.has(tool.name), tool.name);
  }

  setImapClientFactory(() => { throw new Error('no IMAP connection should be opened'); });
  const sample = {
    uid: 1, sender: 'a@example.com', subject: 'x', days: 1, domain: 'example.com', flagged: true, seen: true,
    targetMailbox: 'Archive', name: 'rule-or-folder', oldName: 'a', newName: 'b', partId: '2',
    startDate: '2026-01-01', endDate: '2026-01-02', to: 'you@icloud.com', mailbox: 'INBOX',
    filters: {}, action: { type: 'flag' },
  };
  for (const tool of [...withAccount, ...suggestEventTools]) {
    let asked = null;
    const ctx = {
      accounts: {},
      resolveCreds(account) { asked = account; throw new Error('STOP'); },
      resolveMailbox(name) { return name; },
    };
    const handle = suggestEventTools.includes(tool) ? handleCalendarTool : handleMailTool;
    await assert.rejects(handle(tool.name, { ...sample, account: 'work' }, ctx), /STOP/, tool.name);
    assert.equal(asked, 'work', tool.name);
  }
});

test('a rule runs against the account it was created with', async () => {
  const opened = [];
  const client = (creds) => ({
    async connect() {},
    async logout() {},
    close() {},
    async mailboxOpen(name) { opened.push([creds?.user ?? null, name]); },
    async search() { return [7]; },
    async list() { return [{ path: '[Gmail]/Trash', specialUse: '\\Trash' }]; },
  });
  setImapClientFactory(client);
  const work = { user: 'me@work.example', pass: 'x', host: 'imap.gmail.com' };
  const ctx = {
    accounts: { work },
    resolveCreds(account) {
      if (account && account !== 'work') throw new Error(`Account '${account}' not configured`);
      return work;
    },
    resolveMailbox(name, creds) { return creds?.host === 'imap.gmail.com' && name === 'Archive' ? '[Gmail]/All Mail' : name; },
  };

  await assert.rejects(
    handleMailTool('create_rule', { name: 'bad', filters: {}, action: { type: 'flag' }, account: 'nope' }, ctx),
    /not configured/
  );
  const rule = await handleMailTool('create_rule', {
    name: 'work-archive', filters: { sender: 'a@example.com' }, action: { type: 'move', targetMailbox: 'Archive' }, account: 'work',
  }, ctx);
  assert.equal(rule.account, 'work');
  const dry = await handleMailTool('run_rule', { name: 'work-archive', dryRun: true }, ctx);
  assert.equal(dry.targetMailbox, '[Gmail]/All Mail');
  assert.deepEqual(opened.at(-1), ['me@work.example', 'INBOX']);

  // A rule with no account keeps using the IMAP_USER / IMAP_PASSWORD account.
  await handleMailTool('create_rule', { name: 'legacy', filters: {}, action: { type: 'flag' } }, ctx);
  await handleMailTool('run_rule', { name: 'legacy', dryRun: true }, ctx);
  assert.deepEqual(opened.at(-1), [null, 'INBOX']);
});
