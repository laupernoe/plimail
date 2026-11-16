import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { unlockPrivateKey } from '../utils/pgp.js';
import { isLoginKey, rewrapLoginKeys } from '../utils/pgpKeys.js';
import { loadOwnKeys, ownKeysChanged } from '../utils/pgpOwnKeys.js';
import { deriveKeySecret, keySecret, setKeySecret } from '../utils/pgpSecret.js';
import { rememberUnlockedKey } from '../utils/pgpSession.js';
import { cancelUnlock, currentUnlockRequest, finishUnlock, subscribeUnlock } from '../utils/pgpUnlock.js';
import { trapTab } from './SendLater.jsx';
import { button } from './pgpStyles.js';

// The one question encryption ever asks of most users: their Plimail password, when a key
// protected by it is needed and this tab does not have the secret yet (utils/pgpUnlock.js).
//   'password'  the Plimail password; checked with the server, then against the keys
//   'previous'  the keys were protected under an earlier password (it was reset or changed):
//               that one opens them, and they are encrypted again for the current one
//   'lost'      the earlier password is gone too: what that means, and what to do
//   'create'    an SSO user without a Plimail password and without keys chooses a password for
//               their keys, the fallback when there is no sign-in password to derive from
export const MIN_ENCRYPTION_PASSWORD = 8;

const input = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 14, borderRadius: 7,
  border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none',
};

export default function PgpUnlockPrompt() {
  const request = useSyncExternalStore(subscribeUnlock, currentUnlockRequest);
  if (!request) return null;
  return <UnlockDialog key={request.id} stale={request.options?.stale === true} />;
}

function UnlockDialog({ stale }) {
  const { t } = useTranslation();
  const user = useStore(s => s.user);
  const titleId = useId();
  const boxRef = useRef(null);
  const [step, setStep] = useState(stale ? 'previous' : null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [keys, setKeys] = useState(null);
  const hasPassword = user?.hasPassword !== false;

  useEffect(() => {
    let live = true;
    loadOwnKeys().then(
      (all) => {
        if (!live) return;
        const mine = all.filter(isLoginKey);
        setKeys(mine);
        setStep(s => s || (!hasPassword && !mine.length ? 'create' : 'password'));
      },
      () => { if (live) { setKeys([]); setStep(s => s || 'password'); } },
    );
    return () => { live = false; };
  }, [hasPassword]);
  useEffect(() => { if (stale) setStep('previous'); }, [stale]);
  useEffect(() => { boxRef.current?.querySelector('input')?.focus(); }, [step]);

  const derive = async (pw) => deriveKeySecret(pw, (await api.pgp.kdf()).salt);
  const fail = (text) => { setError(text); setBusy(false); };

  const submitPassword = async () => {
    let verified = false;
    if (hasPassword) {
      const check = await api.pgp.verifyPassword(password);
      if (check.hasPassword && !check.ok) return fail(t('pgp.unlock.wrongPassword'));
      verified = check.hasPassword === true;
    }
    const secret = await derive(password);
    const first = (keys || [])[0];
    if (first) {
      try {
        rememberUnlockedKey(first.fingerprint, await unlockPrivateKey(first.armoredPrivate, secret));
      } catch {
        if (!verified) return fail(t('pgp.unlock.wrongForKeys'));
        // The password is right, and the keys do not open with it: an earlier one protects them.
        setKeySecret(user.id, secret, { verified: true });
        setPassword('');
        setBusy(false);
        setStep('previous');
        return;
      }
    }
    setKeySecret(user.id, secret, { verified });
    finishUnlock();
  };

  const submitPrevious = async () => {
    const to = keySecret(user.id);
    if (!to) { setStep('password'); return fail(''); }
    const from = await derive(password);
    let updates;
    try {
      updates = await rewrapLoginKeys(keys || [], { from, to });
    } catch {
      return fail(t('pgp.unlock.wrongPrevious'));
    }
    if (updates.length) await api.pgp.setProtection(updates);
    ownKeysChanged();
    finishUnlock();
  };

  const submitCreate = async () => {
    if (password.length < MIN_ENCRYPTION_PASSWORD) return fail(t('pgp.unlock.tooShort', { n: MIN_ENCRYPTION_PASSWORD }));
    if (password !== confirm) return fail(t('pgp.unlock.mismatch'));
    setKeySecret(user.id, await derive(password), { verified: false });
    finishUnlock();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !password || !user) return;
    setBusy(true);
    setError('');
    try {
      if (step === 'previous') await submitPrevious();
      else if (step === 'create') await submitCreate();
      else await submitPassword();
    } catch (err) {
      fail(err?.status === 429 ? t('pgp.unlock.tooMany') : t('pgp.errors.generic'));
    }
  };

  const title = {
    password: t('pgp.unlock.title'),
    previous: t('pgp.unlock.previousTitle'),
    lost: t('pgp.unlock.lostTitle'),
    create: t('pgp.unlock.createTitle'),
  }[step] || t('pgp.unlock.title');
  const body = {
    password: hasPassword ? t('pgp.unlock.body') : t('pgp.unlock.bodySso'),
    previous: t('pgp.unlock.previousBody'),
    lost: t('pgp.unlock.lostBody'),
    create: t('pgp.unlock.createBody'),
  }[step];

  return (
    <>
      <div onClick={() => !busy && cancelUnlock()} style={{ position: 'fixed', inset: 0, zIndex: 3100, background: 'rgba(0,0,0,0.45)' }} />
      <form
        ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); cancelUnlock(); } else trapTab(e, boxRef.current);
        }}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 3101,
          width: 'min(380px, calc(100vw - 32px))', boxSizing: 'border-box', background: 'var(--bg-elevated)',
          borderRadius: 12, boxShadow: 'var(--shadow-modal)', padding: '20px 22px 16px',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div id={titleId} style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--accent)' }}>
            <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          {title}
        </div>
        {body && <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{body}</p>}
        {step && step !== 'lost' && (
          <>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy}
              autoComplete={step === 'create' ? 'new-password' : step === 'previous' ? 'off' : 'current-password'}
              aria-label={step === 'previous' ? t('pgp.unlock.previousLabel') : step === 'create' ? t('pgp.unlock.createLabel') : t('pgp.unlock.label')}
              placeholder={step === 'previous' ? t('pgp.unlock.previousLabel') : step === 'create' ? t('pgp.unlock.createLabel') : t('pgp.unlock.label')}
              style={{ ...input, borderColor: error ? 'var(--red)' : 'var(--border)' }}
            />
            {step === 'create' && (
              <input
                type="password" value={confirm} onChange={e => setConfirm(e.target.value)} disabled={busy} autoComplete="new-password"
                aria-label={t('pgp.unlock.confirmLabel')} placeholder={t('pgp.unlock.confirmLabel')} style={input}
              />
            )}
          </>
        )}
        {error && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--red)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {step && step !== 'lost' && (
            <button type="submit" disabled={busy || !password} style={button('primary', busy || !password)}>
              {busy ? t('pgp.unlock.working') : step === 'create' ? t('pgp.unlock.createGo') : t('pgp.unlock.go')}
            </button>
          )}
          <button type="button" disabled={busy} onClick={cancelUnlock} style={button()}>
            {step === 'lost' ? t('pgp.unlock.close') : t('common.cancel')}
          </button>
          {step === 'previous' && (
            <button type="button" disabled={busy} onClick={() => { setError(''); setStep('lost'); }}
              style={{ background: 'none', border: 'none', padding: 0, fontSize: 12.5, color: 'var(--text-secondary)', textDecoration: 'underline', cursor: 'pointer' }}>
              {t('pgp.unlock.forgotPrevious')}
            </button>
          )}
        </div>
      </form>
    </>
  );
}
