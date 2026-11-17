// The MIME entity an encrypted message carries (RFC 3156): built here, in the browser, because it
// is encrypted here and the server only ever sees the ciphertext. CRLF line ends throughout, every
// part 7-bit safe (quoted-printable text, base64 files), so nothing on the way rewrites it.
//
// No imports, so it runs in node:test as it runs in the browser.

const CRLF = '\r\n';
const encoder = new TextEncoder();

function randomBoundary() {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `=_pm_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// base64 in 76-character lines.
export function base64Lines(bytes) {
  return (bytesToBase64(bytes).match(/.{1,76}/g) || ['']).join(CRLF);
}

// Quoted-printable (RFC 2045 6.7) of UTF-8 text, lines at most 76 characters, line breaks CRLF.
export function quotedPrintable(text) {
  const lines = String(text).replace(/\r\n|\r|\n/g, '\n').split('\n');
  return lines.map((line) => {
    const bytes = encoder.encode(line);
    let out = '';
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      let enc;
      if ((b === 0x20 || b === 0x09) && last) enc = `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      else if ((b >= 33 && b <= 126 && b !== 61) || b === 0x20 || b === 0x09) enc = String.fromCharCode(b);
      else enc = `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      // Never at the very start of a line: a leading "From " or "." can be mangled in transit.
      if (cur.length === 0 && (enc === '.' || enc === 'F')) enc = `=${b.toString(16).toUpperCase()}`;
      if (cur.length + enc.length > 75) {
        out += `${cur}=${CRLF}`;
        cur = '';
      }
      cur += enc;
    }
    return out + cur;
  }).join(CRLF);
}

const needsEncoding = s => /[^\x20-\x7e]/.test(s);

// A header value as RFC 2047 encoded-words when it is not plain ASCII.
export function encodeHeaderWord(value) {
  const s = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (!needsEncoding(s)) return s;
  // Words of at most ~45 bytes of UTF-8, split on character boundaries.
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (encoder.encode(chunk + ch).length > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${bytesToBase64(encoder.encode(w))}?=`).join(`${CRLF} `);
}

// "Name <addr>" with the name quoted or encoded as needed.
export function formatAddress({ name, email }) {
  const addr = String(email || '').replace(/[\r\n<>]/g, '');
  if (!name) return addr;
  const n = String(name).replace(/[\r\n]/g, ' ');
  const shown = needsEncoding(n) ? encodeHeaderWord(n) : `"${n.replace(/["\\]/g, '\\$&')}"`;
  return `${shown} <${addr}>`;
}

function quotedParam(name, value) {
  const v = String(value || '').replace(/[\r\n]/g, ' ');
  if (!needsEncoding(v) && !/["\\]/.test(v)) return `${name}="${v}"`;
  // RFC 2231 for readers that follow it, and a plain fallback without the odd characters.
  const pct = Array.from(encoder.encode(v), b => (/[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
  return `${name}*=UTF-8''${pct}`;
}

function textPart(type, text) {
  return [
    `Content-Type: ${type}; charset=utf-8`,
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(text),
  ].join(CRLF);
}

function filePart({ filename, mimeType, data, contentId = null, inline = false }) {
  const type = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType || '') ? mimeType : 'application/octet-stream';
  const name = filename || 'attachment';
  return [
    `Content-Type: ${type};${CRLF} ${quotedParam('name', name)}`,
    `Content-Disposition: ${inline ? 'inline' : 'attachment'};${CRLF} ${quotedParam('filename', name)}`,
    'Content-Transfer-Encoding: base64',
    ...(contentId ? [`Content-ID: <${contentId.replace(/[<>\r\n]/g, '')}>`] : []),
    '',
    base64Lines(data),
  ].join(CRLF);
}

function multipart(subtype, parts, extraParams = '', boundary = randomBoundary()) {
  return {
    header: `Content-Type: multipart/${subtype};${CRLF} boundary="${boundary}"${extraParams}`,
    body: parts.map(p => `--${boundary}${CRLF}${p}${CRLF}`).join('') + `--${boundary}--`,
  };
}

// data: images in the HTML body become multipart/related parts referred to by cid:, as the
// server does for an unencrypted message (embedInlineDataImages).
export function extractDataImages(html) {
  const images = [];
  let n = 0;
  const out = String(html || '').replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\2/gi, (m, pre, q, type, b64) => {
    const bytes = Uint8Array.from(atob(b64.replace(/\s+/g, '')), c => c.charCodeAt(0));
    const id = `img${++n}.${randomBoundary().slice(5, 17)}@plimail`;
    images.push({ filename: `image${n}.${(type.split('/')[1] || 'png').replace('+xml', '')}`, mimeType: type, data: bytes, contentId: id, inline: true });
    return `${pre}${q}cid:${id}${q}`;
  });
  return { html: out, images };
}

// The whole entity. `headers` are the protected headers (draft-ietf-lamps-header-protection):
// Subject, From, To, Cc as the message has them, so a reader that supports them shows them from
// inside the encryption. html may be null for a plain-text message. `extraHeaders` are more
// header lines for the top entity, written as given (an encrypted draft's own mark).
export function buildMimeEntity({ html = null, text = '', attachments = [], headers = null, extraHeaders = [] }) {
  let body;
  const textNode = textPart('text/plain', text || '');
  if (html) {
    const { html: cidHtml, images } = extractDataImages(html);
    const alt = multipart('alternative', [textNode, textPart('text/html', cidHtml)]);
    body = images.length
      ? multipart('related', [`${alt.header}${CRLF}${CRLF}${alt.body}`, ...images.map(filePart)])
      : alt;
  } else {
    body = { header: null, body: null, single: textNode };
  }
  const protectedHeaders = headers ? [
    ...(headers.from ? [`From: ${formatAddress(headers.from)}`] : []),
    ...(headers.to?.length ? [`To: ${headers.to.map(formatAddress).join(`,${CRLF} `)}`] : []),
    ...(headers.cc?.length ? [`Cc: ${headers.cc.map(formatAddress).join(`,${CRLF} `)}`] : []),
    `Subject: ${encodeHeaderWord(headers.subject || '')}`,
  ] : [];

  // The top entity is multipart/mixed whenever there is anything to put next to the body, and
  // always when it carries protected headers, which belong on a multipart (the convention).
  const bodyPart = body.single || `${body.header}${CRLF}${CRLF}${body.body}`;
  const mixed = multipart('mixed', [bodyPart, ...attachments.map(a => filePart(a))], headers ? `;${CRLF} protected-headers="v1"` : '');
  return [mixed.header, ...protectedHeaders, ...extraHeaders, 'MIME-Version: 1.0', '', mixed.body, ''].join(CRLF);
}

export function entityBytes(entity) {
  return encoder.encode(entity);
}
