import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { announceComposeChange, announceHandoffTaken, takeHandoff } from '../utils/composeWindow.js';
import NotificationToasts from './NotificationToasts.jsx';

const ComposeModal = lazy(() => import('./ComposeModal.jsx'));

// How long the window waits after the composer closes before it goes: a request the close started
// (a draft saved or deleted) has to leave first, as a closed window drops it.
const CLOSE_DELAY_MS = 1200;

// The lock screen unmounts this and mounts it again: a composer kept for the lock is in the store
// already, and one that was sent must not be followed by a blank one. composeSession counts the
// composers this page has opened, so it tells the two apart.
const started = () => useStore.getState().composeSession > 0;

// The /compose route: the composer alone, filling a window of its own (ComposeModal draws it that
// way for this path). It loads the accounts the composer needs, opens a blank message, and goes
// once the message is sent, saved away or discarded.
//
// It leaves the sync to the main window. The WebSocket is not opened here: the socket's connect
// only reconnects accounts the main window's already has, and its events are about the mailbox
// this window does not show. The main window hears from this one over a BroadcastChannel instead.
export default function ComposePopup() {
  const { t } = useTranslation();
  const composing = useStore(s => s.composing);
  const composeSession = useStore(s => s.composeSession);
  const holding = useStore(s => s.notifications.some(n => n.heldSendId || n.onUndo || n.persistent));
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => { document.title = t('sidebar.compose'); }, [t]);

  useEffect(() => {
    let cancelled = false;
    api.getAccounts()
      .then(accounts => {
        if (cancelled) return;
        useStore.getState().setAccounts(accounts);
        if (started()) { setReady(true); return; }
        const account = new URLSearchParams(window.location.search).get('account');
        if (account && accounts.some(a => a.id === account)) useStore.setState({ selectedAccountId: account });
        // A composer popped out of the main window arrives whole; otherwise a blank message.
        const handoff = new URLSearchParams(window.location.search).get('handoff');
        const data = takeHandoff(handoff);
        useStore.getState().openCompose(data || {});
        if (data) announceHandoffTaken(handoff);
        setReady(true);
      })
      .catch(err => { if (!cancelled && err?.status !== 401) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  // Nothing left to do here: the composer is closed and no send is still being watched. A sent
  // message waits out its undo window with the Undo bar on screen, and one that fails to leave
  // comes back as a composer, so this stays for both.
  const done = ready && !composing && !holding;
  useEffect(() => {
    if (!done) return undefined;
    const timer = setTimeout(() => {
      announceComposeChange();
      window.close();
      // Not opened by the app (a tab at /compose): there is nothing to close, so go to the mailbox.
      setTimeout(() => { if (!window.closed) window.location.replace('/'); }, 300);
    }, CLOSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [done]);

  // What was saved or sent while the window was open reaches the main window as the composer closes.
  useEffect(() => {
    if (ready && !composing) announceComposeChange();
  }, [ready, composing]);

  return (
    <div style={{ height: '100svh', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {failed && (
        <div role="alert" style={{ padding: 24, fontSize: 14, color: 'var(--text-secondary)' }}>
          {t('compose.window.loadFailed')}
        </div>
      )}
      <Suspense fallback={null}>{ready && composing && <ComposeModal key={composeSession} />}</Suspense>
      <NotificationToasts />
    </div>
  );
}
