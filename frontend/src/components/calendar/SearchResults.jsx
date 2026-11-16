import { useTranslation } from 'react-i18next';
import { formatClock, formatDayText, parseDay } from '../../utils/calendarDates.js';
import { groupSearchResults } from './eventSearch.js';
import { Btn, ErrorBox, Icon, tint } from './calendarUi.jsx';

const SECTION_KEYS = { upcoming: 'calendar.upcoming.title', past: 'calendar.search.past' };

// Takes the place of the view while a search is typed. The rows are the agenda's, under their dates.
export default function SearchResults({ query, events, loading, truncated, error, today, colorOf, calendarName, locale, onOpen, onRetry }) {
  const { t } = useTranslation();
  const sections = groupSearchResults(events);
  const thisYear = parseDay(today).y;

  return (
    <div role="region" aria-label={t('calendar.search.results')} aria-busy={loading} style={{ flex: 1, overflow: 'hidden auto', minHeight: 0 }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '8px 0 96px' }}>
        {error && (
          <div style={{ margin: '16px', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
            <ErrorBox>{t('calendar.search.error', { message: error })}</ErrorBox>
            <Btn onClick={onRetry}>{t('common.retry')}</Btn>
          </div>
        )}
        {!error && loading && !events.length && (
          <p role="status" style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13, margin: '32px 16px' }}>{t('calendar.search.searching')}</p>
        )}
        {!error && !loading && !events.length && (
          <p role="status" style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13, margin: '32px 16px' }}>
            {t('calendar.search.empty', { query })}
          </p>
        )}
        {!error && sections.map(({ kind, days }) => (
          <section key={kind} aria-label={t(SECTION_KEYS[kind])}>
            <h2 style={{ margin: 0, padding: '14px 16px 6px', fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
              {t(SECTION_KEYS[kind])}
            </h2>
            {days.map(({ day, items }) => {
              const isToday = day === today;
              const { y, d } = parseDay(day);
              return (
                <div key={day} aria-label={formatDayText(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, locale)} role="group"
                  style={{ display: 'flex', gap: 14, padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div style={{ width: 52, flexShrink: 0, textAlign: 'center', paddingTop: 2 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 500, color: isToday ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                      {formatDayText(day, { weekday: 'short' }, locale)}
                    </div>
                    <div style={{
                      margin: '2px auto 0', width: 34, height: 34, borderRadius: 17, lineHeight: '34px', fontSize: 18,
                      fontWeight: isToday ? 600 : 500, fontVariantNumeric: 'tabular-nums',
                      background: isToday ? 'var(--accent)' : 'transparent', color: isToday ? 'var(--accent-text)' : 'var(--text-primary)',
                    }}>{d}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      {formatDayText(day, y === thisYear ? { month: 'short' } : { month: 'short', year: 'numeric' }, locale)}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {items.map(occ => {
                      const color = colorOf(occ.calendarId);
                      const cancelled = occ.status === 'CANCELLED';
                      const where = [occ.location, calendarName(occ.calendarId)].filter(Boolean).join(', ');
                      return (
                        <button key={occ.id} type="button" onClick={() => onOpen(occ, day)} style={{
                          display: 'flex', alignItems: 'stretch', gap: 12, padding: '8px 12px', textAlign: 'left', cursor: 'pointer',
                          border: 'none', borderRadius: 8, fontFamily: 'inherit', color: 'var(--text-primary)', background: tint(color, 22),
                          opacity: cancelled ? 0.55 : 1, textDecoration: cancelled ? 'line-through' : 'none',
                        }}>
                          <span style={{ width: 'clamp(46px, 14vw, 84px)', flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', paddingTop: 1 }}>
                            {occ.allDay ? t('calendar.allDay') : (
                              <>
                                {formatClock(occ.start, locale)}
                                <br />
                                <span style={{ color: 'var(--text-tertiary)' }}>{formatClock(occ.end, locale)}</span>
                              </>
                            )}
                          </span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, minWidth: 0 }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{occ.summary || t('common.noSubject')}</span>
                              {occ.isRecurring && <Icon name="repeat" size={12} style={{ color: 'var(--text-tertiary)' }} />}
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', minWidth: 0 }}>
                              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: color }} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{where}</span>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
        {!error && truncated && (
          <p style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12.5, margin: '20px 16px' }}>{t('calendar.search.truncated')}</p>
        )}
      </div>
    </div>
  );
}
