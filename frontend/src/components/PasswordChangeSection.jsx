import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { planOwnPasswordChange } from '../utils/pgpPasswordChange.js';
import { loadOwnKeys, ownKeysChanged } from '../utils/pgpOwnKeys.js';
import { announcePasswordChanged, setKeySecret } from '../utils/pgpSecret.js';
import PasswordInput from './PasswordInput.jsx';

// Settings → Security: the signed-in user changes their own password (POST /api/auth/password).
// The OpenPGP keys that unlock with it are encrypted again here for the new one and go in the same
// request (utils/pgpPasswordChange.js), so the server stores both or neither. A key the current
// password does not open cannot be moved: the user is told which, and decides whether to go on.
// Mirrors the server's rule (utils/passwordPolicy.js), so the common mistakes are caught here.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

const input = {
  width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box',
};
const btn = (kind, busy) => ({
  padding: '8px 18px', borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
  border: kind === 'plain' ? '1px solid var(--border)' : 'none',
  background: kind === 'primary' ? 'var(--accent)' : kind === 'danger' ? 'var(--red)' : 'var(--bg-tertiary)',
  color: kind === 'primary' ? 'var(--accent-text)' : kind === 'danger' ? 'var(--status-text)' : 'var(--text-primary)',
});

export function newPasswordProblem(password, confirm) {
  if (password.length < PASSWORD_MIN_LENGTH) return 'short';
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return 'long';
  if (password !== confirm) return 'mismatch';
  return null;
}

export default function PasswordChangeSection() {
  const { t } = useTranslation();
  const user = useStore(s => s.user);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // A change waiting on the user: some keys would stay under an earlier password.
  const [pending, setPending] = useState(null);

  if (!user?.hasPassword) return null;

  const problem = newPasswordProblem(next, confirm);
  const reset = () => { setOpen(false); setCurrent(''); setNext(''); setConfirm(''); setError(''); setPending(null); };

  const errorText = (err) => ({
    wrong_password: t('admin.password.wrongCurrent'),
    rate_limited: t('admin.password.tooMany'),
    password_changed: t('admin.password.changedElsewhere'),
    keysChanging: t('admin.password.keysFailed'),
    wrongPassphrase: t('admin.password.keysFailed'),
  }[err?.code] || t('admin.password.failed', { message: err?.message || '' }));

  const send = async (plan) => {
    await api.changePassword(current, next, plan.pgpKeys);
    // This tab's secret is the new password's from now on; other tabs forget the old one.
    setKeySecret(user.id, plan.secret, { verified: true });
    announcePasswordChanged(user.id);
    // A key left under an earlier password is no longer offered to others (Autocrypt).
    await Promise.all(plan.unopened.filter(k => !k.stale).map(k => api.pgp.markStale(k.id, true).catch(() => {})));
    if (plan.pgpKeys || plan.unopened.length) ownKeysChanged();
    reset();
    setSaved(true);
    setTimeout(() => setSaved(false), 4000);
  };

  const run = async (step) => {
    setBusy(true);
    setError('');
    try {
      await step();
    } catch (err) {
      setPending(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (busy || problem || !current) return;
    run(async () => {
      // Checked first: with a mistyped current password no key would open, and the user would be
      // told about keys when the password is what is wrong.
      const check = await api.pgp.verifyPassword(current);
      if (!check.ok) throw Object.assign(new Error('wrong'), { code: 'wrong_password' });
      const plan = await planOwnPasswordChange({
        currentPassword: current, newPassword: next,
        loadKeys: () => loadOwnKeys({ fresh: true }), fetchSalt: () => api.pgp.kdf(),
      });
      if (plan.unopened.length) setPending(plan);
      else await send(plan);
    });
  };

  const hint = problem === 'short' && next ? t('admin.password.tooShort', { n: PASSWORD_MIN_LENGTH })
    : problem === 'long' ? t('admin.password.tooLong', { n: PASSWORD_MAX_BYTES })
      : problem === 'mismatch' && confirm ? t('admin.password.mismatch') : '';

  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 24px', marginBottom: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{t('admin.password.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14, lineHeight: 1.5 }}>{t('admin.password.description')}</div>

      {!open && (
        <button type="button" onClick={() => { setOpen(true); setSaved(false); }} style={btn('plain', false)}>{t('admin.password.change')}</button>
      )}

      {open && !pending && (
        <form onSubmit={submit} aria-label={t('admin.password.change')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <PasswordInput aria-label={t('admin.password.current')} placeholder={t('admin.password.current')} autoComplete="current-password"
            value={current} onChange={e => setCurrent(e.target.value)} style={input} />
          <PasswordInput aria-label={t('admin.password.new')} placeholder={t('admin.password.new')} autoComplete="new-password"
            value={next} onChange={e => setNext(e.target.value)} style={input} />
          <PasswordInput aria-label={t('admin.password.confirm')} placeholder={t('admin.password.confirm')} autoComplete="new-password"
            value={confirm} onChange={e => setConfirm(e.target.value)}
            style={{ ...input, borderColor: confirm && next !== confirm ? 'var(--red)' : 'var(--border)' }} />
          {hint && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{hint}</div>}
          {busy && <div role="status" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('admin.password.working')}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={reset} disabled={busy} style={btn('plain', busy)}>{t('common.cancel')}</button>
            <button type="submit" disabled={busy || !!problem || !current} style={btn('primary', busy || !!problem || !current)}>{t('admin.password.change')}</button>
          </div>
        </form>
      )}

      {pending && (
        <div role="alertdialog" aria-label={t('admin.password.unopenedTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--amber)' }}>{t('admin.password.unopenedTitle')}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-primary)' }}>
            {pending.unopened.map(k => <li key={k.id} style={{ overflowWrap: 'anywhere' }}>{(k.emails || []).join(', ')}</li>)}
          </ul>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('admin.password.unopenedNote')}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" onClick={reset} disabled={busy} style={btn('plain', busy)}>{t('common.cancel')}</button>
            <button type="button" onClick={() => run(() => send(pending))} disabled={busy} style={btn('danger', busy)}>{t('admin.password.continueAnyway')}</button>
          </div>
        </div>
      )}

      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{error}</div>}
      {saved && <div role="status" style={{ fontSize: 12, color: 'var(--green)', marginTop: 8 }}>{t('admin.password.saved')}</div>}
    </div>
  );
}
