import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

// Notifications settings, per mailbox: the same notifications_muted switch as the account's own
// settings, in one list. The server reads it when mail arrives, so it silences push, sound and
// the in-app alert together; unread counts and badges are not touched.
export default function NotificationAccounts() {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const updateAccount = useStore(s => s.updateAccount);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  if (!accounts?.length) return null;

  const toggle = async (account) => {
    if (busy) return;
    const muted = account.notifications_muted === true;
    setError('');
    setBusy(account.id);
    try {
      await api.updateAccount(account.id, { notifications_muted: !muted });
      updateAccount(account.id, { notifications_muted: !muted });
    } catch (err) {
      setError(err?.message || t('admin.notifications.mailboxesError'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ height: 1, background: 'var(--border-subtle)', marginBottom: 24 }} />
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.notifications.mailboxesTitle')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        {t('admin.notifications.mailboxesDescription')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {accounts.map(account => {
          const on = account.notifications_muted !== true;
          const label = account.name || account.email_address;
          return (
            <div key={account.id} data-testid="notification-account" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', borderRadius: 10,
              background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 2 }}>{label}</div>
                {account.name && account.email_address && (
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{account.email_address}</div>
                )}
              </div>
              <button
                type="button"
                aria-pressed={on}
                aria-label={label}
                disabled={busy === account.id}
                onClick={() => toggle(account)}
                style={{
                  padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 500,
                  cursor: 'pointer', transition: 'all 0.15s', flexShrink: 0, marginLeft: 16,
                  background: on ? 'var(--accent)' : 'transparent',
                  color: on ? 'var(--accent-text)' : 'var(--text-secondary)',
                  border: on ? '1px solid transparent' : '1px solid var(--border)',
                }}
              >
                {on ? t('admin.notifications.badgeOn') : t('admin.notifications.badgeOff')}
              </button>
            </div>
          );
        })}
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{error}</div>}
    </div>
  );
}
