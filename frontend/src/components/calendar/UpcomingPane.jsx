import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { appLocale } from '../../utils/formatDate.js';
import { addDays, formatClock, formatDayText, formatWhen, todayDay } from '../../utils/calendarDates.js';
import { Icon } from './calendarUi.jsx';
import { useUpcoming } from './useUpcoming.js';

const STORAGE_KEY = 'mailflow:calendar:upcomingOpen';

function storedOpen() {
  try { return localStorage.getItem(STORAGE_KEY) !== '0'; } catch { return true; }
}

const hover = {
  onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--bg-tertiary)'; },
  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
};

// A short look at the coming week in the mail sidebar, like Thunderbird's Today pane. Shown only
// in mail mode and only when a CalDAV account is connected; a failing calendar hides it.
export default function UpcomingPane({ isMobile }) {
  const { t } = useTranslation();
  const showCalendar = useStore(s => s.showCalendar);
  const setShowCalendar = useStore(s => s.setShowCalendar);
  const setCalendarFocus = useStore(s => s.setCalendarFocus);
  const setMobileSidebarOpen = useStore(s => s.setMobileSidebarOpen);
  const [open, setOpen] = useState(storedOpen);
  const data = useUpcoming({ mailMode: !showCalendar, open });
  const locale = appLocale();

  if (showCalendar || !data.hasAccounts || data.failed) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* just not remembered */ }
  };
  const openCalendar = (focus) => {
    setCalendarFocus(focus || null);
    setShowCalendar(true);
    if (isMobile) setMobileSidebarOpen(false);
  };

  const today = todayDay(data.now);
  const tomorrow = addDays(today, 1);
  const dayLabel = (day) => (day === today ? t('calendar.today')
    : day === tomorrow ? t('calendar.upcoming.tomorrow')
      : formatDayText(day, { weekday: 'short', day: 'numeric', month: 'short' }, locale));

  return (
    <section aria-label={t('calendar.upcoming.title')} data-upcoming="" style={{ flexShrink: 0, borderTop: '1px solid var(--border-subtle)', padding: '2px 8px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <button type="button" onClick={toggle} aria-expanded={open} {...hover} style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, padding: '6px 6px', border: 'none', borderRadius: 6,
          background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
          fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
        }}>
          <Icon name="chevR" size={12} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', color: 'var(--text-tertiary)' }} />
          {t('calendar.upcoming.title')}
        </button>
        <button type="button" onClick={() => openCalendar()} title={t('calendar.upcoming.open')} aria-label={t('calendar.upcoming.open')} {...hover} style={{
          width: 26, height: 26, flexShrink: 0, border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)',
        }}><Icon name="calendar" size={14} /></button>
      </div>

      {open && data.loaded && (
        data.groups.length === 0 ? (
          <p style={{ margin: 0, padding: '2px 8px 8px 22px', fontSize: 12, color: 'var(--text-tertiary)' }}>{t('calendar.upcoming.empty')}</p>
        ) : (
          <div style={{ maxHeight: 'min(30vh, 236px)', overflow: 'hidden auto', paddingBottom: 2 }}>
            {data.groups.map(({ day, items }) => (
              <div key={day} role="group" aria-label={dayLabel(day)}>
                <div style={{ fontSize: 11.5, fontWeight: 600, padding: '5px 6px 2px 22px', color: day === today ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                  {dayLabel(day)}
                </div>
                {items.map(({ key, occ, allDay, now, continued }) => (
                  <button key={key} type="button" onClick={() => openCalendar({ day, occ })} title={formatWhen(occ, locale)} {...hover} style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px 4px 22px', border: 'none', borderRadius: 6,
                    background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', color: 'var(--text-primary)',
                  }}>
                    <span style={{ flexShrink: 0, minWidth: 44, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', color: 'var(--text-tertiary)' }}>
                      {allDay ? t('calendar.allDay') : continued ? '…' : formatClock(occ.start, locale)}
                    </span>
                    <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: data.colorOf(occ.calendarId) }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, fontWeight: now ? 600 : 400 }}>
                      {occ.summary || t('common.noSubject')}
                    </span>
                    {now && (
                      <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-text)' }}>
                        {t('calendar.upcoming.now')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
            {data.hidden > 0 && (
              <button type="button" onClick={() => openCalendar()} {...hover} style={{
                display: 'block', width: '100%', padding: '5px 6px 5px 22px', border: 'none', borderRadius: 6, background: 'transparent',
                cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', fontSize: 12, color: 'var(--accent)',
              }}>{t('calendar.more', { count: data.hidden })}</button>
            )}
          </div>
        )
      )}
    </section>
  );
}
