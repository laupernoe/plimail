import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionBtn } from './MessageActions.jsx';
import { QUICK_REACTIONS } from '../utils/reactions.js';
import { ICON, RADIUS } from '../utils/uiSizes.js';

// Emoji reactions on a message (utils/reactions.js): the button that opens the picker, and the
// chips under the message for the reactions it has.

export const ReactIcon = () => (
  <svg width={ICON} height={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
    <circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8"/>
    <line x1="9" y1="9.5" x2="9.01" y2="9.5" strokeWidth={2.5} strokeLinecap="round"/><line x1="15" y1="9.5" x2="15.01" y2="9.5" strokeWidth={2.5} strokeLinecap="round"/>
  </svg>
);

// The full emoji set, the composer's, loaded the first time "More" is opened.
let emojiMart = null;
const loadEmojiMart = async () => {
  if (!emojiMart) {
    const [{ default: Picker }, { default: data }] = await Promise.all([import('@emoji-mart/react'), import('@emoji-mart/data')]);
    emojiMart = { Picker, data };
  }
  return emojiMart;
};

const quickStyle = (used) => ({
  width: 36, height: 36, fontSize: 20, lineHeight: 1, borderRadius: RADIUS,
  border: '1px solid transparent', background: 'transparent', cursor: used ? 'default' : 'pointer',
  opacity: used ? 0.4 : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
});

// The React button and its picker: six common emoji in a row, and More for the rest. A menu with
// the arrow keys moving along it, Home and End to its ends, Escape or a click outside closing it
// and putting focus back on the button. `used` are the emoji the reader has already sent here.
export function ReactButton({ onReact, used = new Set(), touch = false }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const close = (refocus = true) => {
    setOpen(false);
    setFull(null);
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (emoji) => {
    if (used.has(emoji)) return;
    close();
    onReact(emoji);
  };
  const items = () => [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
  useEffect(() => { if (open) items()[0]?.focus(); }, [open]);
  // Kept on screen, as the More menu is.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!open || !el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8 && r.height < r.top) {
      Object.assign(el.style, { top: 'auto', bottom: '100%', marginTop: '0', marginBottom: '4px' });
    }
    // Slid back inside the window on either side: on a phone the picker is wider than the room
    // to the right of its button.
    const shift = r.right > window.innerWidth - 8 ? r.right - (window.innerWidth - 8) : 0;
    const left = Math.min(shift, Math.max(0, r.left - 8));
    if (left > 0) el.style.left = `${(parseFloat(el.style.left) || 0) - left}px`;
  }, [open, full]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { close(false); return; }
    if (full) return;
    const list = items();
    const at = list.indexOf(document.activeElement);
    const go = i => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go(at < 0 ? list.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
  };

  const openFull = async () => {
    try { setFull(await loadEmojiMart()); } catch { /* the quick row stays */ }
  };

  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <ActionBtn btnRef={triggerRef} onClick={() => (open ? close() : setOpen(true))} label={t('reactions.react')} touch={touch} popup expanded={open}>
        <ReactIcon />
      </ActionBtn>
      {open && (
        <>
          <div onClick={() => close()} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
          <div
            ref={menuRef}
            role="menu"
            aria-label={t('reactions.picker')}
            aria-orientation="horizontal"
            onKeyDown={onKeyDown}
            style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: RADIUS,
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)', padding: 4,
            }}
          >
            {full ? (
              <full.Picker data={full.data} onEmojiSelect={emoji => pick(emoji.native)} autoFocus
                previewPosition="none" skinTonePosition="search" perLine={7} emojiSize={20} emojiButtonSize={32} maxFrequentRows={1} />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                {QUICK_REACTIONS.map(emoji => (
                  <button
                    key={emoji}
                    type="button"
                    role="menuitem"
                    aria-label={used.has(emoji) ? t('reactions.alreadySent', { emoji }) : t('reactions.reactWith', { emoji })}
                    aria-disabled={used.has(emoji) || undefined}
                    title={used.has(emoji) ? t('reactions.alreadySent', { emoji }) : undefined}
                    onClick={() => pick(emoji)}
                    className="btn-press"
                    style={quickStyle(used.has(emoji))}
                    onMouseEnter={e => { if (!used.has(emoji)) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span aria-hidden="true">{emoji}</span>
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  aria-label={t('reactions.more')}
                  title={t('reactions.more')}
                  onClick={openFull}
                  style={{ ...quickStyle(false), fontSize: 16, color: 'var(--text-secondary)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Who reacted, for the chip's tooltip and accessible name: "Jonas Ferreira, you".
export function reactionPeople(group, t) {
  return group.people.map(p => (p.mine ? t('reactions.you') : (p.name || p.email))).join(', ');
}

// The reactions under a message, one chip per emoji with how many sent it. A chip the reader has
// not sent yet adds theirs when pressed (when they can react); their own is shown pressed.
export function ReactionChips({ groups, onReact, canReact = false, style }) {
  const { t } = useTranslation();
  if (!groups?.length) return null;
  return (
    <div role="group" aria-label={t('reactions.label')} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, ...style }}>
      {groups.map(group => {
        const people = reactionPeople(group, t);
        const actionable = canReact && !group.mine && Boolean(onReact);
        const label = t('reactions.chip', { emoji: group.emoji, people });
        return (
          <button
            key={group.emoji}
            type="button"
            title={people}
            aria-label={actionable ? `${label}. ${t('reactions.reactWith', { emoji: group.emoji })}` : label}
            aria-pressed={group.mine}
            aria-disabled={!actionable || undefined}
            onClick={actionable ? () => onReact(group.emoji) : undefined}
            className="btn-press"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 26, padding: '1px 9px',
              borderRadius: 13, font: 'inherit', fontSize: 13,
              border: `1px solid ${group.mine ? 'var(--accent)' : 'var(--border)'}`,
              background: group.mine ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'var(--bg-secondary)',
              color: 'var(--text-primary)', cursor: actionable ? 'pointer' : 'default',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1 }}>{group.emoji}</span>
            <span aria-hidden="true" style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{group.count}</span>
          </button>
        );
      })}
    </div>
  );
}
