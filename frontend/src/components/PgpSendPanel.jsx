import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { shortFingerprint } from '../utils/pgp.js';
import { isLoginKey } from '../utils/pgpKeys.js';
import { loadOwnKeys } from '../utils/pgpOwnKeys.js';
import { isUnlocked } from '../utils/pgpSession.js';
import { classifyRecipients, pgpDefaults } from '../utils/pgpSend.js';

export { loadOwnKeys, pgpDefaults };

// The composer's OpenPGP parts: each recipient's key, the line that says the message will be
// encrypted, and, when "Send encrypted" cannot go as it is, what stands in the way and the ways
// past it (a recipient without a key, a key's own passphrase, no key of the user's own).

// Each recipient's key status, looked up (keyring, then WKD) as the recipients change, while
// `enabled`. { statuses, checking, failed, key }: `key` names the recipients `statuses` are for.
// `remember(emails, statuses)` puts in what a send just looked up.
export function usePgpRecipients(enabled, emails) {
  const [state, setState] = useState({ statuses: [], checking: false, failed: false, key: '' });
  const key = enabled ? emails.join(',') : '';
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled || !emails.length) { setState({ statuses: [], checking: false, failed: false, key: '' }); return undefined; }
    const mine = ++seq.current;
    setState(s => (s.key === key ? s : { ...s, checking: true }));
    const timer = setTimeout(async () => {
      try {
        const { results } = await api.pgp.lookup(emails);
        const statuses = await classifyRecipients(emails, results);
        if (seq.current === mine) setState({ statuses, checking: false, failed: false, key });
      } catch {
        if (seq.current === mine) setState({ statuses: emails.map(email => ({ email, status: 'error', keys: [] })), checking: false, failed: true, key });
      }
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the recipients
  }, [key]);
  const remember = (list, statuses) => {
    seq.current += 1;
    setState({ statuses, checking: false, failed: false, key: list.join(',') });
  };
  return { ...state, remember };
}

const LockIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);
export { LockIcon };

// Under the recipients: "This message will be encrypted", with a way to turn that off for this
// message, or, once turned off while it could be, a way back.
export function EncryptionLine({ encrypting, canUndo = false, onTurnOff, onTurnOn, disabled, mobile }) {
  const { t } = useTranslation();
  if (!encrypting && !canUndo) return null;
  const link = {
    background: 'none', border: 'none', padding: mobile ? '8px 2px' : '0 2px', fontSize: 'inherit', color: 'var(--accent)',
    cursor: disabled ? 'default' : 'pointer', textDecoration: 'underline', minHeight: mobile ? 36 : undefined,
  };
  return (
    <div data-encryption-line={encrypting ? 'on' : 'off'} style={{
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0,
      padding: mobile ? '4px 16px' : '4px 14px', borderBottom: '1px solid var(--border-subtle)',
      fontSize: mobile ? 13 : 12, color: encrypting ? 'var(--text-secondary)' : 'var(--text-tertiary)',
    }}>
      {encrypting && <span style={{ color: 'var(--green)', display: 'flex' }}><LockIcon /></span>}
      <span>{encrypting ? t('pgp.compose.willEncrypt') : t('pgp.compose.wontEncrypt')}</span>
      <button type="button" disabled={disabled} onClick={encrypting ? onTurnOff : onTurnOn} style={link}>
        {encrypting ? t('pgp.compose.dontEncrypt') : t('pgp.compose.encryptAgain')}
      </button>
    </div>
  );
}


const chip = status => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999, fontSize: 12,
  border: `1px solid ${status === 'ok' ? 'var(--green)' : status === 'checking' ? 'var(--border)' : 'var(--red)'}`,
  color: status === 'ok' ? 'var(--text-primary)' : status === 'checking' ? 'var(--text-tertiary)' : 'var(--red)',
  background: 'var(--bg-primary)', maxWidth: '100%', overflowWrap: 'anywhere',
});
const small = (kind = 'plain') => ({
  padding: '3px 9px', fontSize: 12, fontWeight: 500, borderRadius: 6, cursor: 'pointer',
  background: kind === 'danger' ? 'var(--red)' : 'var(--bg-primary)', color: kind === 'danger' ? '#fff' : 'var(--text-primary)',
  border: kind === 'danger' ? 'none' : '1px solid var(--border)',
});
const note = { fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 };

function statusText(t, s) {
  if (!s) return t('pgp.compose.keyChecking');
  if (s.status === 'ok') {
    const fp = shortFingerprint(s.keys[0]?.fingerprint);
    if (s.source === 'own') return t('pgp.compose.keyOwn');
    if (s.source === 'wkd') return t('pgp.compose.keyWkd', { key: fp });
    return s.verified ? t('pgp.compose.keyVerified', { key: fp }) : t('pgp.compose.keyKnown', { key: fp });
  }
  if (s.status === 'invalid') return t('pgp.compose.keyExpired');
  if (s.status === 'error') return t('pgp.compose.keyLookupFailed');
  return t('pgp.compose.keyMissing');
}

// `recipients` are addresses (lower case); `statuses` usePgpRecipients'; `ownKey` the key for the
// From address or null; `problem` pgpSendProblem's answer once Send was pressed.
export default function PgpSendPanel({
  value, onChange, recipients, statuses, checking, ownKey, problem, disabled,
  onRemoveRecipient, onUsePassword, onSendPlain, onCreateKey,
}) {
  const { t } = useTranslation();
  if (value == null) return null;
  const set = patch => onChange({ ...value, ...patch });
  const byEmail = new Map((statuses || []).map(s => [s.email, s]));
  // A key with its own passphrase asks for it here; one protected by the Plimail password unlocks
  // by itself, or through the unlock prompt.
  const keyLocked = ownKey && !isLoginKey(ownKey) && !isUnlocked(ownKey.fingerprint);
  const missing = recipients.filter(e => byEmail.get(e) && byEmail.get(e).status !== 'ok');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={note}>{t('pgp.compose.explain')}</p>

      {!ownKey ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <p role="alert" style={{ ...note, color: 'var(--red)' }}>{t('pgp.compose.noOwnKey')}</p>
          {onCreateKey && <button type="button" disabled={disabled} onClick={onCreateKey} style={small()}>{t('pgp.compose.createKey')}</button>}
        </div>
      ) : null}

      {recipients.length > 0 && (
        <ul aria-label={t('pgp.compose.recipients')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {recipients.map((email) => {
            const s = checking && !byEmail.get(email) ? null : byEmail.get(email);
            const status = s ? s.status : 'checking';
            return (
              <li key={email} data-key-status={status} style={chip(status)} title={statusText(t, s)}>
                <span>{email}</span>
                <span style={{ color: 'var(--text-tertiary)' }}>{statusText(t, s)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {keyLocked && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: 'var(--text-primary)' }}>
            <input type="checkbox" checked={value.sign} disabled={disabled} onChange={e => set({ sign: e.target.checked })} />
            {t('pgp.compose.sign')}
          </label>
          {value.sign && (
            <>
              <input
                type="password" autoComplete="off" value={value.passphrase} disabled={disabled}
                onChange={e => set({ passphrase: e.target.value })}
                aria-label={t('pgp.read.passphrase')} placeholder={t('pgp.read.passphrase')}
                style={{ flex: '1 1 160px', minWidth: 0, padding: '5px 8px', fontSize: 12.5, borderRadius: 6, border: `1px solid ${problem?.code === 'passphrase' ? 'var(--red)' : 'var(--border)'}`, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
              />
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" checked={value.remember} disabled={disabled} onChange={e => set({ remember: e.target.checked })} />
                {t('pgp.read.rememberSession')}
              </label>
            </>
          )}
        </div>
      )}

      {problem?.code === 'missingKeys' && missing.length > 0 && (
        <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--red)', background: 'var(--bg-primary)' }}>
          <p style={{ ...note, color: 'var(--text-primary)' }}>{t('pgp.compose.blocked', { n: missing.length })}</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {missing.map(email => (
              <button key={email} type="button" disabled={disabled} onClick={() => onRemoveRecipient(email)} style={small()}>
                {t('pgp.compose.removeRecipient', { email })}
              </button>
            ))}
            <button type="button" disabled={disabled} onClick={onUsePassword} style={small()}>{t('pgp.compose.usePassword')}</button>
            {value.confirmPlain ? (
              <>
                <span style={{ ...note, color: 'var(--red)', flexBasis: '100%' }}>{t('pgp.compose.plainWarning')}</span>
                <button type="button" disabled={disabled} onClick={onSendPlain} style={small('danger')}>{t('pgp.compose.sendPlainConfirm')}</button>
                <button type="button" onClick={() => set({ confirmPlain: false })} style={small()}>{t('common.cancel')}</button>
              </>
            ) : (
              <button type="button" disabled={disabled} onClick={() => set({ confirmPlain: true })} style={small()}>{t('pgp.compose.sendPlain')}</button>
            )}
          </div>
        </div>
      )}

      <p style={note}>{t('pgp.compose.subjectNote')}</p>
    </div>
  );
}

// The panel over the composer's footer for a protected message: "Send encrypted" that cannot go
// as it is, or the password of "Send with a password". `onCancel` sends it as ordinary mail again.
export function ProtectionPanel({ title, onCancel, disabled, mobile, children }) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={title}
      style={{
        padding: mobile ? '12px 14px' : '10px 14px', borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--accent)', display: 'flex' }}><LockIcon size={14} /></span>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        <button type="button" disabled={disabled} onClick={onCancel}
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 12.5, cursor: disabled ? 'default' : 'pointer', padding: mobile ? '8px 4px' : '2px 4px' }}>
          {t('pgp.compose.cancelProtection')}
        </button>
      </div>
      {children}
    </section>
  );
}
