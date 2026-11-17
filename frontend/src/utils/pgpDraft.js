// Drafts of a message that goes encrypted. As Thunderbird and Proton do, the draft is encrypted
// here, to the user's own key only, before it leaves the browser: the server and the mail server's
// Drafts folder get the ciphertext under the draft's headers (routes/draft.js), and the text, the
// signature and the quote stay inside it. Recipients and the subject stay in the clear, as they do
// in the encrypted message itself: the mail server needs the one, and the outer Subject of an
// encrypted message is the convention (the protected one inside is the copy readers show).
//
// Encrypting needs only the public key, so saving, autosave included, never asks for anything.
// Reopening needs the private key, unlocked as reading an encrypted message does.
//
// The inside is an ordinary MIME message, laid out as the server lays out a plain draft (body,
// the marked signature block, then the quote), so another OpenPGP mail program can open it, and
// reopening it here lifts the signature back out (draftSignature.js).

import { buildMimeEntity, entityBytes } from './mimeBuild.js';
import { extractContent, parseMime } from './mimeParse.js';
import { decryptArmored, encryptMime } from './pgp.js';
import { analyzeRaw, findDecryptionKeys } from './pgpReader.js';
import { htmlToText } from './secureSend.js';

export class PgpDraftError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// routes/draft.js and utils/draftSignature.js match this block; the three stay in step.
const SIGNATURE_BLOCK_STYLE = 'margin-top:16px;color:#555;font-size:13px';
// The draft's own mark, inside the encryption: whether automatic encryption decided it, so it
// reopens as it was (protectionForRestore in pgpSend.js).
const MARK_HEADER = 'X-Plimail-Encryption';

const escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textToHtml = text => String(text).split('\n')
  .map(l => `<p style="margin:0">${escapeHtml(l) || '&nbsp;'}</p>`).join('');

// The draft as one document, from the composer's /draft fields (ComposeModal's draftFields).
export function draftDocument(fields) {
  const body = fields.body || '';
  const sig = typeof fields.editedSignature === 'string' ? fields.editedSignature : null;
  const bodyHtml = fields.bodyIsHtml ? body : textToHtml(body);
  const sigBlock = sig != null ? `<div data-mailflow-signature="1" style="${SIGNATURE_BLOCK_STYLE}">${sig}</div>` : '';
  const quotedHtml = fields.quotedBodyHtml || (fields.quotedBody ? textToHtml(fields.quotedBody) : '');
  const html = bodyHtml + sigBlock + quotedHtml;
  const bodyText = fields.bodyIsHtml ? htmlToText(body) : body;
  const sigText = sig ? (fields.bodyIsHtml ? htmlToText(sig) : sig) : '';
  const text = `${bodyText}${sigText ? `\n\n-- \n${sigText}` : ''}${fields.quotedBody || ''}`;
  return { html, text };
}

// The /draft body for an encrypted draft: the composer's fields with the content replaced by its
// ciphertext. `ownKey` is the user's key for the From address (ownKeyFor); without one the draft is
// not saved at all, never in the clear (PgpDraftError 'noOwnKey'). `auto`: automatic encryption
// decided it.
export async function encryptedDraftBody({ fields, ownKey, fromName = '', fromEmail = '', auto = false, encrypt = encryptMime }) {
  if (!ownKey?.armoredPublic) throw new PgpDraftError('noOwnKey');
  if (!globalThis.crypto?.subtle) throw new PgpDraftError('insecure');
  const { html, text } = draftDocument(fields);
  const address = v => (typeof v === 'string' ? { name: '', email: v.replace(/^.*<([^>]+)>.*$/, '$1').trim() } : v);
  const entity = buildMimeEntity({
    html, text,
    headers: {
      from: { name: fromName, email: fromEmail },
      to: (fields.to || []).map(address),
      cc: (fields.cc || []).map(address),
      subject: fields.subject || '',
    },
    extraHeaders: [`${MARK_HEADER}: ${auto ? 'auto' : 'required'}`],
  });
  const armored = await encrypt(entityBytes(entity), { recipientArmored: [ownKey.armoredPublic] });
  const rest = { ...fields };
  for (const key of ['body', 'bodyIsHtml', 'quotedBody', 'quotedBodyHtml', 'editedSignature']) delete rest[key];
  return { ...rest, pgp: { encrypted: armored } };
}

// cid: images inside the draft back as data: URLs, as the composer had them.
export function withInlineImages(html, inline = []) {
  const byCid = new Map(inline.filter(a => a.contentId).map(a => [a.contentId.toLowerCase(), a]));
  return String(html).replace(/(\ssrc\s*=\s*["'])cid:([^"']+)(["'])/gi, (m, pre, cid, post) => {
    let id = cid;
    try { id = decodeURIComponent(cid); } catch { /* used as written */ }
    const part = byCid.get(id.toLowerCase());
    if (!part || !/^image\/[a-z0-9.+-]+$/i.test(part.mimeType)) return m;
    let bin = '';
    for (let i = 0; i < part.data.length; i += 0x8000) bin += String.fromCharCode.apply(null, part.data.subarray(i, i + 0x8000));
    return `${pre}data:${part.mimeType};base64,${btoa(bin)}${post}`;
  });
}

// The draft's content from its decrypted MIME entity: { html, text, attachments, auto }.
export function draftContent(data) {
  const root = parseMime(data);
  const content = extractContent(root);
  return {
    html: content.html != null ? withInlineImages(content.html, content.inline) : null,
    text: content.text,
    attachments: content.attachments,
    auto: String(root.header(MARK_HEADER.toLowerCase()) || '').trim().toLowerCase() === 'auto',
  };
}

// Decrypts a draft's raw source with the user's keys (GET /api/pgp/keys rows). `openKey(row)`
// resolves the unlocked private key, asking for what has to be asked (pgpUnlock.js); what it
// throws (the user closed the prompt) is passed on. Throws PgpDraftError 'unreadable' (no
// encrypted part), 'notForYou' (none of the keys) or 'decryptFailed'.
export async function openEncryptedDraft(raw, { ownKeys, openKey }) {
  const analyzed = analyzeRaw(raw);
  if (!analyzed?.armored) throw new PgpDraftError('unreadable');
  return openOwnMessage(analyzed.armored, { ownKeys, openKey });
}

// The same for an armored message encrypted to the user among others (an encrypted scheduled
// message, which is encrypted to its recipients and to the sender's own key for the Sent copy).
export async function openOwnMessage(armored, { ownKeys, openKey }) {
  const rows = await findDecryptionKeys(armored, ownKeys);
  if (!rows.length) throw new PgpDraftError('notForYou');
  let unlockError = null;
  for (const row of rows) {
    let key;
    try { key = await openKey(row); } catch (err) { unlockError = unlockError || err; continue; }
    try {
      const { data } = await decryptArmored(armored, { decryptionKey: key });
      return draftContent(data);
    } catch { /* not this key */ }
  }
  throw unlockError || new PgpDraftError('decryptFailed');
}

// A decrypted attachment as the composer holds one ({ name, type, size, data: base64 }).
export function composerAttachment(a) {
  let bin = '';
  for (let i = 0; i < a.data.length; i += 0x8000) bin += String.fromCharCode.apply(null, a.data.subarray(i, i + 0x8000));
  return { name: a.filename || 'attachment', type: a.mimeType || 'application/octet-stream', size: a.data.length, data: btoa(bin) };
}
