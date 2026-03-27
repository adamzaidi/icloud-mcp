// ─── lib/reminders.js — iCloud Reminders via JXA (JavaScript for Automation) ──
//
// Uses `osascript -l JavaScript` to talk directly to Reminders.app, bypassing
// the broken CalDAV VTODO endpoint (Apple moved modern Reminders to CloudKit,
// which is not exposed via standard CalDAV).
//
// PERMISSION: The first time Node.js calls osascript on Reminders, macOS will
// show an Automation permission dialog. Run `node -e "require('./lib/reminders.js')"
// manually once to grant permission, then it persists for headless digest runs.

import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const PRIORITY_FROM_JXA = { 0: 'none', 1: 'high', 2: 'high', 3: 'high', 4: 'high', 5: 'medium', 6: 'low', 7: 'low', 8: 'low', 9: 'low' };
const PRIORITY_TO_JXA   = { none: 0, high: 1, medium: 5, low: 9 };

// ─── JXA runner ───────────────────────────────────────────────────────────────

function runJxa(script) {
  const tmpFile = join(tmpdir(), `jxa-${randomUUID()}.js`);
  writeFileSync(tmpFile, script, 'utf8');
  try {
    const output = execFileSync('osascript', ['-l', 'JavaScript', tmpFile], {
      timeout: 30_000,
      encoding: 'utf8',
    });
    return output.trim();
  } catch (err) {
    const stderr = (err.stderr || '').toString();
    if (stderr.includes('not allowed') || stderr.includes('Authorization') || stderr.includes('assistive access')) {
      throw new Error(
        'Reminders access not authorized. Run this once in Terminal to grant permission:\n' +
        '  osascript -l JavaScript -e \'Application("Reminders").lists.length\'\n' +
        'Then click Allow in the dialog.'
      );
    }
    const msg = stderr.replace(/\n/g, ' ').trim() || err.message;
    throw new Error(`JXA error: ${msg}`);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// Shared helper embedded in JXA scripts — finds a reminder within a list by ID.
const JXA_FIND_HELPER = `
function findReminder(list, id) {
  const all = list.reminders();
  for (let i = 0; i < all.length; i++) {
    if (all[i].id() === id) return all[i];
  }
  throw new Error('Reminder not found: ' + id);
}
`;

// ─── Public API ───────────────────────────────────────────────────────────────

export function listReminderLists() {
  const result = runJxa(`
    const app = Application('Reminders');
    const lists = app.lists().map(l => ({
      id: l.id(),
      name: l.name(),
      count: l.reminders.length,
    }));
    JSON.stringify({ lists, count: lists.length });
  `);
  return JSON.parse(result);
}

export function listReminders(listName = null, includeCompleted = false, limit = 50) {
  const result = runJxa(`
    const app = Application('Reminders');
    const listName = ${JSON.stringify(listName)};
    const includeCompleted = ${JSON.stringify(includeCompleted)};
    const limit = ${JSON.stringify(limit)};
    const priorityMap = ${JSON.stringify(PRIORITY_FROM_JXA)};

    const lists = listName ? [app.lists.byName(listName)] : app.lists();
    const reminders = [];

    for (const list of lists) {
      for (const r of list.reminders()) {
        if (!includeCompleted && r.completed()) continue;
        reminders.push({
          id: r.id(),
          title: r.name(),
          notes: r.body() || null,
          completed: r.completed(),
          due: r.dueDate() ? r.dueDate().toISOString() : null,
          completedAt: r.completionDate() ? r.completionDate().toISOString() : null,
          priority: priorityMap[String(r.priority())] || 'none',
          listName: list.name(),
          listId: list.id(),
          createdAt: r.creationDate() ? r.creationDate().toISOString() : null,
          modifiedAt: r.modificationDate() ? r.modificationDate().toISOString() : null,
        });
        if (reminders.length >= limit) break;
      }
      if (reminders.length >= limit) break;
    }

    JSON.stringify({ reminders, count: reminders.length, listName, includeCompleted });
  `);
  return JSON.parse(result);
}

export function getReminder(listName, reminderId) {
  const result = runJxa(`
    ${JXA_FIND_HELPER}
    const app = Application('Reminders');
    const list = app.lists.byName(${JSON.stringify(listName)});
    const r = findReminder(list, ${JSON.stringify(reminderId)});
    const priorityMap = ${JSON.stringify(PRIORITY_FROM_JXA)};
    JSON.stringify({
      id: r.id(),
      title: r.name(),
      notes: r.body() || null,
      completed: r.completed(),
      due: r.dueDate() ? r.dueDate().toISOString() : null,
      completedAt: r.completionDate() ? r.completionDate().toISOString() : null,
      priority: priorityMap[String(r.priority())] || 'none',
      listName: list.name(),
      listId: list.id(),
      createdAt: r.creationDate() ? r.creationDate().toISOString() : null,
      modifiedAt: r.modificationDate() ? r.modificationDate().toISOString() : null,
    });
  `);
  return JSON.parse(result);
}

export function createReminder(listName, fields) {
  const priorityVal = PRIORITY_TO_JXA[fields.priority] ?? 0;
  const result = runJxa(`
    const app = Application('Reminders');
    const list = app.lists.byName(${JSON.stringify(listName)});
    const props = { name: ${JSON.stringify(fields.title || '(No title)')} };
    ${fields.notes !== undefined ? `props.body = ${JSON.stringify(fields.notes)};` : ''}
    ${fields.due !== undefined ? `props.dueDate = new Date(${JSON.stringify(fields.due)});` : ''}
    ${priorityVal ? `props.priority = ${priorityVal};` : ''}
    const r = app.make({ new: 'reminder', at: list, withProperties: props });
    JSON.stringify({ created: true, id: r.id(), listName: list.name() });
  `);
  return JSON.parse(result);
}

export function updateReminder(listName, reminderId, fields) {
  const priorityVal = fields.priority !== undefined ? (PRIORITY_TO_JXA[fields.priority] ?? 0) : null;
  const result = runJxa(`
    ${JXA_FIND_HELPER}
    const app = Application('Reminders');
    const list = app.lists.byName(${JSON.stringify(listName)});
    const r = findReminder(list, ${JSON.stringify(reminderId)});
    ${fields.title !== undefined ? `r.name = ${JSON.stringify(fields.title)};` : ''}
    ${fields.notes !== undefined ? `r.body = ${JSON.stringify(fields.notes)};` : ''}
    ${fields.due !== undefined ? `r.dueDate = new Date(${JSON.stringify(fields.due)});` : ''}
    ${priorityVal !== null ? `r.priority = ${priorityVal};` : ''}
    JSON.stringify({ updated: true, id: r.id() });
  `);
  return JSON.parse(result);
}

export function completeReminder(listName, reminderId) {
  const result = runJxa(`
    ${JXA_FIND_HELPER}
    const app = Application('Reminders');
    const list = app.lists.byName(${JSON.stringify(listName)});
    const r = findReminder(list, ${JSON.stringify(reminderId)});
    r.completed = true;
    JSON.stringify({ updated: true, id: r.id(), completed: true });
  `);
  return JSON.parse(result);
}

export function deleteReminder(listName, reminderId) {
  const result = runJxa(`
    ${JXA_FIND_HELPER}
    const app = Application('Reminders');
    const list = app.lists.byName(${JSON.stringify(listName)});
    const r = findReminder(list, ${JSON.stringify(reminderId)});
    app.delete(r);
    JSON.stringify({ deleted: true, id: ${JSON.stringify(reminderId)} });
  `);
  return JSON.parse(result);
}
