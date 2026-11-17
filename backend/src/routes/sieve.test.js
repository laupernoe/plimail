import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Routes against the local fake ManageSieve server (manageSieve.fixtures.js); db.js is mocked.
const fakePort = vi.hoisted(() => ({ value: 0, hosts: [] }));
const accounts = vi.hoisted(() => new Map());
const folders = vi.hoisted(() => ({ paths: ['INBOX', 'Invoices', 'Trash'] }));

vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) {
      const a = accounts.get(params[0]);
      return { rows: a && a.user_id === params[1] ? [a] : [] };
    }
    if (sql.startsWith('SELECT path FROM folders WHERE account_id = $1 AND path = ANY($2)')) {
      return { rows: params[1].filter(p => folders.paths.includes(p)).map(path => ({ path })) };
    }
    throw new Error(`unexpected query: ${sql}`);
  }),
}));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false, resetMs: 0 })) }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: async () => ({ allowPrivateHosts: true, allowInsecureTls: true, allowNonstandardPorts: false }),
}));
vi.mock('../utils/mailUtils.js', () => ({ resolveTrashFolder: async () => 'Trash' }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: req.headers['x-user'] }; next(); },
}));
// The fake server listens on a random port; the host is the one the route picked.
vi.mock('../services/manageSieve.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    withManageSieve: (options, fn, extra) => {
      fakePort.hosts.push(options.host);
      return actual.withManageSieve({ ...options, port: fakePort.value }, fn, extra);
    },
  };
});

import express from 'express';
import routes from './sieve.js';
import { startFakeManageSieve } from '../services/manageSieve.fixtures.js';
import { PLIMAIL_SCRIPT, readPlimailMeta } from '../services/sieveScript.js';
import { forgetSieveAuthFailure } from '../services/sieveAccount.js';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const OAUTH = '00000000-0000-4000-8000-000000000002';

describe('/api/sieve', () => {
  let server, base, sieve;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/sieve', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/sieve`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

  async function startSieve(options) {
    sieve = await startFakeManageSieve(options);
    fakePort.value = sieve.port;
  }
  beforeEach(async () => {
    accounts.clear();
    accounts.set(ACCOUNT, {
      id: ACCOUNT, user_id: 'user-1', email_address: 'alice@example.test', imap_host: '127.0.0.1', smtp_host: 'smtp.example.test',
      auth_user: 'alice@example.test', auth_pass: 'correct horse', oauth_provider: null, imap_skip_tls_verify: true, folder_mappings: {},
    });
    accounts.set(OAUTH, { ...accounts.get(ACCOUNT), id: OAUTH, oauth_provider: 'google', auth_pass: null });
    fakePort.hosts.length = 0;
    forgetSieveAuthFailure(ACCOUNT);
  });
  afterEach(async () => { await sieve?.close(); sieve = null; });

  const call = (method, path, body, user = 'user-1') => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-User': user }, body: body ? JSON.stringify(body) : undefined,
  });

  it("logs in on the account's IMAP host with its own login and lists the scripts", async () => {
    await startSieve({ scripts: { roundcube: 'keep;' }, active: 'roundcube' });
    const res = await call('GET', `/${ACCOUNT}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      supported: true, implementation: 'Fake Sieve', active: 'roundcube', otherActive: 'roundcube',
      scripts: [{ name: 'roundcube', active: true }],
      plimail: { exists: false, managed: false, rules: [] },
    });
    expect(body.extensions).toContain('vacation');
    expect(fakePort.hosts).toEqual(['127.0.0.1']);
    expect(sieve.state.authAttempts).toEqual([{ secure: true, username: 'alice@example.test', password: 'correct horse' }]);
  });

  it('answers 404 for an account of another user without connecting', async () => {
    await startSieve();
    expect((await call('GET', `/${ACCOUNT}`, null, 'user-2')).status).toBe(404);
    expect(sieve.state.connections).toBe(0);
  });

  it('says Sieve is unavailable when nothing answers, and for an OAuth account, without a login', async () => {
    await startSieve({ starttls: false });
    expect(await (await call('GET', `/${ACCOUNT}`)).json()).toEqual({ supported: false, reason: 'no_starttls' });
    expect(await (await call('GET', `/${OAUTH}`)).json()).toEqual({ supported: false, reason: 'oauth' });
    expect(sieve.state.authAttempts).toEqual([]);
  });

  it('does not log in again right after the server refused the stored password', async () => {
    await startSieve({ password: 'changed elsewhere' });
    expect((await (await call('GET', `/${ACCOUNT}`)).json()).code).toBe('sieve_auth_failed');
    expect((await (await call('GET', `/${ACCOUNT}`)).json()).code).toBe('sieve_auth_failed');
    expect(sieve.state.authAttempts).toHaveLength(1);
  });

  it('builds the Plimail script from rules, checks it, stores it and makes it active', async () => {
    await startSieve();
    const rules = [
      { field: 'subject', contains: 'invoice', action: 'move', folder: 'Invoices' },
      { field: 'from', contains: 'spam@', action: 'delete' },
    ];
    const res = await call('PUT', `/${ACCOUNT}/rules`, { rules });
    expect(res.status).toBe(200);
    const stored = sieve.state.scripts.get(PLIMAIL_SCRIPT);
    expect(stored).toContain('fileinto "Invoices";');
    expect(stored).toContain('fileinto "Trash";');
    expect(readPlimailMeta(stored).rules).toHaveLength(2);
    expect(sieve.state.active).toBe(PLIMAIL_SCRIPT);
    const order = sieve.state.commands.map(c => c.split(' ')[0]);
    expect(order.indexOf('CHECKSCRIPT')).toBeLessThan(order.indexOf('PUTSCRIPT'));

    const state = await (await call('GET', `/${ACCOUNT}`)).json();
    expect(state.plimail).toMatchObject({ exists: true, managed: true, rules: [
      { field: 'subject', contains: 'invoice', action: 'move', folder: 'Invoices' },
      { field: 'from', contains: 'spam@', action: 'delete' },
    ] });
  });

  it('refuses a folder the account does not have', async () => {
    await startSieve();
    const res = await call('PUT', `/${ACCOUNT}/rules`, { rules: [{ field: 'from', contains: 'x', action: 'move', folder: 'Nope' }] });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unknown_folder');
    expect(sieve.state.scripts.size).toBe(0);
  });

  it('does not take over from another active script unless the user confirmed it', async () => {
    await startSieve({ scripts: { roundcube: 'keep;' }, active: 'roundcube' });
    const rules = [{ field: 'from', contains: 'boss', action: 'markRead' }];
    const refused = await call('PUT', `/${ACCOUNT}/rules`, { rules });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'other_active', active: 'roundcube' });
    expect(sieve.state.scripts.has(PLIMAIL_SCRIPT)).toBe(false);
    expect(sieve.state.active).toBe('roundcube');

    expect((await call('PUT', `/${ACCOUNT}/rules`, { rules, activate: false })).status).toBe(200);
    expect(sieve.state.active).toBe('roundcube');
    expect(sieve.state.scripts.get('roundcube')).toBe('keep;');

    expect((await call('PUT', `/${ACCOUNT}/rules`, { rules, replaceActive: true })).status).toBe(200);
    expect(sieve.state.active).toBe(PLIMAIL_SCRIPT);
    expect(sieve.state.scripts.get('roundcube')).toBe('keep;');
  });

  it('does not replace a hand-edited Plimail script with rules unless confirmed', async () => {
    await startSieve({ scripts: { [PLIMAIL_SCRIPT]: 'keep; # mine' }, active: PLIMAIL_SCRIPT });
    const rules = [{ field: 'from', contains: 'boss', action: 'markRead' }];
    const refused = await call('PUT', `/${ACCOUNT}/rules`, { rules });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('plimail_edited');
    expect(sieve.state.scripts.get(PLIMAIL_SCRIPT)).toBe('keep; # mine');
    expect((await call('PUT', `/${ACCOUNT}/rules`, { rules, overwrite: true })).status).toBe(200);
    expect(readPlimailMeta(sieve.state.scripts.get(PLIMAIL_SCRIPT))).toBeTruthy();
  });

  it('stores nothing the server refuses and passes its explanation on', async () => {
    await startSieve();
    const res = await call('PUT', `/${ACCOUNT}/scripts/${PLIMAIL_SCRIPT}`, { content: 'syntax-error' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'sieve_rejected', error: 'line 1: syntax error' });
    expect(sieve.state.commands.some(c => c.startsWith('PUTSCRIPT'))).toBe(false);
  });

  it('overwrites a script Plimail did not write only once confirmed', async () => {
    await startSieve({ scripts: { roundcube: 'keep;' } });
    const refused = await call('PUT', `/${ACCOUNT}/scripts/roundcube`, { content: 'discard;' });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('not_plimail');
    expect(sieve.state.scripts.get('roundcube')).toBe('keep;');
    expect((await call('PUT', `/${ACCOUNT}/scripts/roundcube`, { content: 'discard;\n', overwrite: true })).status).toBe(200);
    expect(sieve.state.scripts.get('roundcube')).toBe('discard;\r\n');
  });

  it('checks a script without storing it', async () => {
    await startSieve();
    expect((await call('POST', `/${ACCOUNT}/check`, { content: 'keep;' })).status).toBe(200);
    expect((await call('POST', `/${ACCOUNT}/check`, { content: 'syntax-error' })).status).toBe(422);
    expect(sieve.state.scripts.size).toBe(0);
  });

  it('deactivates only its own script without confirmation', async () => {
    await startSieve({ scripts: { roundcube: 'keep;', [PLIMAIL_SCRIPT]: 'keep;' }, active: 'roundcube' });
    expect((await call('POST', `/${ACCOUNT}/active`, { name: null })).status).toBe(409);
    expect(sieve.state.active).toBe('roundcube');
    await call('POST', `/${ACCOUNT}/active`, { name: PLIMAIL_SCRIPT, replaceActive: true });
    expect(sieve.state.active).toBe(PLIMAIL_SCRIPT);
    expect((await call('POST', `/${ACCOUNT}/active`, { name: null })).status).toBe(200);
    expect(sieve.state.active).toBeNull();
  });

  const vacation = { enabled: true, subject: 'Away', body: 'Back on the 4th.', start: '2026-12-20', end: '2027-01-04', days: 3 };

  it('writes the out-of-office reply into the Plimail script and keeps the rules it has', async () => {
    await startSieve();
    await call('PUT', `/${ACCOUNT}/rules`, { rules: [{ field: 'subject', contains: 'invoice', action: 'move', folder: 'Invoices' }] });
    const res = await call('PUT', `/${ACCOUNT}/vacation`, { vacation });
    expect(res.status).toBe(200);
    const stored = sieve.state.scripts.get(PLIMAIL_SCRIPT);
    expect(stored).toContain('vacation :days 3 :subject "Away" "Back on the 4th.";');
    expect(stored).toContain('fileinto "Invoices";');
    expect(sieve.state.active).toBe(PLIMAIL_SCRIPT);

    // Saving the rules again keeps the reply.
    await call('PUT', `/${ACCOUNT}/rules`, { rules: [] });
    const state = await (await call('GET', `/${ACCOUNT}`)).json();
    expect(state.plimail).toMatchObject({ managed: true, rules: [], vacation: { ...vacation, addresses: [] } });
    expect(sieve.state.scripts.get(PLIMAIL_SCRIPT)).toContain('vacation :days 3');
  });

  it('turns the reply off without losing its text', async () => {
    await startSieve();
    await call('PUT', `/${ACCOUNT}/vacation`, { vacation });
    expect((await call('PUT', `/${ACCOUNT}/vacation`, { vacation: { ...vacation, enabled: false } })).status).toBe(200);
    expect(sieve.state.scripts.get(PLIMAIL_SCRIPT)).not.toContain('vacation :days');
    const state = await (await call('GET', `/${ACCOUNT}`)).json();
    expect(state.plimail.vacation).toMatchObject({ enabled: false, body: 'Back on the 4th.' });
  });

  it('refuses a reply the server cannot send, and an invalid one, storing nothing', async () => {
    await startSieve({ extensions: ['fileinto', 'imap4flags'] });
    const res = await call('PUT', `/${ACCOUNT}/vacation`, { vacation });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('extension_missing');
    const bad = await call('PUT', `/${ACCOUNT}/vacation`, { vacation: { ...vacation, body: '' } });
    expect((await bad.json()).code).toBe('invalid_vacation');
    expect(sieve.state.scripts.size).toBe(0);
  });

  it('asks before replacing a hand-edited Plimail script or another active script with the reply', async () => {
    await startSieve({ scripts: { [PLIMAIL_SCRIPT]: 'keep; # mine', roundcube: 'keep;' }, active: 'roundcube' });
    expect((await (await call('PUT', `/${ACCOUNT}/vacation`, { vacation })).json()).code).toBe('plimail_edited');
    expect((await (await call('PUT', `/${ACCOUNT}/vacation`, { vacation, overwrite: true })).json()).code).toBe('other_active');
    expect(sieve.state.scripts.get(PLIMAIL_SCRIPT)).toBe('keep; # mine');
    expect((await call('PUT', `/${ACCOUNT}/vacation`, { vacation, overwrite: true, replaceActive: true })).status).toBe(200);
    expect(sieve.state.active).toBe(PLIMAIL_SCRIPT);
  });
});
