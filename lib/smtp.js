import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

const SMTP_PORT = 587;

const SEND_MODES = ['off', 'drafts', 'self-only', 'on'];

// Test hooks. Production leaves both null and uses nodemailer / ImapFlow.
let smtpTransportFactory = null;
let draftImapClientFactory = null;

export function setSmtpTransportFactoryForTests(factory) {
  smtpTransportFactory = factory ?? null;
}

export function setDraftImapClientFactoryForTests(factory) {
  draftImapClientFactory = factory ?? null;
}

// ICLOUD_MCP_SEND_MODE: off | drafts | self-only | on.
// Unset or blank stays 'on' so local stdio keeps today's send behavior.
export function getSendMode(env = process.env) {
  const raw = env.ICLOUD_MCP_SEND_MODE;
  if (raw == null || String(raw).trim() === '') return 'on';
  const mode = String(raw).trim().toLowerCase();
  if (!SEND_MODES.includes(mode)) {
    throw new Error('ICLOUD_MCP_SEND_MODE must be one of: off, drafts, self-only, on');
  }
  return mode;
}

function blockIfSendDisabled() {
  if (getSendMode() === 'off') {
    throw new Error('Sending is disabled (ICLOUD_MCP_SEND_MODE=off). No message was sent.');
  }
}

// Split a comma-separated address list without breaking display names
// ("Last, First" <a@example.com> stays one address).
export function splitAddressList(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap((part) => splitAddressList(part));
  const parts = [];
  let current = '';
  let quote = false;
  let angle = false;
  for (const ch of String(value)) {
    if (ch === '"') quote = !quote;
    else if (ch === '<' && !quote) angle = true;
    else if (ch === '>' && !quote) angle = false;
    if (ch === ',' && !quote && !angle) {
      if (current.trim()) parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

export function recipientAddresses(mailOptions) {
  return ['to', 'cc', 'bcc']
    .flatMap((key) => splitAddressList(mailOptions?.[key]).map((part) => normalizeMailboxAddress(part)))
    .filter(Boolean);
}

// self-only: every To, Cc, and Bcc must be the authenticated account.
// Comparison ignores case, surrounding whitespace, and a display name.
// The error does not echo the foreign address.
export function assertSelfOnly(mailOptions, account) {
  const allowed = normalizeMailboxAddress(account);
  if (!allowed || !allowed.includes('@')) {
    throw new Error('Sending blocked (ICLOUD_MCP_SEND_MODE=self-only): the authenticated account is not an email address.');
  }
  const list = recipientAddresses(mailOptions);
  if (list.length === 0) {
    throw new Error('Sending blocked (ICLOUD_MCP_SEND_MODE=self-only): the message has no To, Cc, or Bcc recipients.');
  }
  if (list.some((addr) => addr !== allowed)) {
    throw new Error('Sending blocked (ICLOUD_MCP_SEND_MODE=self-only): every To, Cc, and Bcc address must be the authenticated account.');
  }
  return list;
}

function draftResult(saved, extra = {}) {
  return {
    sent: false,
    drafted: true,
    mailbox: saved.mailbox,
    to: saved.to,
    subject: saved.subject,
    ...extra,
  };
}

// creds = { user, pass, host (IMAP), smtpHost } — falls back to env vars / iCloud defaults
function getCredentials(creds) {
  const user = creds?.user || process.env.IMAP_USER;
  const pass = creds?.pass || process.env.IMAP_PASSWORD;
  if (!user || !pass) throw new Error('IMAP_USER and IMAP_PASSWORD are required for SMTP operations');
  return { user, pass, imapHost: creds?.host || 'imap.mail.me.com', smtpHost: creds?.smtpHost || 'smtp.mail.me.com' };
}

function createTransport(creds) {
  if (smtpTransportFactory) return smtpTransportFactory(creds);
  const { user, pass, smtpHost } = getCredentials(creds);
  return nodemailer.createTransport({
    host: smtpHost,
    port: SMTP_PORT,
    secure: false, // STARTTLS on port 587
    auth: { user, pass },
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

function normalizeAddresses(val) {
  if (!val) return undefined;
  return Array.isArray(val) ? val.join(', ') : val;
}

// Compare mailbox addresses ignoring case, surrounding whitespace, and a display name.
export function normalizeMailboxAddress(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const angled = text.match(/<([^>]+)>/);
  return (angled ? angled[1] : text).trim();
}

// Recipients replyToEmail will put in To.
// Reply-all drops the account when anyone else is on the message (same as before).
// A message whose only party is the account still replies to the account, so a
// self-seed is not sent with an empty To.
export function planReplyAddresses(email, account, replyAll = false) {
  const user = normalizeMailboxAddress(account);
  const replyTarget = email?.headers?.replyTo || email?.from || '';
  if (!replyAll) return replyTarget ? [replyTarget] : [];

  const parties = [replyTarget, ...(email?.headers?.to || []), ...(email?.headers?.cc || [])].filter(Boolean);
  const others = [];
  const seen = new Set();
  for (const party of parties) {
    const key = normalizeMailboxAddress(party);
    if (!key || key === user || seen.has(key)) continue;
    seen.add(key);
    others.push(party);
  }
  if (others.length === 0) return user ? [account] : [];
  return others;
}

// Convert HTML to a readable plain-text fallback for multipart/alternative
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function applyBody(mailOptions, body, html) {
  if (html && body) {
    // Both provided: multipart/alternative, clients choose which to render
    mailOptions.text = body;
    mailOptions.html = html;
  } else if (html) {
    // HTML only: auto-generate plain text fallback
    mailOptions.html = html;
    mailOptions.text = htmlToText(html);
  } else {
    mailOptions.text = body;
  }
}

// ─── compose_email ────────────────────────────────────────────────────────────

export async function composeEmail(to, subject, body, opts = {}, creds = null) {
  blockIfSendDisabled();
  const { user } = getCredentials(creds);
  const mailOptions = { from: user, to: normalizeAddresses(to), subject };
  applyBody(mailOptions, body, opts.html);
  if (opts.cc)      mailOptions.cc      = normalizeAddresses(opts.cc);
  if (opts.bcc)     mailOptions.bcc     = normalizeAddresses(opts.bcc);
  if (opts.replyTo) mailOptions.replyTo = opts.replyTo;

  const mode = getSendMode();
  if (mode === 'self-only') assertSelfOnly(mailOptions, user);
  if (mode === 'drafts') {
    const saved = await saveDraft(to, subject, body, opts, creds);
    return draftResult(saved);
  }

  const transport = createTransport(creds);
  const info = await transport.sendMail(mailOptions);
  return {
    sent: true,
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
  };
}

// ─── reply_to_email ───────────────────────────────────────────────────────────
// email = getEmailContent(uid, mailbox, maxChars, includeHeaders: true) result

export async function replyToEmail(email, body, opts = {}, creds = null) {
  blockIfSendDisabled();
  const { user } = getCredentials(creds);

  const originalSubject   = email.subject ?? '';
  const originalMessageId = email.headers?.messageId ?? null;
  const existingRefs      = email.headers?.references ?? [];

  const subject = /^(re|in re):\s/i.test(originalSubject) || /^(re|in re):\s/i.test(originalSubject.replace(/^\[EXTERNAL\]\s*/i, ''))
    ? originalSubject
    : `Re: ${originalSubject}`;

  // Build RFC 2822 References chain: existing refs + original message-id
  const references = [...existingRefs, ...(originalMessageId ? [originalMessageId] : [])]
    .filter(Boolean)
    .join(' ');

  // Prefer Reply-To over From. A self-only thread replies to the account.
  const toAddresses = planReplyAddresses(email, user, Boolean(opts.replyAll));

  const mailOptions = {
    from: user,
    to: toAddresses.join(', '),
    subject,
    inReplyTo: originalMessageId,
    references,
  };
  applyBody(mailOptions, body, opts.html);
  if (opts.cc) mailOptions.cc = normalizeAddresses(opts.cc);

  const mode = getSendMode();
  if (mode === 'self-only') assertSelfOnly(mailOptions, user);
  if (mode === 'drafts') {
    const saved = await saveDraft(toAddresses, subject, body, {
      html: opts.html,
      cc: opts.cc,
      inReplyTo: originalMessageId,
      references,
    }, creds);
    return draftResult(saved, { inReplyTo: originalMessageId });
  }

  const transport = createTransport(creds);
  const info = await transport.sendMail(mailOptions);
  return {
    sent: true,
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    inReplyTo: originalMessageId,
  };
}

// ─── forward_email ────────────────────────────────────────────────────────────
// email = getEmailContent result (no need for includeHeaders)

export async function forwardEmail(email, to, note = '', opts = {}, creds = null) {
  blockIfSendDisabled();
  const { user } = getCredentials(creds);

  const originalSubject = email.subject ?? '';
  const subject = /^fwd:/i.test(originalSubject) ? originalSubject : `Fwd: ${originalSubject}`;

  const forwardHeader = [
    '---------- Forwarded message ----------',
    `From: ${email.from ?? '(unknown)'}`,
    `Date: ${email.date ? new Date(email.date).toUTCString() : '(unknown)'}`,
    `Subject: ${originalSubject}`,
    '',
  ].join('\n');

  const forwardBody = note
    ? `${note}\n\n${forwardHeader}\n${email.body ?? ''}`
    : `${forwardHeader}\n${email.body ?? ''}`;

  const mailOptions = { from: user, to: normalizeAddresses(to), subject };
  applyBody(mailOptions, forwardBody, opts.html);
  if (opts.cc) mailOptions.cc = normalizeAddresses(opts.cc);

  const mode = getSendMode();
  if (mode === 'self-only') assertSelfOnly(mailOptions, user);
  if (mode === 'drafts') {
    const saved = await saveDraft(to, subject, forwardBody, { html: opts.html, cc: opts.cc }, creds);
    return draftResult(saved);
  }

  const transport = createTransport(creds);
  const info = await transport.sendMail(mailOptions);
  return {
    sent: true,
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
  };
}

// ImapFlow emits 'error' on socket timeouts. With no listener, Node treats it as
// an uncaught exception and the server exits.
export function attachImapErrorHandler(client) {
  client.on('error', (err) => {
    process.stderr.write(`[imap] connection error: ${err?.message ?? err}\n`);
  });
  return client;
}

// ─── save_draft ───────────────────────────────────────────────────────────────
// Builds the raw MIME message without sending, then APPENDs to Drafts via IMAP.

export async function saveDraft(to, subject, body, opts = {}, creds = null) {
  const { user, pass, imapHost } = getCredentials(creds);

  const mailOptions = { from: user, to: normalizeAddresses(to), subject };
  applyBody(mailOptions, body, opts.html);
  if (opts.cc)        mailOptions.cc        = normalizeAddresses(opts.cc);
  if (opts.bcc)       mailOptions.bcc       = normalizeAddresses(opts.bcc);
  if (opts.inReplyTo) mailOptions.inReplyTo = opts.inReplyTo;
  if (opts.references) mailOptions.references = Array.isArray(opts.references)
    ? opts.references.join(' ')
    : opts.references;

  // Use nodemailer stream transport to produce raw MIME bytes without sending
  const streamTransport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const { message: rawMessage } = await streamTransport.sendMail(mailOptions);

  // APPEND the raw message to the Drafts folder via IMAP. This does not send.
  const client = draftImapClientFactory
    ? draftImapClientFactory({ user, imapHost })
    : attachImapErrorHandler(new ImapFlow({
      host: imapHost,
      port: 993,
      secure: true,
      auth: { user, pass },
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    }));

  await client.connect();

  let draftMailbox = 'Drafts';
  try {
    await client.append(draftMailbox, rawMessage, ['\\Draft', '\\Seen']);
  } catch (err) {
    // Folder might have a different name — scan the list for the \Drafts attribute
    const r = err.responseText ?? err.message ?? '';
    if (r.includes('NONEXISTENT') || r.includes('does not exist') || r.includes("doesn't exist") || r.includes('TRYCREATE') || r.includes('NO ') || r.includes('Failure')) {
      const mailboxes = await client.list();
      const draftMb = mailboxes.find(mb => mb.flags?.has('\\Drafts'));
      draftMailbox = draftMb?.path ?? 'Drafts';
      await client.append(draftMailbox, rawMessage, ['\\Draft', '\\Seen']);
    } else {
      throw err;
    }
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }

  return { saved: true, mailbox: draftMailbox, to: mailOptions.to, subject };
}
