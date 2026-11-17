// Plimail service worker: Web Push, notification clicks, and a cache of the app's static files.
//
// What it caches is an allowlist: Vite's fingerprinted bundle (/assets/), pdf.js's runtime files
// under their version, the self-hosted fonts, and index.html for when the server is out of reach.
// Everything else goes to the network untouched, and above all the API (/api), the WebSocket
// (/ws), sign-in and the page of a password-protected message (/s/<token>): sessions and
// decrypted content never land in a cache here. (The mail kept for offline reading is the page's,
// see frontend/src/utils/offlineCache.js.)
//
// BUILD_ID is written in by the build (vite.config.js) from the bundle's file names, so each
// release is a byte-different sw.js, which is what makes the browser install the new worker.
// The new worker waits instead of taking over: the page shows "New version, reload", and the
// worker takes over when the user agrees (SKIP_WAITING) or once every tab of the old one is gone.
// A page always comes from the server, so even a tab under the old worker loads the new
// index.html, and with it the new bundle, as soon as it is reloaded. Only when the server cannot
// be reached does a page get this release's index.html, which the worker fetched when it
// installed along with the whole bundle and the fonts (PRECACHE, also written in by the build),
// so the app opens offline and reads the mail utils/offlineCache.js kept. Under the Vite dev
// server the placeholders are left as they are and nothing is cached.

const BUILD_ID = '__PLIMAIL_BUILD_ID__';
const PRECACHE = [/* __PLIMAIL_PRECACHE__ */];
const CACHING = !BUILD_ID.startsWith('__');
const CACHE_PREFIX = 'plimail-static-';
const STATIC_CACHE = CACHE_PREFIX + BUILD_ID;
const APP_SHELL = '/';

const CACHEABLE_PATH = /^\/(?:assets|pdfjs\/[^/]+|fonts)\//;
// Never cached, whatever CACHEABLE_PATH ever grows to include.
const NEVER_CACHED_PATH = /^\/(?:api|ws|s|oauth|auth|carddav|\.well-known)(?:\/|$)/;

function isCacheable(request) {
  if (request.method !== 'GET') return false;
  let url;
  try { url = new URL(request.url); } catch (_) { return false; }
  if (url.origin !== self.location.origin || url.search) return false;
  if (NEVER_CACHED_PATH.test(url.pathname)) return false;
  return CACHEABLE_PATH.test(url.pathname);
}

function cacheFirst(request) {
  return self.caches.open(STATIC_CACHE).then((cache) =>
    cache.match(request).then((hit) => hit || fetch(request).then((response) => {
      // Only a whole, same-origin answer: never a 404 page, a redirect or a partial body.
      if (response.ok && response.status === 200 && response.type === 'basic') {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    }))
  );
}

function isAppPage(request) {
  if (request.method !== 'GET' || request.mode !== 'navigate') return false;
  let url;
  try { url = new URL(request.url); } catch (_) { return false; }
  return url.origin === self.location.origin && !NEVER_CACHED_PATH.test(url.pathname);
}

// Network first, always: the cached page is only for when there is no network to ask.
function pageOrOfflineShell(request) {
  return fetch(request).catch((err) =>
    self.caches.open(STATIC_CACHE)
      .then((cache) => cache.match(APP_SHELL, { ignoreVary: true }))
      .then((hit) => { if (hit) return hit; throw err; })
  );
}

// One file at a time, and a failure is skipped: a worker that failed to install for a missing
// font would take push notifications down with it.
function precache() {
  return self.caches.open(STATIC_CACHE).then((cache) => Promise.all([APP_SHELL, ...PRECACHE].map((path) =>
    fetch(path, path === APP_SHELL ? { cache: 'no-store' } : undefined)
      .then((response) => {
        if (response.ok && response.status === 200 && response.type === 'basic') return cache.put(path, response);
        return undefined;
      })
      .catch(() => {})
  ))).catch(() => {});
}

self.addEventListener('install', (event) => {
  // No skipWaiting() here: a new release waits for the page to agree (see above). The first
  // install has no worker to wait for and activates at once.
  if (CACHING) event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== STATIC_CACHE)
        .map((key) => self.caches.delete(key))))
      .catch(() => {})
      // Take control of open tabs so push and the cache work without a reload.
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (!CACHING) return;
  if (isAppPage(event.request)) event.respondWith(pageOrOfflineShell(event.request));
  else if (isCacheable(event.request)) event.respondWith(cacheFirst(event.request));
});

const MESSAGE_ACTIONS = [
  { action: 'read', title: 'Mark as read' },
  { action: 'archive', title: 'Archive' },
];

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch (_) {
    return;
  }

  const {
    title       = 'Plimail',
    body        = 'New message',
    icon        = '/icon-512.png',
    badge       = '/badge-96.png',
    url         = '/',
    messageId,            // only for a push about one message: enables the action buttons
    unreadCount,          // intentionally no default — undefined means "don't touch badge"
  } = data;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const promises = [];

        // Update the home screen badge (iOS 17.4+, Android Chrome PWA).
        // Only runs when unreadCount is explicitly provided — a missing value
        // means the backend couldn't determine the count and should not clear it.
        // Uses self.navigator — bare `navigator` is not reliably exposed in iOS
        // Safari service worker scope.
        try {
          if (self.navigator && 'setAppBadge' in self.navigator && unreadCount != null) {
            const p = unreadCount > 0
              ? self.navigator.setAppBadge(unreadCount)
              : self.navigator.clearAppBadge();
            if (p && typeof p.then === 'function') promises.push(p.catch(() => {}));
          }
        } catch (_) {}

        // iOS/WebKit requires showNotification() to be called for every push event.
        // Skipping it — even when a client is focused — causes WebKit to log a
        // user-visible-notification violation and will eventually revoke push permission.
        // The in-app WebSocket toast still fires independently via the open client.
        promises.push(
          self.registration.showNotification(title, {
            body,
            icon,
            badge,
            data:  { url, messageId },
            // Mark as read / Archive act on the one message the card is about (#689).
            // Browsers that don't support actions (Safari) drop them and show the card as before.
            ...(messageId ? { actions: MESSAGE_ACTIONS } : {}),
            // Replace any existing MailFlow notification so rapid arrivals
            // don't stack unboundedly in the notification center.
            tag:      'mailflow-new-mail',
            renotify: true,
          })
        );

        return Promise.all(promises);
      })
  );
});

// Persist a deep-link target in IndexedDB so the page can consume it on focus or
// launch. This is the reliable channel on iOS: postMessage can be missed on a
// focus-with-reload, and iOS ignores the openWindow() URL on a cold launch — but a
// persisted target survives both. Fully guarded so a storage error never rejects
// the waitUntil. (Only reachable when the app is backgrounded — iOS does not fire
// notificationclick at all for a fully-terminated PWA.)
function storePendingDeepLink(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const open = indexedDB.open('mailflow-nav', 1);
      open.onupgradeneeded = () => { try { open.result.createObjectStore('kv'); } catch (_) {} };
      open.onerror = done;
      open.onblocked = done;
      open.onsuccess = () => {
        try {
          const db = open.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(url, 'pending_deeplink');
          tx.oncomplete = () => { db.close(); done(); };
          tx.onerror = () => { db.close(); done(); };
          tx.onabort = () => { db.close(); done(); };
        } catch (_) { done(); }
      };
    } catch (_) { done(); }
  });
}

// Open the app, at the deep link when there is one: focus a live client, or open a window.
function openApp(targetUrl) {
  const deepLink = !!targetUrl && targetUrl !== '/';
  return (deepLink ? storePendingDeepLink(targetUrl) : Promise.resolve())
    .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .then((clients) => {
      const existing = clients.find(
        (c) => new URL(c.url).origin === self.location.origin
      );
      if (existing) {
        // Nudge the live client to consume the persisted deep-link immediately
        // (no reload). Harmless if nothing is listening.
        if (deepLink) existing.postMessage({ type: 'mailflow_deeplink' });
        return existing.focus();
      }
      // Cold/killed: openWindow's URL is honored on Chromium and ignored on iOS,
      // but the persisted target above covers iOS on the next app launch.
      return self.clients.openWindow(targetUrl);
    });
}

function apiRequest(method, path, body) {
  return fetch(path, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Plimail' },
    body: JSON.stringify(body),
  });
}

// Run a notification button without opening the app. Resolves 'done', 'no-archive-folder', or
// 'open' when it could not run here: signed out (401), screen lock (423), offline, or a refusal.
// The app then opens at the message, as a plain tap would.
function runMessageAction(action, messageId) {
  const id = encodeURIComponent(messageId);
  const request = action === 'read'
    ? apiRequest('PATCH', `/api/mail/messages/${id}/read`, { read: true })
    : apiRequest('POST', '/api/mail/messages/bulk-archive', { ids: [messageId] });
  return request
    .then((res) => {
      if (!res.ok) return 'open';
      if (action === 'read') return 'done';
      return res.json().then((result) => {
        if (Array.isArray(result?.archived) && result.archived.includes(messageId)) return 'done';
        if (Array.isArray(result?.noArchiveFolder) && result.noArchiveFolder.length) return 'no-archive-folder';
        return 'open';
      });
    })
    .catch(() => 'open');
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  const messageId = event.notification.data?.messageId;

  if (messageId && (event.action === 'read' || event.action === 'archive')) {
    event.waitUntil(runMessageAction(event.action, messageId).then((outcome) => {
      if (outcome === 'done') return undefined;
      if (outcome === 'no-archive-folder') {
        return self.registration.showNotification('Not archived', {
          body: 'This account has no Archive folder. Tap to open the message.',
          icon: '/icon-512.png',
          badge: '/badge-96.png',
          data: { url: targetUrl },
          tag: 'mailflow-action-failed',
        });
      }
      return openApp(targetUrl);
    }));
    return;
  }

  event.waitUntil(openApp(targetUrl));
});
