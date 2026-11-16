// The recipient's requests. No cookie goes with them (credentials: 'omit'): the recipient is no
// one here, whoever is signed in on this browser. X-Requested-With is what the API's CSRF check
// asks of every write.
export class SecureApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.code = body?.code || null;
    this.remainingAttempts = body?.remainingAttempts;
  }
}

async function request(path, init = {}) {
  const res = await fetch(`/api/s/${path}`, {
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    ...init,
    headers: { 'X-Requested-With': 'XMLHttpRequest', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new SecureApiError(res.status, body);
  return body;
}

const tokenPath = token => encodeURIComponent(token);

export const getMeta = token => request(`${tokenPath(token)}/meta`);

export const openWithKey = (token, authKey) => request(`${tokenPath(token)}/open`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ authKey }),
});

// The reply is the ciphertext itself; the key and IV go in headers (routes/secureMessagesPublic.js).
export const postReply = (token, authKey, { ciphertext, iv }) => request(`${tokenPath(token)}/reply`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'X-Secure-Auth': authKey, 'X-Secure-IV': iv },
  body: ciphertext,
});
