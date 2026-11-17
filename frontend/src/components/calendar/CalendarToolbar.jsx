import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { VIEWS } from '../../utils/calendarDates.js';
import { SEARCH_MAX } from './eventSearch.js';
import { Btn, Icon, IconBtn } from './calendarUi.jsx';
import { HIT, ICON, ICON_SMALL } from '../../utils/uiSizes.js';

const VIEW_KEYS = {
  month: 'calendar.views.month',
  week: 'calendar.views.week',
  day: 'calendar.views.day',
  agenda: 'calendar.views.agenda',
};

function Segmented({ view, onView, compact }) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t('calendar.views.label')} style={{ display: 'flex', background: 'var(--bg-tertiary)', borderRadius: 8, padding: 2, gap: 2 }}>
      {VIEWS.map(v => (
        <button key={v} type="button" aria-pressed={view === v} onClick={() => onView(v)} style={{
          border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: compact ? 12 : 12.5, fontWeight: 500,
          padding: compact ? '8px 2px' : '0 14px', height: compact ? undefined : HIT - 4, borderRadius: 6, flex: compact ? 1 : 'none', minWidth: 0, whiteSpace: 'nowrap',
          background: view === v ? 'var(--bg-elevated)' : 'transparent',
          color: view === v ? 'var(--text-primary)' : 'var(--text-secondary)',
          boxShadow: view === v ? 'var(--shadow-soft)' : 'none',
        }}>{t(VIEW_KEYS[v])}</button>
      ))}
    </div>
  );
}

// Escape clears what is typed, then leaves the field.
function SearchField({ value, onChange, inputRef, onClose, isMobile }) {
  const { t } = useTranslation();
  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (value) onChange('');
    else { e.currentTarget.blur(); onClose?.(); }
  };
  return (
    <div role="search" style={{ position: 'relative', display: 'flex', alignItems: 'center', flex: isMobile ? 1 : '0 1 240px', minWidth: isMobile ? 0 : 150 }}>
      <Icon name="search" size={ICON_SMALL} style={{ position: 'absolute', left: 9, color: 'var(--text-tertiary)', pointerEvents: 'none' }} />
      <input
        ref={inputRef} type="text" inputMode="search" enterKeyHint="search" value={value} maxLength={SEARCH_MAX} autoFocus={isMobile}
        onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown}
        placeholder={t('calendar.search.placeholder')} aria-label={t('calendar.search.label')}
        style={{
          width: '100%', boxSizing: 'border-box', padding: value ? '0 30px 0 29px' : '0 10px 0 29px', borderRadius: 7,
          border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
          fontSize: isMobile ? 16 : 13, fontFamily: 'inherit', outline: 'none', height: HIT,
        }}
      />
      {value && (
        <IconBtn label={t('calendar.search.clear')} icon="close" onClick={() => { onChange(''); inputRef?.current?.focus(); }}
          size={24} iconSize={13} style={{ position: 'absolute', right: 3 }} />
      )}
    </div>
  );
}

export default function CalendarToolbar({
  title, view, onView, onToday, onPrev, onNext, isMobile, busy, onRail, onBack, onSync, syncing, search = '', onSearch, searchRef,
}) {
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(false);
  const nav = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Btn onClick={onToday} style={{ marginRight: 4, height: HIT, padding: '0 14px' }}>{t('calendar.today')}</Btn>
      <IconBtn label={t('calendar.previous')} icon="chevL" onClick={onPrev} size={HIT} iconSize={ICON} />
      <IconBtn label={t('calendar.next')} icon="chevR" onClick={onNext} size={HIT} iconSize={ICON} />
    </div>
  );
  const heading = (
    <h1 aria-live="polite" style={{
      margin: 0, fontSize: isMobile ? 16 : 19, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: isMobile ? 1 : '1 1 170px',
    }}>{title}</h1>
  );
  const sync = onSync ? (
    <IconBtn label={syncing ? t('calendar.accounts.syncing') : t('calendar.syncAll')} icon="sync" onClick={onSync} disabled={syncing}
      size={HIT} iconSize={ICON} iconStyle={syncing ? { animation: 'spin 0.8s linear infinite' } : undefined} />
  ) : null;
  const status = busy ? <span role="status" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('common.saving')}</span> : null;
  const closeSearch = () => { onSearch(''); setSearchOpen(false); };
  const field = onSearch ? (
    <SearchField value={search} onChange={onSearch} inputRef={searchRef} isMobile={isMobile} onClose={isMobile ? closeSearch : undefined} />
  ) : null;

  if (isMobile) {
    // Everything on two rows that fit a 320 px phone: no control is ever pushed off the edge.
    // The search takes a row of its own while it is open.
    const searching = field && (searchOpen || search);
    return (
      <div style={{ flexShrink: 0, padding: 'calc(var(--sat) + 4px) 8px 8px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          <IconBtn label={t('common.back')} icon="chevL" onClick={onBack} size={36} iconSize={20} />
          {heading}
          {status}
          <IconBtn label={t('calendar.today')} icon="today" onClick={onToday} size={36} iconSize={18} />
          <IconBtn label={t('calendar.previous')} icon="chevL" onClick={onPrev} size={36} />
          <IconBtn label={t('calendar.next')} icon="chevR" onClick={onNext} size={36} />
          {onSearch && (
            <IconBtn label={t('calendar.search.label')} icon="search" onClick={() => setSearchOpen(true)} active={Boolean(searching)}
              aria-expanded={Boolean(searching)} size={36} iconSize={18} />
          )}
          {sync}
          <IconBtn label={t('calendar.calendars')} icon="list" onClick={onRail} size={36} iconSize={18} />
        </div>
        {searching && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {field}
            <Btn kind="plain" onClick={closeSearch}>{t('common.cancel')}</Btn>
          </div>
        )}
        <Segmented view={view} onView={onView} compact />
      </div>
    );
  }
  return (
    <div style={{ flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
      {nav}
      {heading}
      {status}
      {field}
      {sync}
      <Segmented view={view} onView={onView} />
    </div>
  );
}
