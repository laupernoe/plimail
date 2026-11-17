import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { formatDay } from '../utils/formatDate.js';
import { formatFingerprint, generateKeyPair } from '../utils/pgp.js';
import { buildKeyBackup, prepareKeysFromBackup, storeRestoredKeys } from '../utils/pgpBackup.js';
import { ensureAutoKeys, isLoginKey, lockKey, openOwnKey, senderAddresses } from '../utils/pgpKeys.js';
import { OWN_KEYS_CHANGED, ownKeysChanged } from '../utils/pgpOwnKeys.js';
import { keySecretEntry, subscribeKeySecret } from '../utils/pgpSecret.js';
import { forgetAllUnlockedKeys, forgetUnlockedKey, isUnlocked, unlockedCount } from '../utils/pgpSession.js';
import { ensureKeySecret, requestKeyUnlock, unlockOwnKey } from '../utils/pgpUnlock.js';
import { ownKeyFor, staleKeyFor } from '../utils/pgpSend.js';
import { groupKeyring } from '../utils/pgpKeyringGroups.js';
import { StaleKeyBanner } from './PgpSendPanel.jsx';
import { button } from './pgpStyles.js';

// Settings → Encryption. What most people need is at the top and says it plainly: each address's
// key and whether it unlocks by itself, automatic encryption, a backup, and the correspondents'
// keys. Everything about keys as such (fingerprints, import, export, deletion, a key with its own
// passphrase) is under Advanced.
//
// Keys Plimail makes by itself (utils/pgpKeys.js) are protected by a passphrase derived from the
// Plimail password, so they unlock at sign-in. One key per address: a key lists the addresses it
// is for, and each is visible to everyone the key is sent to, so putting all of a user's
// addresses on one key would link them for anyone holding it. An imported key with several
// addresses is kept as it is.

export { senderAddresses };

export const MIN_PASSPHRASE = 8;
// The armor line a pasted key starts with: not words to translate.
const PRIVATE_KEY_PLACEHOLDER = '-----BEGIN PGP PRIVATE KEY BLOCK-----';
const PUBLIC_KEY_PLACEHOLDER = '-----BEGIN PGP PUBLIC KEY BLOCK-----';

const input = {
  width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 13, borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)',
};
const label = { fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 };
const muted = { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 };
const h3 = { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' };
const panel = { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 };

export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/pgp-keys' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFileText(file) {
  return file.text ? file.text() : new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsText(file);
  });
}

function errorText(t, err) {
  const code = err?.code;
  return {
    wrongPassphrase: t('pgp.errors.wrongPassphrase'),
    invalidKey: t('pgp.errors.invalidKey'),
    unprotectedKey: t('pgp.errors.unprotectedKey'),
    unprotected_key: t('pgp.errors.unprotectedKey'),
    duplicate: t('pgp.errors.duplicate'),
    no_email: t('pgp.errors.noEmail'),
    invalid_key: t('pgp.errors.invalidKey'),
  }[code] || t('pgp.errors.generic');
}

function GenerateForm({ addresses, ownEmails, onDone, onCancel }) {
  const { t } = useTranslation();
  const first = addresses.find(a => !ownEmails.has(a.email)) || addresses[0];
  const [email, setEmail] = useState(first?.email || '');
  const [name, setName] = useState(first?.name || '');
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chosen = addresses.find(a => a.email === email);
  const problem = pass.length < MIN_PASSPHRASE ? 'short' : pass !== confirm ? 'mismatch' : null;

  const submit = async (e) => {
    e.preventDefault();
    if (busy || problem || !email) return;
    setBusy(true);
    setError('');
    try {
      const pair = await generateKeyPair({ name: name.trim(), email, passphrase: pass });
      await api.pgp.addKey({ armoredPrivate: pair.armoredPrivate, armoredPublic: pair.armoredPublic, accountId: chosen?.accountId || null, protection: 'passphrase' });
      onDone();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={panel} aria-label={t('pgp.settings.generateOwnTitle')}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{t('pgp.settings.generateOwnTitle')}</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ flex: '1 1 220px' }}>
          <span style={label}>{t('pgp.settings.address')}</span>
          <select value={email} onChange={(e) => { setEmail(e.target.value); setName(addresses.find(a => a.email === e.target.value)?.name || ''); }} style={input}>
            {addresses.map(a => <option key={a.email} value={a.email}>{a.email}</option>)}
          </select>
        </label>
        <label style={{ flex: '1 1 180px' }}>
          <span style={label}>{t('pgp.settings.name')}</span>
          <input value={name} onChange={e => setName(e.target.value)} style={input} />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ flex: '1 1 180px' }}>
          <span style={label}>{t('pgp.settings.passphrase')}</span>
          <input type="password" autoComplete="new-password" value={pass} onChange={e => setPass(e.target.value)} style={input} />
        </label>
        <label style={{ flex: '1 1 180px' }}>
          <span style={label}>{t('pgp.settings.passphraseConfirm')}</span>
          <input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} style={{ ...input, borderColor: confirm && pass !== confirm ? 'var(--red)' : 'var(--border)' }} />
        </label>
      </div>
      <p style={{ ...muted, margin: 0 }}>{t('pgp.settings.passphraseNote', { n: MIN_PASSPHRASE })}</p>
      {ownEmails.has(email) && <p style={{ ...muted, margin: 0, color: 'var(--amber)' }}>{t('pgp.settings.alreadyHasKey')}</p>}
      {error && <p role="alert" style={{ fontSize: 12, color: 'var(--red)', margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy || !!problem} style={button('primary', busy || !!problem)}>
          {busy ? t('pgp.settings.generating') : t('pgp.settings.generate')}
        </button>
        <button type="button" onClick={onCancel} style={button()}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

// A private key from elsewhere (Proton, Thunderbird, GnuPG), or `restore`: a backup made here,
// which may hold several keys (utils/pgpBackup.js). A key the user still has is put back as it
// was, encrypted for what it is to unlock with now: how a key left under a forgotten password
// comes back.
function ImportPrivateForm({ addresses, userId, keys, restore = false, onDone, onCancel }) {
  const { t } = useTranslation();
  const [armored, setArmored] = useState('');
  const [pass, setPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [needsNew, setNeedsNew] = useState(false);
  // On by default: the key then unlocks with the Plimail password, as the keys made here do.
  const [automatic, setAutomatic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Keys Plimail made for the addresses of the key just imported: the imported one is used from
  // now on, and these may go (they are kept unless the user says so, for the mail they opened).
  const [replaced, setReplaced] = useState(null);
  // Keys of the file this passphrase did not open: they come in with another try.
  const [unopened, setUnopened] = useState(0);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !armored.trim()) return;
    if (!automatic && needsNew && newPass.length < MIN_PASSPHRASE) { setError(t('pgp.settings.passphraseNote', { n: MIN_PASSPHRASE })); return; }
    setBusy(true);
    setError('');
    try {
      let secret = null;
      if (automatic) {
        secret = (await ensureKeySecret(userId))?.secret;
        if (!secret) throw Object.assign(new Error('unlockCancelled'), { code: 'unlockCancelled' });
      }
      const prepared = await prepareKeysFromBackup(armored.trim(), { passphrase: pass, secret, newPassphrase: !automatic && needsNew ? newPass : '' });
      await storeRestoredKeys(prepared.keys, {
        ownKeys: keys, addKey: api.pgp.addKey, setProtection: api.pgp.setProtection,
        accountFor: emails => addresses.find(a => emails.includes(a.email))?.accountId || null,
      });
      const emails = prepared.keys.flatMap(k => k.emails);
      const fingerprints = new Set(prepared.keys.map(k => k.fingerprint.toLowerCase()));
      const autos = (keys || []).filter(k => k.auto && !fingerprints.has(String(k.fingerprint).toLowerCase()) && (k.emails || []).some(a => emails.includes(a)));
      if (prepared.unopened) {
        // What did open is stored; the rest wait for their own passphrase.
        setUnopened(prepared.unopened);
        setPass('');
        ownKeysChanged();
      } else if (autos.length) setReplaced(autos);
      else onDone();
    } catch (err) {
      if (err?.code === 'unprotectedKey') setNeedsNew(true);
      if (err?.code !== 'unlockCancelled') setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const removeReplaced = async () => {
    setBusy(true);
    try {
      for (const k of replaced) { await api.pgp.removeKey(k.id); forgetUnlockedKey(k.fingerprint); }
      onDone();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  if (replaced) {
    return (
      <div role="alertdialog" style={panel}>
        <p style={{ ...muted, margin: 0, color: 'var(--text-primary)' }}>{t('pgp.settings.replaceAuto', { email: replaced.flatMap(k => k.emails).join(', ') })}</p>
        {error && <p role="alert" style={{ fontSize: 12, color: 'var(--red)', margin: 0 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled={busy} onClick={removeReplaced} style={button('danger', busy)}>{t('pgp.settings.replaceAutoDelete')}</button>
          <button type="button" disabled={busy} onClick={onDone} style={button()}>{t('pgp.settings.replaceAutoKeep')}</button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={panel} aria-label={restore ? t('pgp.settings.restoreTitle') : t('pgp.settings.importTitle')}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{restore ? t('pgp.settings.restoreTitle') : t('pgp.settings.importTitle')}</div>
      <p style={{ ...muted, margin: 0 }}>{restore ? t('pgp.settings.restoreNote') : t('pgp.settings.importNote')}</p>
      <textarea
        value={armored} onChange={e => setArmored(e.target.value)} rows={6} spellCheck={false}
        aria-label={t('pgp.settings.importPaste')} placeholder={PRIVATE_KEY_PLACEHOLDER}
        style={{ ...input, fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, resize: 'vertical' }}
      />
      <label style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
        {t('pgp.settings.importFile')}{' '}
        <input type="file" accept=".asc,.gpg,.key,.txt,application/pgp-keys" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setArmored(await readFileText(f)); }} />
      </label>
      <label>
        <span style={label}>{restore ? t('pgp.settings.backupPassphrase') : t('pgp.settings.keyPassphrase')}</span>
        <input type="password" autoComplete="off" value={pass} onChange={e => setPass(e.target.value)} style={input} />
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--text-primary)', lineHeight: 1.45 }}>
        <input type="checkbox" checked={automatic} onChange={e => setAutomatic(e.target.checked)} style={{ marginTop: 2 }} />
        <span>{t('pgp.settings.importAutomatic')}</span>
      </label>
      {!automatic && needsNew && (
        <label>
          <span style={label}>{t('pgp.settings.newPassphrase')}</span>
          <input type="password" autoComplete="new-password" value={newPass} onChange={e => setNewPass(e.target.value)} style={input} />
        </label>
      )}
      {unopened > 0 && <p role="status" style={{ ...muted, margin: 0, color: 'var(--amber)' }}>{t('pgp.settings.restorePartial', { count: unopened })}</p>}
      {error && <p role="alert" style={{ fontSize: 12, color: 'var(--red)', margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy || !armored.trim()} style={button('primary', busy || !armored.trim())}>
          {busy ? t('pgp.settings.importing') : t('pgp.settings.import')}
        </button>
        <button type="button" onClick={onCancel} style={button()}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

function OwnKeyRow({ k, userId, onChanged }) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(null); // 'delete' | 'export' | 'automatic'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pass, setPass] = useState('');
  // A key with its own passphrase, protected instead by the Plimail password's secret.
  const makeAutomatic = async (e) => {
    e.preventDefault();
    if (busy || !pass) return;
    setBusy(true);
    setError('');
    try {
      const key = await openOwnKey(k, { passphrase: pass, remember: false });
      const entry = await ensureKeySecret(userId);
      if (!entry?.secret) return;
      await api.pgp.setProtection([{ id: k.id, armoredPrivate: await lockKey(key, entry.secret), protection: 'login' }]);
      setConfirm(null);
      setPass('');
      onChanged();
    } catch (err) {
      if (err?.code !== 'unlockCancelled') setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.pgp.removeKey(k.id);
      forgetUnlockedKey(k.fingerprint);
      onChanged();
    } catch {
      setError(t('pgp.errors.generic'));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  const base = (k.emails[0] || 'key').replace(/[^a-z0-9@._-]/gi, '_');
  return (
    <li style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{k.emails.join(', ')}</div>
          <div style={{ ...muted, fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{formatFingerprint(k.fingerprint)}</div>
          <div style={muted}>{t('pgp.settings.createdOn', { date: formatDay(k.keyCreatedAt || k.createdAt) })}</div>
          <div style={muted}>{isLoginKey(k) ? t('pgp.settings.protectionLogin') : t('pgp.settings.protectionOwn')}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => downloadText(`${base}.public.asc`, k.armoredPublic)} style={button()}>{t('pgp.settings.exportPublic')}</button>
          {!isLoginKey(k) && <button type="button" onClick={() => setConfirm('export')} style={button()}>{t('pgp.settings.exportPrivate')}</button>}
          {!isLoginKey(k) && <button type="button" onClick={() => setConfirm('automatic')} style={button()}>{t('pgp.settings.makeAutomatic')}</button>}
          <button type="button" onClick={() => setConfirm('delete')} style={button()}>{t('pgp.settings.delete')}</button>
        </div>
      </div>
      {confirm === 'automatic' && (
        <form onSubmit={makeAutomatic} style={{ ...panel, marginTop: 10 }}>
          <p style={{ ...muted, margin: 0, color: 'var(--text-primary)' }}>{t('pgp.settings.makeAutomaticNote')}</p>
          <input type="password" autoComplete="off" value={pass} onChange={e => setPass(e.target.value)}
            aria-label={t('pgp.settings.keyPassphrase')} placeholder={t('pgp.settings.keyPassphrase')} style={input} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy || !pass} style={button('primary', busy || !pass)}>{t('pgp.settings.makeAutomaticGo')}</button>
            <button type="button" onClick={() => { setConfirm(null); setPass(''); }} style={button()}>{t('common.cancel')}</button>
          </div>
        </form>
      )}
      {confirm === 'export' && (
        <div role="alertdialog" style={{ ...panel, marginTop: 10 }}>
          <p style={{ ...muted, margin: 0, color: 'var(--text-primary)' }}>{t('pgp.settings.exportPrivateWarning')}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => { downloadText(`${base}.private.asc`, k.armoredPrivate); setConfirm(null); }} style={button('primary')}>{t('pgp.settings.exportPrivateConfirm')}</button>
            <button type="button" onClick={() => setConfirm(null)} style={button()}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
      {confirm === 'delete' && (
        <div role="alertdialog" style={{ ...panel, marginTop: 10 }}>
          <p style={{ ...muted, margin: 0, color: 'var(--text-primary)' }}>{t('pgp.settings.deleteWarning')}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" disabled={busy} onClick={remove} style={button('danger', busy)}>{t('pgp.settings.deleteConfirm')}</button>
            <button type="button" onClick={() => setConfirm(null)} style={button()}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{error}</div>}
    </li>
  );
}

export function sourceLabel(t, source) {
  return {
    manual: t('pgp.source.manual'),
    wkd: t('pgp.source.wkd'),
    autocrypt: t('pgp.source.autocrypt'),
    autocryptAuto: t('pgp.source.autocryptAuto'),
    attachment: t('pgp.source.attachment'),
  }[source] || source;
}

function KeyringRow({ g, onChanged }) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const act = async (call) => {
    setError('');
    try { await call(); onChanged(); } catch { setError(t('pgp.errors.generic')); }
  };
  return (
    <li style={{ padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13.5, fontWeight: 500, overflowWrap: 'anywhere' }}>{g.emails.join(', ')}</span>
            <span style={{ fontSize: 11.5, color: g.verified ? 'var(--green)' : 'var(--text-tertiary)', border: `1px solid ${g.verified ? 'var(--green)' : 'var(--border)'}`, borderRadius: 999, padding: '1px 8px' }}>
              {g.verified ? t('pgp.settings.verified') : t('pgp.settings.unverified')}
            </span>
          </div>
          <div style={{ ...muted, fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5 }}>{formatFingerprint(g.fingerprint)}</div>
          <div style={muted}>{t('pgp.settings.from', { source: g.sources.map(s => sourceLabel(t, s)).join(', ') })}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => act(() => api.pgp.setVerified(g.fingerprint, !g.verified))} style={button()}>
            {g.verified ? t('pgp.settings.markUnverified') : t('pgp.settings.markVerified')}
          </button>
          <button type="button" onClick={() => downloadText(`${g.emails[0] || 'key'}.asc`, g.armored)} style={button()}>{t('pgp.settings.export')}</button>
          {confirm ? (
            <>
              <button type="button" onClick={() => act(() => api.pgp.removeFromKeyring(g.fingerprint))} style={button('danger')}>{t('pgp.settings.deleteConfirm')}</button>
              <button type="button" onClick={() => setConfirm(false)} style={button()}>{t('common.cancel')}</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirm(true)} style={button()}>{t('pgp.settings.delete')}</button>
          )}
        </div>
      </div>
      {!g.verified && <div style={{ ...muted, marginTop: 4 }}>{t('pgp.settings.verifyHint')}</div>}
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>{error}</div>}
    </li>
  );
}

function ImportPublicForm({ onDone, onCancel }) {
  const { t } = useTranslation();
  const [armored, setArmored] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (busy || !armored.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.pgp.addToKeyring({ armored: armored.trim(), source: 'manual' });
      onDone();
    } catch (err) {
      setError(err?.code === 'invalid_key' && /private/i.test(err.message) ? t('pgp.errors.privateInKeyring') : errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} style={panel} aria-label={t('pgp.settings.addPublicTitle')}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{t('pgp.settings.addPublicTitle')}</div>
      <textarea
        value={armored} onChange={e => setArmored(e.target.value)} rows={6} spellCheck={false}
        aria-label={t('pgp.settings.importPaste')} placeholder={PUBLIC_KEY_PLACEHOLDER}
        style={{ ...input, fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5, resize: 'vertical' }}
      />
      <label style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
        {t('pgp.settings.importFile')}{' '}
        <input type="file" accept=".asc,.gpg,.key,.txt,application/pgp-keys" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setArmored(await readFileText(f)); }} />
      </label>
      {error && <p role="alert" style={{ fontSize: 12, color: 'var(--red)', margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy || !armored.trim()} style={button('primary', busy || !armored.trim())}>{t('pgp.settings.addPublic')}</button>
        <button type="button" onClick={onCancel} style={button()}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

// A copy of every private key, for safekeeping off this server: the keys Plimail protects with the
// Plimail password are encrypted for the file with a passphrase chosen here (the derived one is
// nothing anyone could type); a key with its own passphrase goes as it is, still locked with it.
function BackupForm({ keys, userId, onCancel }) {
  const { t } = useTranslation();
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsPass = keys.some(isLoginKey);
  const problem = needsPass && (pass.length < MIN_PASSPHRASE ? 'short' : pass !== confirm ? 'mismatch' : null);
  const submit = async (e) => {
    e.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError('');
    try {
      downloadText('plimail-keys-backup.asc', await buildKeyBackup(keys, { passphrase: pass, open: k => unlockOwnKey(k, userId) }));
      onCancel();
    } catch (err) {
      if (err?.code !== 'unlockCancelled') setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} style={{ ...panel, marginTop: 10 }} aria-label={t('pgp.settings.backupTitle')}>
      <p style={{ ...muted, margin: 0, color: 'var(--text-primary)' }}>{needsPass ? t('pgp.settings.backupNote', { n: MIN_PASSPHRASE }) : t('pgp.settings.backupNoteOwn')}</p>
      {needsPass && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input type="password" autoComplete="new-password" value={pass} onChange={e => setPass(e.target.value)}
            aria-label={t('pgp.settings.backupPassphrase')} placeholder={t('pgp.settings.backupPassphrase')} style={{ ...input, flex: '1 1 180px', width: 'auto' }} />
          <input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)}
            aria-label={t('pgp.settings.passphraseConfirm')} placeholder={t('pgp.settings.passphraseConfirm')}
            style={{ ...input, flex: '1 1 180px', width: 'auto', borderColor: confirm && pass !== confirm ? 'var(--red)' : 'var(--border)' }} />
        </div>
      )}
      {error && <p role="alert" style={{ fontSize: 12, color: 'var(--red)', margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy || !!problem} style={button('primary', busy || !!problem)}>{t('pgp.settings.backupGo')}</button>
        <button type="button" onClick={onCancel} style={button()}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

// Each address's key in a word: what most people need to know about it.
//   'active'  a key that unlocks with the Plimail password, and this tab can unlock it
//   'locked'  such a key, and this tab has no secret yet (a new tab, SSO): Unlock
//   'stale'   such a key, protected under an earlier password: Unlock asks for that one
//   'own'     a key with its own passphrase
//   'making'  no key yet, and one is being made
//   'none'    no key, and none can be made yet (no secret): Create
export function addressKeyState(key, { secret, stale }) {
  if (!key) return secret ? 'making' : 'none';
  if (!isLoginKey(key)) return 'own';
  if (!secret) return 'locked';
  return stale ? 'stale' : 'active';
}

const STATE_COLOR = { active: 'var(--green)', own: 'var(--green)', making: 'var(--text-tertiary)', none: 'var(--text-tertiary)', locked: 'var(--amber)', stale: 'var(--amber)' };

export default function PgpSettingsSection() {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const userId = useStore(s => s.user?.id);
  const autoEncrypt = useStore(s => s.pgpAutoEncrypt);
  const setAutoEncrypt = useStore(s => s.setPgpAutoEncrypt);
  const autoKeys = useStore(s => s.pgpAutoKeys);
  const setAutoKeys = useStore(s => s.setPgpAutoKeys);
  const addresses = useMemo(() => senderAddresses(accounts), [accounts]);
  const secret = useSyncExternalStore(subscribeKeySecret, () => keySecretEntry(userId)?.secret || null);
  const [keys, setKeys] = useState(null);
  const [ring, setRing] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState(null); // 'generate' | 'import' | 'public' | 'backup'
  const [unlocked, setUnlocked] = useState(unlockedCount());
  const [stale, setStale] = useState(() => new Set());

  const load = useCallback(() => {
    Promise.all([api.pgp.keys(), api.pgp.keyring()])
      .then(([k, r]) => { setKeys(k.keys || []); setRing(r.keys || []); setLoadFailed(false); })
      .catch(() => setLoadFailed(true));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    window.addEventListener(OWN_KEYS_CHANGED, load);
    return () => window.removeEventListener(OWN_KEYS_CHANGED, load);
  }, [load]);

  // Which keys the tab's secret does not open: made under an earlier password.
  useEffect(() => {
    if (!keys || !secret) { setStale(new Set()); return undefined; }
    let live = true;
    (async () => {
      const entry = keySecretEntry(userId);
      const found = new Set();
      for (const k of keys.filter(isLoginKey)) {
        if (isUnlocked(k.fingerprint)) continue;
        try { await openOwnKey(k, { secret: entry.secret, verified: entry.verified }); } catch { found.add(k.id); }
      }
      if (live) { setStale(found); setUnlocked(unlockedCount()); }
    })();
    return () => { live = false; };
  }, [keys, secret, userId]);

  const changed = () => { ownKeysChanged(); load(); };
  const done = () => { setForm(null); changed(); };
  const groups = groupKeyring(ring);
  const unlock = (isStale, keyId = null) => requestKeyUnlock({ stale: isStale, keyId }).then(() => setUnlocked(unlockedCount()), () => {});
  // Addresses, and imported keys for addresses that are no account's. An address whose only key
  // the password no longer opens shows that key, with what to do about it.
  const rows = useMemo(() => {
    const list = addresses.map(a => ({ email: a.email, key: ownKeyFor(keys, a.email), staleKey: staleKeyFor(keys, a.email) }));
    const shown = new Set(list.flatMap(r => [r.key?.id, r.staleKey?.id]).filter(Boolean));
    for (const k of keys || []) {
      if (shown.has(k.id) || k.stale || list.some(r => (k.emails || []).includes(r.email))) continue;
      list.push({ email: k.emails[0] || '', key: k, staleKey: null });
    }
    return list;
  }, [addresses, keys]);
  // A new key for an address whose key is stale; the old one stays, for the mail it opened.
  const newKeyFor = async (email) => {
    try {
      const entry = await ensureKeySecret(userId);
      const address = addresses.find(a => a.email === email) || { email };
      if (entry?.secret) {
        await ensureAutoKeys({ userId, addresses: [address], ownKeys: (keys || []).filter(k => !k.stale), secret: entry.secret, addKey: api.pgp.addKey, force: true });
      }
      changed();
    } catch { /* cancelled: nothing changes */ }
  };

  const stateText = {
    active: t('pgp.settings.stateActive'),
    locked: t('pgp.settings.stateLocked'),
    stale: t('pgp.settings.stateStale'),
    own: t('pgp.settings.stateOwn'),
    making: t('pgp.settings.stateMaking'),
    none: t('pgp.settings.stateNone'),
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <section aria-labelledby="pgp-own-title">
        <h3 id="pgp-own-title" style={h3}>{t('pgp.settings.title')}</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>{t('pgp.settings.intro')}</p>
        {loadFailed && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{t('pgp.errors.loadFailed')}</p>}
        {keys && (
          <ul aria-label={t('pgp.settings.addressesTitle')} style={{ listStyle: 'none', margin: '0 0 14px', padding: 0, borderTop: '1px solid var(--border-subtle)' }}>
            {rows.map(({ email, key, staleKey }) => {
              const state = !key && staleKey ? 'stale' : addressKeyState(key, { secret, stale: key && stale.has(key.id) });
              return (
                <li key={key?.id || email} data-key-state={state} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ flex: '1 1 200px', minWidth: 0, fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{email}</span>
                  <span style={{ fontSize: 12.5, color: STATE_COLOR[state] }}>{stateText[state]}</span>
                  {(state === 'locked' || state === 'none') && (
                    <button type="button" onClick={() => unlock(false)} style={button()}>
                      {state === 'none' ? t('pgp.settings.createKeys') : t('pgp.settings.unlock')}
                    </button>
                  )}
                  {state === 'stale' && (
                    <div style={{ flexBasis: '100%' }}>
                      <StaleKeyBanner email={email} onRecover={() => unlock(true, staleKey?.id).then(changed)} onNewKey={() => newKeyFor(email)} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', margin: '0 0 10px' }}>
          <input type="checkbox" checked={autoKeys} onChange={e => setAutoKeys(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <span style={{ display: 'block', fontSize: 13.5, color: 'var(--text-primary)' }}>{t('pgp.settings.autoKeys')}</span>
            <span style={muted}>{t('pgp.settings.autoKeysHint')}</span>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', margin: '0 0 6px' }}>
          <input type="checkbox" checked={autoEncrypt} onChange={e => setAutoEncrypt(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <span style={{ display: 'block', fontSize: 13.5, color: 'var(--text-primary)' }}>{t('pgp.settings.autoEncrypt')}</span>
            <span style={muted}>{t('pgp.settings.autoEncryptHint')}</span>
          </span>
        </label>
        {keys && (
          <div style={{ ...panel, marginTop: 14, background: 'transparent' }}>
            {keys.length > 0 && <p style={{ ...muted, margin: 0, color: 'var(--text-primary)' }}>{t('pgp.settings.resetWarning')}</p>}
            {form === 'backup' && <BackupForm keys={keys} userId={userId} onCancel={() => setForm(null)} />}
            {form === 'restore' && <ImportPrivateForm restore addresses={addresses} userId={userId} keys={keys} onDone={done} onCancel={() => setForm(null)} />}
            {form !== 'backup' && form !== 'restore' && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {keys.length > 0 && <button type="button" onClick={() => setForm('backup')} style={button()}>{t('pgp.settings.backupTitle')}</button>}
                <button type="button" onClick={() => setForm('restore')} style={button()}>{t('pgp.settings.restoreTitle')}</button>
              </div>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="pgp-ring-title">
        <h3 id="pgp-ring-title" style={h3}>{t('pgp.settings.keyringTitle')}</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>{t('pgp.settings.keyringIntro')}</p>
        {ring && groups.length === 0 && form !== 'public' && <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('pgp.settings.keyringEmpty')}</p>}
        {groups.length > 0 && (
          <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, borderTop: '1px solid var(--border-subtle)' }}>
            {groups.map(g => <KeyringRow key={g.fingerprint} g={g} onChanged={load} />)}
          </ul>
        )}
        {form === 'public'
          ? <ImportPublicForm onDone={done} onCancel={() => setForm(null)} />
          : ring && <button type="button" onClick={() => setForm('public')} style={button()}>{t('pgp.settings.addPublicTitle')}</button>}
      </section>

      <details>
        <summary style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>{t('pgp.settings.advanced')}</summary>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ ...muted, margin: 0 }}>{t('pgp.settings.advancedIntro')}</p>
          <p style={{ ...muted, margin: 0 }}>{t('pgp.settings.securityNote')}</p>
          {keys && keys.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border-subtle)' }}>
              {keys.map(k => <OwnKeyRow key={k.id} k={k} userId={userId} onChanged={changed} />)}
            </ul>
          )}
          {form === 'generate' && <GenerateForm addresses={addresses} ownEmails={new Set((keys || []).flatMap(k => k.emails))} onDone={done} onCancel={() => setForm(null)} />}
          {form === 'import' && <ImportPrivateForm addresses={addresses} userId={userId} keys={keys} onDone={done} onCancel={() => setForm(null)} />}
          {form !== 'generate' && form !== 'import' && keys && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => setForm('import')} style={button()}>{t('pgp.settings.importTitle')}</button>
              <button type="button" disabled={!addresses.length} onClick={() => setForm('generate')} style={button('plain', !addresses.length)}>{t('pgp.settings.generateOwnTitle')}</button>
            </div>
          )}
          {unlocked > 0 && (
            <div style={{ ...muted, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{t('pgp.settings.unlockedCount', { n: unlocked })}</span>
              <button type="button" onClick={() => { forgetAllUnlockedKeys(); setUnlocked(0); }} style={button()}>{t('pgp.settings.lockAll')}</button>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
