import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { shortFingerprint } from '../utils/pgp.js';
import { isUnlocked } from '../utils/pgpSession.js';
import { classifyRecipients } from '../utils/pgpSend.js';

// The composer's OpenPGP side of the lock: which mode the lock is in (PGP or a password link,
// SecureSendPanel.jsx), each recipient's key, signing, and what to do when a recipient has none.

// The user's own keys, asked for once per page and again after a change in Settings.
let ownKeysPromise = null;
export function loadOwnKeys({ fresh = false } = {}) {
  if (fresh || !ownKeysPromise) {
    ownKeysPromise = api.pgp.keys().then(r => r.keys || []).catch((err) => { ownKeysPromise = null; throw err; });
  }
  return ownKeysPromise;
}

// Each recipient's key status, looked up (keyring, then WKD) as the recipients change, while
// PGP is on. { statuses, checking, failed }.
export function usePgpRecipients(enabled, emails) {
  const [state, setState] = useState({ statuses: [], checking: false, failed: false });
  const key = enabled ? emails.join(',') : '';
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled || !emails.length) { setState({ statuses: [], checking: false, failed: false }); return undefined; }
    const mine = ++seq.current;
    setState(s => ({ ...s, checking: true }));
    const timer = setTimeout(async () => {
      try {
        const { results } = await api.pgp.lookup(emails);
        const statuses = await classifyRecipients(emails, results);
        if (seq.current === mine) setState({ statuses, checking: false, failed: false });
      } catch {
        if (seq.current === mine) setState({ statuses: emails.map(email => ({ email, status: 'error', keys: [] })), checking: false, failed: true });
      }
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the recipients
  }, [key]);
  return state;
}

export const pgpDefaults = () => ({ sign: true, passphrase: '', remember: true, confirmPlain: false });

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

export function ProtectionModeSwitch({ mode, onMode, disabled }) {
  const { t } = useTranslation();
  const item = active => ({
    padding: '4px 10px', fontSize: 12.5, fontWeight: 500, border: 'none', borderRadius: 5, cursor: disabled ? 'default' : 'pointer',
    background: active ? 'var(--bg-primary)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    boxShadow: active ? '0 0 0 1px var(--border)' : 'none',
  });
  return (
    <div role="radiogroup" aria-label={t('pgp.compose.mode')} style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 7, background: 'var(--bg-secondary)', alignSelf: 'flex-start' }}>
      <button type="button" role="radio" aria-checked={mode === 'pgp'} disabled={disabled} onClick={() => onMode('pgp')} style={item(mode === 'pgp')}>{t('pgp.compose.modePgp')}</button>
      <button type="button" role="radio" aria-checked={mode === 'password'} disabled={disabled} onClick={() => onMode('password')} style={item(mode === 'password')}>{t('pgp.compose.modePassword')}</button>
    </div>
  );
}

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
  onRemoveRecipient, onUsePassword, onSendPlain, onOpenSettings,
}) {
  const { t } = useTranslation();
  if (value == null) return null;
  const set = patch => onChange({ ...value, ...patch });
  const byEmail = new Map((statuses || []).map(s => [s.email, s]));
  const keyLocked = ownKey && !isUnlocked(ownKey.fingerprint);
  const missing = recipients.filter(e => byEmail.get(e) && byEmail.get(e).status !== 'ok');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>{t('pgp.compose.title')}</div>
        <p style={note}>{t('pgp.compose.explain')}</p>
      </div>

      {!ownKey ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <p role="alert" style={{ ...note, color: 'var(--red)' }}>{t('pgp.compose.noOwnKey')}</p>
          {onOpenSettings && <button type="button" onClick={onOpenSettings} style={small()}>{t('pgp.read.openSettings')}</button>}
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

      {ownKey && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: 'var(--text-primary)' }}>
            <input type="checkbox" checked={value.sign} disabled={disabled} onChange={e => set({ sign: e.target.checked })} />
            {t('pgp.compose.sign')}
          </label>
          {value.sign && keyLocked && (
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
      <p style={note}>{t('pgp.compose.limits')}</p>
    </div>
  );
}

// The lock's panel: the mode switch, then the PGP panel or the password one.
export function ProtectionPanel({ mode, onMode, disabled, mobile, children }) {
  const { t } = useTranslation();
  if (!mode) return null;
  return (
    <section
      aria-label={t('pgp.compose.protection')}
      style={{
        padding: mobile ? '12px 14px' : '10px 14px', borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0,
      }}
    >
      <ProtectionModeSwitch mode={mode} onMode={onMode} disabled={disabled} />
      {children}
    </section>
  );
}
