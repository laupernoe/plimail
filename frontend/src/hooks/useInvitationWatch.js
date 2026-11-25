import { useEffect } from 'react';
import { useStore } from '../store/index.js';

const REFRESH_MS = 5 * 60_000;
// New mail may be an invitation; the server reads it once the sync that brought it is done.
const AFTER_SYNC_MS = 15_000;

// Keeps the invitations waiting for an answer current while the app is open: at start, every
// few minutes, a little after new mail, and when the tab comes back.
export function useInvitationWatch(enabled = true) {
  const load = useStore(s => s.loadInvitations);
  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') load(); }, REFRESH_MS);
    let soon = null;
    const afterSync = () => { clearTimeout(soon); soon = setTimeout(load, AFTER_SYNC_MS); };
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('mailflow:sync_done', afterSync);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      clearTimeout(soon);
      window.removeEventListener('mailflow:sync_done', afterSync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, load]);
}
