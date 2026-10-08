// Hard stop for tests/test.js. Outbound mail may go only to the account under test.
import { normalizeMailboxAddress, planReplyAddresses } from '../lib/smtp.js';

export function normalizeAddress(value) {
  return normalizeMailboxAddress(value);
}

function listAddresses(value) {
  if (value == null || value === '') return [];
  const parts = Array.isArray(value) ? value : String(value).split(',');
  return parts.map((part) => normalizeAddress(part)).filter(Boolean);
}

function expandRecipients(recipients) {
  if (Array.isArray(recipients)) return recipients.flatMap((part) => listAddresses(part));
  if (recipients && typeof recipients === 'object') {
    return ['to', 'cc', 'bcc'].flatMap((key) => listAddresses(recipients[key]));
  }
  return listAddresses(recipients);
}

// Throws when any To/Cc/Bcc address is not the tested account. Empty is also a refusal.
export function assertSelfOnlyRecipients(recipients, account) {
  const allowed = normalizeAddress(account);
  if (!allowed || !allowed.includes('@')) {
    throw new Error('Refusing to send: the tested account is not set');
  }
  const list = expandRecipients(recipients);
  if (list.length === 0) {
    throw new Error('Refusing to send: no recipients');
  }
  if (list.some((addr) => addr !== allowed)) {
    throw new Error('Refusing to email anyone but the tested account');
  }
  return list;
}

// Reply and reply-all may proceed only when every party on the message is the tested account.
// Reply-all to a message that includes anyone else throws before a send is attempted.
export function assertReplyStaysWithAccount(email, account, { replyAll = false, cc, bcc } = {}) {
  const allowed = normalizeAddress(account);
  if (replyAll) {
    const involved = [
      email?.from,
      email?.headers?.replyTo,
      ...(email?.headers?.to || []),
      ...(email?.headers?.cc || []),
    ].flatMap((part) => listAddresses(part));
    if (involved.length === 0 || involved.some((addr) => addr !== allowed)) {
      throw new Error('Refusing reply-all: the message includes recipients other than the tested account');
    }
  }
  const planned = planReplyAddresses(email, account, replyAll);
  assertSelfOnlyRecipients({ to: planned, cc, bcc }, account);
  return planned;
}
