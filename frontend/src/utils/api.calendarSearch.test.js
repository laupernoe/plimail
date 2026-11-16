import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

test('a calendar search hands its abort signal to fetch', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let call;
    globalThis.fetch = async (url, opts) => {
      call = { url, opts };
      return { ok: true, status: 200, json: async () => ({ events: [] }) };
    };
    const controller = new AbortController();
    assert.deepEqual(await api.calendar.searchEvents('dentist', { signal: controller.signal }), { events: [] });
    assert.match(call.url, /^\/api\/calendar\/events\/search\?q=dentist&tz=/);
    assert.equal(call.opts.method, 'GET');
    assert.equal(call.opts.signal, controller.signal);

    await api.calendar.searchEvents('dentist');
    assert.equal('signal' in call.opts, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
