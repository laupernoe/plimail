import { useEffect, useState } from 'react';
import { useStore } from '../../store/index.js';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import { formatMessageDateTime } from '../../utils/formatDate.js';
import PasswordInput from '../PasswordInput.jsx';
import { groupCalendarsByAccount } from '../../utils/calendarGroups.js';
import { Btn, ErrorBox, Icon, PALETTE, inputStyle, labelStyle } from './calendarUi.jsx';

const INTERVALS = [5, 15, 30, 60, 180, 720];

function AccountCard({ account, onChanged }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);

  const run = async (name, fn) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setError(err.status === 409 && name === 'sync' ? t('calendar.accounts.syncRunning') : err.message);
    } finally {
      setBusy(null);
    }
  };

  const intervals = INTERVALS.includes(account.intervalMin) ? INTERVALS : [...INTERVALS, account.intervalMin].sort((a, b) => a - b);
  const synced = account.lastSyncAt
    ? t('calendar.accounts.lastSync', { when: formatMessageDateTime(account.lastSyncAt) })
    : account.lastError ? t('calendar.accounts.neverSynced') : t('calendar.accounts.firstSync');

  return (
    <div style={{ border: `1px solid ${account.lastError ? 'var(--red-border, rgba(248,113,113,0.5))' : 'var(--border)'}`, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-primary)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{account.name || account.username}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', wordBreak: 'break-all', marginTop: 2 }}>{account.username}, {account.serverUrl}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            {synced}
            {account.calendarCount != null && ` ${t('calendar.accounts.counts', { calendars: account.calendarCount, events: account.eventCount })}`}
          </div>
        </div>
        <Btn disabled={busy === 'sync'} onClick={() => run('sync', async () => {
          const res = await api.calendar.syncAccount(account.id);
          if (res && res.ok === false) setError(res.error || t('calendar.accounts.syncFailed'));
          else setNote(t('calendar.accounts.synced'));
          await onChanged();
        })} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="sync" size={13} style={busy === 'sync' ? { animation: 'spin 0.8s linear infinite' } : undefined} />
          {busy === 'sync' ? t('calendar.accounts.syncing') : t('calendar.accounts.syncNow')}
        </Btn>
      </div>

      {account.lastError && (
        <ErrorBox>
          <strong style={{ display: 'block', marginBottom: 2 }}>{t('calendar.accounts.syncFailed')}</strong>
          {account.lastError}
        </ErrorBox>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      {note && <div role="status" style={{ fontSize: 12.5, color: 'var(--green)' }}>{note}</div>}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {t('calendar.accounts.interval')}
          <select value={account.intervalMin} disabled={busy === 'interval'} style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}
            onChange={e => run('interval', async () => { await api.calendar.updateAccount(account.id, { intervalMin: Number(e.target.value) }); await onChanged(); })}>
            {intervals.map(n => <option key={n} value={n}>{t('calendar.accounts.everyMinutes', { n })}</option>)}
          </select>
        </label>
        <span style={{ flex: 1 }} />
        <Btn kind="plain" onClick={() => { setPwOpen(o => !o); setPassword(''); }}>{t('calendar.accounts.changePassword')}</Btn>
        {!confirming && <Btn kind="danger" onClick={() => setConfirming(true)}>{t('common.remove')}</Btn>}
      </div>

      {pwOpen && (
        <form onSubmit={e => {
          e.preventDefault();
          if (!password) return;
          run('password', async () => {
            await api.calendar.updateAccount(account.id, { password });
            setPwOpen(false);
            setPassword('');
            setNote(t('calendar.accounts.passwordSaved'));
            await onChanged();
          });
        }} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <label style={{ flex: 1 }}>
            <span style={labelStyle}>{t('calendar.accounts.newPassword')}</span>
            <PasswordInput value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" style={inputStyle} />
          </label>
          <Btn kind="primary" disabled={!password || busy === 'password'} onClick={e => e.currentTarget.form.requestSubmit()}>
            {busy === 'password' ? t('common.saving') : t('common.save')}
          </Btn>
        </form>
      )}

      {confirming && (
        <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--red-dim, rgba(248,113,113,0.1))', border: '1px solid var(--red-border, rgba(248,113,113,0.3))' }}>
          <div style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-primary)', lineHeight: 1.45 }}>
            {t('calendar.accounts.removeConfirm', { name: account.name || account.username })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn kind="solidDanger" disabled={busy === 'remove'} onClick={() => run('remove', async () => { await api.calendar.removeAccount(account.id); await onChanged(); })}>
              {busy === 'remove' ? t('common.deleting') : t('common.remove')}
            </Btn>
            <Btn onClick={() => setConfirming(false)}>{t('common.cancel')}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function MailAccounts({ onAdded }) {
  const { t } = useTranslation();
  const [mail, setMail] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.calendar.mailAccounts().then(list => { if (live) setMail(list); }).catch(err => { if (live) setError(err.message); });
    return () => { live = false; };
  }, []);

  const connect = async (account) => {
    setBusy(account.id);
    setError(null);
    try {
      await api.calendar.addFromMail(account.id);
      setMail(list => list.map(m => (m.id === account.id ? { ...m, connected: true } : m)));
      await onAdded();
    } catch (err) {
      setError(err.code === 'no_caldav' ? t('calendar.accounts.fromMailNone', { host: account.host, error: err.message }) : err.message);
    } finally {
      setBusy(null);
    }
  };

  const open = mail.filter(m => !m.connected);
  if (!open.length && !error) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: '4px 0 0', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('calendar.accounts.fromMailTitle')}</h3>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{t('calendar.accounts.fromMailHint')}</p>
      {open.map(m => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-all' }}>{m.email}</div>
          <Btn kind="primary" disabled={busy !== null} onClick={() => connect(m)}>
            {busy === m.id ? t('calendar.accounts.connecting') : t('calendar.accounts.connect')}
          </Btn>
        </div>
      ))}
      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  );
}

function AddForm({ onAdded, first }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', serverUrl: '', username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm(f => ({ ...f, ...patch }));
  const ready = form.serverUrl.trim() && form.username.trim() && form.password;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.calendar.addAccount({
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        serverUrl: form.serverUrl.trim(), username: form.username.trim(), password: form.password,
      });
      setForm({ name: '', serverUrl: '', username: '', password: '' });
      await onAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!first && <h3 style={{ margin: '4px 0 0', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('calendar.accounts.addTitle')}</h3>}
      <label>
        <span style={labelStyle}>{t('calendar.accounts.name')}</span>
        <input value={form.name} onChange={e => set({ name: e.target.value })} style={inputStyle} />
      </label>
      <label>
        <span style={labelStyle}>{t('calendar.accounts.serverUrl')}</span>
        <input data-autofocus="" value={form.serverUrl} onChange={e => set({ serverUrl: e.target.value })} placeholder="https://caldav.example.com/dav/" inputMode="url" autoComplete="off" style={inputStyle} />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label>
          <span style={labelStyle}>{t('calendar.accounts.username')}</span>
          <input value={form.username} onChange={e => set({ username: e.target.value })} autoComplete="off" style={inputStyle} />
        </label>
        <label>
          <span style={labelStyle}>{t('calendar.accounts.password')}</span>
          <PasswordInput value={form.password} onChange={e => set({ password: e.target.value })} autoComplete="new-password" style={inputStyle} />
        </label>
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
        {t('calendar.accounts.appPasswordHint')} {t('calendar.accounts.googleHint')}
      </p>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn kind="primary" disabled={!ready || busy} onClick={e => e.currentTarget.form.requestSubmit()}>
          {busy ? t('calendar.accounts.connecting') : t('calendar.accounts.connect')}
        </Btn>
      </div>
    </form>
  );
}

function PageHeader({ title, hint }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
      {hint && <p style={{ margin: '4px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{hint}</p>}
    </div>
  );
}

// The calendar accounts and the forms to add one.
export function CalendarAccountsPanel({ accounts, onChanged }) {
  const list = accounts || [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {list.map(a => <AccountCard key={a.id} account={a} onChanged={onChanged} />)}
      {list.length > 0 && <div style={{ borderTop: '1px solid var(--border-subtle)' }} />}
      <MailAccounts onAdded={onChanged} />
      <AddForm first={list.length === 0} onAdded={onChanged} />
    </div>
  );
}

// Loads the calendar accounts itself, as the calendar page may not be open.
function useCalendarAccounts() {
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState(null);
  const load = async () => {
    try {
      setAccounts(await api.calendar.accounts());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => { load(); }, []);
  // A first sync runs in the background: follow it until it has a result.
  const pending = Boolean(accounts?.some(a => !a.lastSyncAt && !a.lastError));
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [pending]);
  return { accounts, error, load };
}

// Settings, Calendar, Accounts.
export function CalendarAccountsTab() {
  const { t } = useTranslation();
  const { accounts, error, load } = useCalendarAccounts();
  return (
    <div>
      <PageHeader title={t('calendar.accounts.title')} />
      {error && <ErrorBox>{error}</ErrorBox>}
      {accounts && <CalendarAccountsPanel accounts={accounts} onChanged={load} />}
    </div>
  );
}

const hexColor = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#7c6af7');

function CalendarRow({ cal, onSaved }) {
  const { t } = useTranslation();
  const [name, setName] = useState(cal.displayName || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => { setName(cal.displayName || ''); }, [cal.displayName]);

  const save = async (patch) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.calendar.updateCalendar(cal.id, patch));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const commitName = () => {
    const next = name.trim();
    if (next !== (cal.displayName || '')) save({ displayName: next });
  };
  const pick = (color) => {
    setPicking(false);
    if (color.toLowerCase() !== String(cal.color).toLowerCase()) save({ color: hexColor(color) });
  };
  const label = cal.displayName || cal.serverName;
  const dim = { opacity: cal.ignored ? 0.55 : 1 };

  return (
    <li style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 200px', minWidth: 0, ...dim }}>
          <button type="button" disabled={busy || cal.ignored} onClick={() => setPicking(p => !p)} aria-expanded={picking}
            aria-label={t('calendar.rail.color', { name: label })} title={t('calendar.rail.color', { name: label })}
            style={{ width: 24, height: 24, padding: 0, border: 'none', background: 'none', cursor: cal.ignored ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ width: 14, height: 14, borderRadius: '50%', background: cal.color, boxShadow: picking ? '0 0 0 2px var(--bg-primary), 0 0 0 3.5px var(--text-tertiary)' : 'none' }} />
          </button>
          <input
            value={name} placeholder={cal.serverName} disabled={busy || cal.ignored}
            aria-label={t('calendar.accounts.calendarName', { name: cal.serverName })} title={cal.serverName}
            onChange={e => setName(e.target.value)} onBlur={commitName}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setName(cal.displayName || ''); }}
            style={{ ...inputStyle, padding: '5px 8px', flex: 1, minWidth: 0 }}
          />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-secondary)', cursor: cal.ignored ? 'default' : 'pointer', ...dim }}>
          <input type="checkbox" checked={cal.visible && !cal.ignored} disabled={busy || cal.ignored}
            onChange={e => save({ visible: e.target.checked })} style={{ accentColor: 'var(--accent)', margin: 0 }} />
          {t('calendar.accounts.showInViews')}
        </label>
        <Btn kind="plain" disabled={busy} onClick={() => save({ ignored: !cal.ignored })} style={{ flexShrink: 0 }}>
          {cal.ignored ? t('calendar.accounts.restore') : t('calendar.accounts.ignore')}
        </Btn>
      </div>
      {picking && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 0 2px 34px', alignItems: 'center' }}>
          {PALETTE.map(c => (
            <button key={c} type="button" onClick={() => pick(c)} aria-label={c}
              style={{ width: 18, height: 18, borderRadius: '50%', background: c, cursor: 'pointer', padding: 0,
                border: c.toLowerCase() === String(cal.color).toLowerCase() ? '2px solid var(--text-primary)' : '2px solid transparent' }} />
          ))}
          <input type="color" value={hexColor(cal.color)} aria-label={t('calendar.rail.customColor')}
            onChange={e => pick(e.target.value)}
            style={{ width: 22, height: 22, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
    </li>
  );
}

// Settings, Calendar, Calendars: every calendar of every account, hidden ones included.
export function CalendarListTab() {
  const { t } = useTranslation();
  const setAdminTab = useStore(s => s.setAdminTab);
  const { accounts, error } = useCalendarAccounts();
  const [calendars, setCalendars] = useState(null);
  const [listError, setListError] = useState(null);
  useEffect(() => {
    let live = true;
    api.calendar.allCalendars().then(cs => { if (live) setCalendars(cs); }).catch(err => { if (live) setListError(err.message); });
    return () => { live = false; };
  }, []);
  const onSaved = (cal) => setCalendars(cs => cs.map(c => (c.id === cal.id ? { ...c, ...cal } : c)));

  const groups = groupCalendarsByAccount(accounts, calendars);
  return (
    <div>
      <PageHeader title={t('admin.tabs.calendarList')} hint={t('calendar.accounts.listHint')} />
      {(error || listError) && <ErrorBox>{error || listError}</ErrorBox>}
      {accounts && calendars && groups.length === 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('calendar.accounts.noCalendars')}</span>
          <Btn onClick={() => setAdminTab('calendar-accounts')}>{t('calendar.accounts.goToAccounts')}</Btn>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {groups.map(({ account, calendars: own }) => (
          <section key={account.id}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6, wordBreak: 'break-word' }}>{account.name || account.username}</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-primary)' }}>
              {own.map((c, i) => (
                <div key={c.id} style={{ borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
                  <CalendarRow cal={c} onSaved={onSaved} />
                </div>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
