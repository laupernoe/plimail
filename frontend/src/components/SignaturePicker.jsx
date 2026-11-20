import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiScale, descale } from '../hooks/useUiScale.js';

// The composer's "Choose signature" menu: any signature of the library (Settings › Signatures),
// whichever address the message is sent from, or none. Shown only when the library has one.
export default function SignaturePicker({ signatures, onPick, disabled, isMobile }) {
  const { t } = useTranslation();
  const uiScale = useUiScale();
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!pos) return;
    const close = (e) => {
      if (buttonRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setPos(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close, { passive: true });
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
    };
  }, [pos]);

  if (!signatures?.length) return null;

  const toggleMenu = () => {
    if (pos) { setPos(null); return; }
    const r = buttonRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: Math.max(4, Math.min(r.left, window.innerWidth - 220)) });
  };
  const choose = (entry) => { setPos(null); onPick(entry); };
  const item = {
    display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
    padding: '7px 14px', fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };
  const hover = {
    onMouseEnter: e => { e.currentTarget.style.background = 'var(--bg-hover)'; },
    onMouseLeave: e => { e.currentTarget.style.background = 'none'; },
  };

  return (
    <>
      <button ref={buttonRef} type="button"
        title={t('compose.chooseSignature')}
        aria-label={t('compose.chooseSignature')}
        aria-haspopup="menu"
        aria-expanded={pos ? 'true' : 'false'}
        disabled={disabled}
        onMouseDown={e => e.preventDefault()}
        onClick={toggleMenu}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          padding: isMobile ? '6px 2px' : '3px 2px', border: 'none', borderRadius: 4,
          background: pos ? 'var(--bg-hover)' : 'none', color: 'var(--text-secondary)',
          cursor: disabled ? 'default' : 'pointer', WebkitTapHighlightColor: 'transparent',
        }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {pos && (
        <div ref={menuRef} role="menu" aria-label={t('compose.chooseSignature')} style={{
          position: 'fixed', top: descale(pos.top, uiScale), left: descale(pos.left, uiScale), zIndex: 9999,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
          padding: '4px 0', minWidth: 180, maxWidth: 260, maxHeight: 320, overflowY: 'auto',
        }}>
          <button type="button" role="menuitem" onMouseDown={e => e.preventDefault()} onClick={() => choose(null)}
            style={{ ...item, color: 'var(--text-secondary)' }} {...hover}>
            {t('compose.noSignature')}
          </button>
          <div role="presentation" style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          {signatures.map(s => (
            <button key={s.id} type="button" role="menuitem" title={s.name}
              onMouseDown={e => e.preventDefault()} onClick={() => choose(s)} style={item} {...hover}>
              {s.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
