import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { receiptAction } from '../utils/readReceipt.js';

// "The sender asks for a read receipt" (RFC 8098), shown above the message with Send and Ignore.
// Mount it with key={message.id}: it asks the server once per message, and only for a message that
// was unread when it was opened, which is when a receipt is due (and keeps the mail server from
// being asked about every message that is reopened). Nothing is sent without a click, unless the
// user chose "always send" in the settings; the server refuses spam, lists and automatic mail.
export default function ReadReceiptBanner({ message }) {
  const { t } = useTranslation();
  const mode = useStore(s => s.readReceiptReply);
  const [unreadOnOpen] = useState(() => message.is_read === false);
  const [verdict, setVerdict] = useState(null); // 'ask' | 'confirm' | null
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const askedRef = useRef(false);

  useEffect(() => {
    if (!unreadOnOpen || mode === 'never' || askedRef.current) return undefined;
    askedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const info = await api.getReadReceipt(message.id);
        const action = receiptAction({ status: info.status, mode });
        if (cancelled) return;
        if (action === 'auto') {
          await api.answerReadReceipt(message.id, 'send').catch(() => {});
        } else if (action !== 'none') {
          setVerdict(action);
        }
      } catch { /* a failed lookup shows nothing: the next opening asks again */ }
    })();
    return () => { cancelled = true; };
  }, [message.id, unreadOnOpen, mode]);

  if (!verdict) return null;

  const answer = async action => {
    setBusy(true);
    setError('');
    try {
      await api.answerReadReceipt(message.id, action, verdict === 'confirm');
      setVerdict(null);
    } catch {
      setError(action === 'send' ? t('message.readReceipt.sendFailed') : t('message.readReceipt.ignoreFailed'));
      setBusy(false);
    }
  };

  const button = primary => ({
    background: 'none', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 9px',
    cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, fontSize: 11, fontWeight: 500,
    color: primary ? 'var(--accent)' : 'var(--text-primary)',
  });

  return (
    <div className="msg-notice" role="status" style={{
      marginBottom: 10, padding: '9px 14px', background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${verdict === 'confirm' ? 'var(--red)' : 'var(--text-tertiary)'}`,
      borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      fontSize: 12, color: 'var(--text-secondary)',
    }}>
      <span style={{ flex: 1 }}>
        {t('message.readReceipt.info')}
        {verdict === 'confirm' && <> {t('message.readReceipt.mismatch')}</>}
        {error && <span style={{ color: 'var(--red)' }}> {error}</span>}
      </span>
      <button type="button" disabled={busy} onClick={() => answer('send')} style={button(true)}>
        {t('message.readReceipt.send')}
      </button>
      <button type="button" disabled={busy} onClick={() => answer('ignore')} style={button(false)}>
        {t('message.readReceipt.ignore')}
      </button>
    </div>
  );
}
