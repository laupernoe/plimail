import { fromBase64, passwordStrength, sealMessage } from './secureMessageCrypto.js';
import { wrapComposeFont } from './composeFont.js';

// Sending a password-protected message from the composer: the message is encrypted here and
// stored on the server as ciphertext, and the recipients get an ordinary email that says who
// sent it and links to it, without its subject or any of its content. That notice is what goes
// through the normal send path and what the Sent folder keeps.

export const SECURE_EXPIRY_DAYS = [1, 7, 30];
export const SECURE_DEFAULT_EXPIRY_DAYS = 7;
export const SECURE_MIN_PASSWORD = 8;
// The composer's attachment limit, which the server's ciphertext cap leaves room for.
export const SECURE_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class SecureSendError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// What stops the composer's protection settings from being used, as a code, or null.
export function secureSettingsProblem({ password = '', confirm = '' } = {}) {
  if (passwordStrength(password) === 'tooShort') return 'tooShort';
  if (password !== confirm) return 'mismatch';
  return null;
}

const escapeHtml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const htmlToText = html => String(html || '')
  .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/blockquote)\b[^>]*>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

// The message as the recipient will read it, from the request body the composer would send
// (buildSendPayload's payload) and its attachments as the composer holds them ({ name, type,
// data: base64 }). The signature is included as the user sees it in the composer.
export function securePayloadFrom(payload, attachments = []) {
  const sig = typeof payload.editedSignature === 'string' ? payload.editedSignature : '';
  let html = '';
  let text;
  if (payload.bodyIsHtml) {
    // Wrapped in the writing font as the server wraps a message it builds (outgoingMail.js).
    html = wrapComposeFont((payload.body || '')
      + (sig ? `<div style="margin-top:16px;color:#555;font-size:13px">${sig}</div>` : ''), payload.composeFont)
      + (payload.quotedBodyHtml || '');
    text = htmlToText(html);
  } else {
    text = (payload.body || '') + (sig ? `\n\n-- \n${sig}` : '') + (payload.quotedBody || '');
  }
  return {
    subject: payload.subject || '',
    html,
    text,
    attachments: attachments.map(a => ({
      filename: a.name || 'attachment',
      mimeType: a.type || 'application/octet-stream',
      data: fromBase64(a.data || ''),
    })),
  };
}

// The email the recipients get in its place, in the sender's language (t is the app's).
export function noticeEmail({ t, senderName, url, expiresAt, formatDate, html = true }) {
  const name = senderName || '';
  const date = formatDate(expiresAt);
  const subject = t('compose.secure.noticeSubject', { name });
  const lines = [
    t('compose.secure.noticeIntro', { name }),
    t('compose.secure.noticeOpen'),
    url,
    t('compose.secure.noticeExpires', { date }),
    t('compose.secure.noticePassword', { name }),
  ];
  if (!html) return { subject, body: lines.join('\n\n') };
  const safeUrl = escapeHtml(url);
  const body = [
    `<p>${escapeHtml(lines[0])}</p>`,
    `<p>${escapeHtml(lines[1])}<br><a href="${safeUrl}">${safeUrl}</a></p>`,
    `<p>${escapeHtml(lines[3])}</p>`,
    `<p>${escapeHtml(lines[4])}</p>`,
  ].join('');
  return { subject, body };
}

// The whole send. `built` is the composer's buildSendPayload result; `api` has
// secureMessages.create/remove and post. Resolves with the send's answer. If the notice fails to
// go, the protected message just made is deleted again, so no link exists that no one was sent.
export async function sendProtected({ built, attachments, forwardedCount = 0, settings, t, formatDate, api, idempotencyKey, seal = sealMessage }) {
  if (forwardedCount > 0) throw new SecureSendError('forwarded');
  const total = attachments.reduce((n, a) => n + (a.size ?? Math.floor((a.data || '').length * 3 / 4)), 0);
  if (total > SECURE_MAX_ATTACHMENT_BYTES) throw new SecureSendError('tooLarge');
  if (!globalThis.crypto?.subtle) throw new SecureSendError('insecure');

  const { payload, toFinal, ccFinal, bccFinal } = built;
  const sealed = await seal(settings.password, securePayloadFrom(payload, attachments));
  const created = await api.secureMessages.create({
    accountId: payload.accountId,
    ...(payload.aliasId ? { aliasId: payload.aliasId } : {}),
    recipients: [...toFinal, ...ccFinal, ...bccFinal],
    ...sealed,
    expiresInDays: settings.expiresInDays || SECURE_DEFAULT_EXPIRY_DAYS,
  });

  const notice = noticeEmail({
    t, formatDate, url: created.url, expiresAt: created.expiresAt,
    senderName: created.senderName || created.senderEmail, html: payload.bodyIsHtml,
  });
  // Nothing of the message itself goes with the notice: no attachments, no quoted text.
  const rest = { ...payload };
  for (const key of ['attachments', 'forwardedAttachments', 'forwardedMessages', 'quotedBody', 'quotedBodyHtml']) delete rest[key];
  try {
    return await api.post('/mail/send', {
      ...rest,
      subject: notice.subject,
      body: notice.body,
      editedSignature: '',
      // Sent at once: undoing would leave a link no one was sent, and the server is not told.
      undoSeconds: 0,
    }, idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : undefined);
  } catch (err) {
    await api.secureMessages.remove(created.id).catch(() => {});
    throw err;
  }
}
