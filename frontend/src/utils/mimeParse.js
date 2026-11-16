// A small MIME parser (RFC 2045-2047, 2231) for what the browser has to read itself: the raw
// source of an OpenPGP message and the MIME entity inside a decrypted one, neither of which the
// server ever parses for us. Bytes are handled as a "binary string" (one char per byte) so that
// byte offsets survive: a multipart/signed signature covers the exact bytes of its first part.
//
// No imports, so it runs in node:test as it runs in the browser.

const MAX_DEPTH = 20;
const MAX_PARTS = 500;

export function bytesToBinary(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return out;
}

export function binaryToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
  return out;
}

// Text in `charset`, read leniently: an unknown label is read as UTF-8, and windows-1252 stands in
// for ISO-8859-1 as browsers do.
export function decodeCharset(bytes, charset) {
  let label = String(charset || 'utf-8').trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!label || label === 'us-ascii' || label === 'ascii') label = 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

export function decodeBase64(str) {
  const clean = String(str).replace(/[^A-Za-z0-9+/]/g, '');
  const padded = clean + '==='.slice((clean.length + 3) % 4);
  try {
    return binaryToBytes(atob(padded.length % 4 === 1 ? padded.slice(0, -1) : padded));
  } catch {
    return new Uint8Array(0);
  }
}

export function decodeQuotedPrintable(str) {
  const s = String(str).replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61 /* = */ && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(c & 0xFF);
    }
  }
  return new Uint8Array(out);
}

// RFC 2047 encoded-words, in the charset each one names. Whitespace between two adjacent
// encoded-words is dropped, as the RFC says.
export function decodeEncodedWords(value) {
  const s = String(value ?? '');
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;
  let out = '';
  let last = 0;
  let prevWasWord = false;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const between = s.slice(last, m.index);
    if (!(prevWasWord && /^\s*$/.test(between))) out += between;
    const charset = m[1].split('*')[0];
    const bytes = m[2].toUpperCase() === 'B'
      ? decodeBase64(m[3])
      : decodeQuotedPrintable(m[3].replace(/_/g, ' '));
    out += decodeCharset(bytes, charset);
    last = re.lastIndex;
    prevWasWord = true;
  }
  return out + s.slice(last);
}

// Raw 8-bit header bytes are read as UTF-8 when they are, and as windows-1252 otherwise.
function headerText(binary) {
  if (!/[\x80-\xff]/.test(binary)) return binary;
  const bytes = binaryToBytes(binary);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeCharset(bytes, 'windows-1252');
  }
}

// The header block (a binary string) as [{ name (lower-case), value (unfolded, raw) }].
export function parseHeaderBlock(block) {
  const fields = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && fields.length) {
      fields[fields.length - 1].value += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  return fields;
}

function splitParams(value) {
  const parts = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"' && value[i - 1] !== '\\') quoted = !quoted;
    if (c === ';' && !quoted) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

const unquote = v => (/^".*"$/s.test(v) ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v);

// "type/subtype; a=b; c*=utf-8''..." -> { value, params }, RFC 2231 continuations and charsets
// joined and decoded, encoded-words in plain parameters decoded (a common violation).
export function parseStructuredHeader(raw) {
  const [first = '', ...rest] = splitParams(String(raw || ''));
  const params = {};
  const continued = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    const val = unquote(p.slice(eq + 1).trim());
    const m = /^([^*]+)\*(?:(\d+)\*?|)$/.exec(key);
    const extended = key.endsWith('*');
    if (m) {
      const name = m[1];
      (continued[name] ||= []).push({ index: m[2] === undefined ? 0 : Number(m[2]), val, extended });
    } else {
      params[key] = decodeEncodedWords(headerText(val));
    }
  }
  for (const [name, pieces] of Object.entries(continued)) {
    pieces.sort((a, b) => a.index - b.index);
    let charset = 'utf-8';
    let binary = '';
    pieces.forEach((piece, i) => {
      let v = piece.val;
      if (piece.extended) {
        if (i === 0) {
          const m = /^([^']*)'[^']*'(.*)$/s.exec(v);
          if (m) { charset = m[1] || 'utf-8'; v = m[2]; }
        }
        binary += v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      } else {
        binary += v;
      }
    });
    params[name] = decodeCharset(binaryToBytes(binary), charset);
  }
  return { value: first.trim().toLowerCase(), params };
}

function findHeaderEnd(str, from) {
  const crlf = str.indexOf('\r\n\r\n', from);
  const lf = str.indexOf('\n\n', from);
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { end: crlf, bodyStart: crlf + 4 };
  if (lf >= 0) return { end: lf, bodyStart: lf + 2 };
  return null;
}

// One MIME entity of `str` between `start` and `end`. Each node:
//   { headers, header(name), contentType, params, disposition, dispositionParams, encoding,
//     start, end, bodyStart, children }
// where start..end is the entity's bytes, its headers included (what a signature covers).
export function parseEntity(str, start = 0, end = str.length, depth = 0, counter = { n: 0 }) {
  if (++counter.n > MAX_PARTS) throw new Error('Too many MIME parts');
  const he = findHeaderEnd(str.slice(start, end), 0);
  // An entity with no blank line has headers only (or, starting with one, no headers at all).
  let headerBlock;
  let bodyStart;
  if (str.startsWith('\r\n', start) || str.startsWith('\n', start)) {
    headerBlock = '';
    bodyStart = start + (str.startsWith('\r\n', start) ? 2 : 1);
  } else if (he) {
    headerBlock = str.slice(start, start + he.end);
    bodyStart = start + he.bodyStart;
  } else {
    headerBlock = str.slice(start, end);
    bodyStart = end;
  }
  const headers = parseHeaderBlock(headerBlock);
  const header = name => headers.find(h => h.name === name)?.value ?? null;
  const ct = parseStructuredHeader(header('content-type') || 'text/plain; charset=us-ascii');
  const cd = parseStructuredHeader(header('content-disposition') || '');
  const node = {
    headers,
    header,
    contentType: ct.value || 'text/plain',
    params: ct.params,
    disposition: cd.value || null,
    dispositionParams: cd.params,
    encoding: String(header('content-transfer-encoding') || '7bit').trim().toLowerCase(),
    start,
    end,
    bodyStart,
    children: [],
  };
  if (node.contentType.startsWith('multipart/') && node.params.boundary && depth < MAX_DEPTH) {
    node.children = splitMultipart(str, bodyStart, end, node.params.boundary)
      .map(([s, e]) => parseEntity(str, s, e, depth + 1, counter));
  }
  return node;
}

// The [start, end) ranges of each part of a multipart body. A part ends before the line break
// that precedes the next delimiter line (RFC 2046 5.1.1: that line break belongs to the delimiter).
function splitMultipart(str, start, end, boundary) {
  const delim = `--${boundary}`;
  const ranges = [];
  let pos = start;
  let partStart = -1;
  for (;;) {
    let idx = str.indexOf(delim, pos);
    while (idx >= 0 && idx < end && !(idx === start || str[idx - 1] === '\n')) idx = str.indexOf(delim, idx + 1);
    if (idx < 0 || idx >= end) {
      if (partStart >= 0) ranges.push([partStart, end]); // an unterminated last part
      break;
    }
    if (partStart >= 0) {
      let partEnd = idx;
      if (str[partEnd - 1] === '\n') partEnd -= 1;
      if (str[partEnd - 1] === '\r') partEnd -= 1;
      ranges.push([partStart, Math.max(partStart, partEnd)]);
    }
    const after = idx + delim.length;
    if (str.startsWith('--', after)) break; // the close delimiter
    const eol = str.indexOf('\n', after);
    if (eol < 0 || eol >= end) break;
    partStart = eol + 1;
    pos = partStart;
  }
  return ranges;
}

export function parseMime(bytesOrBinary) {
  const str = typeof bytesOrBinary === 'string' ? bytesOrBinary : bytesToBinary(bytesOrBinary);
  const root = parseEntity(str);
  root.source = str;
  return root;
}

// The decoded bytes of a leaf part's body.
export function partBytes(str, node) {
  const raw = str.slice(node.bodyStart, node.end);
  if (node.encoding === 'base64') return decodeBase64(raw);
  if (node.encoding === 'quoted-printable') return decodeQuotedPrintable(raw);
  return binaryToBytes(raw);
}

export function partText(str, node) {
  return decodeCharset(partBytes(str, node), node.params.charset);
}

const bodyText = (str, node) => partText(str, node).replace(/\r\n/g, '\n');

// The exact bytes of an entity, headers included, with every line ending made CRLF: what a
// multipart/signed signature is computed over (RFC 3156 5).
export function canonicalEntityBytes(str, node) {
  return binaryToBytes(str.slice(node.start, node.end).replace(/\r?\n/g, '\r\n'));
}

export function filenameOf(node) {
  return node.dispositionParams.filename || node.params.name || '';
}

// What a reader shows of a (decrypted) message: { html, text, attachments, inline, subject }.
// attachments are { filename, mimeType, data, contentId }; `inline` are the ones the HTML refers
// to by cid:. `subject` is the protected Subject header of the top entity, if any.
export function extractContent(root, str = root.source) {
  const out = { html: null, text: null, attachments: [], inline: [], subject: null, protectedHeaders: false };
  if (/^v1$/i.test(root.params['protected-headers'] || '')) out.protectedHeaders = true;
  const subject = root.header('subject');
  if (subject != null) out.subject = decodeEncodedWords(headerText(subject));

  const attach = (node) => {
    const contentId = (node.header('content-id') || '').replace(/^<|>$/g, '').trim() || null;
    out.attachments.push({
      filename: decodeEncodedWords(headerText(filenameOf(node))) || (node.contentType === 'message/rfc822' ? 'message.eml' : 'attachment'),
      mimeType: node.contentType,
      data: partBytes(str, node),
      contentId,
    });
  };

  const walk = (node, inAlternative = false) => {
    const type = node.contentType;
    if (type === 'multipart/alternative') {
      // The richest alternative the reader can show, with the plain text kept as a fallback.
      const html = [...node.children].reverse().find(c => c.contentType === 'text/html' || c.contentType.startsWith('multipart/'));
      const plain = node.children.find(c => c.contentType === 'text/plain');
      if (plain && out.text == null) out.text = bodyText(str, plain);
      if (html) walk(html, true);
      return;
    }
    if (type.startsWith('multipart/')) {
      for (const child of node.children) walk(child, inAlternative);
      return;
    }
    if ((type === 'text/html' || type === 'text/plain') && node.disposition !== 'attachment') {
      const named = Boolean(filenameOf(node));
      if (type === 'text/html' && out.html == null) { out.html = bodyText(str, node); return; }
      if (type === 'text/plain' && !named) {
        if (out.text == null) { out.text = bodyText(str, node); return; }
        if (!inAlternative) { out.text += `\n\n${bodyText(str, node)}`; return; }
      }
    }
    attach(node);
  };
  walk(root);

  // Parts the HTML shows by cid: are images in the body, not files.
  if (out.html) {
    const refs = new Set([...out.html.matchAll(/cid:([^"'\s)>]+)/gi)].map(m => decodeURIComponent(m[1]).toLowerCase()));
    out.inline = out.attachments.filter(a => a.contentId && refs.has(a.contentId.toLowerCase()));
    out.attachments = out.attachments.filter(a => !out.inline.includes(a));
  }
  return out;
}

// The Autocrypt header (Autocrypt Level 1): { addr, keydata (base64), preferEncrypt } or null.
export function parseAutocrypt(value) {
  if (!value) return null;
  const attrs = {};
  for (const part of String(value).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    attrs[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  if (!attrs.addr || !attrs.keydata) return null;
  // Critical attributes this reader does not know make the header one to ignore (spec 2.1).
  if (Object.keys(attrs).some(k => !['addr', 'keydata', 'prefer-encrypt'].includes(k) && !k.startsWith('_'))) return null;
  return { addr: attrs.addr.toLowerCase(), keydata: attrs.keydata.replace(/\s+/g, ''), preferEncrypt: attrs['prefer-encrypt'] || null };
}
