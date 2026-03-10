import { ImapFlow } from 'imapflow';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  decodeTransferEncoding, decodeCharset, stripHtml, extractRawHeader,
  findTextPart, findAttachments, estimateEmailSize, stripSubjectPrefixes
} from './mime.js';

const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD;

const MANIFEST_FILE = join(homedir(), '.icloud-mcp-move-manifest.json');
const RULES_FILE = join(homedir(), '.icloud-mcp-rules.json');
const MAX_HISTORY = 5;

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
const MIN_CONNECT_INTERVAL = 10; // ms between connection initiations

export function createRateLimitedClient() {
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
const ATTACHMENT_SCAN_LIMIT = 500; // max UIDs to scan client-side for hasAttachment filter
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB cap for get_attachment downloads

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

export function getMoveStatus() {
  const data = readManifest();
  if (!data.current) return { status: 'no_operation', history: data.history.map(summarizeOp) };

  const result = {
    current: formatOperation(data.current),
    history: data.history.map(summarizeOp)
  };

  // Stale warning: in_progress but updatedAt is more than 24h ago
  if (data.current.status === 'in_progress') {
    const ageMs = Date.now() - new Date(data.current.updatedAt).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      result.staleWarning = `Operation ${data.current.operationId} has not been updated in ${Math.round(ageMs / 3_600_000)}h — it may be stale. Call abandon_move to discard it if you want to start a new operation.`;
    }
  }

  return result;
}

export function abandonMove() {
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
    phase: 'copying',
    verifiedAt: null,
    deletedAt: null,
    allFingerprints: null,
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

function updateOperationPhase(phase, extraFields = {}) {
  updateManifest((data) => {
    if (!data.current) return;
    data.current.phase = phase;
    Object.assign(data.current, extraFields);
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
    phase: op.phase ?? null,
    source: op.source,
    target: op.target,
    startedAt: op.startedAt,
    updatedAt: op.updatedAt,
    verifiedAt: op.verifiedAt ?? null,
    deletedAt: op.deletedAt ?? null,
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
  const rawDate = msg.envelope?.date;
  let date = '';
  if (rawDate) { try { const d = new Date(rawDate); if (!isNaN(d.getTime())) date = d.toISOString(); } catch { /* malformed date */ } }
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

export async function withRetry(label, fn, maxAttempts = 3) {
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

const COPY_CHUNK_DELAY_MS = 500; // ms between COPY chunks — mitigates iCloud copy throttling

export const TIMEOUT = {
  METADATA:   15_000,
  FETCH:      30_000,
  SCAN:       60_000,
  BULK_OP:    60_000,
  CHUNK:     300_000,
  SINGLE:     15_000,
  VERIFY_ALL: 120_000, // full envelope scan for all N emails
  DELETE_ALL: 600_000, // flag all + single UID EXPUNGE (measured up to 521s at 5k)
};

export function withTimeout(label, ms, fn) {
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

  if (afterScan.length > 200) {
    moveLog(chunkIndex, `${afterScan.length} unmatched after envelope scan — too many for Message-ID fallback, treating as failed`);
    return { verified: false, missing: afterScan, found: fingerprints.length - afterScan.length, expected: fingerprints.length };
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

// ─── Option B phase helpers ────────────────────────────────────────────────────

// Phase 1: Copy all chunks to target without deleting.
// Returns { success, totalCopied, srcClient, errorResult }
async function copyAllChunks(operation, srcClient, targetMailbox, sourceMailbox) {
  let totalCopied = 0;

  for (const chunk of operation.chunks) {
    const chunkUids = chunk.uids;
    const chunkStart = Date.now();
    moveLog(chunk.index, `starting copy (${chunkUids.length} emails)`);

    try {
      await withTimeout(`copy chunk ${chunk.index}`, TIMEOUT.CHUNK, async () => {
        // Step 1: fetch envelopes → fingerprints
        let t = Date.now();
        const envelopes = [];
        try {
          for await (const msg of srcClient.fetch(chunkUids, { envelope: true }, { uid: true })) {
            envelopes.push(msg);
          }
        } catch (err) {
          if (!isTransient(err)) throw err;
          moveLog(chunk.index, `fetch envelopes failed (${err.message}), reconnecting...`);
          srcClient = await reconnect(srcClient, sourceMailbox);
          for await (const msg of srcClient.fetch(chunkUids, { envelope: true }, { uid: true })) {
            envelopes.push(msg);
          }
        }
        const fingerprints = envelopes.map(buildFingerprint);
        const withMsgId = fingerprints.filter(fp => fp.messageId).length;
        moveLog(chunk.index, `fetched ${envelopes.length} envelopes (${withMsgId} with Message-ID) (${elapsed(t)})`);

        // Update in-memory chunk so verifyAllChunks can flatMap fingerprints later
        chunk.fingerprints = fingerprints;
        updateManifest((data) => {
          if (!data.current) return;
          const c = data.current.chunks[chunk.index];
          if (!c) return;
          c.fingerprints = fingerprints;
        });

        // Step 2: copy to target
        t = Date.now();
        try {
          await srcClient.messageCopy(chunkUids, targetMailbox, { uid: true });
        } catch (err) {
          if (!isTransient(err)) throw err;
          moveLog(chunk.index, `copy failed (${err.message}), reconnecting...`);
          srcClient = await reconnect(srcClient, sourceMailbox);
          await srcClient.messageCopy(chunkUids, targetMailbox, { uid: true });
        }
        moveLog(chunk.index, `copied ${chunkUids.length} emails to target (${elapsed(t)})`);
        updateChunk(chunk.index, { status: 'copied_not_verified', copiedAt: new Date().toISOString() });
      });

      totalCopied += chunkUids.length;
      moveLog(chunk.index, `copy complete (${elapsed(chunkStart)})`);
    } catch (err) {
      moveLog(chunk.index, `copy FAILED: ${err.message}`);
      updateChunk(chunk.index, { status: 'failed', failureReason: err.message });
      return {
        success: false,
        totalCopied,
        srcClient,
        errorResult: {
          status: 'partial',
          moved: 0,
          failed: operation.totalUids,
          message: `Copy failed on chunk ${chunk.index}: ${err.message}. No emails deleted from source. ${totalCopied} emails were copied to target but not verified — call get_move_status for details.`
        }
      };
    }

    // Delay between chunks to mitigate iCloud copy throttling
    if (chunk.index < operation.chunks.length - 1) {
      await new Promise(r => setTimeout(r, COPY_CHUNK_DELAY_MS));
    }
  }

  return { success: true, totalCopied, srcClient, errorResult: null };
}

// Phase 2: Verify all copied emails are present in target.
// Returns { verification, tgtClient }
async function verifyAllChunks(tgtClient, operation, targetMailbox) {
  const allFingerprints = operation.chunks.flatMap(c => c.fingerprints);

  updateManifest((data) => {
    if (!data.current) return;
    data.current.allFingerprints = allFingerprints;
  });

  let tgtMb;
  try {
    tgtMb = await tgtClient.mailboxOpen(targetMailbox);
  } catch (err) {
    if (!isTransient(err)) throw err;
    moveLog('global', `mailboxOpen failed (${err.message}), reconnecting...`);
    tgtClient = await reconnect(tgtClient, targetMailbox);
    tgtMb = await tgtClient.mailboxOpen(targetMailbox);
  }

  let verification;
  try {
    verification = await verifyInTarget(tgtClient, allFingerprints, 'global', tgtMb.exists);
  } catch (err) {
    if (!isTransient(err)) throw err;
    moveLog('global', `verify failed (${err.message}), reconnecting...`);
    tgtClient = await reconnect(tgtClient, targetMailbox);
    verification = await verifyInTarget(tgtClient, allFingerprints, 'global');
  }

  return { verification, tgtClient };
}

// Phase 3: Delete all source emails in a single EXPUNGE.
// Returns { srcClient }
async function deleteAllChunks(srcClient, operation, sourceMailbox) {
  const allUids = operation.chunks.flatMap(c => c.uids);
  const t = Date.now();

  try {
    await srcClient.messageDelete(allUids, { uid: true });
  } catch (err) {
    if (!isTransient(err)) throw err;
    moveLog('global', `delete failed (${err.message}), reconnecting...`);
    srcClient = await reconnect(srcClient, sourceMailbox);
    // Retry is idempotent — expunging already-gone UIDs is a no-op
    await srcClient.messageDelete(allUids, { uid: true });
  }

  moveLog('global', `deleted ${allUids.length} from source — single EXPUNGE (${elapsed(t)})`);
  return { srcClient };
}

// ─── Safe Move (Option B: COPY-all → VERIFY-all → single EXPUNGE) ─────────────

async function safeMoveEmails(uids, sourceMailbox, targetMailbox) {
  const operation = startOperation(sourceMailbox, targetMailbox, uids);
  const opStart = Date.now();

  process.stderr.write(`[move] starting: ${uids.length} emails, ${operation.chunks.length} chunks, ${sourceMailbox} → ${targetMailbox}\n`);

  let srcClient = await openClient(sourceMailbox);
  let tgtClient = await openClient(targetMailbox);

  try {
    // Phase 1: COPY all chunks to target (no delete yet)
    process.stderr.write(`[move] phase 1/3: copying ${uids.length} emails in ${operation.chunks.length} chunks\n`);
    const copyResult = await copyAllChunks(operation, srcClient, targetMailbox, sourceMailbox);
    srcClient = copyResult.srcClient;

    if (!copyResult.success) {
      failOperation(`Copy phase failed: ${copyResult.errorResult.message}`);
      return copyResult.errorResult;
    }

    // Phase 2: VERIFY all emails are present in target
    process.stderr.write(`[move] phase 2/3: verifying all ${copyResult.totalCopied} emails in target\n`);
    updateOperationPhase('verifying');

    let verifyResult;
    try {
      verifyResult = await withTimeout('verify all', TIMEOUT.VERIFY_ALL, () =>
        verifyAllChunks(tgtClient, operation, targetMailbox)
      );
      tgtClient = verifyResult.tgtClient;
    } catch (err) {
      moveLog('global', `verify phase FAILED: ${err.message}`);
      failOperation(`Verify phase failed: ${err.message}`);
      return {
        status: 'failed',
        moved: 0,
        message: `Verification timed out or failed: ${err.message}. All ${copyResult.totalCopied} emails remain in source (not deleted). Call get_move_status for details.`
      };
    }

    const { verification } = verifyResult;
    moveLog('global', `verification: ${verification.found}/${verification.expected} confirmed`);

    if (!verification.verified) {
      moveLog('global', `FAILED: ${verification.missing.length} emails missing from target after copy`);
      failOperation(`Verification failed: ${verification.missing.length} emails missing from target`);
      return {
        status: 'failed',
        moved: 0,
        message: `Verification failed: ${verification.missing.length} of ${verification.expected} emails did not arrive in target. Source emails untouched. Call get_move_status for details.`
      };
    }

    updateOperationPhase('verifying', { verifiedAt: new Date().toISOString() });

    // Mark all chunks as verified
    for (const chunk of operation.chunks) {
      updateChunk(chunk.index, { status: 'verified_not_deleted', verifiedAt: new Date().toISOString() });
    }

    // Phase 3: DELETE all source emails — single EXPUNGE
    process.stderr.write(`[move] phase 3/3: deleting all ${uids.length} emails from source (1 EXPUNGE)\n`);
    updateOperationPhase('deleting');

    let deleteResult;
    try {
      deleteResult = await withTimeout('delete all', TIMEOUT.DELETE_ALL, () =>
        deleteAllChunks(srcClient, operation, sourceMailbox)
      );
      srcClient = deleteResult.srcClient;
    } catch (err) {
      moveLog('global', `delete phase FAILED: ${err.message}`);
      // Emails are safe in target (verified). Source may still have them.
      failOperation(`Delete phase failed: ${err.message}`);
      return {
        status: 'failed',
        moved: 0,
        message: `Delete phase failed: ${err.message}. All ${copyResult.totalCopied} emails exist in target (verified) but may still exist in source. Call get_move_status for details.`
      };
    }

    // Mark all chunks complete
    const now = new Date().toISOString();
    for (const chunk of operation.chunks) {
      updateChunk(chunk.index, { status: 'complete', deletedAt: now });
    }
    updateOperationPhase('deleting', { deletedAt: now });
    completeOperation();

    process.stderr.write(`[move] COMPLETE: ${copyResult.totalCopied}/${operation.totalUids} emails moved (${elapsed(opStart)})\n`);
    return { status: 'complete', moved: copyResult.totalCopied, total: operation.totalUids };
  } finally {
    await safeClose(srcClient);
    await safeClose(tgtClient);
  }
}

// ─── Email Functions ──────────────────────────────────────────────────────────

export async function fetchEmails(mailbox = 'INBOX', limit = 10, onlyUnread = false, page = 1) {
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

export async function getInboxSummary(mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  const status = await client.status(mailbox, { messages: true, unseen: true, recent: true });
  await client.logout();
  return { mailbox, total: status.messages, unread: status.unseen, recent: status.recent };
}

export async function getTopSenders(mailbox = 'INBOX', sampleSize = 500, maxResults = 20) {
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

export async function getUnreadSenders(mailbox = 'INBOX', sampleSize = 500, maxResults = 20) {
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

export async function getEmailsBySender(sender, mailbox = 'INBOX', limit = 10) {
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

export async function bulkDeleteBySender(sender, mailbox = 'INBOX') {
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

export async function markOlderThanRead(days, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const date = new Date();
  date.setDate(date.getDate() - days);
  const raw = await client.search({ before: date, seen: false }, { uid: true });
  const uids = Array.isArray(raw) ? raw : [];
  if (uids.length === 0) { await client.logout(); return { marked: 0, olderThan: date.toISOString() }; }
  await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
  await client.logout();
  return { marked: uids.length, olderThan: date.toISOString() };
}

export async function bulkMoveByDomain(domain, targetMailbox, sourceMailbox = 'INBOX', dryRun = false) {
  const result = await bulkMove({ domain }, targetMailbox, sourceMailbox, dryRun);
  return { ...result, domain };
}

export async function bulkMoveBySender(sender, targetMailbox, sourceMailbox = 'INBOX', dryRun = false) {
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

export async function bulkDeleteBySubject(subject, mailbox = 'INBOX') {
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

export async function deleteOlderThan(days, mailbox = 'INBOX') {
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

export async function getEmailsByDateRange(startDate, endDate, mailbox = 'INBOX', limit = 10) {
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

export async function bulkMarkRead(mailbox = 'INBOX', sender = null) {
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

export async function bulkMarkUnread(mailbox = 'INBOX', sender = null) {
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

export async function bulkFlag(filters, flagged, mailbox = 'INBOX') {
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

export async function bulkFlagBySender(sender, flagged, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const raw = await client.search({ from: sender }, { uid: true });
  const uids = Array.isArray(raw) ? raw : [];
  if (uids.length === 0) { await client.logout(); return { [flagged ? 'flagged' : 'unflagged']: 0, sender }; }
  if (flagged) {
    await client.messageFlagsAdd(uids, ['\\Flagged'], { uid: true });
  } else {
    await client.messageFlagsRemove(uids, ['\\Flagged'], { uid: true });
  }
  await client.logout();
  return { [flagged ? 'flagged' : 'unflagged']: uids.length, sender };
}

export async function emptyTrash(dryRun = false) {
  const t0 = Date.now();
  const trashFolders = ['Deleted Messages', 'Trash'];
  const client = createRateLimitedClient();
  await client.connect();

  let mailbox = null;
  for (const folder of trashFolders) {
    try {
      await client.mailboxOpen(folder);
      mailbox = folder;
      break;
    } catch (err) {
      if (!err.message.includes('Mailbox does not exist') && !err.message.includes('NONEXISTENT') && !err.message.includes('does not exist')) {
        await safeClose(client);
        throw err;
      }
    }
  }

  if (!mailbox) {
    await safeClose(client);
    throw new Error('No trash folder found — tried: ' + trashFolders.join(', '));
  }

  const raw = await client.search({ all: true }, { uid: true });
  const uids = Array.isArray(raw) ? raw : [];

  if (dryRun) {
    await safeClose(client);
    return { dryRun: true, wouldDelete: uids.length, mailbox };
  }

  if (uids.length === 0) {
    await safeClose(client);
    return { deleted: 0, mailbox, timeTaken: ((Date.now() - t0) / 1000).toFixed(1) + 's' };
  }

  let deleted = 0;
  for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
    const chunk = uids.slice(i, i + CHUNK_SIZE);
    await client.messageDelete(chunk, { uid: true });
    deleted += chunk.length;
  }
  await safeClose(client);
  return { deleted, mailbox, timeTaken: ((Date.now() - t0) / 1000).toFixed(1) + 's' };
}

export async function archiveOlderThan(days, targetMailbox, sourceMailbox = 'INBOX', dryRun = false) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  const date = new Date();
  date.setDate(date.getDate() - days);
  const raw = await client.search({ before: date }, { uid: true });
  const uids = Array.isArray(raw) ? raw : [];
  await client.logout();
  if (dryRun) return { dryRun: true, wouldMove: uids.length, olderThan: date.toISOString(), sourceMailbox, targetMailbox };
  if (uids.length === 0) return { moved: 0, olderThan: date.toISOString(), sourceMailbox, targetMailbox };
  await ensureMailbox(targetMailbox);
  const result = await safeMoveEmails(uids, sourceMailbox, targetMailbox);
  return { ...result, olderThan: date.toISOString(), sourceMailbox, targetMailbox };
}

export async function getStorageReport(mailbox = 'INBOX', sampleSize = 100) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);

  // Count emails by size bucket using 4x SEARCH LARGER
  const thresholds = [10 * 1024, 100 * 1024, 1024 * 1024, 10 * 1024 * 1024];
  const counts = [];
  for (const thresh of thresholds) {
    const r = await client.search({ larger: thresh }, { uid: true }).catch(() => []);
    counts.push(Array.isArray(r) ? r.length : 0);
  }

  const buckets = [
    { range: '10KB–100KB', count: counts[0] - counts[1] },
    { range: '100KB–1MB', count: counts[1] - counts[2] },
    { range: '1MB–10MB', count: counts[2] - counts[3] },
    { range: '10MB+', count: counts[3] }
  ];

  // Sample top senders among large emails (> 100 KB)
  const largeRaw = await client.search({ larger: 100 * 1024 }, { uid: true }).catch(() => []);
  const largeUids = Array.isArray(largeRaw) ? largeRaw : [];
  const sampleUids = largeUids.slice(-sampleSize);

  const senderSizes = {};
  if (sampleUids.length > 0) {
    for await (const msg of client.fetch(sampleUids, { envelope: true, bodyStructure: true }, { uid: true })) {
      const address = msg.envelope?.from?.[0]?.address;
      if (address && msg.bodyStructure) {
        senderSizes[address] = (senderSizes[address] || 0) + estimateEmailSize(msg.bodyStructure);
      }
    }
  }

  await client.logout();

  const topSendersBySize = Object.entries(senderSizes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([address, estimateBytes]) => ({ address, estimateKB: Math.round(estimateBytes / 1024) }));

  const midpoints = [50, 512, 5120, 15360]; // rough KB midpoint for each bucket
  const estimatedTotalKB = buckets.reduce((sum, b, i) => sum + b.count * midpoints[i], 0);

  return {
    mailbox,
    buckets,
    estimatedTotalKB,
    topSendersBySize,
    ...(sampleUids.length < largeUids.length && {
      note: `Sender analysis sampled ${sampleUids.length} of ${largeUids.length} large emails (>100 KB)`
    })
  };
}

export async function getThread(uid, mailbox = 'INBOX') {
  const THREAD_CANDIDATE_CAP = 100;
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);

  // Fetch target email's envelope + raw headers for threading
  const meta = await client.fetchOne(uid, {
    envelope: true,
    flags: true,
    headers: new Set(['references', 'in-reply-to'])
  }, { uid: true });
  if (!meta) throw new Error(`Email UID ${uid} not found`);

  const targetMessageId = meta.envelope?.messageId ?? null;
  const rawRefs = extractRawHeader(meta.headers, 'references');
  const rawInReplyTo = extractRawHeader(meta.headers, 'in-reply-to');

  // Build full reference set for this email
  const threadRefs = new Set();
  if (targetMessageId) threadRefs.add(targetMessageId.trim());
  if (rawInReplyTo) threadRefs.add(rawInReplyTo.trim());
  if (rawRefs) {
    rawRefs.split(/\s+/).filter(s => s.startsWith('<') && s.endsWith('>')).forEach(r => threadRefs.add(r));
  }

  const normalizedSubject = stripSubjectPrefixes(meta.envelope?.subject ?? '');

  // SEARCH SUBJECT for candidates (iCloud doesn't support SEARCH HEADER)
  let candidateUids = [];
  if (normalizedSubject) {
    const raw = await client.search({ subject: normalizedSubject }, { uid: true });
    candidateUids = Array.isArray(raw) ? raw : [];
  }

  const candidatesCapped = candidateUids.length > THREAD_CANDIDATE_CAP;
  if (candidatesCapped) candidateUids = candidateUids.slice(-THREAD_CANDIDATE_CAP);

  // Fetch envelopes + headers for candidates to filter by References overlap
  const threadEmails = [];
  if (candidateUids.length > 0) {
    for await (const msg of client.fetch(candidateUids, {
      envelope: true,
      flags: true,
      headers: new Set(['references', 'in-reply-to'])
    }, { uid: true })) {
      const msgId = msg.envelope?.messageId ?? null;
      const msgRefs = extractRawHeader(msg.headers, 'references');
      const msgInReplyTo = extractRawHeader(msg.headers, 'in-reply-to');

      // Build this message's reference set
      const msgRefSet = new Set();
      if (msgId) msgRefSet.add(msgId.trim());
      if (msgInReplyTo) msgRefSet.add(msgInReplyTo.trim());
      if (msgRefs) msgRefs.split(/\s+/).filter(s => s.startsWith('<')).forEach(r => msgRefSet.add(r));

      // Include if there's any Reference chain overlap
      const hasOverlap = (msgId && threadRefs.has(msgId.trim())) ||
        [...threadRefs].some(r => msgRefSet.has(r));

      if (hasOverlap) {
        threadEmails.push({
          uid: msg.uid,
          subject: msg.envelope?.subject,
          from: msg.envelope?.from?.[0]?.address,
          date: msg.envelope?.date,
          seen: msg.flags?.has('\\Seen') ?? false,
          flagged: msg.flags?.has('\\Flagged') ?? false,
          messageId: msgId
        });
      }
    }
  }

  await client.logout();

  // Sort by date ascending
  threadEmails.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });

  return {
    uid,
    subject: normalizedSubject || meta.envelope?.subject,
    count: threadEmails.length,
    emails: threadEmails,
    ...(candidatesCapped && {
      candidatesCapped: true,
      note: `Subject search returned more than ${THREAD_CANDIDATE_CAP} candidates — thread results may be incomplete`
    })
  };
}

export async function createMailbox(name) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxCreate(name);
  await client.logout();
  return { created: name };
}

export async function renameMailbox(oldName, newName) {
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

export async function deleteMailbox(name) {
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

export async function getMailboxSummary(mailbox) {
  const client = createRateLimitedClient();
  await client.connect();
  const status = await client.status(mailbox, { messages: true, unseen: true, recent: true });
  await client.logout();
  return { mailbox, total: status.messages, unread: status.unseen, recent: status.recent };
}

// ─── Email content fetcher (MIME-aware) ───────────────────────────────────────

export async function getEmailContent(uid, mailbox = 'INBOX', maxChars = 8000, includeHeaders = false) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);

  const fetchOpts = { envelope: true, flags: true, bodyStructure: true };
  if (includeHeaders) fetchOpts.headers = new Set(['references', 'list-unsubscribe']);
  const meta = await client.fetchOne(uid, fetchOpts, { uid: true });
  if (!meta) {
    await client.logout();
    return { uid, subject: null, from: null, date: null, flags: [], body: '(email not found)' };
  }

  let body = '(body unavailable)';

  try {
    const struct = meta.bodyStructure;
    if (!struct) throw new Error('no bodyStructure');

    const textPart = findTextPart(struct);

    if (!textPart) {
      body = '(no readable text — email may be image-only or have no text parts)';
    } else {
      // Single-part messages use 'TEXT'; multipart use dot-notation part id (e.g. '1', '1.1')
      const imapKey = textPart.partId ?? 'TEXT';

      // For large parts, cap the fetch at 12KB to avoid downloading multi-MB newsletters
      const fetchSpec = (textPart.size && textPart.size > 150_000)
        ? [{ key: imapKey, start: 0, maxLength: 12_000 }]
        : [imapKey];

      const partMsg = await Promise.race([
        client.fetchOne(uid, { bodyParts: fetchSpec }, { uid: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('body fetch timeout')), 10_000))
      ]);

      // bodyParts is a Map — try the key as-is, then uppercase, then lowercase
      const partBuffer = partMsg?.bodyParts?.get(imapKey)
        ?? partMsg?.bodyParts?.get(imapKey.toUpperCase())
        ?? partMsg?.bodyParts?.get(imapKey.toLowerCase());

      if (!partBuffer || partBuffer.length === 0) throw new Error('empty body part');

      const decoded = decodeTransferEncoding(partBuffer, textPart.encoding);
      let text = await decodeCharset(decoded, textPart.charset);

      if (textPart.type === 'text/html') text = stripHtml(text);

      const clampedMaxChars = Math.min(maxChars, 50_000);
      if (text.length > clampedMaxChars) {
        text = text.slice(0, clampedMaxChars) + `\n\n[... truncated — ${text.length.toLocaleString()} chars total]`;
      }

      body = text.trim() || '(empty body)';

      if (textPart.size && textPart.size > 150_000) {
        body += `\n\n[Note: email body is large (${Math.round(textPart.size / 1024)}KB) — showing first 12KB]`;
      }
    }
  } catch {
    // Fallback: raw source slice (original behaviour)
    try {
      const sourceMsg = await Promise.race([
        client.fetchOne(uid, { source: true }, { uid: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
      ]);
      if (sourceMsg?.source) {
        const raw = sourceMsg.source.toString();
        const bodyStart = raw.indexOf('\r\n\r\n');
        body = '[raw fallback]\n' + (bodyStart > -1 ? raw.slice(bodyStart + 4, bodyStart + 2000) : raw.slice(0, 2000));
      }
    } catch { /* leave as unavailable */ }
  }

  await client.logout();

  const attachments = meta.bodyStructure ? findAttachments(meta.bodyStructure) : [];
  const result = {
    uid: meta.uid,
    subject: meta.envelope.subject,
    from: meta.envelope.from?.[0]?.address,
    date: meta.envelope.date,
    flags: [...meta.flags],
    attachments: {
      count: attachments.length,
      items: attachments.map(a => ({ partId: a.partId, filename: a.filename, mimeType: a.mimeType, size: a.size }))
    },
    body
  };

  if (includeHeaders) {
    // imapflow returns headers as a raw Buffer — parse it as text
    const rawRefs = extractRawHeader(meta.headers, 'references');
    const rawUnsub = extractRawHeader(meta.headers, 'list-unsubscribe');
    result.headers = {
      to: meta.envelope.to?.map(a => a.address) ?? [],
      cc: meta.envelope.cc?.map(a => a.address) ?? [],
      replyTo: meta.envelope.replyTo?.[0]?.address ?? null,
      messageId: meta.envelope.messageId ?? null,
      inReplyTo: meta.envelope.inReplyTo ?? null,
      references: rawRefs ? rawRefs.split(/\s+/).filter(s => s.startsWith('<')) : [],
      listUnsubscribe: rawUnsub || null
    };
  }

  return result;
}

export async function listAttachments(uid, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const meta = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
  await client.logout();
  if (!meta) return { uid, subject: null, attachmentCount: 0, attachments: [] };
  const attachments = meta.bodyStructure ? findAttachments(meta.bodyStructure) : [];
  return {
    uid: meta.uid,
    subject: meta.envelope.subject,
    attachmentCount: attachments.length,
    attachments
  };
}

export async function getUnsubscribeInfo(uid, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const meta = await client.fetchOne(uid, { headers: new Set(['list-unsubscribe', 'list-unsubscribe-post']) }, { uid: true });
  await client.logout();
  if (!meta) return { uid, email: null, url: null, raw: null };
  const raw = extractRawHeader(meta.headers, 'list-unsubscribe') || null;
  if (!raw) return { uid, email: null, url: null, raw: null };
  const email = raw.match(/<mailto:([^>]+)>/i)?.[1] ?? null;
  const url = raw.match(/<(https?:[^>]+)>/i)?.[1] ?? null;
  return { uid, email, url, raw };
}

export async function getEmailRaw(uid, mailbox = 'INBOX') {
  const MAX_RAW_BYTES = 1 * 1024 * 1024; // 1 MB cap
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const msg = await client.fetchOne(uid, { source: true }, { uid: true });
  await client.logout();
  if (!msg || !msg.source) throw new Error(`Email UID ${uid} not found`);
  const source = msg.source;
  const truncated = source.length > MAX_RAW_BYTES;
  const slice = truncated ? source.slice(0, MAX_RAW_BYTES) : source;
  return {
    uid,
    size: source.length,
    truncated,
    data: slice.toString('base64'),
    dataEncoding: 'base64'
  };
}

export async function getAttachment(uid, partId, mailbox = 'INBOX', offset = null, length = null) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);

  // First fetch bodyStructure to find the attachment and validate size
  const meta = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
  if (!meta) throw new Error(`Email UID ${uid} not found`);

  const attachments = meta.bodyStructure ? findAttachments(meta.bodyStructure) : [];
  const att = attachments.find(a => a.partId === partId);
  if (!att) throw new Error(`Part ID "${partId}" not found in email UID ${uid}. Use list_attachments to see available parts.`);

  const isPaginated = offset !== null || length !== null;

  if (!isPaginated && att.size > MAX_ATTACHMENT_BYTES) {
    await client.logout();
    return {
      error: `Attachment too large to download in one request (${Math.round(att.size / 1024 / 1024 * 10) / 10} MB). Use offset and length params to download in chunks (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per request).`,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      totalSize: att.size
    };
  }

  // Build fetch spec
  let fetchSpec;
  if (isPaginated) {
    const start = offset ?? 0;
    const maxLength = length ?? MAX_ATTACHMENT_BYTES;
    fetchSpec = [{ key: partId, start, maxLength }];
  } else {
    fetchSpec = [partId];
  }

  // Fetch the raw body part bytes
  const rawChunks = [];
  for await (const msg of client.fetch({ uid }, { bodyParts: fetchSpec }, { uid: true })) {
    const buf = msg.bodyParts?.get(partId)
      ?? msg.bodyParts?.get(partId.toUpperCase())
      ?? msg.bodyParts?.get(partId.toLowerCase());
    if (buf) rawChunks.push(buf);
  }
  await client.logout();

  if (rawChunks.length === 0) throw new Error(`No data returned for part "${partId}" of UID ${uid}`);

  const raw = Buffer.concat(rawChunks);

  if (isPaginated) {
    // Paginated: return raw encoded bytes without transfer-encoding decode
    const fetchOffset = offset ?? 0;
    const actualLength = raw.length;
    const hasMore = att.size ? (fetchOffset + actualLength < att.size) : false;
    return {
      uid, partId,
      filename: att.filename,
      mimeType: att.mimeType,
      encoding: att.encoding,
      totalSize: att.size,
      offset: fetchOffset,
      length: actualLength,
      hasMore,
      data: raw.toString('base64'),
      dataEncoding: 'base64'
    };
  }

  // Full download: decode transfer encoding
  const encoding = att.encoding.toLowerCase();
  let decoded;
  if (encoding === 'base64') {
    decoded = Buffer.from(raw.toString('ascii').replace(/\s/g, ''), 'base64');
  } else if (encoding === 'quoted-printable') {
    const qp = raw.toString('binary').replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    decoded = Buffer.from(qp, 'binary');
  } else {
    decoded = raw; // 7bit / 8bit / binary
  }

  return {
    uid,
    partId,
    filename: att.filename,
    mimeType: att.mimeType,
    size: decoded.length,
    encoding: att.encoding,
    data: decoded.toString('base64'),
    dataEncoding: 'base64'
  };
}

export async function flagEmail(uid, flagged, mailbox = 'INBOX') {
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

export async function markAsRead(uid, seen, mailbox = 'INBOX') {
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

export async function deleteEmail(uid, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  await client.messageDelete(uid, { uid: true });
  await client.logout();
  return true;
}

export async function listMailboxes() {
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

export async function searchEmails(query, mailbox = 'INBOX', limit = 10, filters = {}, options = {}) {
  const { queryMode = 'or', subjectQuery, bodyQuery, fromQuery, includeSnippet = false } = options;
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);

  // Build text query
  let textQuery;
  const targetedParts = [];
  if (subjectQuery) targetedParts.push({ subject: subjectQuery });
  if (bodyQuery) targetedParts.push({ body: bodyQuery });
  if (fromQuery) targetedParts.push({ from: fromQuery });

  if (targetedParts.length > 0) {
    // Targeted field queries
    if (queryMode === 'and') {
      textQuery = Object.assign({}, ...targetedParts); // IMAP AND is implicit
    } else {
      textQuery = targetedParts.length === 1 ? targetedParts[0] : { or: targetedParts };
    }
  } else if (query) {
    // Original OR across subject/from/body
    textQuery = { or: [{ subject: query }, { from: query }, { body: query }] };
  } else {
    textQuery = null;
  }

  const extraQuery = buildQuery(filters);
  const hasExtra = Object.keys(extraQuery).length > 0 && !extraQuery.all;
  const finalQuery = textQuery
    ? (hasExtra ? { ...textQuery, ...extraQuery } : textQuery)
    : (hasExtra ? extraQuery : { all: true });

  let uids = (await client.search(finalQuery, { uid: true })) ?? [];
  if (!Array.isArray(uids)) uids = [];

  if (filters.hasAttachment) {
    if (uids.length > ATTACHMENT_SCAN_LIMIT) {
      await client.logout();
      return { total: null, showing: 0, emails: [], error: `hasAttachment requires narrower filters first — ${uids.length} candidates exceeds scan limit of ${ATTACHMENT_SCAN_LIMIT}. Add from/since/before/subject filters to reduce the set.` };
    }
    uids = await filterUidsByAttachment(client, uids);
  }

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

  // Fetch body snippets if requested (max 10 emails to avoid timeout)
  if (includeSnippet && emails.length > 0) {
    for (const email of emails.slice(0, 10)) {
      try {
        const meta = await client.fetchOne(email.uid, { bodyStructure: true }, { uid: true });
        if (!meta?.bodyStructure) continue;
        const textPart = findTextPart(meta.bodyStructure);
        if (!textPart) continue;
        const imapKey = textPart.partId ?? 'TEXT';
        const partMsg = await client.fetchOne(email.uid, {
          bodyParts: [{ key: imapKey, start: 0, maxLength: 400 }]
        }, { uid: true });
        const buf = partMsg?.bodyParts?.get(imapKey)
          ?? partMsg?.bodyParts?.get(imapKey.toUpperCase())
          ?? partMsg?.bodyParts?.get(imapKey.toLowerCase());
        if (!buf) continue;
        const decoded = decodeTransferEncoding(buf, textPart.encoding);
        let text = await decodeCharset(decoded, textPart.charset);
        if (textPart.type === 'text/html') text = stripHtml(text);
        email.snippet = text.replace(/\s+/g, ' ').slice(0, 200).trim();
      } catch { /* skip snippet on error */ }
    }
  }

  await client.logout();
  return { total: uids.length, showing: emails.length, emails };
}

export async function moveEmail(uid, targetMailbox, sourceMailbox = 'INBOX') {
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
  // hasAttachment is handled as a client-side post-filter (see filterUidsByAttachment)
  // iCloud does not support SEARCH HEADER or reliable size-based attachment detection
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

async function filterUidsByAttachment(client, uids) {
  if (uids.length === 0) return [];
  const result = [];
  for await (const msg of client.fetch(uids, { bodyStructure: true }, { uid: true })) {
    if (msg.bodyStructure && findAttachments(msg.bodyStructure).length > 0) {
      result.push(msg.uid);
    }
  }
  return result;
}

async function ensureMailbox(name) {
  const client = createRateLimitedClient();
  await client.connect();
  try { await client.mailboxCreate(name); } catch { /* already exists */ }
  await client.logout();
}

export async function bulkMove(filters, targetMailbox, sourceMailbox = 'INBOX', dryRun = false, limit = null) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  const query = buildQuery(filters);
  let uids = (await client.search(query, { uid: true })) ?? [];
  if (filters.hasAttachment) {
    if (uids.length > ATTACHMENT_SCAN_LIMIT) {
      await client.logout();
      return { error: `hasAttachment requires narrower filters first — ${uids.length} candidates exceeds scan limit of ${ATTACHMENT_SCAN_LIMIT}.` };
    }
    uids = await filterUidsByAttachment(client, uids);
  }
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

export async function bulkDelete(filters, sourceMailbox = 'INBOX', dryRun = false) {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(sourceMailbox);
  const query = buildQuery(filters);
  let uids = (await client.search(query, { uid: true })) ?? [];
  if (filters.hasAttachment) {
    if (uids.length > ATTACHMENT_SCAN_LIMIT) {
      await client.logout();
      return { error: `hasAttachment requires narrower filters first — ${uids.length} candidates exceeds scan limit of ${ATTACHMENT_SCAN_LIMIT}.` };
    }
    uids = await filterUidsByAttachment(client, uids);
  }

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

export async function countEmails(filters, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const query = buildQuery(filters);
  let uids = (await client.search(query, { uid: true })) ?? [];
  if (filters.hasAttachment) {
    if (uids.length > ATTACHMENT_SCAN_LIMIT) {
      await client.logout();
      return { count: null, candidateCount: uids.length, mailbox, filters, error: `hasAttachment requires narrower filters first — ${uids.length} candidates exceeds scan limit of ${ATTACHMENT_SCAN_LIMIT}. Add from/since/before/subject filters to reduce the set.` };
    }
    uids = await filterUidsByAttachment(client, uids);
  }
  await client.logout();
  return { count: uids.length, mailbox, filters };
}

// ─── Saved Rules ─────────────────────────────────────────────────────────────

function readRules() {
  if (!existsSync(RULES_FILE)) return { rules: [] };
  try { return JSON.parse(readFileSync(RULES_FILE, 'utf8')); }
  catch { return { rules: [] }; }
}

function writeRules(data) {
  writeFileSync(RULES_FILE, JSON.stringify(data, null, 2));
}

export function createRule(name, filters, action, description = '') {
  const data = readRules();
  if (data.rules.find(r => r.name === name)) {
    throw new Error(`Rule '${name}' already exists. Delete it first to update it.`);
  }
  const validActions = ['move', 'delete', 'mark_read', 'mark_unread', 'flag', 'unflag'];
  if (!validActions.includes(action.type)) {
    throw new Error(`Invalid action type '${action.type}'. Must be one of: ${validActions.join(', ')}`);
  }
  if (action.type === 'move' && !action.targetMailbox) {
    throw new Error(`Action type 'move' requires targetMailbox`);
  }
  const rule = {
    name,
    description,
    filters,
    action,
    createdAt: new Date().toISOString(),
    lastRun: null,
    runCount: 0,
  };
  data.rules.push(rule);
  writeRules(data);
  return rule;
}

export function listRules() {
  return { rules: readRules().rules };
}

export function deleteRule(name) {
  const data = readRules();
  const idx = data.rules.findIndex(r => r.name === name);
  if (idx === -1) throw new Error(`Rule '${name}' not found.`);
  data.rules.splice(idx, 1);
  writeRules(data);
  return { deleted: true, name };
}

async function bulkMarkByFilters(filters, read, mailbox = 'INBOX') {
  const client = createRateLimitedClient();
  await client.connect();
  await client.mailboxOpen(mailbox);
  const base = buildQuery(filters);
  const query = { ...base, ...(read ? { seen: false } : { seen: true }) };
  const uids = (await client.search(query, { uid: true })) ?? [];
  if (uids.length === 0) { await client.logout(); return { marked: 0 }; }
  if (read) {
    await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
  } else {
    await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
  }
  await client.logout();
  return { marked: uids.length };
}

async function executeRule(rule, dryRun = false) {
  const { filters, action } = rule;
  const sourceMailbox = action.sourceMailbox || 'INBOX';
  switch (action.type) {
    case 'move':
      return bulkMove(filters, action.targetMailbox, sourceMailbox, dryRun);
    case 'delete':
      return bulkDelete(filters, sourceMailbox, dryRun);
    case 'mark_read': {
      if (dryRun) {
        const { count } = await countEmails(filters, sourceMailbox);
        return { dryRun: true, wouldAffect: count ?? 0 };
      }
      return bulkMarkByFilters(filters, true, sourceMailbox);
    }
    case 'mark_unread': {
      if (dryRun) {
        const { count } = await countEmails(filters, sourceMailbox);
        return { dryRun: true, wouldAffect: count ?? 0 };
      }
      return bulkMarkByFilters(filters, false, sourceMailbox);
    }
    case 'flag': {
      if (dryRun) {
        const { count } = await countEmails(filters, sourceMailbox);
        return { dryRun: true, wouldAffect: count ?? 0 };
      }
      return bulkFlag(filters, true, sourceMailbox);
    }
    case 'unflag': {
      if (dryRun) {
        const { count } = await countEmails(filters, sourceMailbox);
        return { dryRun: true, wouldAffect: count ?? 0 };
      }
      return bulkFlag(filters, false, sourceMailbox);
    }
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

export async function runRule(name, dryRun = false) {
  const data = readRules();
  const rule = data.rules.find(r => r.name === name);
  if (!rule) throw new Error(`Rule '${name}' not found.`);
  const result = await executeRule(rule, dryRun);
  if (!dryRun) {
    rule.lastRun = new Date().toISOString();
    rule.runCount = (rule.runCount || 0) + 1;
    writeRules(data);
  }
  return { rule: name, action: rule.action.type, ...result };
}

export async function runAllRules(dryRun = false) {
  const data = readRules();
  if (data.rules.length === 0) return { results: [], ran: 0 };
  const results = [];
  for (const rule of data.rules) {
    const result = await executeRule(rule, dryRun);
    if (!dryRun) {
      rule.lastRun = new Date().toISOString();
      rule.runCount = (rule.runCount || 0) + 1;
    }
    results.push({ rule: rule.name, action: rule.action.type, ...result });
  }
  if (!dryRun) writeRules(data);
  return { results, ran: data.rules.length };
}
