// Append-only local audit log. One JSON object per line.
// The line has a fixed set of fields. Result keys are never copied, so an
// address used as a key cannot leak into the file.
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

let warnedSharedDirectory = false;

export function resetAuditWarningsForTests() {
  warnedSharedDirectory = false;
}

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

export function stateRoot(env) {
  const dataDir = String(env.ICLOUD_MCP_DATA_DIR ?? '').trim();
  if (dataDir) return dataDir;
  if (env !== process.env) {
    const home = String(env.HOME ?? '').trim();
    if (home) return home;
  }
  return homedir();
}

export function auditLogPath(env = process.env) {
  const override = String(env.ICLOUD_MCP_AUDIT_LOG ?? '').trim();
  if (override) return override;
  return join(stateRoot(env), '.icloud-mcp', 'audit.log');
}

export function auditMaxBytes(env = process.env) {
  const raw = String(env.ICLOUD_MCP_AUDIT_LOG_MAX_BYTES ?? '').trim();
  if (!raw) return DEFAULT_AUDIT_MAX_BYTES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_AUDIT_MAX_BYTES;
  return Math.floor(value);
}

function warnIfShared(dir) {
  if (warnedSharedDirectory) return;
  let mode;
  try {
    mode = statSync(dir).mode & 0o777;
  } catch {
    return;
  }
  if ((mode & 0o022) === 0) return;
  warnedSharedDirectory = true;
  process.stderr.write('[audit] leaving an existing group or world writable directory unchanged\n');
}

// chmod 0700 only a directory this call created. A directory that already
// exists, including $HOME or a shared data directory, is left alone.
export function ensureDirectory(dir) {
  if (existsSync(dir)) {
    warnIfShared(dir);
    return;
  }
  const created = [];
  let current = dir;
  while (!existsSync(current)) {
    created.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (existsSync(current)) warnIfShared(current);
  for (const path of created.reverse()) {
    try {
      mkdirSync(path, { mode: AUDIT_DIR_MODE });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      warnIfShared(path);
      continue;
    }
    chmodSync(path, AUDIT_DIR_MODE);
  }
}

function enforceFile(file) {
  ensureDirectory(dirname(file));
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
  enforceFile(file);
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  if (size >= maxBytes) {
    rotate(file);
    enforceFile(file);
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
