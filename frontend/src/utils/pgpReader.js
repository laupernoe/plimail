// Reading an OpenPGP message in the browser: what is in the raw source, which of the user's keys
// opens it, the decrypted MIME entity, and what its signature says. The plaintext lives in this
// tab only; nothing here sends it anywhere, and the reader shows it without storing it.

import {
  binaryToBytes, bytesToBinary, canonicalEntityBytes, decodeCharset, extractContent, parseAutocrypt, parseMime, partText,
} from './mimeParse.js';
import { WILDCARD_KEY_ID, decryptArmored, encryptionKeyIds, keyMatches, readArmoredKeys, verifyCleartext, verifyDetached } from './pgp.js';

const ARMORED_MESSAGE = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;
// Inline PGP is a body that IS an armored block: one quoted or pasted in the middle of ordinary
// mail is that mail's text, not an encrypted or signed message.
const WHOLE_ENCRYPTED = /^-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;
const CLEARTEXT_SIGNED = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/;

const lower = v => String(v || '').toLowerCase();

// The OpenPGP content of a message's raw source:
//   { kind: 'encrypted', armored }                      RFC 3156 multipart/encrypted, at the root
//   { kind: 'signed', signedBytes, signature, node }    RFC 3156 multipart/signed, at the root
//   { kind: 'inlineEncrypted', armored }                a text body that is an armored block
//   { kind: 'inlineSigned', cleartext }                 a text body that is a cleartext-signed block
//   { kind: 'partlySigned' }                            a signed part inside an unsigned message
// or null, each with `autocrypt` (the parsed Autocrypt header or null) and `root`. Only a
// signature over everything the reader shows can say the message is signed; one over a part
// (a list footer added after it, a signed block quoted in a reply) says nothing about the rest.
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
  const top = find(root);
  if (top) return { ...base, ...top };
  const nested = root.contentType === 'multipart/mixed' && root.children[0] ? find(root.children[0]) : null;
  if (nested?.kind === 'signed') return { ...base, kind: 'partlySigned' };
  const content = extractContent(root);
  const text = (content.text || '').trim();
  const enc = WHOLE_ENCRYPTED.exec(text);
  if (enc) return { ...base, kind: 'inlineEncrypted', armored: enc[0] };
  const sig = CLEARTEXT_SIGNED.exec(text);
  if (sig) {
    // Signed only when the signed text is all the reader shows: no HTML alternative (the pane
    // shows that instead, and nothing signs it), no other part, no unsigned text around it.
    const whole = sig.index === 0 && sig[0].length === text.length
      && content.html == null && !content.attachments.length && !content.inline.length;
    return whole ? { ...base, kind: 'inlineSigned', cleartext: sig[0] } : { ...base, kind: 'partlySigned' };
  }
  return null;
}

// The addresses the message was delivered to, from its own headers, for choosing a key.
export function deliveryAddresses(root) {
  const out = new Set();
  for (const h of root?.headers || []) {
    if (!['to', 'cc', 'delivered-to', 'x-original-to'].includes(h.name)) continue;
    for (const m of h.value.matchAll(/[^\s<>,;:"]+@[^\s<>,;:"]+/g)) out.add(m[0].toLowerCase());
  }
  return [...out];
}

// The user's keys (rows from GET /api/pgp/keys) that may open the message, best first: the ones it
// names. A message with hidden recipients (wildcard key IDs, sent with Bcc) names none, so every
// key may be the one, those for the addresses it was delivered to first; the reader tries them in
// turn. [] when it is for none of them.
export async function findDecryptionKeys(armored, ownKeys, { preferEmails = [] } = {}) {
  const ids = await encryptionKeyIds(armored);
  const named = [];
  for (const row of ownKeys || []) {
    try {
      const [key] = await readArmoredKeys(row.armoredPublic);
      if (key && keyMatches(key, ids)) named.push(row);
    } catch { /* a key that does not read opens nothing */ }
  }
  if (named.length || !ids.includes(WILDCARD_KEY_ID)) return named;
  const prefer = new Set(preferEmails.map(lower));
  const score = row => ((row.emails || []).some(e => prefer.has(lower(e))) ? 1 : 0);
  return [...(ownKeys || [])].sort((a, b) => score(b) - score(a));
}

export async function findDecryptionKey(armored, ownKeys) {
  return (await findDecryptionKeys(armored, ownKeys))[0] || null;
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

// A signed message's signature, checked against the sender's keys. A partly signed message gets
// no verdict: its signature covers something other than what the reader shows.
export async function verifySigned(analyzed, senderKeys = []) {
  if (analyzed.kind === 'partlySigned') return { state: 'partial' };
  const senderArmored = senderKeys.map(k => k.armored);
  if (analyzed.kind === 'signed') return withTrust(await verifyDetached(analyzed.signedBytes, analyzed.signature, senderArmored), senderKeys);
  if (analyzed.kind === 'inlineSigned') return withTrust((await verifyCleartext(analyzed.cleartext, senderArmored)).signature, senderKeys);
  return { state: 'none' };
}

// The sender's keys to verify with, through POST /api/pgp/lookup: the user's own keys and keyring
// only (`local`), since asking the sender's domain for their key when a message is opened would
// tell them it was read. The reader asks the directory only when the user says so. An Autocrypt
// key in the message itself proves nothing about who signed it, so it is never used here.
export async function senderKeysFor(email, lookup, { local = true } = {}) {
  if (!email) return [];
  try {
    const { results } = await lookup([email], { local });
    return results?.[lower(email)]?.keys || [];
  } catch {
    return [];
  }
}

// The attachments the reader lists for a message as the server describes it: none of an encrypted
// one's (the ciphertext and its version part; the decrypted message lists its own), and a signed
// one's without the signature file.
export function pgpVisibleAttachments(body, { original = false } = {}) {
  const list = body?.attachments || [];
  if (original) return list;
  if (body?.pgp === 'encrypted') return [];
  if (body?.pgp === 'signed') return list.filter(a => lower(a?.type) !== 'application/pgp-signature');
  return list;
}
