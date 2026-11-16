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
// or null, from an IMAP BODYSTRUCTURE. A signed or encrypted message forwarded as the first part of
// a multipart/mixed (some mailing lists add a footer that way) counts too.
export function pgpKindOfStructure(structure) {
  const kind = (node) => {
    const type = lower(node?.type);
    const protocol = lower(node?.parameters?.protocol);
    if (type === 'multipart/encrypted' && protocol === 'application/pgp-encrypted') return 'encrypted';
    if (type === 'multipart/signed' && protocol === 'application/pgp-signature') return 'signed';
    return null;
  };
  if (!structure) return null;
  const own = kind(structure);
  if (own) return own;
  if (lower(structure.type) === 'multipart/mixed' && structure.childNodes?.length) return kind(structure.childNodes[0]);
  return null;
}

// Inline PGP: an armored block in a plain-text body.
export function pgpKindOfText(text) {
  const s = String(text || '');
  if (s.includes('-----BEGIN PGP MESSAGE-----') && s.includes('-----END PGP MESSAGE-----')) return 'encrypted';
  if (s.includes('-----BEGIN PGP SIGNED MESSAGE-----') && s.includes('-----END PGP SIGNATURE-----')) return 'signed';
  return null;
}

// What the body route says about a message it serves: the structure's verdict when the body was
// just fetched, otherwise what the stored row and body show.
export function pgpKindOfBody({ structureKind = null, snippet = null, text = null, attachments = [] } = {}) {
  if (structureKind) return structureKind;
  if (typeof attachments === 'string') {
    try { attachments = JSON.parse(attachments); } catch { attachments = []; }
  }
  if (!Array.isArray(attachments)) attachments = [];
  if (snippet === PGP_ENCRYPTED_SNIPPET) return 'encrypted';
  const inline = pgpKindOfText(text);
  if (inline) return inline;
  if ((attachments || []).some(a => lower(a?.type) === 'application/pgp-encrypted')) return 'encrypted';
  if ((attachments || []).some(a => lower(a?.type) === 'application/pgp-signature')) return 'signed';
  return null;
}

// The snippet sync stores: the marker for an encrypted message, the snippet it built otherwise.
export function pgpSnippet(structure, snippet) {
  if (pgpKindOfStructure(structure) === 'encrypted') return PGP_ENCRYPTED_SNIPPET;
  if (String(snippet || '').trimStart().startsWith('-----BEGIN PGP MESSAGE-----')) return PGP_ENCRYPTED_SNIPPET;
  return snippet;
}
