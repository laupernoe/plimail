// "Install the app" in Settings. Chromium browsers fire beforeinstallprompt once the page is
// installable, usually long before Settings is opened, so the event is captured at startup and
// kept here; prompt() can only be called once per event, from a click.

let deferred = null;
let installed = false;
let win = null;
const listeners = new Set();

function notify() { for (const fn of listeners) fn(); }

function runningInstalled(w) {
  try {
    return w.matchMedia('(display-mode: standalone)').matches
      || w.matchMedia('(display-mode: window-controls-overlay)').matches
      || w.navigator?.standalone === true;
  } catch {
    return false;
  }
}

export function captureInstallPrompt(w) {
  win = w;
  installed = runningInstalled(w);
  w.addEventListener('beforeinstallprompt', (event) => {
    // Keeps the browser's own mini-infobar from appearing: Settings offers it instead.
    event.preventDefault();
    deferred = event;
    notify();
  });
  w.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    notify();
  });
}

// 'installed' (running as the app, or just installed), 'available' (the button can install it),
// or 'unavailable' (this browser does not offer it here, or it is installed already but this is a
// browser tab: Chromium stops firing the event once the app is installed).
export function installState() {
  if (installed || (win && runningInstalled(win))) return 'installed';
  return deferred ? 'available' : 'unavailable';
}

export function subscribeInstallState(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Shows the browser's install dialog. Resolves to 'accepted', 'dismissed' or 'unavailable'.
export async function promptInstall() {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null;
  notify();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return 'unavailable';
  }
}

// For tests.
export function resetInstallPromptForTest() {
  deferred = null;
  installed = false;
  win = null;
  listeners.clear();
}
