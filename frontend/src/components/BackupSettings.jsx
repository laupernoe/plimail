import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import PasswordInput from './PasswordInput.jsx';

// Backup and restore (#452), mounted as the admin-only "Backup" tab in AdminPanel: download a
// backup of this installation, or replace the installation with one.

const HEALTH_POLL_MS = 2000;
const RESTART_WAIT_MS = 120_000;
const QUIET_RELOAD_MS = 15_000;

// A restore outlives the tab that started it, so its progress is kept here rather than in the
// component: going to another settings tab and back shows it still running.
let restoreState = { phase: 'idle', rows: 0, error: '' }; // phase: idle | restoring | restarting | lost | failed | restartTimeout
const restoreListeners = new Set();
function setRestoreState(patch) {
  restoreState = { ...restoreState, ...patch };
  restoreListeners.forEach(listener => listener(restoreState));
}

function Row({ label, help, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 0' }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
      {help ? <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{help}</div> : null}
      <div style={{ marginTop: 6 }}>{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, disabled, label }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      aria-label={label}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        background: on ? 'var(--accent)' : 'var(--bg-hover)',
        position: 'relative', padding: 0, transition: 'background 0.12s', opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: 8,
        background: on ? 'var(--accent-text)' : 'var(--text-secondary)', transition: 'left 0.12s',
      }} />
    </button>
  );
}

// The server exits once the restore is committed, so the page reloads after the API has gone
// away and come back; a reload into the old process would show the old data. A restart too quick
// for the polling to see is covered by reloading after the API has answered for a while.
async function waitForRestart({ reload, sleep, now }) {
  const healthy = () => fetch(`/api/health?_=${now()}`, { cache: 'no-store' }).then(r => r.ok, () => false);
  const started = now();
  let down = false;
  while (now() - started < RESTART_WAIT_MS) {
    const ok = await healthy();
    if (!ok) down = true;
    else if (down || now() - started > QUIET_RELOAD_MS) return reload();
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error('restart-timeout');
}

export default function BackupSettings({
  reload = () => window.location.reload(),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = Date.now,
}) {
  const { t } = useTranslation();
  const addNotification = useStore(s => s.addNotification);
  const [loaded, setLoaded] = useState(false);
  const [includeMail, setIncludeMail] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [file, setFile] = useState(null);
  const [confirming, setConfirming] = useState(false);
  // The server asks the admin to confirm who they are before a backup or a restore, for a few
  // minutes at a time. { action, reauth, oidc } while the form for it shows, action being what
  // goes on once confirmed.
  const [identity, setIdentity] = useState(null);
  const [identityForm, setIdentityForm] = useState({ password: '', code: '' });
  const [identityError, setIdentityError] = useState('');
  const [identityBusy, setIdentityBusy] = useState(false);
  const [{ phase, rows, error }, setShown] = useState(restoreState);

  useEffect(() => {
    // A finished failure was already reported; coming back to the tab starts clean.
    if (restoreState.phase === 'failed' || restoreState.phase === 'restartTimeout') setRestoreState({ phase: 'idle', error: '' });
    setShown(restoreState);
    restoreListeners.add(setShown);
    return () => { restoreListeners.delete(setShown); };
  }, []);

  useEffect(() => {
    api.admin.getSettings()
      .then(({ settings }) => setIncludeMail(settings.backup_include_mail === 'true'))
      .catch(err => addNotification({ type: 'error', title: err.message }))
      .finally(() => setLoaded(true));
  }, [addNotification]);

  // The switch is the default for every backup, so it is stored as soon as it is flipped.
  const toggleIncludeMail = async (value) => {
    setIncludeMail(value);
    try {
      await api.admin.updateSettings({ backup_include_mail: value });
    } catch (err) {
      setIncludeMail(!value);
      addNotification({ type: 'error', title: t('admin.backup.includeMailSaveError'), body: err.message });
    }
  };

  // A navigation rather than a fetch, so the browser streams a file of any size to disk. The
  // check first catches what would otherwise only show as a failed download.
  const askIdentity = async (action, known) => {
    setIdentityError('');
    setIdentityForm({ password: '', code: '' });
    try {
      const { reauth, oidc } = known ?? await api.admin.backupReauth();
      setIdentity({ action, reauth, oidc });
    } catch (err) {
      addNotification({ type: 'error', title: err.message });
    }
  };

  const download = async () => {
    const scope = includeMail ? 'full' : 'setup';
    setDownloading(true);
    try {
      await api.admin.checkBackup(scope);
      const a = document.createElement('a');
      a.href = api.admin.backupUrl(scope);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      if (err.code === 'reauth_required') await askIdentity('download');
      else addNotification({ type: 'error', title: t('admin.backup.downloadFailed'), body: err.message });
    } finally {
      setDownloading(false);
    }
  };

  const restore = async () => {
    setConfirming(false);
    // Asked before the upload, so an unconfirmed admin does not send the whole file for nothing.
    try {
      const known = await api.admin.backupReauth();
      if (!known.confirmedUntil) {
        await askIdentity('restore', known);
        return;
      }
    } catch (err) {
      addNotification({ type: 'error', title: t('admin.backup.failed', { message: err.message }) });
      return;
    }
    setRestoreState({ phase: 'restoring', rows: 0, error: '' });
    try {
      await api.admin.restoreBackup(file, progress => setRestoreState({ rows: progress.rows }));
      setRestoreState({ phase: 'restarting' });
    } catch (err) {
      if (err.code === 'reauth_required') {
        setRestoreState({ phase: 'idle', error: '' });
        await askIdentity('restore');
        return;
      }
      if (!err.lost) {
        const message = err.status === 413 ? t('admin.backup.tooLarge') : err.message;
        setRestoreState({ phase: 'failed', error: message });
        // Shown wherever the admin is by now, not only on this tab.
        addNotification({ type: 'error', title: t('admin.backup.failed', { message }) });
        return;
      }
      // The reply stopped before its result: the restore may still have committed and restarted.
      setRestoreState({ phase: 'lost' });
    }
    try {
      await waitForRestart({ reload, sleep, now });
    } catch {
      setRestoreState({ phase: 'restartTimeout' });
    }
  };

  const confirmIdentity = async (e) => {
    e.preventDefault();
    if (!identity || identityBusy) return;
    setIdentityBusy(true);
    setIdentityError('');
    try {
      await api.admin.confirmBackup({
        ...(identity.reauth === 'password' ? { password: identityForm.password } : {}),
        ...(identity.reauth === 'totp' ? { totpCode: identityForm.code } : {}),
      });
      const { action } = identity;
      setIdentity(null);
      if (action === 'download') await download();
      else await restore();
    } catch (err) {
      // A code works once, and a refused password is typed again.
      setIdentityForm({ password: '', code: '' });
      setIdentityError(err.message);
    } finally {
      setIdentityBusy(false);
    }
  };

  const oidcProviders = Array.isArray(identity?.oidc?.providers) ? identity.oidc.providers : [];
  const identityReady = identity?.reauth === 'password' ? !!identityForm.password
    : identity?.reauth === 'totp' ? identityForm.code.length === 6
      : identity?.reauth === 'oidc' ? oidcProviders.length > 0 : false;
  const identityPanel = identity && (
    <form onSubmit={confirmIdentity} aria-labelledby="backup-identity-title"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, marginTop: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
      <div id="backup-identity-title" style={{ fontWeight: 600, fontSize: 13 }}>{t('admin.backup.identityTitle')}</div>
      <div style={hintStyle}>{t('admin.backup.identityIntro')}</div>
      {identity.reauth === 'password' && (
        <label style={labelStyle}>
          <span>{t('admin.apiTokens.passwordLabel')}</span>
          <PasswordInput autoComplete="current-password" value={identityForm.password}
            onChange={e => setIdentityForm(f => ({ ...f, password: e.target.value }))} style={inputStyle} />
        </label>
      )}
      {identity.reauth === 'totp' && (
        <label style={labelStyle}>
          <span>{t('admin.apiTokens.totpLabel')}</span>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={identityForm.code}
            onChange={e => setIdentityForm(f => ({ ...f, code: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
            style={{ ...inputStyle, letterSpacing: '0.3em', fontVariantNumeric: 'tabular-nums' }} />
        </label>
      )}
      {identity.reauth === 'oidc' && (oidcProviders.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={hintStyle}>{t('admin.backup.identityOidcHint')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {oidcProviders.map(p => (
              <a key={p.slug} href={`/auth/oidc/${p.slug}/start?action=reauth`} style={{ ...secondaryBtn, textDecoration: 'none' }}>
                {t('admin.apiTokens.reauthOidcButton', { provider: p.name })}
              </a>
            ))}
          </div>
        </div>
      ) : (
        <div style={hintStyle}>{t('admin.backup.identityOidcNoProvider')}</div>
      ))}
      {identity.reauth === 'totpSetup' && <div style={hintStyle}>{t('admin.backup.identityTotpSetup')}</div>}
      {identityError && <div role="alert" style={{ fontSize: 13, color: 'var(--danger, #dc2626)' }}>{identityError}</div>}
      <div style={{ display: 'flex', gap: 10 }}>
        {identity.reauth !== 'totpSetup' && (
          <button type="submit" disabled={!identityReady || identityBusy}
            style={{ ...primaryBtn, marginTop: 0, opacity: !identityReady || identityBusy ? 0.5 : 1 }}>
            {t('admin.backup.identityConfirm')}
          </button>
        )}
        <button type="button" onClick={() => setIdentity(null)} style={secondaryBtn}>{t('common.cancel')}</button>
      </div>
    </form>
  );

  const chooseFile = e => {
    setFile(e.target.files?.[0] || null);
    setConfirming(false);
    if (phase === 'failed') setRestoreState({ phase: 'idle', error: '' });
  };

  const busy = phase === 'restoring' || phase === 'restarting' || phase === 'lost';
  const status = {
    restoring: t('admin.backup.restoring', { rows }),
    restarting: t('admin.backup.done'),
    lost: t('admin.backup.connectionLost'),
    restartTimeout: t('admin.backup.restartTimeout'),
  }[phase];

  return (
    <div style={{ padding: '4px 2px', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h3 style={{ margin: '16px 0 4px', fontSize: 16 }}>{t('admin.backup.title')}</h3>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.backup.intro')}</p>
      <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.backup.sensitive')}</p>

      <Row label={t('admin.backup.includeMail')} help={t('admin.backup.includeMailDesc')}>
        <Toggle on={includeMail} onChange={toggleIncludeMail} disabled={!loaded || busy} label={t('admin.backup.includeMail')} />
      </Row>

      <button type="button" onClick={download} disabled={!loaded || busy || downloading}
        style={{ ...primaryBtn, alignSelf: 'flex-start', opacity: !loaded || busy || downloading ? 0.5 : 1 }}>
        {t('admin.backup.create')}
      </button>
      {identity?.action === 'download' && identityPanel}

      <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 16 }}>
        <Row label={t('admin.backup.restoreTitle')} help={`${t('admin.backup.restoreIntro')} ${t('admin.backup.versionNote')}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span>{t('admin.backup.chooseFile')}</span>
              <input type="file" accept=".gz,application/gzip" disabled={busy} onChange={chooseFile} />
            </label>
            {confirming ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--danger, #dc2626)' }}>
                  {t('admin.backup.confirmWarn', { name: file?.name })}
                </span>
                <button type="button" onClick={restore} style={dangerBtn}>{t('admin.backup.confirmYes')}</button>
                <button type="button" onClick={() => setConfirming(false)} style={secondaryBtn}>{t('common.cancel')}</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} disabled={!file || busy}
                style={{ ...dangerBtn, alignSelf: 'flex-start', opacity: !file || busy ? 0.5 : 1 }}>
                {t('admin.backup.restore')}
              </button>
            )}
            {identity?.action === 'restore' && identityPanel}
            {status && <div role="status" style={{ fontSize: 13 }}>{status}</div>}
            {phase === 'failed' && (
              <div role="alert" style={{ fontSize: 13, color: 'var(--danger, #dc2626)' }}>
                {t('admin.backup.failed', { message: error })}
              </div>
            )}
          </div>
        </Row>
      </div>
    </div>
  );
}

const primaryBtn = {
  marginTop: 10, padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 13, fontWeight: 600,
};
const dangerBtn = {
  padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--danger, #dc2626)', color: '#fff', fontSize: 13, fontWeight: 600,
};
const secondaryBtn = {
  padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)',
  cursor: 'pointer', background: 'transparent', color: 'var(--text-primary)', fontSize: 13,
};
const hintStyle = { fontSize: 12.5, color: 'var(--text-secondary)' };
const labelStyle = { fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 };
const inputStyle = {
  padding: '7px 9px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, maxWidth: 280,
};
