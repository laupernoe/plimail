import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronIcon, MenuPopup, menuItemStyle, hoverBg } from './MessageActions.jsx';

const NewWindowIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
);

// The Compose button with an arrow beside it: the button composes in the app, the arrow offers the
// same in a window of its own. With no `onComposeWindow` (a phone, where a popup is no use) it is
// the plain button.
export default function ComposeSplitButton({ icon, collapsed = false, onCompose, onComposeWindow }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const split = Boolean(onComposeWindow) && !collapsed;
  const fade = {
    onMouseEnter: e => { e.currentTarget.style.opacity = '0.85'; },
    onMouseLeave: e => { e.currentTarget.style.opacity = '1'; },
  };
  return (
    <div style={{ position: 'relative', display: 'flex', width: '100%' }}>
      <button
        type="button"
        onClick={onCompose}
        className="btn-press"
        style={{
          flex: 1, minWidth: 0, padding: collapsed ? '10px' : '10px 14px',
          background: 'var(--accent)', border: 'none',
          borderRadius: split ? '8px 0 0 8px' : 8,
          color: 'var(--accent-text)', fontSize: 13, fontWeight: 500,
          cursor: 'pointer', display: 'flex', alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap: 8, transition: 'opacity 0.15s',
        }}
        {...fade}
      >
        {icon}
        {!collapsed && t('sidebar.compose')}
      </button>
      {split && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(v => !v)}
          title={t('sidebar.composeOptions')}
          aria-label={t('sidebar.composeOptions')}
          aria-haspopup="menu"
          aria-expanded={open}
          className="btn-press"
          style={{
            width: 30, flexShrink: 0, padding: 0,
            background: 'var(--accent)', border: 'none',
            borderLeft: '1px solid color-mix(in srgb, var(--accent-text) 30%, transparent)',
            borderRadius: '0 8px 8px 0', color: 'var(--accent-text)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'opacity 0.15s',
          }}
          {...fade}
        >
          <ChevronIcon />
        </button>
      )}
      {split && open && (
        <MenuPopup
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          zIndex={100}
          style={{
            top: '100%', right: 0, marginTop: 4,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 8, overflow: 'hidden',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)', minWidth: 200,
          }}
        >
          {choose => (
            <button
              type="button"
              role="menuitem"
              onClick={() => choose(onComposeWindow)}
              style={menuItemStyle({ padding: '9px 14px', whiteSpace: 'nowrap' })}
              {...hoverBg}
            >
              <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--text-secondary)' }}><NewWindowIcon /></span>
              {t('sidebar.composeNewWindow')}
            </button>
          )}
        </MenuPopup>
      )}
    </div>
  );
}
