// Append-only local audit log. One JSON object per line.
// Records the tool name, time, status, duration, and result counts.
// Never records arguments, error text, message bodies, subjects, or addresses.
import { appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { dataFile } from './data-paths.js';

const SENSITIVE_KEY = /subject|body|address|e-?mail|html|password|token|authorization|note/i;

export function isSensitiveKey(key) {
  const name = String(key);
  if (SENSITIVE_KEY.test(name)) return true;
  // Whole key or a delimited segment. A substring of "total" is not "to".
  return /(?:^|[^a-z0-9])(?:from|to|cc|bcc)(?:[^a-z0-9]|$)/i.test(name);
}

export function summarizeCounts(value) {
  if (Array.isArray(value)) return { length: value.length };
  if (!value || typeof value !== 'object') return {};
  const counts = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item)) counts[key] = item;
    else if (Array.isArray(item)) counts[key] = item.length;
  }
  return counts;
}

export function auditLogPath(env = process.env) {
  const override = String(env.ICLOUD_MCP_AUDIT_LOG ?? '').trim();
  if (override) return override;
  if (env === process.env) return dataFile('.icloud-mcp-audit.log');
  return join(env.ICLOUD_MCP_DATA_DIR || homedir(), '.icloud-mcp-audit.log');
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
      counts: summarizeCounts(entry?.result),
    };
    appendFileSync(auditLogPath(env), `${JSON.stringify(line)}\n`, { encoding: 'utf8', flag: 'a' });
  } catch {
    // Leave the tool result alone.
  }
}
