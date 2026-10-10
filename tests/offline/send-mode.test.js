// Runtime send gate. SMTP is mocked; these tests never open a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const projectDir = fileURLToPath(new URL('../..', import.meta.url));
process.env.ICLOUD_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'icloud-mcp-send-mode-'));

const {
  composeEmail,
  replyToEmail,
  forwardEmail,
  saveDraft,
  getSendMode,
  setSmtpTransportFactoryForTests,
  setDraftImapClientFactoryForTests,
} = await import('../../lib/smtp.js');
const { handleMailTool } = await import('../../lib/tools/mail.js');
const { setImapClientFactory } = await import('../../lib/imap.js');

const ACCOUNT = 'you@icloud.com';
const FOREIGN = 'other@example.com';
const CREDS = {
  user: ACCOUNT,
  pass: 'fake-app-password',
  host: 'imap.example.test',
  smtpHost: 'smtp.example.test',
};
const ctx = {
  accounts: { icloud: CREDS },
  resolveCreds() { return CREDS; },
  resolveMailbox(name) { return name; },
};

function selfMessage(extra = {}) {
  return {
    subject: 'Seed note',
    from: ACCOUNT,
    date: '2026-01-02T00:00:00.000Z',
    body: 'fixture body',
    headers: {
      replyTo: null,
      to: [ACCOUNT],
      cc: [],
      messageId: '<seed@example.com>',
      references: [],
    },
    ...extra,
  };
}

function installMocks() {
  const sent = [];
  const drafts = [];
  setSmtpTransportFactoryForTests(() => ({
    async sendMail(options) {
      sent.push(options);
      return { messageId: '<sent@example.com>', accepted: [ACCOUNT], rejected: [] };
    },
  }));
  setDraftImapClientFactoryForTests(() => ({
    async connect() {},
    async logout() {},
    close() {},
    async list() { return []; },
    async append(mailbox, raw) {
      drafts.push({ mailbox, raw: Buffer.isBuffer(raw) ? raw.toString() : String(raw) });
    },
  }));
  return { sent, drafts };
}

function imapFor(email) {
  setImapClientFactory(() => ({
    async connect() {},
    async logout() {},
    close() {},
    async mailboxOpen() {},
    async fetchOne(_uid, query) {
      if (query?.bodyParts) {
        return { bodyParts: new Map([['TEXT', Buffer.from('fixture body')]]) };
      }
      const headers = email.headers ?? {};
      return {
        uid: 5,
        flags: new Set(['\\Seen']),
        envelope: {
          subject: email.subject,
          from: [{ address: email.from }],
          to: (headers.to || []).map((address) => ({ address })),
          cc: (headers.cc || []).map((address) => ({ address })),
          replyTo: headers.replyTo ? [{ address: headers.replyTo }] : [],
          messageId: headers.messageId,
          date: new Date('2026-01-02T00:00:00.000Z'),
        },
        headers: Buffer.from(''),
        bodyStructure: {
          type: 'text/plain',
          encoding: '7bit',
          parameters: { charset: 'utf-8' },
          size: 12,
        },
      };
    },
  }));
}

async function withMode(mode, fn) {
  const previous = process.env.ICLOUD_MCP_SEND_MODE;
  if (mode == null) delete process.env.ICLOUD_MCP_SEND_MODE;
  else process.env.ICLOUD_MCP_SEND_MODE = mode;
  const mocks = installMocks();
  try {
    await fn(mocks);
  } finally {
    if (previous == null) delete process.env.ICLOUD_MCP_SEND_MODE;
    else process.env.ICLOUD_MCP_SEND_MODE = previous;
    setSmtpTransportFactoryForTests(null);
    setDraftImapClientFactoryForTests(null);
    setImapClientFactory(null);
  }
}

function assertNotSent(mocks) {
  assert.equal(mocks.sent.length, 0);
}

test('unset and blank send mode stay on', () => {
  const previous = process.env.ICLOUD_MCP_SEND_MODE;
  try {
    delete process.env.ICLOUD_MCP_SEND_MODE;
    assert.equal(getSendMode(), 'on');
    process.env.ICLOUD_MCP_SEND_MODE = '   ';
    assert.equal(getSendMode(), 'on');
    process.env.ICLOUD_MCP_SEND_MODE = ' ON ';
    assert.equal(getSendMode(), 'on');
    process.env.ICLOUD_MCP_SEND_MODE = 'Sideways';
    assert.throws(() => getSendMode(), /ICLOUD_MCP_SEND_MODE must be one of/);
  } finally {
    if (previous == null) delete process.env.ICLOUD_MCP_SEND_MODE;
    else process.env.ICLOUD_MCP_SEND_MODE = previous;
  }
});

test('default mode still sends, including Cc and Bcc', async () => {
  await withMode(null, async ({ sent, drafts }) => {
    const result = await composeEmail('person@example.com', 'Hello', 'body', {
      cc: 'cc@example.com',
      bcc: ['bcc@example.com'],
    }, CREDS);
    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [{ name: '', address: 'person@example.com' }]);
    assert.deepEqual(sent[0].cc, [{ name: '', address: 'cc@example.com' }]);
    assert.deepEqual(sent[0].bcc, [{ name: '', address: 'bcc@example.com' }]);
    assert.equal(drafts.length, 0);
  });
});

test('off blocks every sending tool and does not touch SMTP', async () => {
  await withMode('off', async (mocks) => {
    await assert.rejects(
      () => composeEmail(ACCOUNT, 'Hello', 'body', {}, CREDS),
      /Sending is disabled \(ICLOUD_MCP_SEND_MODE=off\)/
    );
    await assert.rejects(
      () => replyToEmail(selfMessage(), 'reply', {}, CREDS),
      /ICLOUD_MCP_SEND_MODE=off/
    );
    await assert.rejects(
      () => forwardEmail(selfMessage(), ACCOUNT, 'note', {}, CREDS),
      /ICLOUD_MCP_SEND_MODE=off/
    );
    assertNotSent(mocks);
    assert.equal(mocks.drafts.length, 0);

    imapFor(selfMessage());
    await assert.rejects(() => handleMailTool('compose_email', { to: ACCOUNT, subject: 'Hello', body: 'x' }, ctx), /ICLOUD_MCP_SEND_MODE=off/);
    await assert.rejects(() => handleMailTool('reply_to_email', { uid: 5, body: 'x' }, ctx), /ICLOUD_MCP_SEND_MODE=off/);
    await assert.rejects(() => handleMailTool('forward_email', { uid: 5, to: ACCOUNT }, ctx), /ICLOUD_MCP_SEND_MODE=off/);
    assertNotSent(mocks);

    const saved = await saveDraft(FOREIGN, 'Draft', 'not sent', {}, CREDS);
    assert.equal(saved.saved, true);
    assert.equal(mocks.drafts.length, 1);
    assertNotSent(mocks);
  });
});

test('off does not require credentials to refuse a send', async () => {
  await withMode('off', async (mocks) => {
    await assert.rejects(() => composeEmail(FOREIGN, 'Hello', 'body'), /ICLOUD_MCP_SEND_MODE=off/);
    assertNotSent(mocks);
  });
});

test('drafts saves instead of sending for every sending tool', async () => {
  await withMode('drafts', async ({ sent, drafts }) => {
    const composed = await composeEmail(FOREIGN, 'Hello', 'body', { cc: ACCOUNT }, CREDS);
    assert.equal(composed.sent, false);
    assert.equal(composed.drafted, true);
    assert.equal(composed.mailbox, 'Drafts');

    const replied = await replyToEmail(selfMessage(), 'reply body', {}, CREDS);
    assert.equal(replied.drafted, true);
    assert.equal(replied.sent, false);
    assert.match(replied.subject, /^Re: /);

    const forwarded = await forwardEmail(selfMessage(), FOREIGN, 'see below', {}, CREDS);
    assert.equal(forwarded.drafted, true);
    assert.match(forwarded.subject, /^Fwd: /);

    assert.equal(sent.length, 0);
    assert.equal(drafts.length, 3);
    assert.match(drafts[1].raw, /Re: Seed note/);

    imapFor(selfMessage());
    const viaTool = await handleMailTool('compose_email', {
      to: FOREIGN, subject: 'Via tool', body: 'x',
    }, ctx);
    assert.equal(viaTool.drafted, true);
    assert.equal(sent.length, 0);
    const viaReply = await handleMailTool('reply_to_email', { uid: 5, body: 'x' }, ctx);
    assert.equal(viaReply.drafted, true);
    const viaForward = await handleMailTool('forward_email', { uid: 5, to: FOREIGN }, ctx);
    assert.equal(viaForward.drafted, true);
    assert.equal(sent.length, 0);
  });
});

test('drafts keeps the Reply-To header on the saved draft', async () => {
  await withMode('drafts', async ({ sent, drafts }) => {
    const result = await composeEmail(FOREIGN, 'Hello', 'body', { replyTo: 'other@example.com' }, CREDS);
    assert.equal(result.drafted, true);
    assert.equal(sent.length, 0);
    assert.equal(drafts.length, 1);
    assert.match(drafts[0].raw, /^Reply-To: other@example\.com\r?$/m);

    await assert.rejects(
      () => composeEmail(FOREIGN, 'Hello', 'body', { replyTo: 'other@example.com\r\nBcc: evil@example.com' }, CREDS),
      /header/i,
    );
    assert.equal(drafts.length, 1);
  });
});

test('drafts does not send when the draft append fails', async () => {
  await withMode('drafts', async ({ sent }) => {
    setDraftImapClientFactoryForTests(() => ({
      async connect() {},
      async logout() {},
      close() {},
      async append() { throw new Error('append failed'); },
    }));
    await assert.rejects(() => composeEmail(ACCOUNT, 'Hello', 'body', {}, CREDS), /append failed/);
    assert.equal(sent.length, 0);
  });
});

test('invalid mode sends nothing', async () => {
  await withMode('sometimes', async (mocks) => {
    await assert.rejects(() => composeEmail(ACCOUNT, 'Hello', 'body', {}, CREDS), /must be one of/);
    await assert.rejects(() => replyToEmail(selfMessage(), 'x', {}, CREDS), /must be one of/);
    await assert.rejects(() => forwardEmail(selfMessage(), ACCOUNT, '', {}, CREDS), /must be one of/);
    assertNotSent(mocks);
    assert.equal(mocks.drafts.length, 0);
  });
});

test('self-only allows only the authenticated account, case-insensitively', async () => {
  await withMode('self-only', async ({ sent, drafts }) => {
    const mixed = { user: 'You@iCloud.com', pass: 'fake-app-password', host: 'imap.example.test', smtpHost: 'smtp.example.test' };

    const ok = await composeEmail('  You@iCloud.com ', 'Hello', 'body', {
      cc: 'Person <you@icloud.com>',
      bcc: '"Last, First" <YOU@icloud.com>',
    }, mixed);
    assert.equal(ok.sent, true);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].cc, [{ name: 'Person', address: 'you@icloud.com' }]);
    assert.deepEqual(sent[0].bcc, [{ name: 'Last, First', address: 'YOU@icloud.com' }]);

    await composeEmail([ACCOUNT, 'you@icloud.com'], 'Hello', 'body', {}, CREDS);
    assert.equal(sent.length, 2);

    const reply = await replyToEmail(selfMessage({ from: '  You@iCloud.com ' }), 'thanks', {
      replyAll: true,
      cc: 'Person <you@icloud.com>',
    }, CREDS);
    assert.equal(reply.sent, true);

    const forwarded = await forwardEmail(selfMessage(), ['you@icloud.com'], '', {
      cc: ACCOUNT,
    }, CREDS);
    assert.equal(forwarded.sent, true);
    assert.equal(drafts.length, 0);
  });
});

test('self-only blocks Cc, Bcc, reply-all, and forward recipients that are not the account', async () => {
  await withMode('self-only', async (mocks) => {
    const cases = [
      () => composeEmail(FOREIGN, 'Hello', 'body', {}, CREDS),
      () => composeEmail(ACCOUNT, 'Hello', 'body', { cc: FOREIGN }, CREDS),
      () => composeEmail(ACCOUNT, 'Hello', 'body', { bcc: `Person <${FOREIGN}>` }, CREDS),
      () => composeEmail(ACCOUNT, 'Hello', 'body', { bcc: [ACCOUNT, FOREIGN] }, CREDS),
      () => composeEmail(`${ACCOUNT}, ${FOREIGN}`, 'Hello', 'body', {}, CREDS),
      () => composeEmail('   ', 'Hello', 'body', {}, CREDS),
      () => replyToEmail(selfMessage({
        from: FOREIGN,
        headers: { replyTo: null, to: [ACCOUNT], cc: [], messageId: '<m@example.com>', references: [] },
      }), 'x', {}, CREDS),
      () => replyToEmail(selfMessage({
        headers: { replyTo: null, to: [ACCOUNT, FOREIGN], cc: ['third@example.com'], messageId: '<m@example.com>', references: [] },
      }), 'x', { replyAll: true }, CREDS),
      () => replyToEmail(selfMessage(), 'x', { cc: FOREIGN }, CREDS),
      () => forwardEmail(selfMessage(), FOREIGN, 'note', {}, CREDS),
      () => forwardEmail(selfMessage(), ACCOUNT, 'note', { cc: `Other <${FOREIGN}>` }, CREDS),
      () => forwardEmail(selfMessage(), [ACCOUNT, FOREIGN], '', {}, CREDS),
    ];

    for (const run of cases) {
      const before = mocks.sent.length;
      await assert.rejects(run, /ICLOUD_MCP_SEND_MODE=self-only/);
      assert.equal(mocks.sent.length, before);
    }
    assert.equal(mocks.drafts.length, 0);

    await assert.rejects(
      () => composeEmail(ACCOUNT, 'Hello', 'body', { bcc: FOREIGN }, CREDS),
      (err) => {
        assert.match(err.message, /self-only/);
        assert.equal(err.message.includes(FOREIGN), false);
        return true;
      }
    );
  });
});

test('self-only does not treat Reply-To as a recipient', async () => {
  await withMode('self-only', async ({ sent }) => {
    const result = await composeEmail(ACCOUNT, 'Hello', 'body', { replyTo: FOREIGN }, CREDS);
    assert.equal(result.sent, true);
    assert.deepEqual(sent[0].replyTo, [{ name: '', address: FOREIGN }]);
    assert.deepEqual(sent[0].to, [{ name: '', address: ACCOUNT }]);
  });
});

test('self-only and on are enforced through every sending tool', async () => {
  await withMode('self-only', async ({ sent }) => {
    imapFor(selfMessage());
    await assert.rejects(
      () => handleMailTool('compose_email', { to: FOREIGN, subject: 'Hi', body: 'x', cc: ACCOUNT, bcc: ACCOUNT }, ctx),
      /self-only/
    );
    await assert.rejects(
      () => handleMailTool('reply_to_email', { uid: 5, body: 'x', cc: FOREIGN }, ctx),
      /self-only/
    );
    await assert.rejects(
      () => handleMailTool('forward_email', { uid: 5, to: ACCOUNT, cc: FOREIGN }, ctx),
      /self-only/
    );
    assert.equal(sent.length, 0);

    const composed = await handleMailTool('compose_email', {
      to: '  YOU@icloud.com ',
      subject: 'Hi',
      body: 'x',
      cc: `Me <${ACCOUNT}>`,
      bcc: ACCOUNT,
    }, ctx);
    assert.equal(composed.sent, true);

    const replied = await handleMailTool('reply_to_email', { uid: 5, body: 'x', replyAll: true }, ctx);
    assert.equal(replied.sent, true);

    const forwarded = await handleMailTool('forward_email', { uid: 5, to: ACCOUNT }, ctx);
    assert.equal(forwarded.sent, true);
    assert.equal(sent.length, 3);
  });

  await withMode('on', async ({ sent }) => {
    imapFor(selfMessage({ from: FOREIGN, headers: {
      replyTo: null, to: [ACCOUNT], cc: [], messageId: '<m@example.com>', references: [],
    } }));
    const composed = await handleMailTool('compose_email', { to: FOREIGN, subject: 'Hi', body: 'x' }, ctx);
    assert.equal(composed.sent, true);
    const replied = await handleMailTool('reply_to_email', { uid: 5, body: 'x' }, ctx);
    assert.equal(replied.sent, true);
    const forwarded = await handleMailTool('forward_email', { uid: 5, to: FOREIGN }, ctx);
    assert.equal(forwarded.sent, true);
    assert.equal(sent.length, 3);
    assert.deepEqual(sent[1].to, [{ name: '', address: FOREIGN }]);
  });
});

test('parsed recipients match what sendMail receives, including the quoted-address bypass', async () => {
  const hidden = `"Me <${ACCOUNT}>" <evil@example.com>`;
  const group = `Friends: ${ACCOUNT}, evil@example.com;`;

  await withMode('self-only', async (mocks) => {
    const rejected = [
      () => composeEmail(hidden, 'Hello', 'body', {}, CREDS),
      () => composeEmail(`${hidden}, ${ACCOUNT}`, 'Hello', 'body', {}, CREDS),
      () => composeEmail(ACCOUNT, 'Hello', 'body', { cc: hidden }, CREDS),
      () => composeEmail(ACCOUNT, 'Hello', 'body', { bcc: `"Last, First" <evil@example.com>` }, CREDS),
      () => composeEmail(`YOU@icloud.com, evil@example.com`, 'Hello', 'body', {}, CREDS),
      () => replyToEmail(selfMessage({ from: hidden }), 'x', {}, CREDS),
      () => forwardEmail(selfMessage(), hidden, '', {}, CREDS),
      () => forwardEmail(selfMessage(), [ACCOUNT, 'Evil@Example.com'], '', {}, CREDS),
    ];
    for (const run of rejected) {
      const before = mocks.sent.length;
      await assert.rejects(run, (err) => {
        assert.match(err.message, /self-only/);
        assert.equal(err.message.includes('evil@example.com'), false);
        return true;
      });
      assert.equal(mocks.sent.length, before);
    }

    const allowed = await composeEmail(`"Last, First" <${ACCOUNT}>`, 'Hello', 'body', {
      cc: `YOU@icloud.com, "Also" <you@icloud.com>`,
    }, CREDS);
    assert.equal(allowed.sent, true);
    assert.deepEqual(mocks.sent.at(-1).to, [{ name: 'Last, First', address: ACCOUNT }]);
    assert.deepEqual(mocks.sent.at(-1).cc, [
      { name: '', address: 'YOU@icloud.com' },
      { name: 'Also', address: 'you@icloud.com' },
    ]);
  });

  await withMode('on', async ({ sent }) => {
    const result = await composeEmail(hidden, 'Hello', 'body', {}, CREDS);
    assert.equal(result.sent, true);
    assert.deepEqual(sent.at(-1).to, [{ name: `Me <${ACCOUNT}>`, address: 'evil@example.com' }]);

    await assert.rejects(() => composeEmail(group, 'Hello', 'body', {}, CREDS), /recipient groups are not allowed/);
    await assert.rejects(() => composeEmail('not-an-email', 'Hello', 'body', {}, CREDS), /could not be parsed/);
    await assert.rejects(() => composeEmail('<>', 'Hello', 'body', {}, CREDS), /could not be parsed/);
    await assert.rejects(() => composeEmail('foo@bar@baz.com', 'Hello', 'body', {}, CREDS), /could not be parsed/);
    await assert.rejects(
      () => composeEmail(`${ACCOUNT}\r\nBcc: evil@example.com`, 'Hello', 'body', {}, CREDS),
      /line break/
    );
    await assert.rejects(
      () => composeEmail(ACCOUNT, 'Hello\r\nBcc: evil@example.com', 'body', {}, CREDS),
      /line break/
    );
    await assert.rejects(
      () => composeEmail(ACCOUNT, 'Hello', 'body', { cc: `${ACCOUNT}\nBcc: evil@example.com` }, CREDS),
      /line break/
    );
    await assert.rejects(
      () => composeEmail(ACCOUNT, 'Hello\tworld', 'body', {}, CREDS),
      /line break/
    );
    const foldedReply = await replyToEmail(selfMessage({ subject: 'Hi\r\nBcc: evil@example.com' }), 'x', {}, CREDS);
    assert.equal(foldedReply.sent, true);
    assert.equal(sent.at(-1).subject, 'Re: Hi Bcc: evil@example.com');
    await assert.rejects(
      () => replyToEmail(selfMessage({
        headers: {
          replyTo: null,
          to: [ACCOUNT],
          cc: [],
          messageId: '<id@example.com>\r\nBcc: evil@example.com',
          references: [],
        },
      }), 'x', {}, CREDS),
      /line break/
    );
    const foldedForward = await forwardEmail(selfMessage({ subject: 'Hi\nBcc: evil@example.com' }), ACCOUNT, '', {}, CREDS);
    assert.equal(foldedForward.sent, true);
    assert.equal(sent.at(-1).subject, 'Fwd: Hi Bcc: evil@example.com');
    await assert.rejects(() => saveDraft(group, 'Hello', 'body', {}, CREDS), /recipient groups are not allowed/);
    assert.equal(sent.length, 3);
    assert.equal(JSON.stringify(sent).includes('\r'), false);
    assert.equal(JSON.stringify(sent).includes('\nBcc'), false);
    assert.equal(JSON.stringify(sent).includes('\t'), false);
  });
});

test('reply and forward in on mode send a folded or encoded original subject', async () => {
  const libmime = (await import('libmime')).default;
  const folded = libmime.decodeWords('Hello\r\n\tworld');
  const encodedFold = libmime.decodeWords('=?utf-8?q?Hello=0D=0A=09world?=');
  const encodedControl = libmime.decodeWords('=?utf-8?q?Hello=01world?=');
  assert.equal(folded, 'Hello\r\n\tworld');
  assert.equal(encodedFold, 'Hello\r\n\tworld');
  assert.equal(encodedControl, 'Hello\u0001world');

  await withMode('on', async ({ sent }) => {
    const replied = await replyToEmail(selfMessage({ subject: folded }), 'thanks', {}, CREDS);
    assert.equal(replied.sent, true);
    assert.equal(sent.at(-1).subject, 'Re: Hello world');

    const already = await replyToEmail(selfMessage({ subject: 'Re:\r\n\tHello world' }), 'thanks', {}, CREDS);
    assert.equal(already.sent, true);
    assert.equal(sent.at(-1).subject, 'Re: Hello world');

    const forwarded = await forwardEmail(selfMessage({ subject: encodedFold }), ACCOUNT, 'note', {}, CREDS);
    assert.equal(forwarded.sent, true);
    assert.equal(sent.at(-1).subject, 'Fwd: Hello world');
    assert.match(sent.at(-1).text, /Subject: Hello world/);
    assert.equal(sent.at(-1).text.includes('\r'), false);
    assert.equal(sent.at(-1).text.includes('\n\t'), false);

    const stripped = await forwardEmail(selfMessage({ subject: encodedControl }), ACCOUNT, '', {}, CREDS);
    assert.equal(stripped.sent, true);
    assert.equal(sent.at(-1).subject, 'Fwd: Helloworld');

    await assert.rejects(
      () => composeEmail(ACCOUNT, 'Hello\r\n\tworld', 'body', {}, CREDS),
      /line break/
    );
    await assert.rejects(
      () => composeEmail(ACCOUNT, encodedControl, 'body', {}, CREDS),
      /line break/
    );
    assert.equal(JSON.stringify(sent).includes('\u0001'), false);
  });
});

test('network SMTP sendMail is only reachable from lib/smtp.js', () => {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) files.push(path);
    }
  }
  walk(join(projectDir, 'lib'));
  const hits = files.filter((path) => readFileSync(path, 'utf8').includes('.sendMail('));
  assert.deepEqual(hits.map((path) => path.replace(projectDir, '')), ['lib/smtp.js']);
});
