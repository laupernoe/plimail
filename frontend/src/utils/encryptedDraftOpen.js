// Reopening what was saved encrypted (utils/pgpDraft.js) in the composer: a draft from Drafts or
// the reply-draft lookup, and an encrypted scheduled message opened for editing. The content is
// decrypted here with the user's key, unlocked as reading an encrypted message unlocks it, and
// what the composer gets reopens encrypted, so it is never saved or sent in the clear unasked.

import DOMPurify from 'dompurify';
import { api } from './api.js';
import { splitDraftSignature } from './draftSignature.js';
import { PgpDraftError, composerAttachment, openEncryptedDraft, openOwnMessage } from './pgpDraft.js';
import { openOwnKey } from './pgpKeys.js';
import { loadOwnKeys } from './pgpOwnKeys.js';
import { keySecretEntry, keySecretOwner } from './pgpSecret.js';
import { unlockOwnKey } from './pgpUnlock.js';

// The decrypted HTML was the user's own, but it came back from a mail server: it is cleaned as
// any HTML the composer opens is.
const clean = html => DOMPurify.sanitize(String(html || ''), {
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'base', 'meta', 'link', 'iframe', 'frame', 'object', 'embed', 'script', 'style'],
});

// `prompt`: the unlock prompt may ask for the Plimail password. An automatic opening (a reply
// draft opened on its own) only uses what this tab already has.
const keyOpener = ({ prompt }) => (row) => {
  const userId = keySecretOwner();
  if (prompt) return unlockOwnKey(row, userId);
  const entry = userId ? keySecretEntry(userId) : null;
  return openOwnKey(row, { secret: entry?.secret || null, verified: entry?.verified !== false });
};

const protectionOf = auto => ({ mode: 'pgp', sign: true, ...(auto ? { auto: true } : {}) });

// What a saved draft's compose data gets in place of what the server could tell of it. A draft
// with files inside (one another mail program saved) is not opened for editing: drafts here carry
// no files, so its next save would lose them (PgpDraftError 'hasAttachments').
export async function encryptedDraftFields(messageId, { prompt = true, rawMessage = api.pgp.rawMessage, ownKeys = loadOwnKeys } = {}) {
  const [raw, keys] = await Promise.all([rawMessage(messageId), ownKeys()]);
  const opened = await openEncryptedDraft(raw, { ownKeys: keys, openKey: keyOpener({ prompt }) });
  if (opened.attachments.length) throw new PgpDraftError('hasAttachments');
  const html = opened.html != null ? clean(opened.html) : null;
  const { body, signature, inline } = html != null ? splitDraftSignature(html) : { body: opened.text || '', signature: null, inline: false };
  return {
    body,
    bodyIsHtml: html != null,
    ...(signature !== null ? { signature } : inline ? { signature: '' } : {}),
    externalAttachments: [],
    forwardedAttachments: [],
    unresolvedExternalAttachments: false,
    protection: protectionOf(opened.auto),
  };
}

// An encrypted scheduled message (GET /api/mail/scheduled/:id with spec.pgp) as the composer
// edits it: its content from the ciphertext, which is encrypted to the sender's own key too, its
// files back in the composer, and the ciphertext itself not kept (the edit is encrypted again).
export async function encryptedScheduledFields(detail, { attachmentBase64 = api.scheduled.attachmentBase64, ownKeys = loadOwnKeys } = {}) {
  const cipher = (detail.attachments || []).find(a => a.kind === 'pgp');
  if (!cipher) throw new PgpDraftError('unreadable');
  const [b64, keys] = await Promise.all([attachmentBase64(detail.id, cipher.index), ownKeys()]);
  const opened = await openOwnMessage(atob(b64), { ownKeys: keys, openKey: keyOpener({ prompt: true }) });
  return {
    body: opened.html != null ? clean(opened.html) : (opened.text || ''),
    bodyIsHtml: opened.html != null,
    // The signature was sent inside the message's body.
    signature: '',
    quotedBody: undefined,
    quotedBodyHtml: undefined,
    attachments: opened.attachments.map(composerAttachment),
    protection: protectionOf(false),
  };
}
