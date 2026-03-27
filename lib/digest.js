// ─── Digest State ─────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DIGEST_FILE = join(homedir(), '.icloud-mcp-digest.json');

const DEFAULT_STATE = {
  lastRun: null,
  processedUids: [],
  pendingActions: [],
  skipCounts: {},
  dismissedReminders: [],
  seenReminders: []
};

function readDigest() {
  if (!existsSync(DIGEST_FILE)) return { ...DEFAULT_STATE };
  try { return JSON.parse(readFileSync(DIGEST_FILE, 'utf8')); }
  catch { return { ...DEFAULT_STATE }; }
}

function writeDigest(data) {
  writeFileSync(DIGEST_FILE, JSON.stringify(data, null, 2));
}

export function getDigestState() {
  return readDigest();
}

export function updateDigestState({ processedUids, lastRun, pendingActions, skipCounts, dismissedReminders, seenReminders } = {}) {
  const state = readDigest();
  if (lastRun !== undefined) state.lastRun = lastRun;
  if (processedUids !== undefined) {
    // Merge with existing, deduplicate, cap at 5000 to prevent unbounded growth
    const merged = [...new Set([...state.processedUids, ...processedUids])];
    state.processedUids = merged.slice(-5000);
  }
  if (pendingActions !== undefined) state.pendingActions = pendingActions;
  if (skipCounts !== undefined) {
    // Accumulate skip counts per sender for smart unsubscribe
    for (const [sender, count] of Object.entries(skipCounts)) {
      state.skipCounts[sender] = (state.skipCounts[sender] || 0) + count;
    }
  }
  if (dismissedReminders !== undefined) {
    // Replace, prune entries older than 30 days, cap at 500
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    state.dismissedReminders = dismissedReminders
      .filter(r => !r.dismissedAt || new Date(r.dismissedAt).getTime() > cutoff)
      .slice(-500);
  }
  if (seenReminders !== undefined) {
    // Replace wholesale — snapshot of current "claude" list, no accumulation
    state.seenReminders = seenReminders;
  }
  writeDigest(state);
  return state;
}
