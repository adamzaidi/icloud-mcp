// ─── Session Log ──────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dataFile } from './data-paths.js';

function logFile() {
  return dataFile('.icloud-mcp-session.json');
}

export function logRead() {
  const file = logFile();
  if (!existsSync(file)) return { steps: [], startedAt: null };
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { steps: [], startedAt: null };
  }
}

export function logWrite(step) {
  const log = logRead();
  if (!log.startedAt) log.startedAt = new Date().toISOString();
  log.steps.push({ time: new Date().toISOString(), step });
  writeFileSync(logFile(), JSON.stringify(log, null, 2));
  return log;
}

export function logClear() {
  writeFileSync(logFile(), JSON.stringify({ steps: [], startedAt: null }, null, 2));
  return { cleared: true };
}
