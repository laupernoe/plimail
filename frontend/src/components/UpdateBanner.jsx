import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { applyUpdate, isUpdateReady, subscribeUpdateReady } from '../utils/swUpdate.js';

// "New version, reload": a new release's service worker is waiting (utils/swUpdate.js). Not
// dismissable on purpose: the tab runs the old bundle until it reloads, and the old bundle's lazily
// loaded screens may already be gone from the server.
export default function UpdateBanner() {
  const { t } = useTranslation();
  const ready = useSyncExternalStore(subscribeUpdateReady, isUpdateReady, () => false);
  if (!ready) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed', left: '50%', bottom: 'calc(var(--sab, 0px) + 16px)', transform: 'translateX(-50%)',
        zIndex: 3000, display: 'flex', alignItems: 'center', gap: 12, maxWidth: 'calc(100vw - 32px)',
        padding: '8px 8px 8px 14px', borderRadius: 10, background: 'var(--bg-elevated)',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-modal)',
        fontSize: 13, color: 'var(--text-primary)',
      }}
    >
      <span>{t('app.update.available')}</span>
      <button
        type="button"
        onClick={applyUpdate}
        style={{
          height: 28, padding: '0 12px', background: 'var(--accent)', color: 'var(--accent-text)',
          border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 500, flexShrink: 0,
        }}
      >
        {t('app.update.reload')}
      </button>
    </div>
  );
}
