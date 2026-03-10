// ─── MIME parsing helpers ─────────────────────────────────────────────────────
// Pure functions — no IMAP, no side effects.

export function decodeTransferEncoding(buffer, encoding) {
  const enc = (encoding || '7bit').toLowerCase().trim();
  if (enc === 'base64') {
    return Buffer.from(buffer.toString('ascii').replace(/\s/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    const str = buffer.toString('binary')
      .replace(/[\t ]+$/gm, '')
      .replace(/=(?:\r?\n|$)/g, '');
    const result = Buffer.alloc(str.length);
    let pos = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '=' && i + 2 < str.length) {
        const hex = str.slice(i + 1, i + 3);
        if (/^[\da-fA-F]{2}$/.test(hex)) {
          result[pos++] = parseInt(hex, 16);
          i += 2;
          continue;
        }
      }
      result[pos++] = str.charCodeAt(i) & 0xff;
    }
    return result.slice(0, pos);
  }
  return buffer;
}

export async function decodeCharset(buffer, charset) {
  const cs = (charset || 'utf-8').toLowerCase().trim();
  const nativeMap = { 'utf-8': 'utf8', 'utf8': 'utf8', 'us-ascii': 'ascii',
    'ascii': 'ascii', 'latin1': 'latin1', 'iso-8859-1': 'latin1', 'binary': 'binary' };
  if (nativeMap[cs]) return buffer.toString(nativeMap[cs]);
  try {
    const { default: iconv } = await import('iconv-lite');
    if (iconv.encodingExists(cs)) return iconv.decode(buffer, cs);
  } catch { /* iconv unavailable */ }
  return buffer.toString('utf8');
}

export function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Extract a specific header from imapflow's headers property.
// imapflow returns headers as a raw Buffer (BODY[HEADER.FIELDS ...] response bytes),
// so we parse it as text with MIME unfolding. Falls back to .get() if it's a Map.
export function extractRawHeader(headers, name) {
  if (!headers) return '';
  let str;
  if (Buffer.isBuffer(headers)) {
    str = headers.toString();
  } else if (typeof headers.get === 'function') {
    return (headers.get(name) ?? '').toString().trim();
  } else {
    str = headers.toString();
  }
  // Unfold MIME-folded header values (CRLF + whitespace = continuation)
  const unfolded = str.replace(/\r?\n[ \t]+/g, ' ');
  return unfolded.match(new RegExp(`^${name}:\\s*(.+)`, 'im'))?.[1]?.trim() ?? '';
}

export function findTextPart(node) {
  if (!node.childNodes) {
    if (node.type && node.type.startsWith('text/') && node.disposition !== 'attachment') {
      return { partId: null, type: node.type, encoding: node.encoding, charset: node.parameters?.charset, size: node.size };
    }
    return null;
  }
  if (node.type === 'multipart/alternative') {
    let plainPart = null, htmlPart = null;
    for (const child of node.childNodes) {
      if (child.childNodes || child.disposition === 'attachment') continue;
      if (child.type === 'text/plain') plainPart = child;
      else if (child.type === 'text/html') htmlPart = child;
    }
    const chosen = plainPart || htmlPart;
    if (chosen) return { partId: chosen.part, type: chosen.type, encoding: chosen.encoding, charset: chosen.parameters?.charset, size: chosen.size };
  }
  for (const child of node.childNodes) {
    if (child.disposition === 'attachment') continue;
    const found = findTextPart(child);
    if (found) return found;
  }
  return null;
}

export function findAttachments(node, parts = []) {
  if (node.childNodes) {
    for (const child of node.childNodes) findAttachments(child, parts);
  } else {
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
    const isTextBody = (node.type === 'text/plain' || node.type === 'text/html') && node.disposition !== 'attachment';
    if (node.disposition === 'attachment' || node.disposition === 'inline' || (filename && !isTextBody)) {
      parts.push({
        partId: node.part ?? 'TEXT',
        filename,
        mimeType: node.type ?? 'application/octet-stream',
        size: node.size ?? 0,
        encoding: node.encoding ?? '7bit',
        disposition: node.disposition ?? 'attachment'
      });
    }
  }
  return parts;
}

export function estimateEmailSize(node) {
  if (node.childNodes) return node.childNodes.reduce((s, c) => s + estimateEmailSize(c), 0);
  return node.size || 0;
}

export function stripSubjectPrefixes(subject) {
  if (!subject) return '';
  return subject.replace(/^(Re:|RE:|Fwd:|FWD:|Fw:|FW:|AW:|回复:|转发:)\s*/i, '').trim();
}
