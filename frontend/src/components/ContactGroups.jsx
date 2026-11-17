import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';

// The Contacts / Groups switch shown at the top of both views of the contacts page.
export function ContactsTabs({ tab, onTab }) {
  const { t } = useTranslation();
  const tabs = [['contacts', t('contacts.title')], ['groups', t('contacts.groups.tabGroups')]];
  return (
    <div role="tablist" style={{ display: 'flex', gap: 4, padding: '8px 14px 0', flexShrink: 0 }}>
      {tabs.map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={tab === id}
          onClick={() => onTab(id)}
          style={{
            flex: 1, padding: '6px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
            fontSize: 12, fontWeight: 500,
            background: tab === id ? 'var(--bg-hover)' : 'transparent',
            color: tab === id ? 'var(--accent)' : 'var(--text-tertiary)',
            transition: 'background 0.1s, color 0.1s',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ActionBtn({ children, onClick, danger, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="btn-press"
      style={{
        background: danger ? 'transparent' : 'var(--bg-tertiary)',
        border: danger ? '1px solid var(--red-border, rgba(248,113,113,0.4))' : '1px solid var(--border)',
        borderRadius: 7,
        color: danger ? 'var(--red, #f87171)' : 'var(--text-primary)',
        fontSize: 12, fontWeight: 500,
        padding: '6px 12px', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background 0.1s',
      }}
    >
      {children}
    </button>
  );
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  padding: '7px 10px', borderRadius: 7,
  border: '1px solid var(--border)',
  background: 'var(--bg-input)', color: 'var(--text-primary)',
  fontSize: 13, outline: 'none',
};

function ErrorLine({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      marginBottom: 14, padding: '10px 14px', borderRadius: 8,
      background: 'var(--red-dim, rgba(248,113,113,0.1))',
      border: '1px solid var(--red-border, rgba(248,113,113,0.3))',
      fontSize: 13, color: 'var(--red, #f87171)',
    }}>
      {msg}
    </div>
  );
}

function memberLabel(m) {
  return m.display_name || m.primary_email || '';
}

export default function ContactGroupsPanel({ tab, onTab }) {
  const { t } = useTranslation();
  const { setShowContacts } = useStore();
  const isMobile = useMobile();

  const [groups, setGroups]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [listError, setListError] = useState(null);
  const [selected, setSelected]   = useState(null); // { id, name, source, members }
  const [error, setError]         = useState(null);
  const [busy, setBusy]           = useState(false);
  const [creating, setCreating]   = useState(false);
  const [newName, setNewName]     = useState('');
  const [renaming, setRenaming]   = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [memberQuery, setMemberQuery]     = useState('');
  const [candidates, setCandidates]       = useState([]);
  const [mobilePanel, setMobilePanel]     = useState('list');
  const searchTimer = useRef(null);

  const load = useCallback(async () => {
    setListError(null);
    try {
      const res = await api.getContactGroups();
      setGroups(res.groups);
    } catch (err) {
      setListError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const resetDetail = () => {
    setRenaming(false); setConfirmDelete(false); setMemberQuery(''); setCandidates([]); setError(null);
  };

  const openGroup = async (g) => {
    resetDetail();
    try {
      setSelected(await api.getContactGroup(g.id));
      if (isMobile) setMobilePanel('detail');
    } catch (err) {
      setError(err.message);
    }
  };

  const backToList = () => { setMobilePanel('list'); setSelected(null); resetDetail(); };

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const createGroup = () => run(async () => {
    const created = await api.createContactGroup(newName);
    setCreating(false);
    setNewName('');
    await load();
    await openGroup(created);
  });

  const saveName = () => run(async () => {
    await api.renameContactGroup(selected.id, nameDraft);
    setSelected(await api.getContactGroup(selected.id));
    setRenaming(false);
    await load();
  });

  const deleteGroup = () => run(async () => {
    await api.deleteContactGroup(selected.id);
    setSelected(null);
    setConfirmDelete(false);
    if (isMobile) setMobilePanel('list');
    await load();
  });

  const onMemberQuery = (e) => {
    const val = e.target.value;
    setMemberQuery(val);
    clearTimeout(searchTimer.current);
    if (!val.trim()) { setCandidates([]); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await api.getContacts({ q: val.trim(), limit: 8, offset: 0 });
        setCandidates(res.contacts);
      } catch { setCandidates([]); }
    }, 250);
  };

  const addMember = (contact) => run(async () => {
    setSelected(await api.addContactGroupMembers(selected.id, [contact.id]));
    setMemberQuery('');
    setCandidates([]);
    await load();
  });

  const removeMember = (contact) => run(async () => {
    await api.removeContactGroupMember(selected.id, contact.id);
    setSelected(await api.getContactGroup(selected.id));
    await load();
  });

  const readOnly = selected && selected.source !== 'local';
  const memberIds = new Set((selected?.members || []).map(m => m.id));
  const addable = candidates.filter(c => !memberIds.has(c.id));

  const newForm = creating && (
    <form
      onSubmit={(e) => { e.preventDefault(); if (newName.trim() && !busy) createGroup(); }}
      style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <input
        autoFocus
        value={newName}
        onChange={e => setNewName(e.target.value)}
        placeholder={t('contacts.groups.namePlaceholder')}
        maxLength={100}
        style={inputStyle}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <ActionBtn onClick={createGroup} disabled={busy || !newName.trim()}>{t('contacts.groups.create')}</ActionBtn>
        <ActionBtn onClick={() => { setCreating(false); setNewName(''); setError(null); }}>{t('common.cancel')}</ActionBtn>
      </div>
      {!selected && <ErrorLine msg={error} />}
    </form>
  );

  const listPanel = (
    <>
      {newForm}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>{t('common.loading')}</div>
        )}
        {!loading && !groups.length && (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: listError ? 'var(--red, #f87171)' : 'var(--text-tertiary)' }}>
            {listError || t('contacts.groups.empty')}
          </div>
        )}
        {groups.map(g => (
          <div
            key={g.id}
            onClick={() => openGroup(g)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 14px', cursor: 'pointer',
              background: selected?.id === g.id ? 'var(--bg-hover)' : 'transparent',
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => { if (selected?.id !== g.id) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
            onMouseLeave={e => { if (selected?.id !== g.id) e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {g.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {t('contacts.groups.memberCount', { count: g.member_count })}
              </div>
            </div>
            {g.source !== 'local' && (
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)', borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>
                {t('contacts.groups.category')}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );

  const detailPanel = !selected ? (
    !isMobile && (
      <div style={{ color: 'var(--text-tertiary)', textAlign: 'center', fontSize: 15, padding: 24 }}>
        {t('contacts.groups.selectHint')}
      </div>
    )
  ) : (
    <div style={{ width: '100%', maxWidth: 560, alignSelf: 'flex-start' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        {renaming ? (
          <form
            onSubmit={(e) => { e.preventDefault(); if (nameDraft.trim() && !busy) saveName(); }}
            style={{ flex: 1, display: 'flex', gap: 8 }}
          >
            <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)} maxLength={100} style={inputStyle} />
            <ActionBtn onClick={saveName} disabled={busy || !nameDraft.trim()}>{t('common.save')}</ActionBtn>
            <ActionBtn onClick={() => { setRenaming(false); setError(null); }}>{t('common.cancel')}</ActionBtn>
          </form>
        ) : (
          <>
            <h2 style={{ flex: 1, margin: 0, fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selected.name}
            </h2>
            {!readOnly && (
              <>
                <ActionBtn onClick={() => { setNameDraft(selected.name); setRenaming(true); setError(null); }}>{t('contacts.groups.rename')}</ActionBtn>
                <ActionBtn onClick={() => setConfirmDelete(true)} danger>{t('common.delete')}</ActionBtn>
              </>
            )}
          </>
        )}
      </div>

      <ErrorLine msg={error} />

      {readOnly && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>{t('contacts.groups.readOnlyHint')}</div>
      )}

      {confirmDelete && (
        <div style={{
          padding: '14px 16px', borderRadius: 10, marginBottom: 20,
          background: 'var(--red-dim, rgba(248,113,113,0.1))',
          border: '1px solid var(--red-border, rgba(248,113,113,0.3))',
        }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 10 }}>{t('contacts.groups.deleteConfirm')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <ActionBtn onClick={deleteGroup} danger disabled={busy}>
              {busy ? t('common.deleting') : t('common.delete')}
            </ActionBtn>
            <ActionBtn onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</ActionBtn>
          </div>
        </div>
      )}

      {!readOnly && (
        <div style={{ position: 'relative', marginBottom: 16 }}>
          <input
            value={memberQuery}
            onChange={onMemberQuery}
            placeholder={t('contacts.groups.addMember')}
            style={inputStyle}
          />
          {addable.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, marginTop: 2,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 8, boxShadow: 'var(--shadow-popover)', overflow: 'hidden',
            }}>
              {addable.map((c, i) => (
                <div
                  key={c.id}
                  onClick={() => addMember(c)}
                  style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: i < addable.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{memberLabel(c)}</div>
                  {c.display_name && c.primary_email && (
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{c.primary_email}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selected.members.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('contacts.groups.noMembers')}</div>
      )}
      {selected.members.map(m => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {memberLabel(m)}
            </div>
            {m.display_name && m.primary_email && (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{m.primary_email}</div>
            )}
          </div>
          {!readOnly && (
            <ActionBtn onClick={() => removeMember(m)} disabled={busy}>{t('common.remove')}</ActionBtn>
          )}
        </div>
      ))}
    </div>
  );

  const newButton = (
    <button
      onClick={() => { setCreating(true); setError(null); }}
      style={{
        background: 'var(--accent)', border: 'none', borderRadius: 6,
        color: 'var(--accent-text)', fontSize: 12, fontWeight: 500,
        padding: '4px 10px', cursor: 'pointer',
      }}
    >
      + {t('contacts.groups.new')}
    </button>
  );

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--bg-secondary)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          paddingTop: 'calc(var(--sat) + 10px)', paddingBottom: 10, paddingLeft: 12, paddingRight: 12,
          borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', flexShrink: 0,
        }}>
          <button
            onClick={mobilePanel === 'detail' ? backToList : () => setShowContacts(false)}
            aria-label={t('common.back')}
            style={{
              background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <h2 style={{ flex: 1, margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {mobilePanel === 'detail' && selected ? selected.name : t('contacts.groups.tabGroups')}
          </h2>
          {mobilePanel === 'list' && newButton}
        </div>
        {mobilePanel === 'list' ? (
          <>
            <ContactsTabs tab={tab} onTab={onTab} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', marginTop: 8 }}>{listPanel}</div>
          </>
        ) : (
          <div style={{ flex: 1, overflow: 'hidden auto', padding: '20px 16px' }}>{detailPanel}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      <div style={{
        width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)', overflow: 'hidden',
      }}>
        <ContactsTabs tab={tab} onTab={onTab} />
        <div style={{ padding: '10px 14px 10px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('contacts.groups.tabGroups')}</span>
          {newButton}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', marginTop: 8 }}>{listPanel}</div>
      </div>
      <div style={{
        flex: 1, minWidth: 0, overflow: 'hidden auto', padding: selected ? 32 : 0,
        display: 'flex', alignItems: selected ? 'flex-start' : 'center', justifyContent: selected ? 'flex-start' : 'center',
      }}>
        {detailPanel}
      </div>
    </div>
  );
}
