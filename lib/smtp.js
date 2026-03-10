import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

const SMTP_HOST = 'smtp.mail.me.com';
const SMTP_PORT = 587;

function getCredentials() {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;
  if (!user || !pass) throw new Error('IMAP_USER and IMAP_PASSWORD are required for SMTP operations');
  return { user, pass };
}

function createTransport() {
  const { user, pass } = getCredentials();
  return nodemailer.createTransport({
    host: SMTP_HOST,
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

export async function composeEmail(to, subject, body, opts = {}) {
  const { user } = getCredentials();
  const transport = createTransport();
  const mailOptions = { from: user, to: normalizeAddresses(to), subject };
  applyBody(mailOptions, body, opts.html);
  if (opts.cc)      mailOptions.cc      = normalizeAddresses(opts.cc);
  if (opts.bcc)     mailOptions.bcc     = normalizeAddresses(opts.bcc);
  if (opts.replyTo) mailOptions.replyTo = opts.replyTo;

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

export async function replyToEmail(email, body, opts = {}) {
  const { user } = getCredentials();
  const transport = createTransport();

  const originalSubject   = email.subject ?? '';
  const originalMessageId = email.headers?.messageId ?? null;
  const originalFrom      = email.from ?? '';
  const originalReplyTo   = email.headers?.replyTo ?? null;
  const existingRefs      = email.headers?.references ?? [];

  const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;

  // Build RFC 2822 References chain: existing refs + original message-id
  const references = [...existingRefs, ...(originalMessageId ? [originalMessageId] : [])]
    .filter(Boolean)
    .join(' ');

  // Who to reply to: prefer Reply-To over From
  const replyTarget = originalReplyTo ?? originalFrom;

  let toAddresses;
  if (opts.replyAll) {
    const originalTo = email.headers?.to  ?? [];
    const originalCc = email.headers?.cc  ?? [];
    // Reply-all: reply target + original To/Cc, excluding ourselves
    toAddresses = [replyTarget, ...originalTo, ...originalCc]
      .filter(a => a && a !== user);
  } else {
    toAddresses = [replyTarget].filter(Boolean);
  }

  const mailOptions = {
    from: user,
    to: toAddresses.join(', '),
    subject,
    inReplyTo: originalMessageId,
    references,
  };
  applyBody(mailOptions, body, opts.html);
  if (opts.cc) mailOptions.cc = normalizeAddresses(opts.cc);

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

export async function forwardEmail(email, to, note = '', opts = {}) {
  const { user } = getCredentials();
  const transport = createTransport();

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

  const info = await transport.sendMail(mailOptions);
  return {
    sent: true,
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
  };
}

// ─── save_draft ───────────────────────────────────────────────────────────────
// Builds the raw MIME message without sending, then APPENDs to Drafts via IMAP.

export async function saveDraft(to, subject, body, opts = {}) {
  const { user, pass } = getCredentials();

  const mailOptions = { from: user, to: normalizeAddresses(to), subject };
  applyBody(mailOptions, body, opts.html);
  if (opts.cc)  mailOptions.cc  = normalizeAddresses(opts.cc);
  if (opts.bcc) mailOptions.bcc = normalizeAddresses(opts.bcc);

  // Use nodemailer stream transport to produce raw MIME bytes without sending
  const streamTransport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const { message: rawMessage } = await streamTransport.sendMail(mailOptions);

  // APPEND the raw message to the Drafts folder via IMAP
  const client = new ImapFlow({
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });

  await client.connect();

  let draftMailbox = 'Drafts';
  try {
    await client.append(draftMailbox, rawMessage, ['\\Draft', '\\Seen']);
  } catch (err) {
    // Folder might have a different name — scan the list for the \Drafts attribute
    if (err.message?.includes('NONEXISTENT') || err.message?.includes('does not exist') || err.message?.includes('NO ')) {
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
