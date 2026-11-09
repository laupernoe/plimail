import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import { ATTENDEE_KEYS, addGuests, parseGuests } from './calendarEvents.js';
import { Icon, inputStyle } from './calendarUi.jsx';

const MARKS = { ACCEPTED: ['✓', 'var(--green, #3fb97f)'], DECLINED: ['✕', 'var(--red, #f87171)'], TENTATIVE: ['?', 'var(--amber, #f59e42)'] };

function StatusMark({ status }) {
  const { t } = useTranslation();
  const mark = MARKS[status];
  if (!mark || !ATTENDEE_KEYS[status]) return null;
  return <span title={t(ATTENDEE_KEYS[status])} aria-label={t(ATTENDEE_KEYS[status])} style={{ color: mark[1], fontSize: 11, fontWeight: 700, lineHeight: 1 }}>{mark[0]}</span>;
}

// The people invited, as removable chips, and a box that takes addresses typed, pasted or picked
// from the contacts the user already writes to.
export default function AttendeeField({ value, onChange, disabled }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2 || /[,;]/.test(q)) { setSuggestions([]); return undefined; }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await api.suggestContacts(q);
        if (mine !== seq.current) return;
        const taken = new Set(value.map(g => g.email));
        setSuggestions((res.contacts || []).filter(c => c.email && !taken.has(c.email.toLowerCase())).slice(0, 6));
        setActive(0);
      } catch {
        if (mine === seq.current) setSuggestions([]);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [text, value]);

  const commit = (raw = text) => {
    const { people, rest } = parseGuests(raw);
    if (people.length) onChange(addGuests(value, people));
    setText(rest);
    setSuggestions([]);
  };
  const pick = (c) => {
    onChange(addGuests(value, [{ email: c.email.toLowerCase(), name: c.name || null }]));
    setText('');
    setSuggestions([]);
    inputRef.current?.focus();
  };
  const remove = email => onChange(value.filter(g => g.email !== email));

  const onKeyDown = (e) => {
    if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive(i => (i + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && text.trim())) {
      if (!text.trim()) return;
      e.preventDefault();
      if (suggestions.length && e.key !== ',' && e.key !== ';') pick(suggestions[active]);
      else commit();
    } else if (e.key === 'Backspace' && !text && value.length) {
      remove(value[value.length - 1].email);
    } else if (e.key === 'Escape' && suggestions.length) {
      e.stopPropagation();
      setSuggestions([]);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <div onClick={() => inputRef.current?.focus()} style={{
        ...inputStyle, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '5px 6px', minHeight: 36, cursor: 'text',
        opacity: disabled ? 0.6 : 1,
      }}>
        {value.map(g => (
          <span key={g.email} title={g.name ? `${g.name} <${g.email}>` : g.email} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', padding: '3px 4px 3px 9px', borderRadius: 999,
            background: 'var(--bg-tertiary)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-primary)',
          }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name || g.email}</span>
            <StatusMark status={g.status} />
            {!disabled && (
              <button type="button" aria-label={t('calendar.form.removeGuest', { name: g.name || g.email })} onClick={(e) => { e.stopPropagation(); remove(g.email); }} style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%',
                border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0,
              }}>
                <Icon name="close" size={11} />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <input ref={inputRef} value={text} type="text" inputMode="email" autoComplete="off" spellCheck={false}
            aria-label={t('calendar.form.guests')} placeholder={value.length ? '' : t('calendar.form.guestsPlaceholder')}
            onChange={e => setText(e.target.value)} onKeyDown={onKeyDown}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData('text');
              if (/[,;\n]/.test(pasted)) { e.preventDefault(); commit(`${text}${pasted}`); }
            }}
            onBlur={() => setTimeout(() => { if (text.trim()) commit(); else setSuggestions([]); }, 120)}
            style={{ flex: '1 0 140px', minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', padding: '3px 4px' }} />
        )}
      </div>
      {suggestions.length > 0 && (
        <div role="listbox" aria-label={t('calendar.form.guests')} style={{
          position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 10, padding: 4, borderRadius: 8,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-popover)',
        }}>
          {suggestions.map((c, i) => (
            <div key={c.email} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setActive(i)} style={{
              display: 'flex', flexDirection: 'column', padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
              background: i === active ? 'var(--bg-hover)' : 'transparent',
            }}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || c.email}</span>
              {c.name && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.email}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
