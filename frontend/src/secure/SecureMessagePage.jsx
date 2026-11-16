import { useEffect, useMemo, useRef, useState } from 'react';
import { openMessage, sealReply, unlock } from '../utils/secureMessageCrypto.js';
import { getMeta, openWithKey, postReply } from './api.js';
import { formatDateTime, t } from './i18n.js';
import { attachmentBlobType } from '../utils/attachmentBlobType.js';

// The recipient's page for a password-protected message: the password is turned into keys here,
// the message decrypted here, and a reply encrypted here. The server sees neither.

export const tokenFromPath = (pathname) => {
  const m = /^\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname || '');
  return m ? m[1] : null;
};

// The decrypted HTML came from the sender's composer, but is treated as untrusted all the same:
// it is shown in a frame sandboxed without scripts or same-origin access (and the page's CSP
// inherited by srcdoc blocks remote images), links opening in a new tab without a referrer.
export function frameDocument(html) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="referrer" content="no-referrer"><base target="_blank">'
    + '<style>body{margin:16px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:15px;line-height:1.5;'
    + 'color:#1b222c;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}'
    + 'blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex}</style>'
    + `</head><body>${html}</body></html>`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const card = {
  background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: '22px 24px',
};
const primaryButton = busy => ({
  padding: '10px 18px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 14,
  background: 'var(--accent)', color: 'var(--accent-text)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1,
});
const muted = { color: 'var(--text-secondary)', fontSize: 13.5, margin: 0 };

function LockMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="10.5" width="16" height="10.5" rx="2.2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15.6" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function Notice({ title, body, action }) {
  return (
    <div style={card} role="status">
      <h1 style={{ fontSize: 19, fontWeight: 650, margin: '0 0 8px' }}>{title}</h1>
      <p style={{ ...muted, fontSize: 14.5 }}>{body}</p>
      {action}
    </div>
  );
}

const senderLabel = meta => meta?.senderName || meta?.senderEmail || '';

export default function SecureMessagePage({ token }) {
  const [phase, setPhase] = useState(token ? 'loading' : 'unavailable');
  const [meta, setMeta] = useState(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [message, setMessage] = useState(null);
  const keysRef = useRef(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    getMeta(token)
      .then((m) => { if (!cancelled) { setMeta(m); setPhase(globalThis.crypto?.subtle ? 'password' : 'insecure'); } })
      .catch((err) => {
        if (cancelled) return;
        setPhase(err.status === 404 ? 'unavailable' : err.code === 'rate_limited' ? 'rateLimited' : 'error');
      });
    return () => { cancelled = true; };
  }, [token, loadAttempt]);

  // Blob URLs for the attachments, given back when the page lets them go. The link keeps the
  // file's name; its type is the sender's only for a raster image (attachmentBlobType.js).
  const attachmentUrls = useMemo(() => (message?.attachments || []).map(a => URL.createObjectURL(new Blob([a.data], { type: attachmentBlobType(a.mimeType) }))), [message]);
  useEffect(() => () => attachmentUrls.forEach(u => URL.revokeObjectURL(u)), [attachmentUrls]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setFormError('');
    try {
      const keys = await unlock(password, meta);
      let sealed;
      try {
        sealed = await openWithKey(token, keys.authKeyHex);
      } catch (err) {
        if (err.code === 'wrong_password') {
          setFormError(Number.isInteger(err.remainingAttempts)
            ? t('securePage.wrongPasswordLeft', { count: err.remainingAttempts })
            : t('securePage.wrongPassword'));
        } else if (err.code === 'locked') setPhase('locked');
        else if (err.status === 404) setPhase('unavailable');
        else if (err.code === 'rate_limited') setFormError(t('securePage.rateLimited'));
        else setFormError(t('securePage.loadFailed'));
        return;
      }
      try {
        setMessage(await openMessage(keys.encKey, sealed));
      } catch {
        setFormError(t('securePage.decryptFailed'));
        return;
      }
      keysRef.current = keys;
      setPassword('');
      setPhase('open');
    } catch {
      setFormError(t('securePage.decryptFailed'));
    } finally {
      setBusy(false);
    }
  };

  let content;
  if (phase === 'loading') {
    content = <p style={muted}>{t('securePage.loading')}</p>;
  } else if (phase === 'unavailable') {
    content = <Notice title={t('securePage.unavailableTitle')} body={t('securePage.unavailableBody')} />;
  } else if (phase === 'locked') {
    content = <Notice title={t('securePage.lockedTitle')} body={t('securePage.lockedBody')} />;
  } else if (phase === 'insecure') {
    content = <Notice title={t('securePage.title')} body={t('securePage.insecure')} />;
  } else if (phase === 'error' || phase === 'rateLimited') {
    content = (
      <Notice
        title={t('securePage.title')}
        body={phase === 'rateLimited' ? t('securePage.rateLimited') : t('securePage.loadFailed')}
        action={(
          <button type="button" style={{ ...primaryButton(false), marginTop: 16 }} onClick={() => { setPhase('loading'); setLoadAttempt(n => n + 1); }}>
            {t('securePage.retry')}
          </button>
        )}
      />
    );
  } else if (phase === 'password') {
    content = (
      <form style={card} onSubmit={submit}>
        <h1 style={{ fontSize: 19, fontWeight: 650, margin: '0 0 4px' }}>
          {t('securePage.sentYou', { name: senderLabel(meta) })}
        </h1>
        {meta.senderName && meta.senderEmail && (
          <p style={{ ...muted, margin: '0 0 14px' }}>{meta.senderEmail}</p>
        )}
        <p style={{ fontSize: 14.5, margin: '0 0 18px' }}>
          {t('securePage.passwordHint', { name: senderLabel(meta) })}
        </p>
        <label htmlFor="secure-password" style={{ display: 'block', fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>
          {t('securePage.passwordLabel')}
        </label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            id="secure-password"
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            onChange={e => setPassword(e.target.value)}
            aria-invalid={formError ? 'true' : undefined}
            aria-describedby={formError ? 'secure-password-error' : undefined}
            style={{
              flex: '1 1 220px', padding: '10px 12px', borderRadius: 8, fontSize: 15,
              border: `1px solid ${formError ? 'var(--red)' : 'var(--border)'}`,
              background: 'var(--bg-primary)', color: 'var(--text-primary)',
            }}
          />
          <button type="submit" disabled={busy || !password} style={primaryButton(busy || !password)}>
            {busy ? t('securePage.opening') : t('securePage.open')}
          </button>
        </div>
        {formError && (
          <p id="secure-password-error" role="alert" style={{ color: 'var(--red)', fontSize: 13.5, margin: '10px 0 0' }}>{formError}</p>
        )}
        <p style={{ ...muted, marginTop: 18 }}>{t('securePage.neverAsks')}</p>
        {meta.expiresAt && (
          <p style={{ ...muted, marginTop: 6 }}>{t('securePage.expires', { date: formatDateTime(meta.expiresAt) })}</p>
        )}
      </form>
    );
  } else if (phase === 'open') {
    content = (
      <>
        <article style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <header style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)' }}>
            <h1 style={{ fontSize: 19, fontWeight: 650, margin: '0 0 4px', overflowWrap: 'anywhere' }}>
              {message.subject || t('securePage.noSubject')}
            </h1>
            <p style={muted}>
              {meta.senderName ? `${meta.senderName} <${meta.senderEmail}>` : meta.senderEmail}
            </p>
          </header>
          {message.attachments.length > 0 && (
            <section aria-label={t('securePage.attachments')} style={{ padding: '12px 24px', borderBottom: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {message.attachments.map((a, i) => (
                <a
                  key={`${i}-${a.filename}`}
                  href={attachmentUrls[i]}
                  download={a.filename}
                  title={t('securePage.download')}
                  style={{
                    display: 'inline-flex', gap: 8, alignItems: 'baseline', padding: '6px 10px', borderRadius: 7,
                    background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)',
                    textDecoration: 'none', fontSize: 13.5, maxWidth: '100%',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>{formatSize(a.data.length)}</span>
                </a>
              ))}
            </section>
          )}
          {message.html ? (
            <iframe
              title={message.subject || t('securePage.noSubject')}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              srcDoc={frameDocument(message.html)}
              style={{ display: 'block', width: '100%', height: 'min(70vh, 640px)', border: 'none', background: '#fff', resize: 'vertical' }}
            />
          ) : (
            <div style={{ padding: '18px 24px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 15 }}>{message.text}</div>
          )}
        </article>
        <ReplyBox token={token} keysRef={keysRef} senderName={senderLabel(meta)} />
      </>
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '32px 16px 48px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, color: 'var(--accent)' }}>
        <LockMark />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('securePage.title')}</span>
      </div>
      {content}
      {phase === 'open' && (
        <p style={{ ...muted, marginTop: 16, textAlign: 'center' }}>{t('securePage.decryptedHere')}</p>
      )}
    </main>
  );
}

function ReplyBox({ token, keysRef, senderName }) {
  const [text, setText] = useState('');
  const [state, setState] = useState(null); // null | 'sending' | 'sent' | error text
  const [sentCount, setSentCount] = useState(0);
  const sending = state === 'sending';

  const send = async (e) => {
    e.preventDefault();
    if (sending || !text.trim() || !keysRef.current) return;
    setState('sending');
    try {
      const sealed = await sealReply(keysRef.current.encKey, text);
      await postReply(token, keysRef.current.authKeyHex, sealed);
      setText('');
      setSentCount(n => n + 1);
      setState('sent');
    } catch (err) {
      if (err.code === 'reply_limit') setState(t('securePage.replyLimit'));
      else if (err.code === 'too_large') setState(t('securePage.replyTooLarge'));
      else if (err.code === 'rate_limited') setState(t('securePage.rateLimited'));
      else if (err.status === 404 || err.code === 'locked') setState(t('securePage.unavailableTitle'));
      else setState(t('securePage.replyFailed'));
    }
  };

  const errorText = state && state !== 'sending' && state !== 'sent' ? state : '';
  return (
    <form style={{ ...card, marginTop: 16 }} onSubmit={send}>
      <h2 style={{ fontSize: 16, fontWeight: 650, margin: '0 0 4px' }}>{t('securePage.replyTitle')}</h2>
      <p style={{ ...muted, margin: '0 0 12px' }}>{t('securePage.replyHint', { name: senderName })}</p>
      <textarea
        value={text}
        onChange={e => { setText(e.target.value); if (state === 'sent') setState(null); }}
        rows={5}
        aria-label={t('securePage.replyTitle')}
        placeholder={t('securePage.replyPlaceholder')}
        style={{
          width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', resize: 'vertical',
          background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 15,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="submit" disabled={sending || !text.trim()} style={primaryButton(sending || !text.trim())}>
          {sending ? t('securePage.sendingReply') : t('securePage.sendReply')}
        </button>
        {state === 'sent' && <span role="status" style={{ color: 'var(--green)', fontSize: 13.5 }}>{t('securePage.replySent')}</span>}
        {errorText && <span role="alert" style={{ color: 'var(--red)', fontSize: 13.5 }}>{errorText}</span>}
        {sentCount > 1 && state !== 'sent' && !errorText && (
          <span style={{ ...muted }}>{t('securePage.repliesSent', { count: sentCount })}</span>
        )}
      </div>
    </form>
  );
}
