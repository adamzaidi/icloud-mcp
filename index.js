#!/usr/bin/env node
import { ImapFlow } from 'imapflow';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOG_FILE = join(homedir(), '.icloud-mcp-session.json');
const MANIFEST_FILE = join(homedir(), '.icloud-mcp-move-manifest.json');
const MAX_HISTORY = 5;

const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD;

if (!IMAP_USER || !IMAP_PASSWORD) {
  if (process.argv.includes('--doctor')) {
    // Doctor will handle missing credentials with friendly output
  } else {
    process.stderr.write('Error: IMAP_USER and IMAP_PASSWORD environment variables are required\n');
    process.exit(1);
  }
}

// ─── IMPROVEMENT 1: Connection-level timeout on createClient ──────────────────
// ImapFlow supports connectionTimeout and greetingTimeout options.
// This ensures we don't hang forever waiting for iCloud to respond.

function createClient() {
  return new ImapFlow({
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false,
    connectionTimeout: 15_000,   // 15s to establish TCP+TLS connection
    greetingTimeout: 15_000,     // 15s to receive IMAP greeting after connect
    socketTimeout: 60_000,       // 60s of inactivity before socket is killed
  });
}

// ─── Managed client helpers ───────────────────────────────────────────────────

// Rate limit: space out connection initiations within a single server process
// to avoid triggering iCloud's connection throttle under concurrent tool calls.
// Wraps connect() on every client returned by createClient() so the gate
// applies regardless of whether tools use openClient() or createClient() directly.
// Uses a serialized gate — concurrent callers queue up; each waits 200ms after
// the previous before initiating its connection. Connections run concurrently
// after passing the gate.
let _lastConnectTime = 0;
let _connectGate = Promise.resolve();
const MIN_CONNECT_INTERVAL = 200; // ms between connection initiations

function createRateLimitedClient() {
  const client = createClient();
  const originalConnect = client.connect.bind(client);
  client.connect = async () => {
    await new Promise(resolve => {
      _connectGate = _connectGate.then(async () => {
        const wait = MIN_CONNECT_INTERVAL - (Date.now() - _lastConnectTime);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        _lastConnectTime = Date.now();
      }).then(resolve, resolve);
    });
    return originalConnect();
  };
  return client;
}

async function openClient(mailbox) {
  const client = createRateLimitedClient();
  await client.connect();
  if (mailbox) await client.mailboxOpen(mailbox);
  return client;
}

async function safeClose(client) {
  try { await client.logout(); } catch { try { client.close(); } catch { /* already gone */ } }
}

async function reconnect(client, mailbox) {
  safeClose(client);
  return openClient(mailbox);
}

// ─── Move Manifest ────────────────────────────────────────────────────────────

const CHUNK_SIZE = 500;
const CHUNK_SIZE_RETRY = 100;

function readManifest() {
  if (!existsSync(MANIFEST_FILE)) return { current: null, history: [] };
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    return { current: null, history: [] };
  }
}

function writeManifest(data) {
  writeFileSync(MANIFEST_FILE, JSON.stringify(data, null, 2));
}

function updateManifest(updater) {
  const data = readManifest();
  if (!data.current) return data; // guard: operation already archived/failed
  updater(data);
  if (!data.current) return data; // guard: updater may have archived it
  data.current.updatedAt = new Date().toISOString();
  writeManifest(data);
  return data;
}

function archiveCurrent(data) {
  if (data.current) {
    data.history.unshift(data.current);
    if (data.history.length > MAX_HISTORY) data.history = data.history.slice(0, MAX_HISTORY);
    data.current = null;
  }
}

function getMoveStatus() {
  const data = readManifest();
  if (!data.current) return { status: 'no_operation', history: data.history.map(summarizeOp) };
  return {
    current: formatOperation(data.current),
    history: data.history.map(summarizeOp)
  };
}

function abandonMove() {
  const data = readManifest();
  if (!data.current) return { abandoned: false, message: 'No in-progress operation to abandon' };
  if (data.current.status !== 'in_progress') {
    return { abandoned: false, message: `Current operation is already '${data.current.status}', nothing to abandon` };
  }
  const operationId = data.current.operationId;
  data.current.status = 'abandoned';
  data.current.updatedAt = new Date().toISOString();
  archiveCurrent(data);
  writeManifest(data);
  return { abandoned: true, operationId };
}

function startOperation(source, target, uids) {
  const data = readManifest();

  if (data.current && data.current.status === 'in_progress') {
    const op = data.current;
    throw new Error(
      `Incomplete move operation detected (${op.operationId}): ` +
      `${op.summary.emailsMoved} of ${op.totalUids} emails moved from '${op.source}' to '${op.target}' ` +
      `started at ${op.startedAt}. ` +
      `Call abandon_move to discard it or get_move_status to inspect it before starting a new operation.`
    );
  }

  archiveCurrent(data);

  const operationId = `move_${Date.now()}`;
  const chunks = [];

  for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
    chunks.push({
      index: chunks.length,
      uids: uids.slice(i, i + CHUNK_SIZE),
      fingerprints: [],
      status: 'pending',
      copiedAt: null,
      verifiedAt: null,
      deletedAt: null,
      failureReason: null
    });
  }

  data.current = {
    operationId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source,
    target,
    totalUids: uids.length,
    status: 'in_progress',
    chunks,
    summary: {
      chunksComplete: 0,
      emailsMoved: 0,
      emailsPending: uids.length,
      emailsFailed: 0
    }
  };

  writeManifest(data);
  return data.current;
}

function updateChunk(index, updates) {
  updateManifest((data) => {
    if (!data.current) return; // guard: operation already archived
    const chunk = data.current.chunks[index];
    if (!chunk) return; // guard: chunk index out of range
    Object.assign(chunk, updates);

    let moved = 0, failed = 0, pending = 0;
    for (const c of data.current.chunks) {
      if (c.status === 'complete') moved += c.uids.length;
      else if (c.status === 'failed') failed += c.uids.length;
      else pending += c.uids.length;
    }
    data.current.summary = {
      chunksComplete: data.current.chunks.filter(c => c.status === 'complete').length,
      emailsMoved: moved,
      emailsPending: pending,
      emailsFailed: failed
    };
  });
}

function completeOperation() {
  const data = readManifest();
  if (!data.current) return;
  data.current.status = 'complete';
  data.current.updatedAt = new Date().toISOString();
  archiveCurrent(data);
  writeManifest(data);
}

function failOperation(reason) {
  const data = readManifest();
  if (!data.current) return;
  data.current.status = 'failed';
  data.current.failureReason = reason;
  data.current.updatedAt = new Date().toISOString();
  archiveCurrent(data);
  writeManifest(data);
}

function formatOperation(op) {
  return {
    operationId: op.operationId,
    status: op.status,
    source: op.source,
    target: op.target,
    startedAt: op.startedAt,
    updatedAt: op.updatedAt,
    summary: op.summary,
    failedChunks: op.chunks.filter(c => c.status === 'failed').map(c => ({
      index: c.index,
      uids: c.uids.length,
      reason: c.failureReason
    }))
  };
}

function summarizeOp(op) {
  return {
    operationId: op.operationId,
    status: op.status,
    source: op.source,
    target: op.target,
    startedAt: op.startedAt,
    moved: op.summary.emailsMoved,
    failed: op.summary.emailsFailed,
    total: op.totalUids
  };
}

// ─── Fingerprinting ───────────────────────────────────────────────────────────

function buildFingerprint(msg) {
  const messageId = msg.envelope?.messageId ?? null;
  const sender = msg.envelope?.from?.[0]?.address ?? '';
  const date = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : '';
  const subject = msg.envelope?.subject ?? '';
  const fallback = [sender, date, subject].join('|');
  return { uid: msg.uid, messageId, fallback };
}

function fingerprintToKey(fp) {
  return fp.messageId ?? fp.fallback;
}

// ─── Transient error detection ────────────────────────────────────────────────

function isTransient(err) {
  const msg = err.message ?? '';
  return msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('EPIPE') ||
    msg.includes('socket hang up') ||
    msg.includes('Connection not available') ||
    msg.includes('BAD') ||
    msg.includes('NO ');
}

async function withRetry(label, fn, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === maxAttempts) throw err;
      const delay = attempt * 2000;
      process.stderr.write(`[retry] ${label} failed (attempt ${attempt}/${maxAttempts}): ${err.message} — retrying in ${delay}ms\n`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─── Per-operation timeouts ───────────────────────────────────────────────────

const TIMEOUT = {
  METADATA: 15_000,
  FETCH:    30_000,
  SCAN:     60_000,
  BULK_OP:  60_000,
  CHUNK:   300_000,
  SINGLE:   15_000,
};

function withTimeout(label, ms, fn) {
  let timer;
  return Promise.race([
    fn().finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        process.stderr.write(`[timeout] ${label} timed out after ${ms / 1000}s\n`);
        reject(new Error(`${label} timed out after ${ms / 1000}s`));
      }, ms);
    })
  ]);
}

// ─── Move logging ─────────────────────────────────────────────────────────────

function elapsed(startMs) {
  return ((Date.now() - startMs) / 1000).toFixed(1) + 's';
}

function moveLog(chunkIndex, msg) {
  process.stderr.write(`[move] chunk ${chunkIndex}: ${msg}\n`);
}

// ─── Verification (v3: envelope scan first, Message-ID fallback) ──────────────
// Strategy: one bulk FETCH of recent envelopes in the target is far faster than
// N individual SEARCH commands. We use envelope scan as the primary check, then
// only fall back to per-email Message-ID SEARCH for the few that didn't match
// (which can happen if the envelope fingerprint differs slightly between source
// and target, e.g. date normalization).

async function verifyByEnvelopeScan(client, fingerprints, chunkIndex, knownTotal = null) {
  if (fingerprints.length === 0) return { missing: [], found: 0 };

  const t0 = Date.now();
  const total = knownTotal ?? (await client.status(client.mailbox.path, { messages: true })).messages;
  const fetchCount = Math.min(total, fingerprints.length + 150);
  const start = Math.max(1, total - fetchCount + 1);
  const range = `${start}:${total}`;

  const targetKeys = new Set();
  let scanned = 0;
  for await (const msg of client.fetch(range, { envelope: true })) {
    const fp = buildFingerprint(msg);
    targetKeys.add(fingerprintToKey(fp));
    scanned++;
  }

  const missing = [];
  for (const fp of fingerprints) {
    if (!targetKeys.has(fingerprintToKey(fp))) missing.push(fp);
  }

  moveLog(chunkIndex, `envelope scan: ${scanned} scanned, ${fingerprints.length - missing.length}/${fingerprints.length} matched (${elapsed(t0)})`);
  return { missing, found: fingerprints.length - missing.length };
}

async function verifyByMessageId(client, fingerprints, chunkIndex) {
  if (fingerprints.length === 0) return { missing: [], verified: 0 };

  const t0 = Date.now();
  const missing = [];
  let verified = 0;

  for (const fp of fingerprints) {
    if (!fp.messageId) {
      // No Message-ID — can't verify this way, count as missing
      missing.push(fp);
      continue;
    }
    const uids = (await client.search({ header: ['Message-ID', fp.messageId] }, { uid: true })) ?? [];
    if (uids.length === 0) {
      missing.push(fp);
    } else {
      verified++;
    }
    // Progress logging every 25 emails
    const checked = verified + missing.length;
    if (checked % 25 === 0) {
      moveLog(chunkIndex, `Message-ID fallback: ${checked}/${fingerprints.length} checked (${verified} found, ${missing.length} missing, ${elapsed(t0)})`);
    }
  }

  moveLog(chunkIndex, `Message-ID fallback: ${verified}/${fingerprints.length} verified, ${missing.length} still missing (${elapsed(t0)})`);
  return { missing, verified };
}

async function verifyInTarget(targetClient, fingerprints, chunkIndex, knownTotal = null) {
  // Primary: fast envelope scan (one FETCH command)
  const { missing: afterScan } = await verifyByEnvelopeScan(targetClient, fingerprints, chunkIndex, knownTotal);

  if (afterScan.length === 0) {
    return { verified: true, missing: [], found: fingerprints.length, expected: fingerprints.length };
  }

  // Secondary: Message-ID search only for the ones envelope scan missed
  moveLog(chunkIndex, `${afterScan.length} unmatched after envelope scan — trying Message-ID search`);
  const withMessageId = afterScan.filter(fp => fp.messageId);
  const noMessageId = afterScan.filter(fp => !fp.messageId);

  if (withMessageId.length > 0) {
    const { missing: stillMissing } = await verifyByMessageId(targetClient, withMessageId, chunkIndex);
    const allMissing = [...stillMissing, ...noMessageId];
    return {
      verified: allMissing.length === 0,
      missing: allMissing,
      found: fingerprints.length - allMissing.length,
      expected: fingerprints.length
    };
  }

  // No Message-IDs to try — whatever envelope scan missed is truly missing
  return {
    verified: noMessageId.length === 0,
    missing: noMessageId,
    found: fingerprints.length - noMessageId.length,
    expected: fingerprints.length
  };
}

// ─── Safe Move (v3: connection reuse + envelope-first verify + logging) ───────

async function safeMoveEmails(uids, sourceMailbox, targetMailbox) {
  const operation = startOperation(sourceMailbox, targetMailbox, uids);
  let totalMoved = 0;
  let totalFailed = 0;
  const opStart = Date.now();

  process.stderr.write(`[move] starting: ${uids.length} emails, ${operation.chunks.length} chunks, ${sourceMailbox} → ${targetMailbox}\n`);

  let srcClient = await openClient(sourceMailbox);
  let tgtClient = await openClient(targetMailbox);

  try {
    for (const chunk of operation.chunks) {
      const chunkUids = chunk.uids;
      let succeeded = false;
      const chunkStart = Date.now();

      moveLog(chunk.index, `starting (${chunkUids.length} emails)`);

      for (const attemptChunkSize of [CHUNK_SIZE, CHUNK_SIZE_RETRY]) {
        const subChunks = [];
        for (let i = 0; i < chunkUids.length; i += attemptChunkSize) {
          subChunks.push(chunkUids.slice(i, i + attemptChunkSize));
        }

        let verificationFailed = false;

        for (const subChunk of subChunks) {
          try {
            await withTimeout(`safeMoveEmails chunk ${chunk.index}`, TIMEOUT.CHUNK, async () => {
              // Step 1: fetch fingerprints from source
              let t = Date.now();
              const envelopes = [];
              try {
                for await (const msg of srcClient.fetch(subChunk, { envelope: true }, { uid: true })) {
                  envelopes.push(msg);
                }
              } catch (err) {
                if (!isTransient(err)) throw err;
                moveLog(chunk.index, `fetch envelopes failed (${err.message}), reconnecting...`);
                srcClient = await reconnect(srcClient, sourceMailbox);
                for await (const msg of srcClient.fetch(subChunk, { envelope: true }, { uid: true })) {
                  envelopes.push(msg);
                }
              }
              const fingerprints = envelopes.map(buildFingerprint);
              const withMsgId = fingerprints.filter(fp => fp.messageId).length;
              moveLog(chunk.index, `fetched ${envelopes.length} envelopes (${withMsgId} with Message-ID) (${elapsed(t)})`);

              updateManifest((data) => {
                if (!data.current) return;
                const c = data.current.chunks[chunk.index];
                if (!c) return;
                c.fingerprints = [...c.fingerprints, ...fingerprints];
                c.status = 'pending';
              });

              // Step 2: copy to target
              t = Date.now();
              try {
                await srcClient.messageCopy(subChunk, targetMailbox, { uid: true });
              } catch (err) {
                if (!isTransient(err)) throw err;
                moveLog(chunk.index, `copy failed (${err.message}), reconnecting...`);
                srcClient = await reconnect(srcClient, sourceMailbox);
                await srcClient.messageCopy(subChunk, targetMailbox, { uid: true });
              }
              moveLog(chunk.index, `copied ${subChunk.length} emails to target (${elapsed(t)})`);
              updateChunk(chunk.index, { status: 'copied_not_verified', copiedAt: new Date().toISOString() });

              // Step 3: verify in target
              t = Date.now();
              let verification;
              try {
                const tgtMb = await tgtClient.mailboxOpen(targetMailbox);
                verification = await verifyInTarget(tgtClient, fingerprints, chunk.index, tgtMb.exists);
              } catch (err) {
                if (!isTransient(err)) throw err;
                moveLog(chunk.index, `verify failed (${err.message}), reconnecting...`);
                tgtClient = await reconnect(tgtClient, targetMailbox);
                verification = await verifyInTarget(tgtClient, fingerprints, chunk.index);
              }
              moveLog(chunk.index, `verification: ${verification.found}/${verification.expected} confirmed (${elapsed(t)})`);

              if (!verification.verified) {
                throw Object.assign(new Error('verification_failed'), { _verificationFailed: true });
              }
              updateChunk(chunk.index, { status: 'verified_not_deleted', verifiedAt: new Date().toISOString() });

              // Step 4: delete from source
              t = Date.now();
              try {
                await srcClient.messageDelete(subChunk, { uid: true });
              } catch (err) {
                if (!isTransient(err)) throw err;
                moveLog(chunk.index, `delete failed (${err.message}), reconnecting...`);
                srcClient = await reconnect(srcClient, sourceMailbox);
                await srcClient.messageDelete(subChunk, { uid: true });
              }
              moveLog(chunk.index, `deleted ${subChunk.length} from source (${elapsed(t)})`);
            });
            totalMoved += subChunk.length;
            moveLog(chunk.index, `sub-chunk complete: ${subChunk.length} moved (chunk total: ${totalMoved}/${operation.totalUids})`);
          } catch (err) {
            if (err._verificationFailed) {
              verificationFailed = true;
              break;
            }
            moveLog(chunk.index, `FAILED: ${err.message}`);
            updateChunk(chunk.index, {
              status: 'failed',
              failureReason: err.message
            });
            totalFailed += chunkUids.length;
            failOperation(`Chunk ${chunk.index} failed: ${err.message}`);
            return {
              status: 'partial',
              moved: totalMoved,
              failed: totalFailed,
              message: `${err.message}. ${totalMoved} emails moved successfully. ${operation.totalUids - totalMoved} remain in source untouched. Call get_move_status for details.`
            };
          }
        }

        if (!verificationFailed) {
          succeeded = true;
          break;
        }

        if (attemptChunkSize === CHUNK_SIZE_RETRY) {
          moveLog(chunk.index, `FAILED: verification failed at both chunk sizes`);
          updateChunk(chunk.index, {
            status: 'failed',
            failureReason: 'Verification failed at both chunk sizes'
          });
          totalFailed += chunkUids.length;
          failOperation(`Verification failed after retry on chunk ${chunk.index}`);
          return {
            status: 'partial',
            moved: totalMoved,
            failed: totalFailed,
            message: `Verification failed after retry. ${totalMoved} emails moved successfully. ${operation.totalUids - totalMoved} remain in source untouched. Call get_move_status for details.`
          };
        }

        moveLog(chunk.index, `verification failed at chunk size ${attemptChunkSize}, retrying at ${CHUNK_SIZE_RETRY}`);
      }

      if (succeeded) {
        updateChunk(chunk.index, { status: 'complete', deletedAt: new Date().toISOString() });
        moveLog(chunk.index, `COMPLETE (${elapsed(chunkStart)})`);
      }
    }

    completeOperation();
    process.stderr.write(`[move] COMPLETE: ${totalMoved}/${operation.totalUids} emails moved (${elapsed(opStart)})\n`);
    return { status: 'complete', moved: totalMoved, total: operation.totalUids };
  } finally {
    await safeClose(srcClient);
    await safeClose(tgtClient);
  }
}

// ─── Email Functions ──────────────────────────────────────────────────────────

async function fetchEmails(mailbox = 'INBOX', limit = 10, onlyUnread = false, page = 1) {
  const client = createRateLimitedClient();
  await client.connect();
  const mb = await client.mailboxOpen(mailbox);
  const total = mb.exists;
  const emails = [];

  if (total === 0) {
    await client.logout();
    return { emails, page, limit, total, totalPages: 0, hasMore: false };
  }

  if (onlyUnread) {
    const uids = (await client.search({ seen: false }, { uid: true })) ?? [];
    const totalUnread = uids.length;
    const skip = (page - 1) * limit;
    const pageUids = uids.reverse().slice(skip, skip + limit);
    for (const uid of pageUids) {
      const msg = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
      if (msg) {
        emails.push({
          uid,
          subject: msg.envelope.subject,
          from: msg.envelope.from?.[0]?.address,
          date: msg.envelope.date,
          flagged: msg.flags.has('\\Flagged'),
          seen: msg.flags.has('\\Seen')
        });
      }
    }
    await client.logout();
    return { emails, page, limit, total: totalUnread, totalPages: Math.ceil(totalUnread / limit), hasMore: (page * limit) < totalUnread };
  }

  const end = Math.max(1, total - ((page - 1) * limit));
  const start = Math.max(1, end - limit + 1);
  const range = `${start}:${end}`;

  for await (const msg of client.fetch(range, { envelope: true, flags: true })) {
    emails.push({
      uid: msg.uid,
      subject: msg.envelope.subject,
      from: msg.envelope.from?.[0]?.address,
      date: msg.envelope.date,
      flagged: msg.flags.has('\\Flagged'),
      seen: msg.flags.has('\\Seen')
    });
  }

  await client.logout();
  emails.reverse();
  return { emails, page, limit, total, totalPages: Math.ceil(total / limit), hasMore: (page * limit) < total };
}

async function getInboxSummary(mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  const status = await client.status(mailbox, { messages: true, unseen: true, recent: true });
  await client.logout();
  return { mailbox, total: status.messages, unread: status.unseen, recent: status.recent };
}

async function getTopSenders(mailbox = 'INBOX', sampleSize = 500, maxResults = 20) {
  const client = createRateLimitedClient();
  await client.connect();
  const mb = await client.mailboxOpen(mailbox);
  const total = mb.exists;
  const senderCounts = {};
  const senderDomains = {};

  const end = total;
  const start = Math.max(1, total - sampleSize + 1);
  const range = `${start}:${end}`;
  let count = 0;

  for await (const msg of client.fetch(range, { envelope: true })) {
    const address = msg.envelope.from?.[0]?.address;
    if (address) {
      senderCounts[address] = (senderCounts[address] || 0) + 1;
      const domain = address.split('@')[1];
      if (domain) senderDomains[domain] = (senderDomains[domain] || 0) + 1;
    }
    count++;
  }

  await client.logout();
  const topAddresses = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]).slice(0, maxResults).map(([address, count]) => ({ address, count }));
  const topDomains = Object.entries(senderDomains).sort((a, b) => b[1] - a[1]).slice(0, maxResults).map(([domain, count]) => ({ domain, count }));
  return { sampledEmails: count, topAddresses, topDomains };
}

async function getUnreadSenders(mailbox = 'INBOX', sampleSize = 500, maxResults = 20) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = (await client.search({ seen: false }, { uid: true })) ?? [];
  const recentUids = uids.reverse().slice(0, sampleSize);
  const senderCounts = {};

  if (recentUids.length === 0) {
    await client.logout();
    return [];
  }

  for await (const msg of client.fetch(recentUids, { envelope: true }, { uid: true })) {
    const address = msg.envelope.from?.[0]?.address;
    if (address) senderCounts[address] = (senderCounts[address] || 0) + 1;
  }

  await client.logout();
  return Object.entries(senderCounts).sort((a, b) => b[1] - a[1]).slice(0, maxResults).map(([address, count]) => ({ address, count }));
}

async function getEmailsBySender(sender, mailbox = 'INBOX', limit = 10) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = (await client.search({ from: sender }, { uid: true })) ?? [];
  const total = uids.length;
  const recentUids = uids.slice(-limit).reverse();
  const emails = [];
  for (const uid of recentUids) {
    const msg = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
    if (msg) {
      emails.push({
        uid,
        subject: msg.envelope.subject,
        from: msg.envelope.from?.[0]?.address,
        date: msg.envelope.date,
        flagged: msg.flags.has('\\Flagged'),
        seen: msg.flags.has('\\Seen')
      });
    }
  }
  await client.logout();
  return { total, showing: emails.length, emails };
}

async function bulkDeleteBySender(sender, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = (await client.search({ from: sender }, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { deleted: 0 }; }
  let deleted = 0;
  for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
    const chunk = uids.slice(i, i + CHUNK_SIZE);
    await client.messageDelete(chunk, { uid: true });
    deleted += chunk.length;
  }
  await client.logout();
  return { deleted, sender };
}

async function bulkMoveBySender(sender, targetMailbox, sourceMailbox = 'INBOX', dryRun = false) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  const uids = (await client.search({ from: sender }, { uid: true })) ?? [];
  await client.logout();
  if (dryRun) return { dryRun: true, wouldMove: uids.length, sender, sourceMailbox, targetMailbox };
  if (uids.length === 0) return { moved: 0 };
  await ensureMailbox(targetMailbox);
  const result = await safeMoveEmails(uids, sourceMailbox, targetMailbox);
  return { ...result, sender, targetMailbox };
}

async function bulkDeleteBySubject(subject, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = (await client.search({ subject }, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { deleted: 0 }; }
  let deleted = 0;
  for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
    const chunk = uids.slice(i, i + CHUNK_SIZE);
    await client.messageDelete(chunk, { uid: true });
    deleted += chunk.length;
  }
  await client.logout();
  return { deleted, subject };
}

async function deleteOlderThan(days, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const date = new Date();
  date.setDate(date.getDate() - days);
  const uids = (await client.search({ before: date }, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { deleted: 0 }; }
  let deleted = 0;
  for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
    const chunk = uids.slice(i, i + CHUNK_SIZE);
    await client.messageDelete(chunk, { uid: true });
    deleted += chunk.length;
  }
  await client.logout();
  return { deleted, olderThan: date.toISOString() };
}

async function getEmailsByDateRange(startDate, endDate, mailbox = 'INBOX', limit = 10) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const uids = (await client.search({ since: new Date(startDate), before: new Date(endDate) }, { uid: true })) ?? [];
  const total = uids.length;
  const recentUids = uids.slice(-limit).reverse();
  const emails = [];
  for (const uid of recentUids) {
    const msg = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
    if (msg) {
      emails.push({
        uid,
        subject: msg.envelope.subject,
        from: msg.envelope.from?.[0]?.address,
        date: msg.envelope.date,
        flagged: msg.flags.has('\\Flagged'),
        seen: msg.flags.has('\\Seen')
      });
    }
  }
  await client.logout();
  return { total, showing: emails.length, emails };
}

async function bulkMarkRead(mailbox = 'INBOX', sender = null) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const query = sender ? { from: sender, seen: false } : { seen: false };
  const uids = (await client.search(query, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { marked: 0 }; }
  await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
  await client.logout();
  return { marked: uids.length, sender: sender || 'all' };
}

async function bulkMarkUnread(mailbox = 'INBOX', sender = null) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const query = sender ? { from: sender, seen: true } : { seen: true };
  const uids = (await client.search(query, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { marked: 0 }; }
  await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
  await client.logout();
  return { marked: uids.length, sender: sender || 'all' };
}

async function bulkFlag(filters, flagged, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const query = buildQuery(filters);
  const uids = (await client.search(query, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { flagged: 0 }; }
  if (flagged) {
    await client.messageFlagsAdd(uids, ['\\Flagged'], { uid: true });
  } else {
    await client.messageFlagsRemove(uids, ['\\Flagged'], { uid: true });
  }
  await client.logout();
  return { [flagged ? 'flagged' : 'unflagged']: uids.length, filters };
}

async function emptyTrash() {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen('Deleted Messages');
  const uids = (await client.search({ all: true }, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { deleted: 0 }; }
  let deleted = 0;
  for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
    const chunk = uids.slice(i, i + CHUNK_SIZE);
    await client.messageDelete(chunk, { uid: true });
    deleted += chunk.length;
  }
  await client.logout();
  return { deleted };
}

async function createMailbox(name) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxCreate(name);
  await client.logout();
  return { created: name };
}

async function renameMailbox(oldName, newName) {
  const client = createRateLimitedClient();
  await client.connect();
  try {
    await Promise.race([
      client.mailboxRename(oldName, newName),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('rename timed out after 15s — Apple IMAP may not support renaming this folder')), 15000)
      )
    ]);
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
  return { renamed: { from: oldName, to: newName } };
}

async function deleteMailbox(name) {
  const client = createRateLimitedClient();
  await client.connect();
  try {
    await Promise.race([
      client.mailboxDelete(name),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('delete timed out after 15s — Apple IMAP may not support deleting this folder')), 15000)
      )
    ]);
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
  return { deleted: name };
}

async function getMailboxSummary(mailbox) {
  const client = createRateLimitedClient();
  await client.connect();
  const status = await client.status(mailbox, { messages: true, unseen: true, recent: true });
  await client.logout();
  return { mailbox, total: status.messages, unread: status.unseen, recent: status.recent };
}

async function getEmailContent(uid, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const meta = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
  let body = '(body unavailable)';
  try {
    const sourceMsg = await Promise.race([
      client.fetchOne(uid, { source: true }, { uid: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
    ]);
    if (sourceMsg?.source) {
      const raw = sourceMsg.source.toString();
      const bodyStart = raw.indexOf('\r\n\r\n');
      body = bodyStart > -1 ? raw.slice(bodyStart + 4, bodyStart + 2000) : raw.slice(0, 2000);
    }
  } catch {
    body = '(body unavailable - email may be too large)';
  }
  await client.logout();
  return {
    uid: meta.uid,
    subject: meta.envelope.subject,
    from: meta.envelope.from?.[0]?.address,
    date: meta.envelope.date,
    flags: [...meta.flags],
    body
  };
}

async function flagEmail(uid, flagged, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  if (flagged) {
    await client.messageFlagsAdd(uid, ['\\Flagged'], { uid: true });
  } else {
    await client.messageFlagsRemove(uid, ['\\Flagged'], { uid: true });
  }
  await client.logout();
  return true;
}

async function markAsRead(uid, seen, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  if (seen) {
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
  } else {
    await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
  }
  await client.logout();
  return true;
}

async function deleteEmail(uid, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  await client.messageDelete(uid, { uid: true });
  await client.logout();
  return true;
}

async function listMailboxes() {
  const client = createRateLimitedClient();
  await client.connect();
  const tree = await client.listTree();
  const mailboxes = [];
  function walk(items) {
    for (const item of items) {
      mailboxes.push({ name: item.name, path: item.path });
      if (item.folders && item.folders.length > 0) walk(item.folders);
    }
  }
  walk(tree.folders);
  await client.logout();
  return mailboxes;
}

async function searchEmails(query, mailbox = 'INBOX', limit = 10, filters = {}) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);

  const textQuery = { or: [{ subject: query }, { from: query }, { body: query }] };
  const extraQuery = buildQuery(filters);
  const finalQuery = Object.keys(extraQuery).length > 0 && !extraQuery.all
    ? { ...textQuery, ...extraQuery }
    : textQuery;

  const uids = (await client.search(finalQuery, { uid: true })) ?? [];
  const emails = [];
  const recentUids = uids.slice(-limit).reverse();
  for (const uid of recentUids) {
    const msg = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
    if (msg) {
      emails.push({
        uid,
        subject: msg.envelope.subject,
        from: msg.envelope.from?.[0]?.address,
        date: msg.envelope.date,
        flagged: msg.flags.has('\\Flagged'),
        seen: msg.flags.has('\\Seen')
      });
    }
  }
  await client.logout();
  return { total: uids.length, showing: emails.length, emails };
}

async function moveEmail(uid, targetMailbox, sourceMailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  await client.messageMove(uid, targetMailbox, { uid: true });
  await client.logout();
  return true;
}

function buildQuery(filters) {
  const query = {};
  if (filters.sender) query.from = filters.sender;
  if (filters.domain) query.from = filters.domain.replace(/^@/, '');
  if (filters.subject) query.subject = filters.subject;
  if (filters.before) query.before = new Date(filters.before);
  if (filters.since) query.since = new Date(filters.since);
  if (filters.unread === true) query.seen = false;
  if (filters.unread === false) query.seen = true;
  if (filters.flagged === true) query.flagged = true;
  if (filters.flagged === false) query.unflagged = true;
  if (filters.larger) query.larger = filters.larger * 1024;
  if (filters.smaller) query.smaller = filters.smaller * 1024;
  if (filters.hasAttachment) query.header = ['Content-Type', 'multipart/mixed'];
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

async function ensureMailbox(name) {
  const client = createRateLimitedClient();
  await client.connect();
  try { await client.mailboxCreate(name); } catch { /* already exists */ }
  await client.logout();
}

async function bulkMove(filters, targetMailbox, sourceMailbox = 'INBOX', dryRun = false, limit = null) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  const query = buildQuery(filters);
  let uids = (await client.search(query, { uid: true })) ?? [];
  await client.logout();

  if (limit !== null) uids = uids.slice(0, limit);

  if (dryRun) {
    return { dryRun: true, wouldMove: uids.length, sourceMailbox, targetMailbox, filters };
  }
  if (uids.length === 0) return { moved: 0, sourceMailbox, targetMailbox };

  await ensureMailbox(targetMailbox);
  const result = await safeMoveEmails(uids, sourceMailbox, targetMailbox);
  return { ...result, sourceMailbox, targetMailbox, filters };
}

// ─── IMPROVEMENT 3: bulk_delete now has per-chunk timeout ─────────────────────
// Previously the chunk loop could run unbounded. Now each chunk gets a BULK_OP
// timeout. If a single chunk hangs, we bail with a partial result instead of
// hanging forever.

async function bulkDelete(filters, sourceMailbox = 'INBOX', dryRun = false) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  const query = buildQuery(filters);
  const uids = (await client.search(query, { uid: true })) ?? [];

  if (dryRun) {
    await client.logout();
    return { dryRun: true, wouldDelete: uids.length, sourceMailbox, filters };
  }
  if (uids.length === 0) { await client.logout(); return { deleted: 0, sourceMailbox }; }

  let deleted = 0;
  for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
    const chunk = uids.slice(i, i + CHUNK_SIZE);
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    try {
      await withTimeout(`bulk_delete chunk ${chunkIndex}`, TIMEOUT.BULK_OP, async () => {
        await client.messageDelete(chunk, { uid: true });
      });
      deleted += chunk.length;
    } catch (err) {
      await safeClose(client);
      return {
        deleted,
        failed: uids.length - deleted,
        sourceMailbox,
        filters,
        error: `Chunk ${chunkIndex} failed: ${err.message}. ${deleted} deleted so far, ${uids.length - deleted} remaining.`
      };
    }
  }
  await client.logout();
  return { deleted, sourceMailbox, filters };
}

async function countEmails(filters, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const query = buildQuery(filters);
  const uids = (await client.search(query, { uid: true })) ?? [];
  await client.logout();
  return { count: uids.length, mailbox, filters };
}

// ─── Session Log ──────────────────────────────────────────────────────────────

function logRead() {
  if (!existsSync(LOG_FILE)) return { steps: [], startedAt: null };
  try {
    return JSON.parse(readFileSync(LOG_FILE, 'utf8'));
  } catch {
    return { steps: [], startedAt: null };
  }
}

function logWrite(step) {
  const log = logRead();
  if (!log.startedAt) log.startedAt = new Date().toISOString();
  log.steps.push({ time: new Date().toISOString(), step });
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  return log;
}

function logClear() {
  writeFileSync(LOG_FILE, JSON.stringify({ steps: [], startedAt: null }, null, 2));
  return { cleared: true };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    { name: 'icloud-mail', version: '1.5.1' },
    { capabilities: { tools: {} } }
  );

  const filtersSchema = {
    sender: { type: 'string', description: 'Match exact sender email address' },
    domain: { type: 'string', description: 'Match any sender from this domain (e.g. substack.com)' },
    subject: { type: 'string', description: 'Keyword to match in subject' },
    before: { type: 'string', description: 'Only emails before this date (YYYY-MM-DD)' },
    since: { type: 'string', description: 'Only emails since this date (YYYY-MM-DD)' },
    unread: { type: 'boolean', description: 'True for unread only, false for read only' },
    flagged: { type: 'boolean', description: 'True for flagged only, false for unflagged only' },
    larger: { type: 'number', description: 'Only emails larger than this size in KB' },
    smaller: { type: 'number', description: 'Only emails smaller than this size in KB' },
    hasAttachment: { type: 'boolean', description: 'Only emails with attachments' }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_inbox_summary',
        description: 'Get a summary of a mailbox including total, unread, and recent email counts',
        inputSchema: { type: 'object', properties: { mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' } } }
      },
      {
        name: 'get_mailbox_summary',
        description: 'Get total, unread, and recent email counts for any specific mailbox/folder',
        inputSchema: {
          type: 'object',
          properties: { mailbox: { type: 'string', description: 'Mailbox path to summarize (e.g. Newsletters, Archive)' } },
          required: ['mailbox']
        }
      },
      {
        name: 'get_top_senders',
        description: 'Get the top senders by email count from a sample of the inbox',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox to analyze (default INBOX)' },
            sampleSize: { type: 'number', description: 'Number of emails to sample (default 500)' },
            maxResults: { type: 'number', description: 'Max number of senders/domains to return (default 20)' }
          }
        }
      },
      {
        name: 'get_unread_senders',
        description: 'Get top senders of unread emails',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox to analyze (default INBOX)' },
            sampleSize: { type: 'number', description: 'Number of emails to sample (default 500)' },
            maxResults: { type: 'number', description: 'Max number of senders to return (default 20)' }
          }
        }
      },
      {
        name: 'get_emails_by_sender',
        description: 'Get all emails from a specific sender',
        inputSchema: {
          type: 'object',
          properties: {
            sender: { type: 'string', description: 'Sender email address or domain' },
            mailbox: { type: 'string', description: 'Mailbox to search (default INBOX)' },
            limit: { type: 'number', description: 'Max results to show (default 10)' }
          },
          required: ['sender']
        }
      },
      {
        name: 'read_inbox',
        description: 'Read emails from iCloud inbox with pagination',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of emails per page (default 10)' },
            page: { type: 'number', description: 'Page number (default 1)' },
            onlyUnread: { type: 'boolean', description: 'Only fetch unread emails' },
            mailbox: { type: 'string', description: 'Mailbox to read (default INBOX)' }
          }
        }
      },
      {
        name: 'get_email',
        description: 'Get full content of a specific email by UID',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' }
          },
          required: ['uid']
        }
      },
      {
        name: 'search_emails',
        description: 'Search emails by keyword, with optional filters for date, read status, domain, and more',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keyword (matches subject, sender, body)' },
            mailbox: { type: 'string', description: 'Mailbox to search (default INBOX)' },
            limit: { type: 'number', description: 'Max results (default 10)' },
            ...filtersSchema
          },
          required: ['query']
        }
      },
      {
        name: 'count_emails',
        description: 'Count how many emails match a set of filters without moving or deleting them. Use this before bulk_move or bulk_delete to preview how many emails will be affected.',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox to count in (default INBOX)' },
            ...filtersSchema
          }
        }
      },
      {
        name: 'bulk_move',
        description: 'Move emails matching any combination of filters from one mailbox to another. Uses safe copy-verify-delete with fingerprint verification and a persistent manifest. Use dryRun: true to preview without making changes.',
        inputSchema: {
          type: 'object',
          properties: {
            targetMailbox: { type: 'string', description: 'Destination mailbox path' },
            sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' },
            dryRun: { type: 'boolean', description: 'If true, preview what would be moved without actually moving' },
            limit: { type: 'number', description: 'Maximum number of emails to move (default: all matching)' },
            ...filtersSchema
          },
          required: ['targetMailbox']
        }
      },
      {
        name: 'bulk_delete',
        description: 'Delete emails matching any combination of filters. Processes in chunks of 250 with per-chunk timeouts for reliability. Use dryRun: true to preview without making changes.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceMailbox: { type: 'string', description: 'Mailbox to delete from (default INBOX)' },
            dryRun: { type: 'boolean', description: 'If true, preview what would be deleted without actually deleting' },
            ...filtersSchema
          }
        }
      },
      {
        name: 'bulk_flag',
        description: 'Flag or unflag emails matching any combination of filters in bulk',
        inputSchema: {
          type: 'object',
          properties: {
            flagged: { type: 'boolean', description: 'True to flag, false to unflag' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
            ...filtersSchema
          },
          required: ['flagged']
        }
      },
      {
        name: 'bulk_delete_by_sender',
        description: 'Delete all emails from a specific sender',
        inputSchema: {
          type: 'object',
          properties: {
            sender: { type: 'string', description: 'Sender email address' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' }
          },
          required: ['sender']
        }
      },
      {
        name: 'bulk_move_by_sender',
        description: 'Move all emails from a specific sender to a folder',
        inputSchema: {
          type: 'object',
          properties: {
            sender: { type: 'string', description: 'Sender email address' },
            targetMailbox: { type: 'string', description: 'Destination folder' },
            sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' },
            dryRun: { type: 'boolean', description: 'Preview only — return count without moving' }
          },
          required: ['sender', 'targetMailbox']
        }
      },
      {
        name: 'bulk_delete_by_subject',
        description: 'Delete all emails matching a subject pattern',
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Subject keyword to match' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' }
          },
          required: ['subject']
        }
      },
      {
        name: 'bulk_mark_read',
        description: 'Mark all emails as read, optionally filtered by sender',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
            sender: { type: 'string', description: 'Optional: only mark emails from this sender as read' }
          }
        }
      },
      {
        name: 'bulk_mark_unread',
        description: 'Mark all emails as unread, optionally filtered by sender',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
            sender: { type: 'string', description: 'Optional: only mark emails from this sender as unread' }
          }
        }
      },
      {
        name: 'delete_older_than',
        description: 'Delete all emails older than a certain number of days',
        inputSchema: {
          type: 'object',
          properties: {
            days: { type: 'number', description: 'Delete emails older than this many days' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' }
          },
          required: ['days']
        }
      },
      {
        name: 'get_emails_by_date_range',
        description: 'Get emails between two dates',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
            endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
            mailbox: { type: 'string', description: 'Mailbox (default INBOX)' },
            limit: { type: 'number', description: 'Max results (default 10)' }
          },
          required: ['startDate', 'endDate']
        }
      },
      {
        name: 'flag_email',
        description: 'Flag or unflag a single email',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            flagged: { type: 'boolean', description: 'True to flag, false to unflag' },
            mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' }
          },
          required: ['uid', 'flagged']
        }
      },
      {
        name: 'mark_as_read',
        description: 'Mark a single email as read or unread',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            seen: { type: 'boolean', description: 'True to mark as read, false for unread' },
            mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' }
          },
          required: ['uid', 'seen']
        }
      },
      {
        name: 'delete_email',
        description: 'Delete a single email',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            mailbox: { type: 'string', description: 'Mailbox name (default INBOX)' }
          },
          required: ['uid']
        }
      },
      {
        name: 'move_email',
        description: 'Move a single email to a different mailbox/folder',
        inputSchema: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'Email UID' },
            targetMailbox: { type: 'string', description: 'Destination mailbox path' },
            sourceMailbox: { type: 'string', description: 'Source mailbox (default INBOX)' }
          },
          required: ['uid', 'targetMailbox']
        }
      },
      {
        name: 'list_mailboxes',
        description: 'List all mailboxes/folders in iCloud Mail',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'create_mailbox',
        description: 'Create a new mailbox/folder',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Name of the new mailbox' } },
          required: ['name']
        }
      },
      {
        name: 'rename_mailbox',
        description: 'Rename an existing mailbox/folder',
        inputSchema: {
          type: 'object',
          properties: {
            oldName: { type: 'string', description: 'Current mailbox path' },
            newName: { type: 'string', description: 'New mailbox path' }
          },
          required: ['oldName', 'newName']
        }
      },
      {
        name: 'delete_mailbox',
        description: 'Delete a mailbox/folder. The folder must be empty first.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Mailbox path to delete' } },
          required: ['name']
        }
      },
      {
        name: 'empty_trash',
        description: 'Permanently delete all emails in Deleted Messages',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'get_move_status',
        description: 'Check the status of the current or most recent bulk move operation. Shows progress, chunk statuses, and any failures. Call this to monitor a long-running move or inspect a failed one.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'abandon_move',
        description: 'Abandon an in-progress move operation so a new one can start. Only use if you are certain the operation should not be resumed. Emails already moved will not be returned to source.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'log_write',
        description: 'Write a step to the session log. Use this to record your plan before starting, and after each completed step. Helps maintain progress across long operations.',
        inputSchema: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'Description of what you are doing or just completed' }
          },
          required: ['step']
        }
      },
      {
        name: 'log_read',
        description: 'Read the current session log to see what has been done so far.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'log_clear',
        description: 'Clear the session log and start fresh. Use this at the start of a new task.',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      // ── Metadata tier (15s) ──
      if (name === 'get_inbox_summary') {
        result = await withTimeout('get_inbox_summary', TIMEOUT.METADATA, () => getInboxSummary(args.mailbox || 'INBOX'));
      } else if (name === 'get_mailbox_summary') {
        result = await withTimeout('get_mailbox_summary', TIMEOUT.METADATA, () => getMailboxSummary(args.mailbox));
      } else if (name === 'count_emails') {
        const { mailbox, ...filters } = args;
        result = await withTimeout('count_emails', TIMEOUT.METADATA, () => countEmails(filters, mailbox || 'INBOX'));
      } else if (name === 'list_mailboxes') {
        result = await withTimeout('list_mailboxes', TIMEOUT.METADATA, () => listMailboxes());
      } else if (name === 'create_mailbox') {
        result = await withTimeout('create_mailbox', TIMEOUT.METADATA, () => createMailbox(args.name));
      } else if (name === 'rename_mailbox') {
        result = await renameMailbox(args.oldName, args.newName); // already has its own 15s timeout
      } else if (name === 'delete_mailbox') {
        result = await deleteMailbox(args.name); // already has its own 15s timeout
      // ── Fetch tier (30s) ──
      } else if (name === 'read_inbox') {
        result = await withTimeout('read_inbox', TIMEOUT.FETCH, () => fetchEmails(args.mailbox || 'INBOX', args.limit || 10, args.onlyUnread || false, args.page || 1));
      } else if (name === 'get_email') {
        result = await withTimeout('get_email', TIMEOUT.FETCH, () => getEmailContent(args.uid, args.mailbox || 'INBOX'));
      } else if (name === 'search_emails') {
        const { query, mailbox, limit, ...filters } = args;
        result = await withTimeout('search_emails', TIMEOUT.FETCH, () => searchEmails(query, mailbox || 'INBOX', limit || 10, filters));
      } else if (name === 'get_emails_by_sender') {
        result = await withTimeout('get_emails_by_sender', TIMEOUT.FETCH, () => getEmailsBySender(args.sender, args.mailbox || 'INBOX', args.limit || 10));
      } else if (name === 'get_emails_by_date_range') {
        result = await withTimeout('get_emails_by_date_range', TIMEOUT.FETCH, () => getEmailsByDateRange(args.startDate, args.endDate, args.mailbox || 'INBOX', args.limit || 10));
      // ── Scan tier (60s) ──
      } else if (name === 'get_top_senders') {
        result = await withTimeout('get_top_senders', TIMEOUT.SCAN, () => getTopSenders(args.mailbox || 'INBOX', args.sampleSize || 500, args.maxResults || 20));
      } else if (name === 'get_unread_senders') {
        result = await withTimeout('get_unread_senders', TIMEOUT.SCAN, () => getUnreadSenders(args.mailbox || 'INBOX', args.sampleSize || 500, args.maxResults || 20));
      // ── Bulk operation tier (60s) ──
      } else if (name === 'bulk_delete_by_sender') {
        result = await withTimeout('bulk_delete_by_sender', TIMEOUT.BULK_OP, () => bulkDeleteBySender(args.sender, args.mailbox || 'INBOX'));
      } else if (name === 'bulk_delete_by_subject') {
        result = await withTimeout('bulk_delete_by_subject', TIMEOUT.BULK_OP, () => bulkDeleteBySubject(args.subject, args.mailbox || 'INBOX'));
      } else if (name === 'bulk_mark_read') {
        result = await withTimeout('bulk_mark_read', TIMEOUT.BULK_OP, () => bulkMarkRead(args.mailbox || 'INBOX', args.sender || null));
      } else if (name === 'bulk_mark_unread') {
        result = await withTimeout('bulk_mark_unread', TIMEOUT.BULK_OP, () => bulkMarkUnread(args.mailbox || 'INBOX', args.sender || null));
      } else if (name === 'bulk_flag') {
        const { flagged, mailbox, ...filters } = args;
        result = await withTimeout('bulk_flag', TIMEOUT.BULK_OP, () => bulkFlag(filters, flagged, mailbox || 'INBOX'));
      } else if (name === 'delete_older_than') {
        result = await withTimeout('delete_older_than', TIMEOUT.BULK_OP, () => deleteOlderThan(args.days, args.mailbox || 'INBOX'));
      } else if (name === 'empty_trash') {
        result = await withTimeout('empty_trash', TIMEOUT.BULK_OP, () => emptyTrash());
      // ── No top-level timeout — chunked with internal timeouts ──
      } else if (name === 'bulk_move') {
        const { targetMailbox, sourceMailbox, dryRun, limit, ...filters } = args;
        result = await bulkMove(filters, targetMailbox, sourceMailbox || 'INBOX', dryRun || false, limit ?? null);
      } else if (name === 'bulk_move_by_sender') {
        result = await bulkMoveBySender(args.sender, args.targetMailbox, args.sourceMailbox || 'INBOX', args.dryRun || false);
      } else if (name === 'bulk_delete') {
        // IMPROVEMENT 3: bulk_delete now has per-chunk timeouts internally
        const { sourceMailbox, dryRun, ...filters } = args;
        result = await bulkDelete(filters, sourceMailbox || 'INBOX', dryRun || false);
      // ── Single-email tier (15s) ──
      } else if (name === 'flag_email') {
        result = await withTimeout('flag_email', TIMEOUT.SINGLE, () => flagEmail(args.uid, args.flagged, args.mailbox || 'INBOX'));
      } else if (name === 'mark_as_read') {
        result = await withTimeout('mark_as_read', TIMEOUT.SINGLE, () => markAsRead(args.uid, args.seen, args.mailbox || 'INBOX'));
      } else if (name === 'delete_email') {
        result = await withTimeout('delete_email', TIMEOUT.SINGLE, () => deleteEmail(args.uid, args.mailbox || 'INBOX'));
      } else if (name === 'move_email') {
        result = await withTimeout('move_email', TIMEOUT.SINGLE, () => moveEmail(args.uid, args.targetMailbox, args.sourceMailbox || 'INBOX'));
      // ── Move status (synchronous, no timeout needed) ──
      } else if (name === 'get_move_status') {
        result = getMoveStatus();
      } else if (name === 'abandon_move') {
        result = abandonMove();
      // ── Session log (synchronous, no timeout needed) ──
      } else if (name === 'log_write') {
        result = logWrite(args.step);
      } else if (name === 'log_read') {
        result = logRead();
      } else if (name === 'log_clear') {
        result = logClear();
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${friendlyError(error)}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('iCloud Mail MCP Server running\n');
}

// ─── Friendly error messages ──────────────────────────────────────────────────

function friendlyError(err) {
  const msg = err.message ?? '';

  if (msg.includes('AUTHENTICATIONFAILED') || msg.includes('Invalid credentials') || msg.includes('Authentication failed')) {
    return [
      'Authentication failed.',
      '→ Make sure IMAP_PASSWORD is an app-specific password, not your regular iCloud password.',
      '→ Generate one at: appleid.apple.com → Sign-In and Security → App-Specific Passwords',
      '→ Also check that IMAP_USER is your full iCloud email address (e.g. you@icloud.com)'
    ].join('\n');
  }

  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ENETUNREACH')) {
    return [
      'Could not reach imap.mail.me.com:993.',
      '→ Check your internet connection.',
      '→ If you are behind a firewall or VPN, port 993 may be blocked.'
    ].join('\n');
  }

  if (msg.includes('ETIMEDOUT') || msg.includes('socket hang up')) {
    return [
      'Connection to iCloud timed out.',
      '→ Check your internet connection and try again.',
      '→ iCloud IMAP can be slow under load — this is usually transient.'
    ].join('\n');
  }

  if (msg.includes('ECONNRESET')) {
    return [
      'iCloud closed the connection unexpectedly.',
      '→ This is usually transient. Try again in a few seconds.'
    ].join('\n');
  }

  if (msg.includes('timed out after')) {
    return [
      `Operation ${msg}`,
      '→ This usually means iCloud is slow or the operation is larger than expected.',
      '→ Try again — if it persists, the operation may need to be broken into smaller steps.'
    ].join('\n');
  }

  if (msg.includes('Mailbox does not exist') || msg.includes('does not exist') || msg.includes('NONEXISTENT')) {
    return [
      `Mailbox not found: ${msg}`,
      '→ Check the folder name is correct — iCloud folder names are case-sensitive.',
      '→ Use list_mailboxes to see all available folders.'
    ].join('\n');
  }

  // Fall through — return original message
  return msg;
}

// ─── Doctor command ───────────────────────────────────────────────────────────

async function runDoctor() {
  const divider = '─'.repeat(45);
  process.stdout.write(`\nicloud-mcp doctor\n${divider}\n`);

  const checks = [
    {
      label: 'IMAP_USER is set',
      run: () => {
        if (!IMAP_USER) throw new Error('IMAP_USER environment variable is not set.\n→ Add it to your Claude Desktop config env block.');
      }
    },
    {
      label: 'IMAP_PASSWORD is set',
      run: () => {
        if (!IMAP_PASSWORD) throw new Error('IMAP_PASSWORD environment variable is not set.\n→ Add it to your Claude Desktop config env block.');
      }
    },
    {
      label: 'IMAP_USER looks like an email address',
      run: () => {
        if (!IMAP_USER?.includes('@')) throw new Error(`IMAP_USER "${IMAP_USER}" doesn't look like an email address.\n→ Use your full iCloud address, e.g. you@icloud.com`);
      }
    },
    {
      label: `Connected to imap.mail.me.com:993`,
      run: async () => {
        const client = createRateLimitedClient();
        await client.connect();
        await client.logout();
      }
    },
    {
      label: `Authenticated as ${IMAP_USER}`,
      run: async () => {
        // Auth is validated as part of connect — if we reach here it passed.
        // This check exists to give a clearer label in the output.
      }
    },
    {
      label: 'INBOX opened',
      run: async () => {
        const client = createRateLimitedClient();
        await client.connect();
        const mb = await client.mailboxOpen('INBOX');
        await client.logout();
        return `${mb.exists.toLocaleString()} messages`;
      }
    }
  ];

  let allPassed = true;

  for (const check of checks) {
    try {
      const detail = await check.run();
      const suffix = detail ? ` (${detail})` : '';
      process.stdout.write(`✅ ${check.label}${suffix}\n`);
    } catch (err) {
      process.stdout.write(`❌ ${check.label}\n   ${friendlyError(err).replace(/\n/g, '\n   ')}\n`);
      allPassed = false;
      break; // No point continuing after a failure
    }
  }

  process.stdout.write(`${divider}\n`);
  if (allPassed) {
    process.stdout.write('All checks passed. Ready to use with Claude Desktop.\n\n');
    process.exit(0);
  } else {
    process.stdout.write('Setup is not complete. Fix the issue above and run --doctor again.\n\n');
    process.exit(1);
  }
}


process.on('uncaughtException', (err) => {
  process.stderr.write(`Uncaught exception: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`Unhandled rejection: ${reason}\n`);
  process.exit(1);
});

if (process.argv.includes('--doctor')) {
  runDoctor().catch((err) => {
    process.stderr.write(`Doctor failed unexpectedly: ${err.message}\n`);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}
