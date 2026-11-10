// Safe move confirms each copy by the UID the server gave it, a lost COPY reply
// does not leave duplicates, and a timeout stops the work it was guarding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.ICLOUD_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'icloud-mcp-move-'));

const {
  setImapClientFactory, createRateLimitedClient, bulkMove, getMoveStatus, withTimeout, withImapScope,
} = await import('../../lib/imap.js');

// ─── In-memory IMAP ───────────────────────────────────────────────────────────

function envelope(n) {
  return {
    messageId: `<fixture-${n}@example.com>`,
    subject: `Fixture ${n}`,
    from: [{ address: 'sender@example.com' }],
    date: new Date(Date.UTC(2026, 0, n)),
  };
}

function makeServer() {
  const server = {
    boxes: new Map(),
    copyCalls: 0,
    // Called per COPY: 'ok' | 'nomap' | 'lost-reply' | 'silent-noop'
    copyBehavior: () => 'ok',
    clients: [],
    addBox(name, envelopes = []) {
      const box = { uidNext: 1, msgs: new Map() };
      for (const env of envelopes) box.msgs.set(box.uidNext++, { envelope: env });
      server.boxes.set(name, box);
      return box;
    },
  };
  server.addBox('Deleted Messages');
  return server;
}

function makeClient(server) {
  let selected = null;
  const list = (range) => (Array.isArray(range) ? range : [range]);
  const client = {
    closed: false,
    mailbox: null,
    async connect() {},
    async logout() { client.closed = true; },
    close() { client.closed = true; },
    async mailboxOpen(name) {
      const box = server.boxes.get(name);
      if (!box) throw new Error(`Mailbox does not exist: ${name}`);
      selected = box;
      client.mailbox = { path: name, uidNext: box.uidNext, exists: box.msgs.size };
      return client.mailbox;
    },
    async mailboxCreate(name) {
      if (server.boxes.has(name)) throw new Error('ALREADYEXISTS');
      server.addBox(name);
    },
    async list() {
      return [...server.boxes.keys()].map((path) => ({ path, specialUse: path === 'Deleted Messages' ? '\\Trash' : undefined }));
    },
    async search() { return [...selected.msgs.keys()]; },
    async *fetch(range) {
      let uids;
      if (typeof range === 'string' && range.endsWith(':*')) {
        const first = Number(range.split(':')[0]);
        const all = [...selected.msgs.keys()];
        uids = all.filter((uid) => uid >= first);
        // IMAP returns the newest message for n:* even when its UID is below n.
        if (uids.length === 0 && all.length > 0) uids = [Math.max(...all)];
      } else {
        uids = list(range).filter((uid) => selected.msgs.has(uid));
      }
      for (const uid of uids) yield { uid, envelope: selected.msgs.get(uid).envelope };
    },
    async messageCopy(range, target) {
      const behavior = server.copyBehavior(server.copyCalls++);
      if (behavior === 'silent-noop') return { path: client.mailbox.path, destination: target };
      const dest = server.boxes.get(target);
      const uidMap = new Map();
      for (const uid of list(range)) {
        if (!selected.msgs.has(uid)) continue;
        const newUid = dest.uidNext++;
        dest.msgs.set(newUid, { envelope: selected.msgs.get(uid).envelope });
        uidMap.set(uid, newUid);
      }
      if (behavior === 'lost-reply') return false;
      if (behavior === 'nomap') return { path: client.mailbox.path, destination: target };
      return { path: client.mailbox.path, destination: target, uidMap };
    },
    async messageDelete(range) {
      for (const uid of list(range)) selected.msgs.delete(uid);
      return true;
    },
  };
  server.clients.push(client);
  return client;
}

function setup(sourceCount = 3) {
  const server = makeServer();
  server.addBox('INBOX', Array.from({ length: sourceCount }, (_, i) => envelope(i + 1)));
  server.addBox('Archive');
  setImapClientFactory(() => makeClient(server));
  return server;
}

const subjects = (box) => [...box.msgs.values()].map((m) => m.envelope.subject).sort();

test('a move is confirmed by destination UID and then removed from the source', async () => {
  const server = setup();
  const result = await bulkMove({}, 'Archive', 'INBOX');
  assert.equal(result.status, 'complete');
  assert.equal(result.moved, 3);
  assert.equal(server.boxes.get('INBOX').msgs.size, 0);
  assert.deepEqual(subjects(server.boxes.get('Archive')), ['Fixture 1', 'Fixture 2', 'Fixture 3']);
  assert.ok(server.clients.every((client) => client.closed));
});

test('an older copy already in the target is not proof that this copy arrived', async () => {
  const server = setup();
  // The target already holds the same three messages from some earlier time,
  // and this operation's COPY reports success without copying anything.
  const archive = server.boxes.get('Archive');
  for (let n = 1; n <= 3; n++) archive.msgs.set(archive.uidNext++, { envelope: envelope(n) });
  server.copyBehavior = () => 'silent-noop';

  const result = await bulkMove({}, 'Archive', 'INBOX');
  assert.equal(result.status, 'failed');
  assert.match(result.message, /did not arrive in target/);
  // Nothing was deleted from the source.
  assert.equal(server.boxes.get('INBOX').msgs.size, 3);
  assert.equal(getMoveStatus().history[0].status, 'failed');
});

test('a lost COPY reply does not copy the messages a second time', async () => {
  const server = setup();
  server.copyBehavior = (call) => (call === 0 ? 'lost-reply' : 'ok');
  const result = await bulkMove({}, 'Archive', 'INBOX');
  assert.equal(result.status, 'complete');
  assert.equal(server.boxes.get('INBOX').msgs.size, 0);
  // Exactly one copy of each, not two.
  assert.deepEqual(subjects(server.boxes.get('Archive')), ['Fixture 1', 'Fixture 2', 'Fixture 3']);
});

test('a server without COPYUID is verified against new arrivals only', async () => {
  const server = setup();
  server.copyBehavior = () => 'nomap';
  const result = await bulkMove({}, 'Archive', 'INBOX');
  assert.equal(result.status, 'complete');
  assert.equal(server.boxes.get('INBOX').msgs.size, 0);
  assert.equal(server.boxes.get('Archive').msgs.size, 3);
});

test('a timeout closes the connection and blocks a reconnect', async () => {
  const server = setup();
  let reconnectError = null;
  let resumed;
  const finished = new Promise((resolve) => { resumed = resolve; });
  await assert.rejects(
    withTimeout('slow op', 20, async () => {
      const client = createRateLimitedClient();
      await client.connect();
      await new Promise((resolve) => setTimeout(resolve, 60));
      // What a retry loop would do next: it must not get a new connection.
      try { createRateLimitedClient(); } catch (err) { reconnectError = err; }
      resumed();
    }),
    /slow op timed out after 0.02s/
  );
  assert.equal(server.clients[0].closed, true);
  await finished;
  assert.match(reconnectError.message, /Operation cancelled: slow op timed out/);
});

test('a connection left open by an error is closed when the call ends', async () => {
  const server = setup();
  await assert.rejects(withImapScope(async () => {
    const client = createRateLimitedClient();
    await client.connect();
    throw new Error('failed before logout');
  }), /failed before logout/);
  assert.equal(server.clients.length, 1);
  assert.equal(server.clients[0].closed, true);
});
