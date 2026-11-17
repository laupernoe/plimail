import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';

// Settings → Mail → Server filters: Sieve rules the mail server runs itself, over ManageSieve
// (backend routes/sieve.js). Plimail writes its own script, `plimail`; replacing another active
// script, or saving over one Plimail did not write, is asked first.

export const PLIMAIL_SCRIPT = 'plimail';

const button = (kind = 'plain', busy = false) => ({
  padding: '5px 11px', fontSize: 12.5, fontWeight: 500, borderRadius: 6, cursor: busy ? 'default' : 'pointer',
  background: kind === 'primary' ? 'var(--accent)' : kind === 'danger' ? 'var(--red)' : 'var(--bg-tertiary)',
  color: kind === 'primary' ? 'var(--accent-text)' : kind === 'danger' ? '#fff' : 'var(--text-primary)',
  border: kind === 'plain' ? '1px solid var(--border)' : 'none',
  opacity: busy ? 0.6 : 1,
});

const input = {
  padding: '6px 9px', fontSize: 13, borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-primary)', color: 'var(--text-primary)', minWidth: 0,
};

const heading = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: '18px 0 8px' };
const hint = { fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 };

const blankRule = () => ({ field: 'from', contains: '', action: 'move', folder: '', address: '' });

// Accounts whose IMAP password can also open ManageSieve: not OAuth, not POP.
export function sieveAccounts(accounts) {
  return (accounts || []).filter(a => a.protocol !== 'pop3' && !a.oauth_provider && a.enabled !== false);
}

function reasonText(t, reason) {
  return {
    oauth: t('admin.serverFilters.reasonOauth'),
    no_starttls: t('admin.serverFilters.reasonNoStarttls'),
    tls_failed: t('admin.serverFilters.reasonTls'),
    no_plain: t('admin.serverFilters.reasonNoPlain'),
  }[reason] || t('admin.serverFilters.reasonUnreachable');
}

function errorText(t, err) {
  if (err?.code === 'sieve_rejected') return t('admin.serverFilters.errorRejected', { message: err.message });
  if (err?.code === 'sieve_auth_failed') return t('admin.serverFilters.errorAuth');
  if (err?.code === 'extension_missing') return t('admin.serverFilters.errorExtension');
  if (err?.code === 'no_trash') return t('admin.serverFilters.errorNoTrash');
  if (err?.code === 'invalid_rule' || err?.code === 'unknown_folder') return t('admin.serverFilters.errorRule');
  if (err?.code === 'rate_limited') return t('admin.serverFilters.errorRateLimited');
  return t('admin.serverFilters.errorGeneric');
}

function Pill({ children, color }) {
  return (
    <span style={{ fontSize: 11.5, fontWeight: 500, color, border: `1px solid ${color}`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

// A question the save needs answered first, with the action that answers it.
function Confirm({ text, confirmLabel, onConfirm, onCancel, extra, busy }) {
  const { t } = useTranslation();
  return (
    <div role="alertdialog" style={{ border: '1px solid var(--amber)', background: 'var(--bg-secondary)', borderRadius: 8, padding: '10px 12px', margin: '10px 0' }}>
      <p style={{ fontSize: 13, color: 'var(--text-primary)', margin: '0 0 8px', lineHeight: 1.5 }}>{text}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy} onClick={onConfirm} style={button('primary', busy)}>{confirmLabel}</button>
        {extra}
        <button type="button" disabled={busy} onClick={onCancel} style={button()}>{t('admin.serverFilters.cancel')}</button>
      </div>
    </div>
  );
}

function RuleRow({ rule, index, folders, onChange, onRemove }) {
  const { t } = useTranslation();
  const set = patch => onChange(index, { ...rule, ...patch });
  return (
    <li style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <select aria-label={t('admin.serverFilters.fieldLabel')} value={rule.field} onChange={e => set({ field: e.target.value })} style={input}>
        <option value="from">{t('admin.serverFilters.fieldFrom')}</option>
        <option value="subject">{t('admin.serverFilters.fieldSubject')}</option>
        <option value="recipient">{t('admin.serverFilters.fieldRecipient')}</option>
      </select>
      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{t('admin.serverFilters.contains')}</span>
      <input
        aria-label={t('admin.serverFilters.containsLabel')}
        value={rule.contains}
        onChange={e => set({ contains: e.target.value })}
        maxLength={200}
        style={{ ...input, flex: '1 1 140px' }}
      />
      <select aria-label={t('admin.serverFilters.actionLabel')} value={rule.action} onChange={e => set({ action: e.target.value })} style={input}>
        <option value="move">{t('admin.serverFilters.actionMove')}</option>
        <option value="markRead">{t('admin.serverFilters.actionMarkRead')}</option>
        <option value="delete">{t('admin.serverFilters.actionDelete')}</option>
        <option value="redirect">{t('admin.serverFilters.actionRedirect')}</option>
      </select>
      {rule.action === 'move' && (
        <select aria-label={t('admin.serverFilters.folderLabel')} value={rule.folder || ''} onChange={e => set({ folder: e.target.value })} style={{ ...input, maxWidth: 200 }} title={rule.folder || undefined}>
          <option value="">{t('admin.serverFilters.chooseFolder')}</option>
          {folders.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}
        </select>
      )}
      {rule.action === 'redirect' && (
        <input
          type="email"
          aria-label={t('admin.serverFilters.addressLabel')}
          placeholder={t('admin.serverFilters.addressPh')}
          value={rule.address || ''}
          onChange={e => set({ address: e.target.value })}
          style={{ ...input, flex: '1 1 160px' }}
        />
      )}
      <button type="button" onClick={() => onRemove(index)} aria-label={t('admin.serverFilters.removeRule')} title={t('admin.serverFilters.removeRule')} style={button()}>
        ×
      </button>
    </li>
  );
}

function RawEditor({ accountId, scripts, initialName, initialContent, onSaved }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const open = async (next) => {
    setName(next);
    setMessage(null);
    setConfirm(null);
    if (!scripts.some(s => s.name === next)) { setContent(''); return; }
    setBusy(true);
    try {
      setContent((await api.sieve.script(accountId, next)).content);
    } catch (err) {
      setMessage({ error: true, text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.sieve.check(accountId, content);
      setMessage({ error: false, text: r.warnings ? t('admin.serverFilters.checkWarnings', { warnings: r.warnings }) : t('admin.serverFilters.checkOk') });
    } catch (err) {
      setMessage({ error: true, text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  const save = async (options = {}) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.sieve.saveScript(accountId, name, { content, ...options });
      setConfirm(null);
      setMessage({ error: false, text: t('admin.serverFilters.saved') });
      onSaved();
    } catch (err) {
      if (err.code === 'not_plimail') setConfirm({ kind: 'overwrite' });
      else if (err.code === 'other_active') setConfirm({ kind: 'active', active: err.active });
      else setMessage({ error: true, text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  const names = [...new Set([PLIMAIL_SCRIPT, ...scripts.map(s => s.name)])];
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <select aria-label={t('admin.serverFilters.scriptLabel')} value={name} onChange={e => open(e.target.value)} style={input} disabled={busy}>
          {names.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        {name !== PLIMAIL_SCRIPT && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('admin.serverFilters.notPlimailScript')}</span>}
      </div>
      <textarea
        aria-label={t('admin.serverFilters.rawLabel')}
        value={content}
        onChange={e => setContent(e.target.value)}
        spellCheck={false}
        rows={14}
        style={{ ...input, width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-mono, monospace)', fontSize: 12.5, lineHeight: 1.5, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy} onClick={check} style={button('plain', busy)}>{t('admin.serverFilters.check')}</button>
        <button type="button" disabled={busy} onClick={() => save()} style={button('primary', busy)}>{t('admin.serverFilters.saveScript')}</button>
      </div>
      {confirm?.kind === 'overwrite' && (
        <Confirm
          busy={busy}
          text={t('admin.serverFilters.confirmOverwrite', { name })}
          confirmLabel={t('admin.serverFilters.overwrite')}
          onConfirm={() => save({ overwrite: true })}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'active' && (
        <Confirm
          busy={busy}
          text={t('admin.serverFilters.confirmReplaceActive', { active: confirm.active })}
          confirmLabel={t('admin.serverFilters.replaceActive')}
          onConfirm={() => save({ activate: true, replaceActive: true, overwrite: name !== PLIMAIL_SCRIPT })}
          onCancel={() => setConfirm(null)}
        />
      )}
      {message && <p role={message.error ? 'alert' : 'status'} style={{ fontSize: 12.5, color: message.error ? 'var(--red)' : 'var(--green)', margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{message.text}</p>}
    </div>
  );
}

export default function ServerFiltersSection() {
  const { t } = useTranslation();
  const { accounts, folders: storeFolders, setFolders } = useStore();
  const eligible = useMemo(() => sieveAccounts(accounts), [accounts]);
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [rules, setRules] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [mode, setMode] = useState('rules');

  const current = accountId || eligible[0]?.id || '';

  const load = useCallback(async () => {
    if (!current) return;
    setLoading(true);
    setLoadError('');
    try {
      const s = await api.sieve.status(current);
      setStatus(s);
      setRules(s.plimail?.rules?.length ? s.plimail.rules.map(r => ({ ...blankRule(), ...r })) : []);
      setMode(s.plimail?.exists && !s.plimail.managed ? 'raw' : 'rules');
    } catch (err) {
      setStatus(null);
      setLoadError(errorText(t, err));
    } finally {
      setLoading(false);
    }
  }, [current, t]);

  useEffect(() => {
    setStatus(null);
    setMessage(null);
    setConfirm(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!current || current in useStore.getState().folders) return;
    api.getFolders(current).then(data => setFolders(current, data)).catch(() => {});
  }, [current, setFolders]);

  const folders = (storeFolders[current] || []).filter(f => f.path && f.path !== 'INBOX');

  const saveRules = async (options = {}) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.sieve.saveRules(current, { rules, ...options });
      setConfirm(null);
      setMessage({ error: false, text: t('admin.serverFilters.saved') });
      load();
    } catch (err) {
      if (err.code === 'other_active') setConfirm({ kind: 'active', active: err.active, options });
      else if (err.code === 'plimail_edited') setConfirm({ kind: 'edited', options });
      else setMessage({ error: true, text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (name, replaceActive = false) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.sieve.setActive(current, name, replaceActive);
      setConfirm(null);
      load();
    } catch (err) {
      if (err.code === 'other_active') setConfirm({ kind: 'activate', name, active: err.active });
      else setMessage({ error: true, text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  const changeRule = (index, rule) => setRules(rs => rs.map((r, i) => (i === index ? rule : r)));
  const removeRule = index => setRules(rs => rs.filter((_, i) => i !== index));

  return (
    <section aria-labelledby="server-filters-title">
      <h3 id="server-filters-title" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' }}>
        {t('admin.serverFilters.title')}
      </h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
        {t('admin.serverFilters.intro')}
      </p>

      {eligible.length === 0 && <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.serverFilters.noAccounts')}</p>}
      {eligible.length > 1 && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
          {t('admin.serverFilters.account')}
          <select value={current} onChange={e => setAccountId(e.target.value)} style={input}>
            {eligible.map(a => <option key={a.id} value={a.id}>{a.email_address}</option>)}
          </select>
        </label>
      )}

      {loading && <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.serverFilters.connecting')}</p>}
      {loadError && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{loadError}</p>}

      {status && !status.supported && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Pill color="var(--text-tertiary)">{t('admin.serverFilters.unsupported')}</Pill>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{reasonText(t, status.reason)}</span>
        </div>
      )}

      {status?.supported && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <Pill color="var(--green)">{t('admin.serverFilters.supported')}</Pill>
            {status.implementation && <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{status.implementation}</span>}
          </div>

          {status.otherActive && (
            <p role="note" style={{ fontSize: 13, color: 'var(--text-primary)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', margin: '12px 0 0', lineHeight: 1.5 }}>
              {t('admin.serverFilters.otherActiveWarning', { active: status.otherActive })}
            </p>
          )}

          <h4 style={heading}>{t('admin.serverFilters.scripts')}</h4>
          {status.scripts.length === 0 && <p style={hint}>{t('admin.serverFilters.noScripts')}</p>}
          {status.scripts.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border-subtle)' }}>
              {status.scripts.map(s => (
                <li key={s.name} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1, overflowWrap: 'anywhere' }}>
                    {s.name}
                    {s.name === PLIMAIL_SCRIPT && <span style={{ color: 'var(--text-secondary)', marginLeft: 8, fontSize: 12 }}>{t('admin.serverFilters.plimailScript')}</span>}
                  </span>
                  {s.active
                    ? <Pill color="var(--green)">{t('admin.serverFilters.active')}</Pill>
                    : <button type="button" disabled={busy} onClick={() => setActive(s.name)} style={button('plain', busy)}>{t('admin.serverFilters.activate')}</button>}
                  {s.active && s.name === PLIMAIL_SCRIPT && (
                    <button type="button" disabled={busy} onClick={() => setActive(null)} style={button('plain', busy)}>{t('admin.serverFilters.deactivate')}</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {confirm?.kind === 'activate' && (
            <Confirm
              busy={busy}
              text={t('admin.serverFilters.confirmReplaceActive', { active: confirm.active })}
              confirmLabel={t('admin.serverFilters.replaceActive')}
              onConfirm={() => setActive(confirm.name, true)}
              onCancel={() => setConfirm(null)}
            />
          )}

          <div role="tablist" style={{ display: 'flex', gap: 6, margin: '18px 0 8px' }}>
            {['rules', 'raw'].map(m => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} style={button(mode === m ? 'primary' : 'plain')}>
                {m === 'rules' ? t('admin.serverFilters.rulesTab') : t('admin.serverFilters.rawTab')}
              </button>
            ))}
          </div>

          {mode === 'rules' && (
            <div>
              {status.plimail.exists && !status.plimail.managed && <p style={hint}>{t('admin.serverFilters.editedByHand')}</p>}
              {rules.length === 0 && <p style={hint}>{t('admin.serverFilters.noRules')}</p>}
              {rules.length > 0 && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border-subtle)' }}>
                  {rules.map((rule, i) => (
                    <RuleRow key={i} rule={rule} index={i} folders={folders} onChange={changeRule} onRemove={removeRule} />
                  ))}
                </ul>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => setRules(rs => [...rs, blankRule()])} style={button()}>{t('admin.serverFilters.addRule')}</button>
                <button type="button" disabled={busy} onClick={() => saveRules()} style={button('primary', busy)}>
                  {busy ? t('admin.serverFilters.saving') : t('admin.serverFilters.saveRules')}
                </button>
              </div>
              {confirm?.kind === 'active' && (
                <Confirm
                  busy={busy}
                  text={t('admin.serverFilters.confirmReplaceActive', { active: confirm.active })}
                  confirmLabel={t('admin.serverFilters.replaceActive')}
                  onConfirm={() => saveRules({ ...confirm.options, replaceActive: true })}
                  extra={(
                    <button type="button" disabled={busy} onClick={() => saveRules({ ...confirm.options, activate: false })} style={button('plain', busy)}>
                      {t('admin.serverFilters.saveInactive')}
                    </button>
                  )}
                  onCancel={() => setConfirm(null)}
                />
              )}
              {confirm?.kind === 'edited' && (
                <Confirm
                  busy={busy}
                  text={t('admin.serverFilters.confirmReplaceEdited')}
                  confirmLabel={t('admin.serverFilters.overwrite')}
                  onConfirm={() => saveRules({ ...confirm.options, overwrite: true })}
                  onCancel={() => setConfirm(null)}
                />
              )}
            </div>
          )}

          {mode === 'raw' && (
            <RawEditor
              key={current}
              accountId={current}
              scripts={status.scripts}
              initialName={PLIMAIL_SCRIPT}
              initialContent={status.plimail.content}
              onSaved={load}
            />
          )}

          {message && <p role={message.error ? 'alert' : 'status'} style={{ fontSize: 12.5, color: message.error ? 'var(--red)' : 'var(--green)', margin: '8px 0 0' }}>{message.text}</p>}
        </>
      )}
    </section>
  );
}
