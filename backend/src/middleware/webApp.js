import express from 'express';
import compression from 'compression';
import { existsSync } from 'node:fs';
import path from 'node:path';

// The image used to put nginx in front of the backend; these are the headers, compression and
// caching it provided, now served by Express itself. A real certificate is the job of the
// operator's reverse proxy or tunnel, which tells us about HTTPS with X-Forwarded-Proto (trust
// proxy); the built-in HTTPS listener (index.js) only serves a self-signed one.

// 'unsafe-inline' styles are required by the React app (inline style props). Email images load
// from arbitrary https origins. Over plain HTTP the WebSocket is ws:, which 'self' does not cover
// in every browser.
function contentSecurityPolicy(secure) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data: https:",
    "img-src 'self' data: https: blob:",
    `connect-src 'self' wss:${secure ? '' : ' ws:'}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ') + ';';
}

// On every response, API included, as nginx added them at server level. A route that sets its
// own, stricter Content-Security-Policy (attachments, contact photos) replaces this one.
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', contentSecurityPolicy(req.secure));
  // Only once the browser has reached us over HTTPS, through a proxy we trust to say so: sent over
  // HTTP it would be ignored, and on a LAN install it would lock the host out of plain HTTP. Never
  // from the built-in HTTPS listener (req.socket.encrypted), whatever certificate it serves: its
  // self-signed default is one a browser must not be pinned to, HSTS covers every port of the host
  // (plain HTTP on 3000 included), and a trusted certificate belongs on the proxy, which sends it.
  if (req.secure && !req.socket.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=63072000');
  next();
}

// Compress what is worth it, but never a stream that has to reach the browser as it is written:
// the AI assistant's server-sent events and the restore progress both say so with
// X-Accel-Buffering: no, the header that already kept nginx from buffering them.
export const compress = compression({
  threshold: 1024,
  filter(req, res) {
    if (res.getHeader('X-Accel-Buffering') === 'no') return false;
    if (String(res.getHeader('Content-Type') || '').startsWith('text/event-stream')) return false;
    return compression.filter(req, res);
  },
});

// Paths the backend answers itself. Anything else that is not a file is a client-side route of
// the single-page app and gets index.html.
const BACKEND_PATH = /^\/(?:api|ws|oauth|auth\/oidc|carddav|\.well-known)(?:\/|$)/;

const STATIC_FILE = /\.(?:m?js|css|png|jpe?g|gif|ico|svg|woff2?|json|map)$/i;

const IMMUTABLE ='public, max-age=31536000, immutable';
// Vite fingerprints everything under assets/, and pdf.js's runtime files sit under its version.
const FINGERPRINTED = /^\/(?:assets|pdfjs\/[^/]+)\//;
// Never cached: index.html names the current bundle, sw.js must update as soon as it is deployed
// (it delivers push notifications), and the manifest follows the app.
const NEVER_CACHED = new Set(['/index.html', '/sw.js', '/manifest.json']);

function cacheControlFor(urlPath) {
  if (NEVER_CACHED.has(urlPath)) return 'no-store';
  if (FINGERPRINTED.test(urlPath)) return IMMUTABLE;
  // Icons and fonts keep their names across releases, so they are kept for a day, not forever.
  return 'public, max-age=86400';
}

// The SPA's own pages may frame each other (nginx sent SAMEORIGIN for them); the API stays DENY.
function appHeaders(res, cacheControl) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', cacheControl);
}

// Serves the built frontend from `dir` when it holds one. In development there is none, and the
// Vite dev server serves the app instead. Returns whether it mounted.
export function mountWebApp(app, dir) {
  const indexFile = dir && path.join(dir, 'index.html');
  if (!indexFile || !existsSync(indexFile)) return false;

  app.use(express.static(dir, {
    index: false,
    redirect: false,
    setHeaders(res, filePath) {
      const urlPath = '/' + path.relative(dir, filePath).split(path.sep).join('/');
      appHeaders(res, cacheControlFor(urlPath));
    },
  }));

  app.get('*', (req, res, next) => {
    if (BACKEND_PATH.test(req.path)) return next();
    // A missing script, stylesheet, image or font (a stale tab asking for the last release's
    // bundle, say) is a 404, not index.html served in its place.
    if (STATIC_FILE.test(req.path)) return next();
    appHeaders(res, 'no-store');
    res.sendFile(indexFile);
  });
  return true;
}
