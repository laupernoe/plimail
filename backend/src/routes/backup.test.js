import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'http';
import { randomBytes } from 'crypto';
import { gzipSync } from 'zlib';

vi.mock('../services/db.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn() },
}));
// One session for every request of a test, confirmed for backups unless a test says otherwise.
const auth = vi.hoisted(() => ({ session: null }));
vi.mock('../middleware/auth.js', () => ({
  requireAdmin: (req, _res, next) => {
    req.session = auth.session;
    next();
  },
}));
vi.mock('../services/apiTokenReauth.js', () => ({
  userForReauth: vi.fn(async id => ({ id, username: 'admin' })),
  reauthFor: vi.fn(async () => 'password'),
  oidcConfirmationState: vi.fn(),
  confirmReauth: vi.fn(),
}));
// `actual` is the module the mock's BackupFileError comes from, so a test that runs the real
// restore gets errors the router recognises.
vi.mock('../services/backup.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, actual, writeBackup: vi.fn(), restoreBackup: vi.fn(), unclassifiedTables: vi.fn() };
});
vi.mock('../index.js', () => ({
  APP_VERSION: '3.6.0',
  imapManager: { disconnectUser: vi.fn(async () => {}), connectAllForUser: vi.fn(async () => {}) },
  restartAfterRestore: vi.fn(),
}));

vi.mock('../services/scheduledSend.js', () => ({
  stopScheduledSender: vi.fn(async () => {}),
  startScheduledSender: vi.fn(),
}));

import express from 'express';

let server;
let base;
let port;
const client = { release: vi.fn(), query: vi.fn() };

// A committed restore keeps the router's restore slot taken until the process restarts, which
// the mock never does, so every test gets a fresh router, and the mocks it was built with.
let m;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/backup', (req, res, next) => m.router(req, res, next));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  base = `http://127.0.0.1:${port}/api/admin/backup`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
  vi.resetModules();
  m = {
    db: await import('../services/db.js'),
    backup: await import('../services/backup.js'),
    index: await import('../index.js'),
    scheduled: await import('../services/scheduledSend.js'),
    router: (await import('./backup.js')).default,
    reauth: await import('../services/apiTokenReauth.js'),
  };
  vi.clearAllMocks();
  auth.session = {
    userId: 'admin-1', username: 'admin', backupConfirmation: { userId: 'admin-1', until: Date.now() + 60_000 },
  };
  m.db.pool.connect.mockResolvedValue(client);
  m.db.query.mockResolvedValue({ rows: [{ id: 'u1' }, { id: 'u2' }] });
  m.backup.unclassifiedTables.mockResolvedValue([]);
});

const wait = ms => new Promise(r => setTimeout(r, ms));
const post = (body, type = 'application/gzip') => fetch(`${base}/restore`, { method: 'POST', headers: { 'Content-Type': type }, body });
const ndjson = async res => (await res.text()).trim().split('\n').map(l => JSON.parse(l));
const RESULT = { scope: 'setup', tables: 1, rows: 2, warnings: [] };

describe('GET /api/admin/backup/check', () => {
  it('says whether a backup can start', async () => {
    expect((await fetch(`${base}/check?scope=full`)).status).toBe(200);
    m.backup.unclassifiedTables.mockResolvedValue(['brand_new_table']);
    const res = await fetch(`${base}/check?scope=full`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Tables not classified for backup: brand_new_table' });
  });
});

describe('GET /api/admin/backup', () => {
  it('streams the backup as a gzip download named after the moment and scope', async () => {
    m.backup.writeBackup.mockImplementation(async (_client, { out }) => { out.write('gz'); out.end(); return { tables: 2, rows: 5 }; });
    const res = await fetch(`${base}?scope=full`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="mailflow-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-full\.json\.gz"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('gz');
    expect(m.backup.writeBackup).toHaveBeenCalledWith(client, expect.objectContaining({ scope: 'full', appVersion: '3.6.0' }));
    expect(client.release).toHaveBeenCalled();
  });

  it('backs up the setup by default', async () => {
    m.backup.writeBackup.mockImplementation(async (_client, { out }) => { out.end(); return { tables: 0, rows: 0 }; });
    await fetch(base);
    expect(m.backup.writeBackup.mock.calls[0][1].scope).toBe('setup');
  });

  it('rejects an unknown scope', async () => {
    const res = await fetch(`${base}?scope=everything`);
    expect(res.status).toBe(400);
    expect(m.backup.writeBackup).not.toHaveBeenCalled();
  });

  it('refuses a download another site started', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = await fetch(base, { headers: { 'Sec-Fetch-Site': site } });
      expect(res.status).toBe(403);
    }
    expect(m.backup.writeBackup).not.toHaveBeenCalled();
    m.backup.writeBackup.mockImplementation(async (_client, { out }) => { out.end(); return { tables: 0, rows: 0 }; });
    expect((await fetch(base, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
  });

  it('answers a failure before the first byte as JSON, not as a download', async () => {
    m.backup.writeBackup.mockRejectedValue(new Error('Tables not classified for backup: x'));
    const res = await fetch(base);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: 'Tables not classified for backup: x' });
    expect(client.release).toHaveBeenCalled();
  });
});

describe('POST /api/admin/backup/restore', () => {
  it('streams progress, then the result, and restarts once the reply is out', async () => {
    m.backup.restoreBackup.mockImplementation(async (_client, input, { beforeWrite, onProgress }) => {
      expect(typeof input.pipe).toBe('function');
      await beforeWrite();
      onProgress({ table: 'users', rows: 2 });
      return { ...RESULT, warnings: ['note'] };
    });
    const res = await post('gz-bytes');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(await ndjson(res)).toEqual([{ table: 'users', rows: 2 }, { ok: true, ...RESULT, warnings: ['note'] }]);
    expect(m.index.imapManager.disconnectUser.mock.calls.map(c => c[0])).toEqual(['u1', 'u2']);
    expect(m.index.imapManager.connectAllForUser).not.toHaveBeenCalled();
    // The scheduled sender stopped, its sends in flight finished, before the accounts went,
    // and stays stopped for the restart.
    expect(m.scheduled.stopScheduledSender).toHaveBeenCalledTimes(1);
    expect(m.scheduled.stopScheduledSender.mock.invocationCallOrder[0])
      .toBeLessThan(m.index.imapManager.disconnectUser.mock.invocationCallOrder[0]);
    expect(m.scheduled.startScheduledSender).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(m.index.restartAfterRestore).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(client.release).toHaveBeenCalled();
  });

  it('still restarts when the browser went away before the result reached it', async () => {
    m.backup.restoreBackup.mockImplementation(async (_client, _input, { beforeWrite }) => {
      await beforeWrite();
      await wait(200);
      return RESULT;
    });
    await new Promise(resolve => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/admin/backup/restore', method: 'POST', headers: { 'Content-Type': 'application/gzip' } });
      req.on('response', () => { req.destroy(); resolve(); });
      req.on('error', () => {});
      req.end('gz-bytes');
    });
    await vi.waitFor(() => expect(m.index.restartAfterRestore).toHaveBeenCalledTimes(1), { timeout: 4000 });
  });

  it('answers a bad file with 400 and the reason, without restarting', async () => {
    m.backup.restoreBackup.mockRejectedValue(new m.backup.BackupFileError('This backup was made on a server with a different ENCRYPTION_KEY.'));
    const res = await post('gz-bytes');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This backup was made on a server with a different ENCRYPTION_KEY.' });
    await wait(600);
    expect(m.index.restartAfterRestore).not.toHaveBeenCalled();
    expect(m.index.imapManager.disconnectUser).not.toHaveBeenCalled();
    expect(m.scheduled.stopScheduledSender).not.toHaveBeenCalled();
  });

  it('answers a refused upload even when most of it is still unread', async () => {
    m.backup.restoreBackup.mockImplementation(m.backup.actual.restoreBackup);
    client.query.mockResolvedValue({ rows: [{ version: '0061_message_bcc_addresses' }] });
    const manifest = { mailflow: 'backup', format: m.backup.BACKUP_FORMAT, scope: 'setup', schemaVersion: '0999_future', tables: [], sequences: {}, keyCheck: 'enc:x' };
    const filler = Array.from({ length: 80 }, () => JSON.stringify({ table: 'users', rows: [{ id: 'u', username: randomBytes(30000).toString('base64') }] }));
    const res = await post(gzipSync([JSON.stringify(manifest), ...filler].join('\n')));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/newer version/);
    // The next restore is not refused as "already running".
    m.backup.restoreBackup.mockRejectedValue(new m.backup.BackupFileError('nope'));
    expect((await post('gz-bytes')).status).toBe(400);
  });

  it('reports a failure after the write began inside the stream and reconnects the accounts', async () => {
    m.backup.restoreBackup.mockImplementation(async (_client, _input, { beforeWrite }) => { await beforeWrite(); throw new Error('lock timeout'); });
    const res = await post('gz-bytes');
    expect(res.status).toBe(200);
    expect(await ndjson(res)).toEqual([{ error: 'lock timeout' }]);
    await vi.waitFor(() => expect(m.index.imapManager.connectAllForUser.mock.calls.map(c => c[0])).toEqual(['u1', 'u2']));
    // Nothing was committed, so the scheduled sender starts again.
    expect(m.scheduled.stopScheduledSender).toHaveBeenCalledTimes(1);
    expect(m.scheduled.startScheduledSender).toHaveBeenCalledTimes(1);
    await wait(600);
    expect(m.index.restartAfterRestore).not.toHaveBeenCalled();
  });

  it('frees the restore slot when no database connection can be had', async () => {
    m.db.pool.connect.mockRejectedValueOnce(new Error('pool exhausted'));
    const res = await post('gz-bytes');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'pool exhausted' });
    m.backup.restoreBackup.mockResolvedValue(RESULT);
    expect((await post('gz-bytes')).status).toBe(200);
  });

  it('wants the file as application/gzip', async () => {
    const res = await post('{}', 'application/json');
    expect(res.status).toBe(415);
    expect(m.backup.restoreBackup).not.toHaveBeenCalled();
  });

  it('runs one restore at a time and holds backups off meanwhile', async () => {
    let finish;
    m.backup.restoreBackup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = post('gz-bytes');
    await vi.waitFor(() => expect(m.backup.restoreBackup).toHaveBeenCalled());
    expect((await post('gz-bytes')).status).toBe(409);
    expect((await fetch(base)).status).toBe(409);
    expect((await fetch(`${base}/check`)).status).toBe(409);
    finish(RESULT);
    expect((await first).status).toBe(200);
    expect(m.backup.restoreBackup).toHaveBeenCalledTimes(1);
    // After a committed restore the process is about to restart, so the slot stays taken.
    expect((await post('gz-bytes')).status).toBe(409);
  });

  it('waits for a running download instead of racing its locks', async () => {
    let finishDownload;
    m.backup.writeBackup.mockImplementation(async (_client, { out }) => {
      out.write('gz');
      await new Promise(resolve => { finishDownload = resolve; });
      out.end();
      return { tables: 1, rows: 1 };
    });
    const download = fetch(base).then(res => res.text());
    await vi.waitFor(() => expect(m.backup.writeBackup).toHaveBeenCalled());
    const refused = await post('gz-bytes');
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/download is running/);
    expect(m.backup.restoreBackup).not.toHaveBeenCalled();
    finishDownload();
    await download;
    m.backup.restoreBackup.mockResolvedValue(RESULT);
    expect((await post('gz-bytes')).status).toBe(200);
  });

  it('lifts the request time limit only while a restore reads its upload', async () => {
    const before = server.requestTimeout;
    expect(before).toBeGreaterThan(0);
    let during;
    m.backup.restoreBackup.mockImplementation(async () => { during = server.requestTimeout; return RESULT; });
    await (await post('gz-bytes')).text();
    expect(during).toBe(0);
    expect(server.requestTimeout).toBe(before);
    m.backup.restoreBackup.mockRejectedValue(new m.backup.BackupFileError('nope'));
    await (await post('gz-bytes')).text();
    expect(server.requestTimeout).toBe(before);
  });

  it('explains a restore that gave up on a busy lock', async () => {
    m.backup.restoreBackup.mockImplementation(async (_client, _input, { beforeWrite }) => {
      await beforeWrite();
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    });
    const res = await post('gz-bytes');
    expect(await ndjson(res)).toEqual([{ error: 'Another connection kept Plimail’s tables busy for 30 seconds. Nothing was changed; try again.' }]);
  });
});

describe('confirming it is the admin', () => {
  const refused = { error: 'Confirm it is you before a backup or a restore.', code: 'reauth_required' };

  it('is needed before a backup, its check or a restore', async () => {
    delete auth.session.backupConfirmation;
    const check = await fetch(`${base}/check?scope=full`);
    expect(check.status).toBe(403);
    expect(await check.json()).toEqual(refused);
    const download = await fetch(`${base}?scope=full`);
    expect(download.status).toBe(403);
    expect(await download.json()).toEqual(refused);
    expect(m.backup.writeBackup).not.toHaveBeenCalled();
    const restore = await post(gzipSync(Buffer.from('{}')));
    expect(restore.status).toBe(403);
    expect(await restore.json()).toEqual(refused);
    expect(m.backup.restoreBackup).not.toHaveBeenCalled();
  });

  it('runs out after a few minutes, and counts only for the admin who confirmed', async () => {
    auth.session.backupConfirmation = { userId: 'admin-1', until: Date.now() - 1 };
    expect((await fetch(`${base}/check?scope=full`)).status).toBe(403);
    auth.session.backupConfirmation = { userId: 'someone-else', until: Date.now() + 60_000 };
    expect((await fetch(`${base}/check?scope=full`)).status).toBe(403);
  });

  it('is recorded in the session once the password checks out, and refused otherwise', async () => {
    delete auth.session.backupConfirmation;
    m.reauth.confirmReauth.mockResolvedValueOnce({
      refusal: { status: 400, body: { error: 'Incorrect password', reauth: 'password' } },
    });
    const wrong = await fetch(`${base}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }),
    });
    expect(wrong.status).toBe(400);
    expect(auth.session.backupConfirmation).toBeUndefined();

    m.reauth.confirmReauth.mockResolvedValueOnce({ confirmedWith: 'password' });
    const right = await fetch(`${base}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'right' }),
    });
    expect(right.status).toBe(200);
    expect(m.reauth.confirmReauth).toHaveBeenLastCalledWith(expect.anything(), { id: 'admin-1', username: 'admin' }, 'password');
    const { confirmedUntil } = await right.json();
    expect(new Date(confirmedUntil).getTime()).toBeGreaterThan(Date.now());
    expect((await fetch(`${base}/check?scope=full`)).status).toBe(200);
    expect(await (await fetch(`${base}/reauth`)).json()).toEqual({ reauth: 'password', confirmedUntil });
  });
});
