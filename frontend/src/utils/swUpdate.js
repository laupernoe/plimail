// Registers the service worker and notices a new release, for the "New version, reload" banner.
//
// A new release's worker installs and then waits (public/sw.js). This module reports it as soon
// as it is waiting, asks the browser for a new sw.js now and then (an app window can stay open
// for weeks without a navigation, which is when browsers check on their own), and on the user's
// word tells the waiting worker to take over, then reloads once it has.
//
// Registration can fail and that is fine: a browser without service workers, a private window,
// or HTTPS on a certificate the browser does not trust (an install reached by IP with a
// self-signed one) refuses it. The app works the same without, minus push and the cache.

const CHECK_EVERY_MS = 30 * 60 * 1000;

let updateReady = false;
const listeners = new Set();

function setUpdateReady() {
  if (updateReady) return;
  updateReady = true;
  for (const fn of listeners) fn();
}

export function isUpdateReady() { return updateReady; }

export function subscribeUpdateReady(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

let applyUpdateImpl = null;

// The banner's button: switch to the new worker and reload. Without one waiting (another tab
// already switched), a reload is all it takes.
export function applyUpdate() {
  applyUpdateImpl?.();
}

export async function startServiceWorker({
  container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined,
  reload = () => window.location.reload(),
  setIntervalFn = setInterval,
  logger = console,
} = {}) {
  if (!container) return null;
  let reg;
  try {
    // updateViaCache 'none': the browser asks the server for sw.js every time, whatever a proxy
    // in between set for its cache.
    reg = await container.register('/sw.js', { updateViaCache: 'none' });
  } catch (err) {
    logger.warn('Service worker registration failed:', err?.message || err);
    return null;
  }

  // A worker that installs while another controls the page is a new release, not the first one.
  const watchInstalling = (worker) => {
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && container.controller) setUpdateReady();
    });
  };
  if (reg.waiting && container.controller) setUpdateReady();
  watchInstalling(reg.installing);
  reg.addEventListener('updatefound', () => watchInstalling(reg.installing));

  let switching = false;
  let hadController = !!container.controller;
  container.addEventListener('controllerchange', () => {
    if (switching) { reload(); return; }
    // Another tab switched to the new release: this one still runs the old bundle.
    if (hadController) setUpdateReady();
    hadController = true;
  });

  applyUpdateImpl = () => {
    const waiting = reg.waiting;
    if (!waiting) { reload(); return; }
    switching = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
  };

  setIntervalFn(() => { reg.update().catch(() => {}); }, CHECK_EVERY_MS);
  return reg;
}

// For tests.
export function resetSwUpdateForTest() {
  updateReady = false;
  applyUpdateImpl = null;
  listeners.clear();
}
