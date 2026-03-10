// ─── Session Log ──────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOG_FILE = join(homedir(), '.icloud-mcp-session.json');

export function logRead() {
  if (!existsSync(LOG_FILE)) return { steps: [], startedAt: null };
  try {
    return JSON.parse(readFileSync(LOG_FILE, 'utf8'));
  } catch {
    return { steps: [], startedAt: null };
  }
}

export function logWrite(step) {
  const log = logRead();
  if (!log.startedAt) log.startedAt = new Date().toISOString();
  log.steps.push({ time: new Date().toISOString(), step });
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  return log;
}

export function logClear() {
  writeFileSync(LOG_FILE, JSON.stringify({ steps: [], startedAt: null }, null, 2));
  return { cleared: true };
}
