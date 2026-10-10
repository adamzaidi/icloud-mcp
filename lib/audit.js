// Append-only local audit log. One JSON object per line.
// The line has a fixed set of fields. Result keys are never copied, so an
// address used as a key cannot leak into the file.
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dataFile } from './data-paths.js';

export const AUDIT_FILE_MODE = 0o600;
export const AUDIT_DIR_MODE = 0o700;
export const DEFAULT_AUDIT_MAX_BYTES = 1024 * 1024;
export const AUDIT_ROTATIONS = 3;

// Only these result fields may contribute the integer count, and only as a
// value. The logged object never uses a key taken from the result.
const COUNT_FIELDS = Object.freeze([
  'total',
  'count',
  'length',
  'unread',
  'recent',
  'wouldDelete',
  'wouldMove',
  'wouldUpdate',
  'wouldCreate',
  'deleted',
  'moved',
  'updated',
  'created',
  'matched',
]);

const LOG_FIELDS = Object.freeze(['ts', 'tool', 'status', 'durationMs', 'count']);

export function integerCount(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;
  for (const key of COUNT_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (typeof item === 'number' && Number.isFinite(item)) return Math.max(0, Math.trunc(item));
    if (Array.isArray(item)) return item.length;
  }
  return 0;
}

export function auditLogPath(env = process.env) {
  const override = String(env.ICLOUD_MCP_AUDIT_LOG ?? '').trim();
  if (override) return override;
  if (env === process.env) return dataFile('.icloud-mcp-audit.log');
  return join(env.ICLOUD_MCP_DATA_DIR || homedir(), '.icloud-mcp-audit.log');
}

export function auditMaxBytes(env = process.env) {
  const raw = String(env.ICLOUD_MCP_AUDIT_LOG_MAX_BYTES ?? '').trim();
  if (!raw) return DEFAULT_AUDIT_MAX_BYTES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_AUDIT_MAX_BYTES;
  return Math.floor(value);
}

function enforceModes(file) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: AUDIT_DIR_MODE });
  chmodSync(dir, AUDIT_DIR_MODE);
  const fd = openSync(file, 'a', AUDIT_FILE_MODE);
  closeSync(fd);
  chmodSync(file, AUDIT_FILE_MODE);
}

function rotate(file) {
  rmSync(`${file}.${AUDIT_ROTATIONS}`, { force: true });
  for (let generation = AUDIT_ROTATIONS - 1; generation >= 1; generation -= 1) {
    const from = `${file}.${generation}`;
    const to = `${file}.${generation + 1}`;
    try {
      renameSync(from, to);
      chmodSync(to, AUDIT_FILE_MODE);
    } catch {
      // That generation does not exist yet.
    }
  }
  try {
    renameSync(file, `${file}.1`);
    chmodSync(`${file}.1`, AUDIT_FILE_MODE);
  } catch {
    // Nothing to rotate.
  }
}

function appendLine(file, line, maxBytes) {
  enforceModes(file);
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  if (size >= maxBytes) {
    rotate(file);
    enforceModes(file);
  }
  appendFileSync(file, line, { encoding: 'utf8', flag: 'a', mode: AUDIT_FILE_MODE });
  chmodSync(file, AUDIT_FILE_MODE);
}

// Failure is swallowed. A write error must not fail the tool, and the
// message from the filesystem can echo the path.
export function recordAudit(entry, env = process.env) {
  try {
    const line = {
      ts: new Date().toISOString(),
      tool: String(entry?.tool ?? ''),
      status: entry?.status === 'error' ? 'error' : 'ok',
      durationMs: Math.max(0, Math.round(Number(entry?.durationMs) || 0)),
      count: integerCount(entry?.result),
    };
    for (const key of Object.keys(line)) {
      if (!LOG_FIELDS.includes(key)) delete line[key];
    }
    appendLine(auditLogPath(env), `${JSON.stringify(line)}\n`, auditMaxBytes(env));
  } catch {
    // Leave the tool result alone.
  }
}
