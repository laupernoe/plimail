import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { autofillAvailable, cancelPasskeyCeremony, isPasskeyCancel, passkeyBlocker, signInWithPasskey } from '../utils/passkeys.js';

// "Sign in with a passkey" under the sign-in form, and the same passkeys offered in the username
// field's suggestions (conditional mediation) where the browser supports it. Where passkeys
// cannot work (an IP address, another host than the server's), the button is off and says why.
// `onSignedIn(user)`: the passkey signed the user in. No password was typed, so the caller must
// not derive the OpenPGP key secret from the password field (utils/passkeys.js).
export const BLOCKED_KEYS = {
  ip: 'passkeys.blocked.ip',
  server: 'passkeys.blocked.server',
  browser: 'passkeys.blocked.browser',
  otherHost: 'passkeys.blocked.otherHost',
};

export function signInErrorKey(err) {
  if (err?.status === 429) return 'passkeys.errors.tooMany';
  if (err?.status === 401) return 'passkeys.errors.refused';
  if (err?.code === 'challenge') return 'passkeys.errors.expired';
  if (err?.code === 'passwordLoginOff') return 'passkeys.errors.loginOff';
  return 'passkeys.errors.generic';
}

export default function PasskeySignIn({ onSignedIn, disabled = false }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(undefined); // undefined while loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true);
  const manual = useRef(false);
  const done = useRef(onSignedIn);
  done.current = onSignedIn;

  useEffect(() => {
    live.current = true;
    api.passkeys.status().then(s => { if (live.current) setStatus(s); }, () => { if (live.current) setStatus(null); });
    return () => {
      live.current = false;
      cancelPasskeyCeremony();
    };
  }, []);

  const blocker = status === undefined ? null : passkeyBlocker(status);
  const ready = status !== undefined && !blocker;

  // The autofill ceremony waits in the background until a passkey is picked in the username
  // field, and is started again after the button's ceremony replaced it.
  const [autofillRound, setAutofillRound] = useState(0);
  useEffect(() => {
    if (!ready) return undefined;
    let stop = false;
    (async () => {
      if (!(await autofillAvailable()) || stop) return;
      try {
        const user = await signInWithPasskey({ autofill: true, proceed: () => !stop && !manual.current });
        if (!stop && live.current) done.current(user);
      } catch (err) {
        if (!stop && live.current && !isPasskeyCancel(err)) setError(t(signInErrorKey(err)));
      }
    })();
    return () => { stop = true; };
  }, [ready, autofillRound, t]);

  const click = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    manual.current = true;
    try {
      const user = await signInWithPasskey();
      if (live.current) done.current(user);
    } catch (err) {
      if (!live.current) return;
      if (!isPasskeyCancel(err)) setError(t(signInErrorKey(err)));
      manual.current = false;
      setBusy(false);
      setAutofillRound(n => n + 1);
    }
  };

  if (status === undefined) return null;
  const off = !ready || busy || disabled;
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button
        type="button"
        onClick={click}
        disabled={off}
        aria-describedby={blocker ? 'passkey-blocked' : undefined}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: '10px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          borderRadius: 8, color: 'var(--text-primary)', fontSize: 14, fontWeight: 500,
          cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.6 : 1,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="8" cy="15" r="4" /><path d="M10.85 12.15 19 4M18 5l2 2M15 8l2 2" />
        </svg>
        {busy ? t('passkeys.signingIn') : t('passkeys.signIn')}
      </button>
      {blocker && (
        <div id="passkey-blocked" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
          {t(BLOCKED_KEYS[blocker], { host: status?.rpId || '' })}
        </div>
      )}
      {error && (
        <div role="alert" style={{
          padding: '10px 14px', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
          borderRadius: 8, color: 'var(--red)', fontSize: 13,
        }}>{error}</div>
      )}
    </div>
  );
}
