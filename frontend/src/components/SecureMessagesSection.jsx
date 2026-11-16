import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDateTime, formatDay } from '../utils/formatDate.js';
import { openReply, unlock } from '../utils/secureMessageCrypto.js';

// Settings → Mail → Protected messages: the password-protected messages the user sent, whether
// they were opened, and their replies, which are decrypted here with the message's password.
// The server cannot read them.

export const SECURE_REPLY_EVENT = 'mailflow:secure-message-reply';

const button = (kind = 'plain', busy = false) => ({
  padding: '5px 11px', fontSize: 12.5, fontWeight: 500, borderRadius: 6, cursor: busy ? 'default' : 'pointer',
  background: kind === 'primary' ? 'var(--accent)' : kind === 'danger' ? 'var(--red)' : 'var(--bg-tertiary)',
  color: kind === 'primary' ? 'var(--accent-text)' : kind === 'danger' ? '#fff' : 'var(--text-primary)',
  border: kind === 'plain' ? '1px solid var(--border)' : 'none',
  opacity: busy ? 0.6 : 1,
});

function StatusPill({ status }) {
  const { t } = useTranslation();
  const text = {
    active: t('admin.secureMessages.statusActive'),
    expired: t('admin.secureMessages.statusExpired'),
    revoked: t('admin.secureMessages.statusRevoked'),
    locked: t('admin.secureMessages.statusLocked'),
  }[status] || status;
  const color = status === 'active' ? 'var(--green)' : status === 'locked' ? 'var(--red)' : 'var(--text-tertiary)';
  return (
    <span style={{ fontSize: 11.5, fontWeight: 500, color, border: `1px solid ${color}`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' }}>
      {text}
    </span>
  );
}

function Replies({ message, onRead }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replies, setReplies] = useState(null);

  const show = async (e) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      const detail = await api.secureMessages.get(message.id);
      const { encKey } = await unlock(password, detail);
      const opened = [];
      for (const r of detail.replies) {
        try {
          opened.push({ id: r.id, createdAt: r.createdAt, text: (await openReply(encKey, r)).text });
        } catch {
          setError(t('admin.secureMessages.wrongPassword'));
          return;
        }
      }
      setReplies(opened);
      setPassword('');
      if (detail.replies.some(r => !r.readAt)) {
        api.secureMessages.markRead(message.id).then(onRead).catch(() => {});
      }
    } catch (err) {
      setError(err?.message === 'secure_context_required' ? t('compose.secure.errorInsecure') : t('admin.secureMessages.loadFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (replies) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
        {replies.map(r => (
          <div key={r.id} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('admin.secureMessages.replyReceived', { date: formatDateTime(r.createdAt) })}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.text}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <form onSubmit={show} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
      <input
        type="password"
        autoComplete="off"
        value={password}
        onChange={e => setPassword(e.target.value)}
        aria-label={t('admin.secureMessages.passwordPh')}
        placeholder={t('admin.secureMessages.passwordPh')}
        style={{
          flex: '1 1 200px', minWidth: 0, padding: '6px 9px', fontSize: 13, borderRadius: 6,
          border: `1px solid ${error ? 'var(--red)' : 'var(--border)'}`, background: 'var(--bg-primary)', color: 'var(--text-primary)',
        }}
      />
      <button type="submit" disabled={busy || !password} style={button('primary', busy || !password)}>
        {busy ? t('admin.secureMessages.decrypting') : t('admin.secureMessages.showReplies')}
      </button>
      {error && <span role="alert" style={{ fontSize: 12, color: 'var(--red)', flexBasis: '100%' }}>{error}</span>}
    </form>
  );
}

function Row({ message, onChanged }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const act = async (kind, call) => {
    setBusy(kind);
    setError('');
    try {
      await call();
      onChanged();
    } catch {
      setError(t('admin.secureMessages.actionFailed'));
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  const opened = message.firstOpenedAt
    ? t('admin.secureMessages.opened', { date: formatDateTime(message.firstOpenedAt), n: message.openCount })
    : t('admin.secureMessages.notOpened');

  return (
    <li style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
              {message.recipients.join(', ')}
            </span>
            <StatusPill status={message.status} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.6 }}>
            <div>{t('admin.secureMessages.sentOn', { date: formatDay(message.createdAt), expiry: formatDay(message.expiresAt) })}</div>
            <div>{opened}</div>
            {message.replyCount > 0 && (
              <div style={{ color: message.unreadReplyCount ? 'var(--accent)' : undefined }}>
                {message.unreadReplyCount
                  ? t('admin.secureMessages.repliesNew', { n: message.replyCount, unread: message.unreadReplyCount })
                  : t('admin.secureMessages.replies', { n: message.replyCount })}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {message.replyCount > 0 && (
            <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} style={button()}>
              {open ? t('admin.secureMessages.hideReplies') : t('admin.secureMessages.readReplies')}
            </button>
          )}
          {message.status === 'active' && (
            <button type="button" disabled={!!busy} onClick={() => act('revoke', () => api.secureMessages.revoke(message.id))} style={button('plain', busy === 'revoke')}>
              {t('admin.secureMessages.revoke')}
            </button>
          )}
          {confirmDelete ? (
            <>
              <button type="button" disabled={!!busy} onClick={() => act('delete', () => api.secureMessages.remove(message.id))} style={button('danger', busy === 'delete')}>
                {t('admin.secureMessages.confirmDelete')}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} style={button()}>{t('common.cancel')}</button>
            </>
          ) : (
            <button type="button" disabled={!!busy} onClick={() => setConfirmDelete(true)} style={button()}>
              {t('admin.secureMessages.delete')}
            </button>
          )}
        </div>
      </div>
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{error}</div>}
      {open && <Replies message={message} onRead={onChanged} />}
    </li>
  );
}

export default function SecureMessagesSection() {
  const { t } = useTranslation();
  const [messages, setMessages] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    api.secureMessages.list()
      .then((r) => { setMessages(r.messages || []); setLoadFailed(false); })
      .catch(() => setLoadFailed(true));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(SECURE_REPLY_EVENT, load);
    return () => window.removeEventListener(SECURE_REPLY_EVENT, load);
  }, [load]);

  return (
    <section aria-labelledby="secure-messages-title">
      <h3 id="secure-messages-title" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' }}>
        {t('admin.secureMessages.title')}
      </h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
        {t('admin.secureMessages.intro')}
      </p>
      {loadFailed && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{t('admin.secureMessages.loadFailed')}</p>}
      {messages && messages.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.secureMessages.empty')}</p>
      )}
      {messages && messages.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border-subtle)' }}>
          {messages.map(m => <Row key={m.id} message={m} onChanged={load} />)}
        </ul>
      )}
    </section>
  );
}
