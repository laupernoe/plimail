// Password-protected messages: everything that touches the password or the plaintext, in the
// browser only, with WebCrypto. Shared by the composer, the recipient's page (/s/<token>) and the
// owner's view of replies; no imports, so the recipient's page stays small.
//
// From the password and a random 32-byte salt, PBKDF2-SHA256 (600 000 iterations by default; the
// count travels with the message so it can change) derives 64 bytes:
//   - the first 32 are the AES-256-GCM key the message and its replies are encrypted with;
//   - the last 32 are the authentication key. The server stores SHA-256 of it (the verifier) and
//     hands out the ciphertext only to whoever presents the key itself, so the link alone allows
//     no guessing offline. The server never sees the encryption key, nor anything it could derive
//     it from without guessing the password.
//
// The plaintext is binary, so attachments are not base64-encoded twice:
//   version (1 byte = 1) | header length (uint32, big-endian) | header (UTF-8 JSON) | attachments
// where the header is { subject, html, text, attachments: [{ filename, mimeType, size }] } and the
// attachments' bytes follow one after another, in that order.

export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const PAYLOAD_VERSION = 1;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  // crypto.subtle exists only in a secure context (HTTPS or localhost).
  if (!s) throw new Error('secure_context_required');
  return s;
};

export const randomBytes = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function toBase64(bytes) {
  let binary = '';
  // In chunks: String.fromCharCode with millions of arguments overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

// The two keys from a password. `salt` is bytes.
export async function deriveKeys(password, salt, iterations = PBKDF2_ITERATIONS) {
  const s = subtle();
  const material = await s.importKey('raw', new TextEncoder().encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 512));
  const encKey = await s.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const authKey = bits.slice(32);
  bits.fill(0);
  return { encKey, authKey };
}

export async function verifierOf(authKey) {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', authKey)));
}

export async function encryptBytes(encKey, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, encKey, plaintext));
  return { ciphertext, iv };
}

// Throws if the key is wrong or the ciphertext was changed (GCM authenticates both).
export async function decryptBytes(encKey, ciphertext, iv) {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, encKey, ciphertext));
}

// attachments: [{ filename, mimeType, data: Uint8Array }]
export function encodePayload({ subject = '', html = '', text = '', attachments = [] }) {
  const header = new TextEncoder().encode(JSON.stringify({
    subject, html, text,
    attachments: attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType || 'application/octet-stream', size: a.data.length })),
  }));
  const total = 5 + header.length + attachments.reduce((n, a) => n + a.data.length, 0);
  const out = new Uint8Array(total);
  out[0] = PAYLOAD_VERSION;
  new DataView(out.buffer).setUint32(1, header.length);
  out.set(header, 5);
  let at = 5 + header.length;
  for (const a of attachments) {
    out.set(a.data, at);
    at += a.data.length;
  }
  return out;
}

export function decodePayload(bytes) {
  if (bytes.length < 5 || bytes[0] !== PAYLOAD_VERSION) throw new Error('unsupported_payload');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  if (5 + headerLength > bytes.length) throw new Error('unsupported_payload');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(5, 5 + headerLength)));
  let at = 5 + headerLength;
  const attachments = (Array.isArray(header.attachments) ? header.attachments : []).map((a) => {
    const size = Number(a.size);
    if (!Number.isInteger(size) || size < 0 || at + size > bytes.length) throw new Error('unsupported_payload');
    const data = bytes.subarray(at, at + size);
    at += size;
    return { filename: String(a.filename || 'attachment'), mimeType: String(a.mimeType || 'application/octet-stream'), data };
  });
  return {
    subject: typeof header.subject === 'string' ? header.subject : '',
    html: typeof header.html === 'string' ? header.html : '',
    text: typeof header.text === 'string' ? header.text : '',
    attachments,
  };
}

// The composer's side: what POST /api/secure-messages takes, all of it safe to hand the server.
export async function sealMessage(password, payload, { iterations = PBKDF2_ITERATIONS } = {}) {
  const salt = randomBytes(SALT_BYTES);
  const { encKey, authKey } = await deriveKeys(password, salt, iterations);
  const { ciphertext, iv } = await encryptBytes(encKey, encodePayload(payload));
  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    salt: toBase64(salt),
    iterations,
    authVerifier: await verifierOf(authKey),
  };
}

// The recipient's (and the owner's) side: the keys from the password and the message's meta.
export async function unlock(password, { salt, iterations }) {
  const { encKey, authKey } = await deriveKeys(password, fromBase64(salt), iterations);
  return { encKey, authKeyHex: toHex(authKey) };
}

export async function openMessage(encKey, { ciphertext, iv }) {
  return decodePayload(await decryptBytes(encKey, fromBase64(ciphertext), fromBase64(iv)));
}

// A reply is UTF-8 JSON { text }, encrypted with the message's key under a new IV.
export async function sealReply(encKey, text) {
  const { ciphertext, iv } = await encryptBytes(encKey, new TextEncoder().encode(JSON.stringify({ text })));
  return { ciphertext, iv: toBase64(iv) };
}

export async function openReply(encKey, { ciphertext, iv }) {
  const bytes = await decryptBytes(encKey, fromBase64(ciphertext), fromBase64(iv));
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return { text: typeof parsed?.text === 'string' ? parsed.text : '' };
}

// A rough guide for the composer, not a guarantee: length and the kinds of characters used.
export function passwordStrength(password) {
  const p = String(password || '');
  if (p.length < 8) return 'tooShort';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(p)).length;
  const score = (p.length >= 12 ? 1 : 0) + (p.length >= 16 ? 1 : 0) + (kinds >= 3 ? 1 : 0) + (kinds === 4 ? 1 : 0);
  if (score >= 3) return 'strong';
  if (score >= 1) return 'fair';
  return 'weak';
}
