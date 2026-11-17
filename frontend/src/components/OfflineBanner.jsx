import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { isOffline, subscribeOffline } from '../utils/offlineCache.js';

// Shown while the server cannot be reached (utils/offlineCache.js): what is on screen may be the
// copy kept for offline reading, and nothing sent or changed now reaches the server.
export default function OfflineBanner() {
  const { t } = useTranslation();
  const offline = useSyncExternalStore(subscribeOffline, isOffline, () => false);
  if (!offline) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed', left: '50%', top: 'calc(var(--sat, 0px) + 10px)', transform: 'translateX(-50%)',
        zIndex: 3000, maxWidth: 'calc(100vw - 32px)', padding: '7px 14px', borderRadius: 10,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-modal)',
        fontSize: 13, color: 'var(--text-primary)', textAlign: 'center',
      }}
    >
      {t('app.offline.banner')}
    </div>
  );
}
