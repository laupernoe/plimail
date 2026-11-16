// Recognizing OpenPGP mail, which the server can only recognize: decrypting and verifying happen
// in the browser (frontend/src/utils/pgp.js), from the message's raw source.
//
// An encrypted message's list snippet is this armor line rather than ciphertext or the PGP/MIME
// version part ("Version: 1"). It says what the message is in any language, and the client shows
// "Encrypted message" for it. The body route also reads it back as the mark of an encrypted message
// whose body is stored, since an encrypted body has no text of its own to tell.
export const PGP_ENCRYPTED_SNIPPET = '-----BEGIN PGP MESSAGE-----';

const lower = v => String(v || '').toLowerCase();

// 'encrypted' (RFC 3156 multipart/encrypted), 'signed' (multipart/signed with an OpenPGP signature)
// or null, from an IMAP BODYSTRUCTURE. Only the root counts: an encrypted or signed part inside an
// ordinary message (a forwarded one, a part a list wrapped with a footer) is that message's
// content, shown as such, and the reader would otherwise hide everything around it.
export function pgpKindOfStructure(structure) {
  if (!structure) return null;
  const type = lower(structure.type);
  const protocol = lower(structure.parameters?.protocol);
  if (type === 'multipart/encrypted' && protocol === 'application/pgp-encrypted') return 'encrypted';
  if (type === 'multipart/signed' && protocol === 'application/pgp-signature') return 'signed';
  return null;
}

// Inline PGP: a text body that is an armored block, from its first line. A block quoted in a reply
// ("> -----BEGIN PGP MESSAGE-----") or pasted in the middle of a message is just text.
export function pgpKindOfText(text) {
  const s = String(text || '').trimStart();
  if (s.startsWith('-----BEGIN PGP MESSAGE-----') && s.includes('-----END PGP MESSAGE-----')) return 'encrypted';
  if (s.startsWith('-----BEGIN PGP SIGNED MESSAGE-----') && s.includes('-----END PGP SIGNATURE-----')) return 'signed';
  return null;
}

// What the body route says about a message it serves: the structure's verdict when the body was
// just fetched, otherwise what the stored row and body show. An attachment's type never makes a
// message encrypted (an ordinary message can carry a .pgp file); the marker snippet, which only
// sync's reading of the structure or an inline body writes, does.
export function pgpKindOfBody({ structureKind = null, snippet = null, text = null, attachments = [] } = {}) {
  if (structureKind) return structureKind;
  if (typeof attachments === 'string') {
    try { attachments = JSON.parse(attachments); } catch { attachments = []; }
  }
  if (!Array.isArray(attachments)) attachments = [];
  if (snippet === PGP_ENCRYPTED_SNIPPET) return 'encrypted';
  const inline = pgpKindOfText(text);
  if (inline) return inline;
  // A signature file adds a line under the message, checked by the browser against the source.
  if (attachments.some(a => lower(a?.type) === 'application/pgp-signature')) return 'signed';
  return null;
}

// The snippet sync stores: the marker for an encrypted message, the snippet it built otherwise.
export function pgpSnippet(structure, snippet) {
  if (pgpKindOfStructure(structure) === 'encrypted') return PGP_ENCRYPTED_SNIPPET;
  if (String(snippet || '').trimStart().startsWith('-----BEGIN PGP MESSAGE-----')) return PGP_ENCRYPTED_SNIPPET;
  return snippet;
}
