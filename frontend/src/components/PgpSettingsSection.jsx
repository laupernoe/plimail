import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { formatDay } from '../utils/formatDate.js';
import { formatFingerprint, generateKeyPair, keyInfo, preparePrivateKeyImport, readArmoredKeys } from '../utils/pgp.js';
import { forgetAllUnlockedKeys, forgetUnlockedKey, unlockedCount } from '../utils/pgpSession.js';
import { button } from './pgpStyles.js';

// Settings → Mail → Encryption (PGP). The user's own keys, made or imported here and stored on the
// server only protected by their passphrase, and the keyring of correspondents' public keys.
//
// One key per address: a key lists the addresses it is for, and each is visible to everyone the
// key is sent to, so putting all of a user's addresses on one key would link them for anyone
// holding it. Proton and Thunderbird keep one key per identity too. An imported key with several
// addresses is kept as it is.

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

// The addresses the user sends from: accounts and their aliases.
export function senderAddresses(accounts) {
  const out = [];
  for (const a of accounts || []) {
    if (a.email_address) out.push({ email: a.email_address.toLowerCase(), name: a.sender_name || a.name || '', accountId: a.id });
    for (const al of a.aliases || []) if (al.email) out.push({ email: al.email.toLowerCase(), name: al.name || '', accountId: a.id });
  }
  const seen = new Set();
  return out.filter(x => !seen.has(x.email) && seen.add(x.email));
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
      await api.pgp.addKey({ armoredPrivate: pair.armoredPrivate, armoredPublic: pair.armoredPublic, accountId: chosen?.accountId || null });
      onDone();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={panel} aria-label={t('pgp.settings.generateTitle')}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{t('pgp.settings.generateTitle')}</div>
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

function ImportPrivateForm({ addresses, onDone, onCancel }) {
  const { t } = useTranslation();
  const [armored, setArmored] = useState('');
  const [pass, setPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [needsNew, setNeedsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !armored.trim()) return;
    if (needsNew && newPass.length < MIN_PASSPHRASE) { setError(t('pgp.settings.passphraseNote', { n: MIN_PASSPHRASE })); return; }
    setBusy(true);
    setError('');
    try {
      const pair = await preparePrivateKeyImport(armored.trim(), pass, needsNew ? newPass : '');
      const [key] = await readArmoredKeys(pair.armoredPublic);
      const emails = (await keyInfo(key)).emails;
      const account = addresses.find(a => emails.includes(a.email));
      await api.pgp.addKey({ armoredPrivate: pair.armoredPrivate, armoredPublic: pair.armoredPublic, accountId: account?.accountId || null });
      onDone();
    } catch (err) {
      if (err?.code === 'unprotectedKey') setNeedsNew(true);
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={panel} aria-label={t('pgp.settings.importTitle')}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{t('pgp.settings.importTitle')}</div>
      <p style={{ ...muted, margin: 0 }}>{t('pgp.settings.importNote')}</p>
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
        <span style={label}>{t('pgp.settings.keyPassphrase')}</span>
        <input type="password" autoComplete="off" value={pass} onChange={e => setPass(e.target.value)} style={input} />
      </label>
      {needsNew && (
        <label>
          <span style={label}>{t('pgp.settings.newPassphrase')}</span>
          <input type="password" autoComplete="new-password" value={newPass} onChange={e => setNewPass(e.target.value)} style={input} />
        </label>
      )}
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

function OwnKeyRow({ k, onChanged }) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(null); // 'delete' | 'export'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => downloadText(`${base}.public.asc`, k.armoredPublic)} style={button()}>{t('pgp.settings.exportPublic')}</button>
          <button type="button" onClick={() => setConfirm('export')} style={button()}>{t('pgp.settings.exportPrivate')}</button>
          <button type="button" onClick={() => setConfirm('delete')} style={button()}>{t('pgp.settings.delete')}</button>
        </div>
      </div>
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
    attachment: t('pgp.source.attachment'),
  }[source] || source;
}

// Keyring rows grouped by key: { fingerprint, emails, sources, verified, armored, firstSeen }.
export function groupKeyring(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const g = by.get(r.fingerprint) || { fingerprint: r.fingerprint, emails: [], sources: [], verified: true, armored: r.armored, firstSeen: r.firstSeen };
    g.emails.push(r.email);
    if (!g.sources.includes(r.source)) g.sources.push(r.source);
    g.verified = g.verified && r.verified;
    by.set(r.fingerprint, g);
  }
  return [...by.values()];
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

export default function PgpSettingsSection() {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const addresses = useMemo(() => senderAddresses(accounts), [accounts]);
  const [keys, setKeys] = useState(null);
  const [ring, setRing] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState(null); // 'generate' | 'import' | 'public'
  const [unlocked, setUnlocked] = useState(unlockedCount());

  const load = useCallback(() => {
    Promise.all([api.pgp.keys(), api.pgp.keyring()])
      .then(([k, r]) => { setKeys(k.keys || []); setRing(r.keys || []); setLoadFailed(false); })
      .catch(() => setLoadFailed(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const ownEmails = useMemo(() => new Set((keys || []).flatMap(k => k.emails)), [keys]);
  const done = () => { setForm(null); load(); };
  const groups = groupKeyring(ring);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <section aria-labelledby="pgp-own-title">
        <h3 id="pgp-own-title" style={h3}>{t('pgp.settings.title')}</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>{t('pgp.settings.intro')}</p>
        {loadFailed && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{t('pgp.errors.loadFailed')}</p>}
        {keys && keys.length === 0 && !form && <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('pgp.settings.noKeys')}</p>}
        {keys && keys.length > 0 && (
          <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, borderTop: '1px solid var(--border-subtle)' }}>
            {keys.map(k => <OwnKeyRow key={k.id} k={k} onChanged={load} />)}
          </ul>
        )}
        {form === 'generate' && <GenerateForm addresses={addresses} ownEmails={ownEmails} onDone={done} onCancel={() => setForm(null)} />}
        {form === 'import' && <ImportPrivateForm addresses={addresses} onDone={done} onCancel={() => setForm(null)} />}
        {!form && keys && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" disabled={!addresses.length} onClick={() => setForm('generate')} style={button('primary', !addresses.length)}>{t('pgp.settings.generateTitle')}</button>
            <button type="button" onClick={() => setForm('import')} style={button()}>{t('pgp.settings.importTitle')}</button>
          </div>
        )}
        {unlocked > 0 && (
          <div style={{ ...muted, marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{t('pgp.settings.unlockedCount', { n: unlocked })}</span>
            <button type="button" onClick={() => { forgetAllUnlockedKeys(); setUnlocked(0); }} style={button()}>{t('pgp.settings.lockAll')}</button>
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
    </div>
  );
}
