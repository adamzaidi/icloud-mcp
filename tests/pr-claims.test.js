// Offline checks for the claims in PR #2's description that aren't about a single
// tool's dry-run behavior: tool descriptions are impersonal, .gitignore covers
// the personal and local-state files it lists, nothing it ignores is tracked,
// every tool that removes or bulk-changes data takes dryRun, and CI runs the
// suite without credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const { mailTools } = await import('../lib/tools/mail.js');
const { contactTools } = await import('../lib/tools/contacts.js');
const { calendarTools, suggestEventTools } = await import('../lib/tools/calendar.js');
const { reminderTools } = await import('../lib/tools/reminders.js');
const tools = [...mailTools, ...contactTools, ...calendarTools, ...reminderTools, ...suggestEventTools];

const git = (...args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' });

test('tool names are unique', () => {
  const names = tools.map((t) => t.name);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
});

test('tool descriptions name no real person or personal mailbox', () => {
  const text = JSON.stringify(tools);
  // Real-provider addresses; the README/test placeholders use example domains
  // or the documented you@icloud.com.
  const addresses = (text.match(/[\w.+-]+@(?:icloud|me|mac|gmail|outlook|hotmail|yahoo)\.com|[\w.+-]+@[\w-]+\.edu/gi) || [])
    .filter((a) => a.toLowerCase() !== 'you@icloud.com');
  assert.deepEqual(addresses, []);
  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  for (const part of String(pkg.author || '').split(/\s+/).filter((p) => p.length > 2)) {
    assert.ok(!new RegExp(`\\b${part}\\b`, 'i').test(text), `tool schema mentions "${part}"`);
  }
});

test('every tool that removes, moves, or bulk-changes data takes dryRun', () => {
  // get_move_status and abandon_move only read or clear the local move log.
  const logOnly = new Set(['get_move_status', 'abandon_move']);
  const risky = tools.filter((t) => !logOnly.has(t.name) && /delete|move|archive|empty|^bulk_|^run_|older_than|rename_reminder_list/.test(t.name));
  const missing = risky.filter((t) => t.inputSchema.properties?.dryRun?.type !== 'boolean').map((t) => t.name);
  assert.deepEqual(missing, []);
});

test('.gitignore covers the files the PR says it covers', () => {
  const samples = [
    '.env', '.env.local', '.mcp.json', 'start-with-env.sh',
    'contacts/export.vcf', 'people.vcf', 'csv/contacts.csv', 'exports/a.json', 'crm/people.json',
    'cache/x.json', 'data/x.json', 'logs/run.log', 'digest-output/today.md', 'x.digest.json',
    'SOME_PLAN.md', 'OBSIDIAN_PLAN.md', 'CLAUDE.md', '.claude/settings.json',
    'lsat/notes.md', 'mathnasium/notes.md', 'digest-runner.mjs', 'probe-carddav.js',
  ];
  const notIgnored = samples.filter((p) => {
    try { git('check-ignore', '-q', '--no-index', p); return false; } catch { return true; }
  });
  assert.deepEqual(notIgnored, []);
});

test('nothing .gitignore excludes is still tracked', () => {
  assert.equal(git('ls-files', '-ci', '--exclude-standard').trim(), '');
});

test('the old credential file is not in the tree', () => {
  assert.ok(!git('ls-files').split('\n').includes('digest-runner.mjs'));
});

test('CI runs npm test with credentials blanked', () => {
  const ci = readFileSync(join(projectDir, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /run: npm test/);
  assert.match(ci, /IMAP_USER: ''/);
  assert.match(ci, /IMAP_PASSWORD: ''/);
});
