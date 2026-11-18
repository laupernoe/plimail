// Runs before the app is imported: every /api request, the WebSocket and the service worker are
// answered inside the page, so the demo makes no request to any server but the static files'.
import { handle, HttpError } from './backend.js';

const realFetch = window.fetch.bind(window);
const LATENCY_MS = 60;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readBody(body) {
  if (body == null) return undefined;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return body; }
  }
  if (body instanceof Blob) return body;
  return undefined;
}

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

window.fetch = async function demoFetch(input, init = {}) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), window.location.href);
  const method = String(init.method || request?.method || 'GET').toUpperCase();
  if (url.origin !== window.location.origin) {
    throw new TypeError('The demo makes no requests to other sites');
  }
  if (url.pathname === '/' && method === 'HEAD') return new Response(null, { status: 200 });
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/oauth/')) return realFetch(input, init);
  if (url.pathname.startsWith('/oauth/')) return json(404, { error: 'Not available in the demo' });

  const path = url.pathname.slice(4);
  const query = Object.fromEntries(url.searchParams);
  const body = await readBody(init.body ?? (request && method !== 'GET' ? await request.text() : undefined));
  await wait(LATENCY_MS);
  try {
    const result = await handle(method, path, query, body);
    if (result instanceof Blob) return new Response(result, { status: 200, headers: { 'Content-Type': result.type || 'application/octet-stream' } });
    if (result === null) return new Response(null, { status: 204 });
    return json(200, result);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.warn('[demo] fake backend failed', method, path, err);
    return json(500, { error: 'The demo could not answer this request' });
  }
};

// The WebSocket only pushes in Plimail, and nothing arrives in the demo: it opens, and answers pings.
class DemoSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    super();
    this.url = String(url);
    this.readyState = DemoSocket.CONNECTING;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    setTimeout(() => {
      if (this.readyState !== DemoSocket.CONNECTING) return;
      this.readyState = DemoSocket.OPEN;
      this.#emit('open', new Event('open'));
    }, 30);
  }
  #emit(type, event) {
    this[`on${type}`]?.(event);
    this.dispatchEvent(event);
  }
  send(data) {
    if (this.readyState !== DemoSocket.OPEN) return;
    let message = null;
    try { message = JSON.parse(data); } catch { /* not ours */ }
    if (message?.type === 'ping') {
      setTimeout(() => this.#emit('message', new MessageEvent('message', { data: JSON.stringify({ type: 'pong' }) })), 10);
    }
  }
  close(code = 1000, reason = '') {
    if (this.readyState === DemoSocket.CLOSED) return;
    this.readyState = DemoSocket.CLOSED;
    setTimeout(() => this.#emit('close', new CloseEvent('close', { code, reason, wasClean: true })), 0);
  }
}
window.WebSocket = DemoSocket;

// No service worker: the demo is not installable and caches nothing. register() never settles, so
// the app neither registers one nor reports a failure.
const never = new Promise(() => {});
const noWorker = {
  register: () => never,
  getRegistration: async () => undefined,
  getRegistrations: async () => [],
  ready: never,
  controller: null,
  addEventListener() {},
  removeEventListener() {},
};
try {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get: () => noWorker });
} catch { /* left as it is */ }
