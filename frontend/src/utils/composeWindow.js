// The composer in a window of its own (the /compose route), so a message can be written on one
// screen with the mailbox on another, and several can be open at once.
//
// The popup is the same app on the same origin: it shares the session cookie, the preferences and
// the store code, but not the store, so it loads what the composer needs itself (ComposePopup.jsx).
// What it does not do is sync: the main window's socket already hears what the server pushes, and
// a second one here would only reconnect the same accounts again.

export const COMPOSE_WINDOW_PATH = '/compose';
const CHANNEL = 'plimail-compose';
// 768 and wider is the desktop layout (useMobile): narrower would draw the phone composer.
const WIDTH = 820;
const HEIGHT = 760;

export const isComposeWindowPath = pathname => pathname === COMPOSE_WINDOW_PATH || pathname === `${COMPOSE_WINDOW_PATH}/`;

export const isComposeWindow = () => typeof window !== 'undefined' && isComposeWindowPath(window.location.pathname);

export function composeWindowUrl({ accountId } = {}) {
  return accountId ? `${COMPOSE_WINDOW_PATH}?account=${encodeURIComponent(accountId)}` : COMPOSE_WINDOW_PATH;
}

// Opens the popup and returns it, or null when the browser refused. Call it straight from the
// click: a popup opened after an await is blocked. Each one gets its own name, or the browser would
// reuse the first window instead of opening another.
export function openComposeWindow({ win = window, accountId, now = Date.now } = {}) {
  try {
    const screen = win.screen || {};
    const left = Math.max(0, Math.round(((screen.availWidth || WIDTH) - WIDTH) / 2) + (screen.availLeft || 0));
    const top = Math.max(0, Math.round(((screen.availHeight || HEIGHT) - HEIGHT) / 2) + (screen.availTop || 0));
    const features = `popup=yes,width=${WIDTH},height=${HEIGHT},left=${left},top=${top}`;
    return win.open(composeWindowUrl({ accountId }), `plimail-compose-${now()}-${Math.random().toString(36).slice(2, 7)}`, features) || null;
  } catch {
    return null;
  }
}

// Compose in a new window, or in the app's own composer when the browser blocks the popup.
export function composeInNewWindow({ openCompose, accountId, win = window } = {}) {
  if (openComposeWindow({ win, accountId })) return true;
  openCompose({});
  return false;
}

// The popup tells the main window that mail may have changed (a draft saved or deleted, a message
// sent), which refreshes the list and the counts. A BroadcastChannel keeps it to this browser.
export function announceComposeChange(Channel = globalThis.BroadcastChannel) {
  try {
    if (!Channel) return;
    const channel = new Channel(CHANNEL);
    channel.postMessage({ type: 'changed' });
    channel.close();
  } catch { /* no BroadcastChannel: the socket and the next refresh catch up */ }
}

// Main window side. Returns the stop function.
export function listenForComposeChanges(onChange, Channel = globalThis.BroadcastChannel) {
  try {
    if (!Channel) return () => {};
    const channel = new Channel(CHANNEL);
    channel.onmessage = e => { if (e.data?.type === 'changed') onChange(); };
    return () => channel.close();
  } catch {
    return () => {};
  }
}
