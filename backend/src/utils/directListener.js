// The built-in HTTPS listener is opened directly by browsers (index.js), never through the reverse
// proxy or tunnel that 'trust proxy' counts. Left in place, a client there could write its own
// X-Forwarded-For and be a new address on every request, with a fresh login rate-limit bucket each
// time, or claim another host or protocol. Express only reads these from req.headers, so deleting
// them before the app sees the request leaves req.ip, req.protocol and req.hostname to the socket.
export const FORWARDED_HEADERS = Object.freeze([
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'forwarded',
]);

export function stripForwardedHeaders(req) {
  for (const name of FORWARDED_HEADERS) delete req.headers[name];
}

// For createServer(): the app's request handler, behind the strip.
export function directRequestHandler(handler) {
  return (req, res) => {
    stripForwardedHeaders(req);
    return handler(req, res);
  };
}

// The WebSocket upgrade reads the session from the same request, so it is stripped first too.
export function stripForwardedOnUpgrade(server) {
  server.prependListener('upgrade', req => stripForwardedHeaders(req));
  return server;
}
