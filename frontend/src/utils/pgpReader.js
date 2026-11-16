// Reading an OpenPGP message in the browser: what is in the raw source, which of the user's keys
// opens it, the decrypted MIME entity, and what its signature says. The plaintext lives in this
// tab only; nothing here sends it anywhere, and the reader shows it without storing it.

import {
  binaryToBytes, bytesToBinary, canonicalEntityBytes, decodeCharset, extractContent, parseAutocrypt, parseMime, partText,
} from './mimeParse.js';
import { decryptArmored, encryptionKeyIds, keyMatches, readArmoredKeys, verifyCleartext, verifyDetached } from './pgp.js';

const ARMORED_MESSAGE = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;
const CLEARTEXT_SIGNED = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/;

const lower = v => String(v || '').toLowerCase();

// The OpenPGP content of a message's raw source:
//   { kind: 'encrypted', armored }                      RFC 3156 multipart/encrypted
//   { kind: 'signed', signedBytes, signature, node }    RFC 3156 multipart/signed
//   { kind: 'inlineEncrypted', armored }                an armored block in a text body
//   { kind: 'inlineSigned', cleartext }                 a cleartext-signed text body
// or null, each with `autocrypt` (the parsed Autocrypt header or null) and `root`.
export function analyzeRaw(raw) {
  const root = parseMime(raw);
  const str = root.source;
  const autocrypt = parseAutocrypt(root.header('autocrypt'));
  const base = { root, autocrypt };
  const find = (node) => {
    const protocol = lower(node.params.protocol);
    if (node.contentType === 'multipart/encrypted' && protocol === 'application/pgp-encrypted' && node.children.length >= 2) {
      const armored = partText(str, node.children[1]);
      const m = ARMORED_MESSAGE.exec(armored);
      return m ? { kind: 'encrypted', armored: m[0] } : null;
    }
    if (node.contentType === 'multipart/signed' && protocol === 'application/pgp-signature' && node.children.length >= 2) {
      return {
        kind: 'signed', node: node.children[0], signedBytes: canonicalEntityBytes(str, node.children[0]),
        signature: partText(str, node.children[1]),
      };
    }
    return null;
  };
  const top = find(root) || (root.contentType === 'multipart/mixed' && root.children[0] ? find(root.children[0]) : null);
  if (top) return { ...base, ...top };
  const content = extractContent(root);
  const text = content.text || '';
  const enc = ARMORED_MESSAGE.exec(text);
  if (enc) return { ...base, kind: 'inlineEncrypted', armored: enc[0] };
  const sig = CLEARTEXT_SIGNED.exec(text);
  if (sig) return { ...base, kind: 'inlineSigned', cleartext: sig[0] };
  return null;
}

// Which of the user's keys (rows from GET /api/pgp/keys) the message is encrypted to, or null.
export async function findDecryptionKey(armored, ownKeys) {
  const ids = await encryptionKeyIds(armored);
  for (const row of ownKeys || []) {
    try {
      const [key] = await readArmoredKeys(row.armoredPublic);
      if (key && keyMatches(key, ids)) return row;
    } catch { /* a key that does not read opens nothing */ }
  }
  return null;
}

// A signature result with the trust the user gave the key: 'verified' when good and the key is
// one the user verified (or their own), else as signatureState said.
export function withTrust(signature, senderKeys) {
  if (signature?.state !== 'good') return signature || { state: 'none' };
  const row = (senderKeys || []).find(k => lower(k.fingerprint) === lower(signature.fingerprint));
  return row?.verified ? { ...signature, state: 'verified', source: row.source } : { ...signature, source: row?.source || null };
}

const looksLikeMime = bytes => /^(?:[!-9;-~]+:[^\r\n]*\r?\n(?:[ \t][^\r\n]*\r?\n)*)+\r?\n/.test(bytesToBinary(bytes.subarray(0, 4096)))
  && /^content-type:/im.test(bytesToBinary(bytes.subarray(0, 4096)));

// What a decrypted message shows: extractContent's fields plus `signature`. A PGP/MIME
// plaintext is a MIME entity, perhaps itself multipart/signed (sign, then encrypt); an inline
// one is text.
export async function openPlaintext(data, { signature, senderArmored = [] }) {
  if (!looksLikeMime(data)) {
    return { html: null, text: decodeCharset(data, 'utf-8'), attachments: [], inline: [], subject: null, signature };
  }
  let root = parseMime(data);
  let sig = signature;
  if (root.contentType === 'multipart/signed' && lower(root.params.protocol) === 'application/pgp-signature' && root.children.length >= 2) {
    const inner = root.children[0];
    sig = await verifyDetached(canonicalEntityBytes(root.source, inner), partText(root.source, root.children[1]), senderArmored);
    root = parseMime(binaryToBytes(root.source.slice(inner.start, inner.end)));
  }
  return { ...extractContent(root), signature: sig };
}

// The whole of decryption once a key is unlocked.
export async function decryptMessage(analyzed, { decryptionKey, senderKeys = [] }) {
  const senderArmored = senderKeys.map(k => k.armored);
  const { data, signature } = await decryptArmored(analyzed.armored, { decryptionKey, verificationArmored: senderArmored });
  const opened = await openPlaintext(data, { signature, senderArmored });
  return { ...opened, signature: withTrust(opened.signature, senderKeys) };
}

// A signed message's signature, checked against the sender's keys.
export async function verifySigned(analyzed, senderKeys = []) {
  const senderArmored = senderKeys.map(k => k.armored);
  if (analyzed.kind === 'signed') return withTrust(await verifyDetached(analyzed.signedBytes, analyzed.signature, senderArmored), senderKeys);
  if (analyzed.kind === 'inlineSigned') return withTrust((await verifyCleartext(analyzed.cleartext, senderArmored)).signature, senderKeys);
  return { state: 'none' };
}

// The sender's keys to verify with: the user's own keys and keyring (and, failing those, the
// sender's Web Key Directory) through POST /api/pgp/lookup. An Autocrypt key in the message itself
// proves nothing about who signed it, so it is never used here; the reader offers to import it.
export async function senderKeysFor(email, lookup) {
  if (!email) return [];
  try {
    const { results } = await lookup([email]);
    return results?.[lower(email)]?.keys || [];
  } catch {
    return [];
  }
}

// The attachments the reader lists for a message as the server describes it: none of an encrypted
// one's (the ciphertext and its version part; the decrypted message lists its own), and a signed
// one's without the signature file.
export function pgpVisibleAttachments(body) {
  const list = body?.attachments || [];
  if (body?.pgp === 'encrypted') return [];
  if (body?.pgp === 'signed') return list.filter(a => lower(a?.type) !== 'application/pgp-signature');
  return list;
}
