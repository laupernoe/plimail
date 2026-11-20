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

export function composeWindowUrl({ accountId, handoff } = {}) {
  const query = [
    accountId ? `account=${encodeURIComponent(accountId)}` : '',
    handoff ? `handoff=${encodeURIComponent(handoff)}` : '',
  ].filter(Boolean).join('&');
  return query ? `${COMPOSE_WINDOW_PATH}?${query}` : COMPOSE_WINDOW_PATH;
}

// Opens the popup and returns it, or null when the browser refused. Call it straight from the
// click: a popup opened after an await is blocked. Each one gets its own name, or the browser would
// reuse the first window instead of opening another.
export function openComposeWindow({ win = window, accountId, handoff, now = Date.now } = {}) {
  try {
    const screen = win.screen || {};
    const left = Math.max(0, Math.round(((screen.availWidth || WIDTH) - WIDTH) / 2) + (screen.availLeft || 0));
    const top = Math.max(0, Math.round(((screen.availHeight || HEIGHT) - HEIGHT) / 2) + (screen.availTop || 0));
    const features = `popup=yes,width=${WIDTH},height=${HEIGHT},left=${left},top=${top}`;
    return win.open(composeWindowUrl({ accountId, handoff }), `plimail-compose-${now()}-${Math.random().toString(36).slice(2, 7)}`, features) || null;
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

// ── Pop-out: an open composer moves to a window of its own ────────────────────────────────
//
// Not through a draft: a draft carries no attachments and not how the message is protected, and
// the composer already has a lossless way to be put back as it was (buildRestoreData: what undo
// send and the lock screen reopen from, attachments, quote, reply headers and the draft it saves
// into included). That is handed to the popup through localStorage, which both windows share, and
// the composer here stays exactly as it is until the popup says it has taken it. Any failure
// (storage full, popup blocked, no answer) leaves this composer untouched.
const HANDOFF_PREFIX = 'mailflow_compose_handoff_';
const HANDOFF_WAIT_MS = 8000;

const postMessageOnChannel = (message, Channel = globalThis.BroadcastChannel) => {
  try {
    if (!Channel) return;
    const channel = new Channel(CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch { /* the sender times out and keeps its composer */ }
};

// Called straight from the click: the popup opens synchronously. `data` is what to reopen.
// `onTaken` runs when the popup has the message (close the composer there); `onFailed(reason)`
// when it cannot be done ('storage', 'blocked' or 'timeout'), with nothing changed.
export function popOutCompose({
  data, onTaken, onFailed, win = window, storage = globalThis.localStorage, Channel = globalThis.BroadcastChannel,
  waitMs = HANDOFF_WAIT_MS, id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
}) {
  const key = HANDOFF_PREFIX + id;
  try {
    storage.setItem(key, JSON.stringify(data));
  } catch {
    try { storage.removeItem(key); } catch { /* nothing was written */ }
    onFailed('storage');
    return;
  }
  const forget = () => { try { storage.removeItem(key); } catch { /* already gone */ } };
  const popup = openComposeWindow({ win, handoff: id });
  if (!popup) { forget(); onFailed('blocked'); return; }
  let stop = () => {};
  let timer = null;
  stop = listenForMessage(msg => {
    if (msg?.type !== 'handoff-taken' || msg.id !== id) return;
    clearTimeout(timer);
    stop();
    onTaken();
  }, Channel);
  timer = setTimeout(() => {
    stop();
    forget();
    try { popup.close(); } catch { /* already closed */ }
    onFailed('timeout');
  }, waitMs);
}

function listenForMessage(handler, Channel = globalThis.BroadcastChannel) {
  try {
    if (!Channel) return () => {};
    const channel = new Channel(CHANNEL);
    channel.onmessage = e => handler(e.data);
    return () => channel.close();
  } catch {
    return () => {};
  }
}

// Popup side: the message handed over for `id`, taken out of storage, or null (none, or unreadable).
export function takeHandoff(id, storage = globalThis.localStorage) {
  if (!id) return null;
  const key = HANDOFF_PREFIX + id;
  try {
    const raw = storage.getItem(key);
    storage.removeItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export const announceHandoffTaken = (id, Channel) => postMessageOnChannel({ type: 'handoff-taken', id }, Channel);
