import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import SignatureEditor from './SignatureEditor.jsx';

// Settings → Mail → Signatures: the user's signature library (routes/signatures.js), and which
// one each account and alias starts a message with. The composer can switch to any of them.

const button = (kind = 'plain', busy = false) => ({
  padding: '5px 11px', fontSize: 12.5, fontWeight: 500, borderRadius: 6, cursor: busy ? 'default' : 'pointer',
  background: kind === 'primary' ? 'var(--accent)' : kind === 'danger' ? 'var(--red)' : 'var(--bg-tertiary)',
  color: kind === 'primary' ? 'var(--accent-text)' : kind === 'danger' ? '#fff' : 'var(--text-primary)',
  border: kind === 'plain' ? '1px solid var(--border)' : 'none',
  opacity: busy ? 0.6 : 1,
});

const fieldStyle = {
  padding: '7px 10px', fontSize: 13, borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
};

const heading = { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' };
const intro = { fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 };

function Editor({ initial, onSave, onCancel }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name || '');
  const [html, setHtml] = useState(initial.html || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError(t('admin.signatures.errorName')); return; }
    setBusy(true);
    setError('');
    try {
      await onSave({ name: name.trim(), html });
    } catch (err) {
      setError(err?.message || t('admin.signatures.saveFailed'));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} data-signature-form style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, margin: '0 0 14px', background: 'var(--bg-secondary)' }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
        {t('admin.signatures.name')}
        <input value={name} onChange={e => setName(e.target.value)} maxLength={200} autoFocus
          placeholder={t('admin.signatures.namePh')}
          style={{ ...fieldStyle, display: 'block', width: '100%', marginTop: 4 }} />
      </label>
      <div style={{ marginTop: 10 }}>
        <SignatureEditor value={html} onChange={setHtml} />
      </div>
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <button type="submit" disabled={busy} style={button('primary', busy)}>{busy ? t('common.saving') : t('common.save')}</button>
        <button type="button" onClick={onCancel} style={button()}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

function Entry({ signature, usedBy, onEdit, onDuplicate, onDelete }) {
  const { t } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <li style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{signature.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, overflowWrap: 'anywhere' }}>
            {usedBy.length ? t('admin.signatures.usedBy', { list: usedBy.join(', ') }) : t('admin.signatures.unused')}
          </div>
          {signature.html ? (
            <div data-signature-preview
              style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--bg-tertiary)', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, maxHeight: 120, overflow: 'hidden', overflowWrap: 'anywhere' }}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(signature.html) }} />
          ) : null}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={onEdit} style={button()}>{t('common.edit')}</button>
          <button type="button" onClick={onDuplicate} style={button()}>{t('admin.signatures.duplicate')}</button>
          {confirmDelete ? (
            <>
              <button type="button" onClick={onDelete} style={button('danger')}>{t('admin.signatures.confirmDelete')}</button>
              <button type="button" onClick={() => setConfirmDelete(false)} style={button()}>{t('common.cancel')}</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} style={button()}>{t('common.delete')}</button>
          )}
        </div>
      </div>
    </li>
  );
}

function AssignSelect({ label, value, signatures, emptyLabel, onChange, disabled }) {
  return (
    <select aria-label={label} value={value || ''} disabled={disabled}
      onChange={e => onChange(e.target.value || null)}
      style={{ ...fieldStyle, cursor: 'pointer', maxWidth: '100%', minWidth: 160 }}>
      <option value="">{emptyLabel}</option>
      {signatures.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

export default function SignaturesSection() {
  const { t } = useTranslation();
  const { accounts, setAccounts } = useStore();
  const [signatures, setSignatures] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(null); // null | { id?, name, html }
  const [error, setError] = useState('');
  const [assigning, setAssigning] = useState(null);

  const load = useCallback(() => {
    api.getSignatures()
      .then((list) => { setSignatures(list || []); setLoadFailed(false); })
      .catch(() => setLoadFailed(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  // The accounts carry the copy of their signature the composer starts with, so they are fetched
  // again after any change that can rewrite it.
  const refreshAccounts = () => api.getAccounts().then(setAccounts).catch(() => {});

  const act = async (call) => {
    setError('');
    try {
      await call();
      load();
      await refreshAccounts();
    } catch (err) {
      setError(err?.message || t('admin.signatures.saveFailed'));
    }
  };

  const save = async ({ name, html }) => {
    if (editing.id) await api.updateSignature(editing.id, { name, html });
    else await api.createSignature({ name, html });
    setEditing(null);
    load();
    if (editing.id) await refreshAccounts();
  };

  const assign = async (accountId, aliasId, signatureId) => {
    setAssigning(aliasId || accountId);
    await act(() => api.assignSignature({ accountId, aliasId, signatureId }));
    setAssigning(null);
  };

  const usedBy = (id) => accounts.flatMap(a => [
    ...(a.signature_id === id ? [a.email_address] : []),
    ...(a.aliases || []).filter(al => al.signature_id === id).map(al => al.email),
  ]);

  const list = signatures || [];
  return (
    <section aria-labelledby="signatures-title">
      <h3 id="signatures-title" style={heading}>{t('admin.signatures.title')}</h3>
      <p style={intro}>{t('admin.signatures.intro')}</p>
      {loadFailed && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{t('admin.signatures.loadFailed')}</p>}
      {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{error}</p>}

      {editing ? (
        <Editor key={editing.id || 'new'} initial={editing} onSave={save} onCancel={() => setEditing(null)} />
      ) : (
        <button type="button" disabled={!signatures} onClick={() => setEditing({ name: '', html: '' })}
          style={{ ...button('primary', !signatures), marginBottom: 14 }}>
          {t('admin.signatures.new')}
        </button>
      )}

      {signatures && list.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.signatures.empty')}</p>
      )}
      {list.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border-subtle)' }}>
          {list.map(s => (
            <Entry key={s.id} signature={s} usedBy={usedBy(s.id)}
              onEdit={() => setEditing({ id: s.id, name: s.name, html: s.html })}
              onDuplicate={() => act(() => api.createSignature({ name: t('admin.signatures.copyName', { name: s.name }), html: s.html }))}
              onDelete={() => act(() => api.deleteSignature(s.id))} />
          ))}
        </ul>
      )}

      {signatures && accounts.length > 0 && (
        <div style={{ marginTop: 28, paddingTop: 22, borderTop: '1px solid var(--border-subtle)' }}>
          <h3 style={heading}>{t('admin.signatures.assignTitle')}</h3>
          <p style={intro}>{t('admin.signatures.assignIntro')}</p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {accounts.map(a => (
              <li key={a.id} data-assign-account={a.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }}>
                    {a.name && a.name !== a.email_address ? `${a.name} · ${a.email_address}` : a.email_address}
                  </span>
                  <AssignSelect label={a.email_address} value={a.signature_id} signatures={list}
                    emptyLabel={t('admin.signatures.none')} disabled={assigning === a.id}
                    onChange={id => assign(a.id, null, id)} />
                </div>
                {(a.aliases || []).map(al => (
                  <div key={al.id} data-assign-alias={al.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 6, paddingLeft: 16 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', minWidth: 0, overflowWrap: 'anywhere' }}>
                      {al.name && al.name !== al.email ? `${al.name} · ${al.email}` : al.email}
                    </span>
                    <AssignSelect label={al.email} value={al.signature_id} signatures={list}
                      emptyLabel={t('admin.signatures.sameAsAccount')} disabled={assigning === al.id}
                      onChange={id => assign(a.id, al.id, id)} />
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
