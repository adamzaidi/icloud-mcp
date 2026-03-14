#!/usr/bin/env node
// ─── Inbox Intelligence — Digest Status Helper ────────────────────────────────
// Shows current digest state and what's pending. Not the runner itself —
// Claude Code is the runner. Use this to inspect state or reset it.
//
// Usage:
//   node run-digest.js            → show current state
//   node run-digest.js --reset    → clear all processed UIDs and state

import { getDigestState, updateDigestState } from './lib/digest.js';

const args = process.argv.slice(2);

if (args.includes('--reset')) {
  updateDigestState({
    lastRun: null,
    processedUids: [],
    pendingActions: [],
    skipCounts: {}
  });
  // Force full reset by re-reading and overwriting
  const { writeFileSync } = await import('fs');
  const { homedir } = await import('os');
  const { join } = await import('path');
  writeFileSync(
    join(homedir(), '.icloud-mcp-digest.json'),
    JSON.stringify({ lastRun: null, processedUids: [], pendingActions: [], skipCounts: {} }, null, 2)
  );
  console.log('✓ Digest state reset.');
  process.exit(0);
}

const state = getDigestState();

console.log('\n── Digest State ──────────────────────────────────────────');
console.log(`Last run:          ${state.lastRun ? new Date(state.lastRun).toLocaleString() : 'never'}`);
console.log(`Processed UIDs:    ${state.processedUids.length}`);
console.log(`Pending actions:   ${state.pendingActions.length}`);

if (state.pendingActions.length > 0) {
  for (const a of state.pendingActions) {
    console.log(`  • [${a.type}] ${a.subject}${a.dueDate ? ' — due ' + a.dueDate : ''}`);
  }
}

const candidates = Object.entries(state.skipCounts)
  .filter(([, c]) => c >= 3)
  .sort((a, b) => b[1] - a[1]);

if (candidates.length > 0) {
  console.log(`\nUnsubscribe candidates (skipped 3+ times):`);
  for (const [sender, count] of candidates) {
    console.log(`  • ${sender} (${count}×)`);
  }
}

console.log('──────────────────────────────────────────────────────────\n');
