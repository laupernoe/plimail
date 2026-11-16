// Sending an OpenPGP-encrypted message from the composer (RFC 3156). The message the user wrote,
// with its signature, quoted text and attachments, becomes one MIME entity here, which is signed
// and encrypted here to every recipient's key and to the sender's own, so the Sent copy stays
// readable. The server gets the ciphertext and the envelope, never the text.
//
// The rule that matters most: with encryption asked for, nothing goes out unencrypted unless the
// user says so for this message. A recipient without a usable key stops the send.

import { buildMimeEntity, entityBytes } from './mimeBuild.js';
import { encryptMime, keyInfo, readArmoredKeys } from './pgp.js';
import { securePayloadFrom } from './secureSend.js';

// Below the 25 MB of an ordinary send: armoring adds a third, and the send route reads 35 MB.
export const PGP_MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;

export class PgpSendError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export function emailOfRecipient(value) {
  const s = String(value || '').trim();
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  return (m ? m[1] : s).toLowerCase();
}

function nameOfRecipient(value) {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(String(value || ''));
  return m ? m[1].trim() : '';
}

// Each recipient's state from POST /api/pgp/lookup's answer: { email, status, keys, source,
// verified } where status is 'ok' (a key that can encrypt), 'missing' (none found), 'invalid'
// (only expired or revoked keys) or 'error' (the lookup failed). `keys` are the usable ones.
export async function classifyRecipients(emails, results) {
  const out = [];
  for (const email of emails) {
    const r = results?.[email];
    if (!r) { out.push({ email, status: 'error', keys: [] }); continue; }
    if (!r.keys?.length) { out.push({ email, status: r.error ? 'error' : 'missing', keys: [] }); continue; }
    const usable = [];
    for (const row of r.keys) {
      try {
        const [key] = await readArmoredKeys(row.armored);
        if (key && (await keyInfo(key)).canEncrypt) usable.push(row);
      } catch { /* a key that does not read encrypts nothing */ }
    }
    out.push({
      email,
      status: usable.length ? 'ok' : 'invalid',
      keys: usable,
      source: r.source,
      verified: usable.length > 0 && usable.every(k => k.verified),
    });
  }
  return out;
}

// Why the encrypted message cannot go yet, or null:
//   { code: 'noOwnKey' }                       the sender has no key (the Sent copy would be unreadable)
//   { code: 'checking' }                       keys are still being looked up
//   { code: 'missingKeys', emails }            these recipients have no usable key
//   { code: 'passphrase' }                     signing needs the key's passphrase
export function pgpSendProblem({ recipients, statuses, ownKey, sign = false, signingReady = false }) {
  if (!ownKey) return { code: 'noOwnKey' };
  const byEmail = new Map((statuses || []).map(s => [s.email, s]));
  const missing = [];
  for (const email of recipients) {
    const s = byEmail.get(email);
    if (!s) return { code: 'checking' };
    if (s.status !== 'ok') missing.push(email);
  }
  if (missing.length) return { code: 'missingKeys', emails: missing };
  if (sign && !signingReady) return { code: 'passphrase' };
  return null;
}

// The user's key for sending from `fromEmail`: the one with that address, else none.
export function ownKeyFor(ownKeys, fromEmail) {
  const email = String(fromEmail || '').toLowerCase();
  return (ownKeys || []).find(k => (k.emails || []).includes(email)) || null;
}

// The /mail/send body for the encrypted message: `payload` is the composer's (buildSendPayload),
// `attachments` its files ({ name, type, data: base64 }). Throws PgpSendError for what the
// composer explains: 'forwarded' (forwarded parts are fetched by the server, so they cannot be
// encrypted here), 'tooLarge', 'missingKeys' (the last guard: a recipient without a key).
export async function encryptedSendPayload({ payload, attachments = [], forwardedCount = 0, statuses, ownKey, signingKey = null, fromName = '', fromEmail, encrypt = encryptMime }) {
  if (forwardedCount > 0) throw new PgpSendError('forwarded');
  const total = attachments.reduce((n, a) => n + (a.size ?? Math.floor((a.data || '').length * 3 / 4)), 0);
  if (total > PGP_MAX_ATTACHMENT_BYTES) throw new PgpSendError('tooLarge');
  const recipients = [...payload.to, ...(payload.cc || []), ...(payload.bcc || [])].map(emailOfRecipient);
  const problem = pgpSendProblem({ recipients, statuses, ownKey });
  if (problem) throw new PgpSendError(problem.code, problem.emails || null);

  const message = securePayloadFrom(payload, attachments);
  const entity = buildMimeEntity({
    html: message.html || null,
    text: message.text || '',
    attachments: message.attachments,
    // Protected headers, so a reader that supports them shows them from inside the encryption.
    // Bcc stays out: every recipient can decrypt this.
    headers: {
      from: { name: fromName, email: fromEmail },
      to: payload.to.map(v => ({ name: nameOfRecipient(v), email: emailOfRecipient(v) })),
      cc: (payload.cc || []).map(v => ({ name: nameOfRecipient(v), email: emailOfRecipient(v) })),
      subject: payload.subject || '',
    },
  });
  const byEmail = new Map(statuses.map(s => [s.email, s]));
  const recipientArmored = [...new Set([
    ...recipients.flatMap(e => byEmail.get(e).keys.map(k => k.armored)),
    ownKey.armoredPublic,
  ])];
  const armored = await encrypt(entityBytes(entity), { recipientArmored, signingKey });

  // What the server needs and nothing more: no body, signature, quote or files in the clear.
  const rest = { ...payload };
  for (const key of ['body', 'bodyIsHtml', 'attachments', 'forwardedAttachments', 'forwardedMessages', 'quotedBody', 'quotedBodyHtml', 'editedSignature']) delete rest[key];
  return { ...rest, body: '', editedSignature: '', pgp: { encrypted: armored } };
}
