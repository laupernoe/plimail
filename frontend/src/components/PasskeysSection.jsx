import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { formatDateTime } from '../utils/formatDate.js';
import { addPasskey, isPasskeyCancel, passkeyBlocker } from '../utils/passkeys.js';
import PasswordInput from './PasswordInput.jsx';
import { BLOCKED_KEYS } from './PasskeySignIn.jsx';

// The user's passkeys, in Settings → Security after two-factor (routes/passkeys.js). Adding or
// removing one asks for the Plimail password first; renaming does not.

const cardStyle = {
  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
  borderRadius: 12, padding: '20px 24px', marginBottom: 20,
};
const inputStyle = {
  width: '100%', padding: '9px 12px',
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13,
  outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box',
};
const focusRing = {
  onFocus: e => { e.target.style.borderColor = 'var(--accent)'; },
  onBlur: e => { e.target.style.borderColor = 'var(--border)'; },
};
const primaryButton = (disabled, danger = false) => ({
  padding: '8px 16px', background: danger ? 'var(--red)' : 'var(--accent)', border: 'none',
  borderRadius: 7, color: danger ? 'var(--status-text)' : 'var(--accent-text)', fontSize: 13, fontWeight: 500,
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1, flexShrink: 0,
});
const secondaryButton = {
  padding: '8px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', flexShrink: 0,
};
const smallButton = (color = 'var(--text-secondary)') => ({
  padding: '5px 10px', fontSize: 12, borderRadius: 6, flexShrink: 0, cursor: 'pointer',
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color,
});
const errorBox = {
  padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
  border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8,
  color: 'var(--red)', fontSize: 13,
};
const hintStyle = { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 };

// What went wrong with a request, as a sentence for this card.
export function passkeyErrorKey(err) {
  if (err?.status === 429) return 'passkeys.errors.tooMany';
  if (err?.status === 400 && err?.message === 'Incorrect password') return 'passkeys.errors.wrongPassword';
  if (err?.code === 'challenge') return 'passkeys.errors.expired';
  if (err?.code === 'noPassword') return 'passkeys.settings.noPassword';
  if (err?.code === 'tooMany' || err?.code === 'notAdded') return 'passkeys.errors.notAdded';
  if (err?.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'passkeys.errors.alreadyOnDevice';
  return 'passkeys.errors.generic';
}

export default function PasskeysSection() {
  const { t } = useTranslation();
  const userId = useStore(s => s.user?.id ?? null);
  const hasPassword = useStore(s => s.user?.hasPassword !== false);

  const [status, setStatus] = useState(undefined);
  const [passkeys, setPasskeys] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [removingId, setRemovingId] = useState(null);
  const [rowError, setRowError] = useState(null); // { id, message }

  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const { passkeys: list } = await api.passkeys.list();
      if (mine !== seq.current) return;
      setPasskeys(list);
      setLoadFailed(false);
    } catch {
      if (mine === seq.current) setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    api.passkeys.status().then(setStatus, () => setStatus(null));
    load();
  }, [userId, load]);

  const blocker = status === undefined ? null : passkeyBlocker(status);

  const closeAdd = () => { setAdding(false); setNewName(''); setPassword(''); setError(''); };
  const closeRow = () => { setRenamingId(null); setRemovingId(null); setPassword(''); setRowError(null); };

  const submitAdd = async (e) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      await addPasskey({ password, name: newName.trim() });
      closeAdd();
      await load();
    } catch (err) {
      setPassword('');
      if (!isPasskeyCancel(err)) setError(t(passkeyErrorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async (e, id) => {
    e.preventDefault();
    if (busy || !renameValue.trim()) return;
    setBusy(true);
    try {
      await api.passkeys.rename(id, renameValue.trim());
      closeRow();
      await load();
    } catch (err) {
      setRowError({ id, message: t(passkeyErrorKey(err)) });
    } finally {
      setBusy(false);
    }
  };

  const submitRemove = async (e, id) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    try {
      await api.passkeys.remove(id, password);
      closeRow();
      await load();
    } catch (err) {
      setPassword('');
      setRowError({ id, message: t(passkeyErrorKey(err)) });
    } finally {
      setBusy(false);
    }
  };

  const used = pk => (pk.lastUsedAt
    ? t('passkeys.settings.lastUsed', { date: formatDateTime(pk.lastUsedAt) })
    : t('passkeys.settings.neverUsed'));

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('passkeys.settings.title')}</div>
        {!adding && !blocker && status !== undefined && hasPassword && (
          <button type="button" onClick={() => { closeRow(); setAdding(true); }} style={primaryButton(false)}>
            {t('passkeys.settings.add')}
          </button>
        )}
      </div>
      <div style={{ ...hintStyle, marginBottom: 14 }}>{t('passkeys.settings.description')}</div>

      {blocker && <div style={{ ...hintStyle, color: 'var(--text-secondary)', marginBottom: 14 }}>{t(BLOCKED_KEYS[blocker], { host: status?.rpId || '' })}</div>}
      {!hasPassword && <div style={{ ...hintStyle, color: 'var(--text-secondary)', marginBottom: 14 }}>{t('passkeys.settings.noPassword')}</div>}

      {adding && (
        <form onSubmit={submitAdd} style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 14 }}>
          <input
            type="text" value={newName} maxLength={64} onChange={e => setNewName(e.target.value)} disabled={busy} autoFocus
            aria-label={t('passkeys.settings.nameLabel')} placeholder={t('passkeys.settings.namePh')} style={inputStyle} {...focusRing}
          />
          <div style={hintStyle}>{t('passkeys.settings.confirmPassword')}</div>
          <PasswordInput
            value={password} onChange={e => setPassword(e.target.value)} disabled={busy} autoComplete="current-password"
            aria-label={t('login.password')} placeholder={t('login.password')} style={inputStyle} {...focusRing}
          />
          {error && <div role="alert" style={errorBox}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy || !password} style={primaryButton(busy || !password)}>
              {busy ? t('passkeys.settings.adding') : t('passkeys.settings.addGo')}
            </button>
            <button type="button" onClick={closeAdd} disabled={busy} style={secondaryButton}>{t('common.cancel')}</button>
          </div>
        </form>
      )}

      {loadFailed && <div role="alert" style={errorBox}>{t('passkeys.settings.loadFailed')}</div>}
      {passkeys && passkeys.length === 0 && !adding && <div style={hintStyle}>{t('passkeys.settings.none')}</div>}
      {passkeys && passkeys.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {passkeys.map(pk => (
            <li key={pk.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px', background: 'var(--bg-tertiary)' }}>
              {renamingId === pk.id ? (
                <form onSubmit={e => submitRename(e, pk.id)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="text" value={renameValue} maxLength={64} onChange={e => setRenameValue(e.target.value)} disabled={busy} autoFocus
                    aria-label={t('passkeys.settings.nameLabel')} style={{ ...inputStyle, flex: '1 1 160px', width: 'auto' }} {...focusRing}
                  />
                  <button type="submit" disabled={busy || !renameValue.trim()} style={primaryButton(busy || !renameValue.trim())}>{t('passkeys.settings.save')}</button>
                  <button type="button" onClick={closeRow} disabled={busy} style={secondaryButton}>{t('common.cancel')}</button>
                </form>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{pk.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
                      {t('passkeys.settings.added', { date: formatDateTime(pk.createdAt) })} · {used(pk)}
                    </div>
                  </div>
                  {removingId !== pk.id && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" onClick={() => { closeAdd(); closeRow(); setRenamingId(pk.id); setRenameValue(pk.name); }} style={smallButton()}>
                        {t('passkeys.settings.rename')}
                      </button>
                      {hasPassword && (
                        <button type="button" onClick={() => { closeAdd(); closeRow(); setRemovingId(pk.id); }} style={smallButton('var(--red)')}>
                          {t('passkeys.settings.remove')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {removingId === pk.id && (
                <form onSubmit={e => submitRemove(e, pk.id)} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  <div style={hintStyle}>{t('passkeys.settings.removeConfirm', { name: pk.name })}</div>
                  <PasswordInput
                    value={password} onChange={e => setPassword(e.target.value)} disabled={busy} autoComplete="current-password" autoFocus
                    aria-label={t('login.password')} placeholder={t('login.password')} style={inputStyle} {...focusRing}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="submit" disabled={busy || !password} style={primaryButton(busy || !password, true)}>{t('passkeys.settings.removeGo')}</button>
                    <button type="button" onClick={closeRow} disabled={busy} style={secondaryButton}>{t('common.cancel')}</button>
                  </div>
                </form>
              )}
              {rowError?.id === pk.id && <div role="alert" style={{ ...errorBox, marginTop: 8 }}>{rowError.message}</div>}
            </li>
          ))}
        </ul>
      )}
      <div style={{ ...hintStyle, marginTop: 14 }}>{t('passkeys.settings.pgpNote')}</div>
    </div>
  );
}
