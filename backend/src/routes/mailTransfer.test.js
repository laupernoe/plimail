import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Buffer } from 'node:buffer';

// Bulk export (.mbox / .zip of .eml) and import (.mbox / .eml) of a folder. Both are scoped to an
// account of the signed-in user, and the import only ever appends.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    listFolderUids: vi.fn(),
    fetchRawBatch: vi.fn(),
    appendImportBatch: vi.fn(),
    syncFolderOnDemand: vi.fn(),
    broadcast: vi.fn(),
  },
}));

import express from 'express';
import mailTransferRoutes from './mailTransfer.js';
import { mboxFlagsOf, parseMbox } from '../services/mailTransfer.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const SEL_1 = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const SEL_2 = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const MSG_1 = Buffer.from('Message-ID: <1@x>\r\nSubject: First\r\n\r\nFrom the body\r\n>From quoted\r\n');
const MSG_2 = Buffer.from('Message-ID: <2@x>\r\nSubject: Second\r\n\r\nplain\r\n');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail-transfer', mailTransferRoutes);
  return app;
}

const importUrl = (base, params = {}) => {
  const q = new URLSearchParams({ accountId: ACCOUNT_ID, folder: 'INBOX', format: 'mbox', ...params });
  return `${base}/api/mail-transfer/import?${q}`;
};
const exportUrl = (base, params = {}) => {
  const q = new URLSearchParams({ accountId: ACCOUNT_ID, folder: 'INBOX', format: 'mbox', ...params });
  return `${base}/api/mail-transfer/export?${q}`;
};

describe('mail import and export routes', () => {
  let server, base;
  let owner, knownIds, ownedMessages;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => { server.closeAllConnections?.(); server.close(r); }); });
  beforeEach(() => {
    owner = 'user-1';
    knownIds = [];
    ownedMessages = [
      { id: SEL_1, account_id: ACCOUNT_ID, folder: 'INBOX', uid: 2 },
      { id: SEL_2, account_id: ACCOUNT_ID, folder: 'Archive', uid: 1 },
    ];
    query.mockReset().mockImplementation((sql, params) => {
      if (sql.includes('FROM email_accounts')) {
        // Like Postgres: the row only comes back for its owner.
        return Promise.resolve({ rows: params[1] === owner ? [{ id: ACCOUNT_ID, user_id: owner, imap_host: 'imap.example.com' }] : [] });
      }
      if (sql.includes('FROM folders')) return Promise.resolve({ rows: params[1] === 'Nope' ? [] : [{ path: params[1] }] });
      if (sql.includes('FROM messages m JOIN email_accounts')) {
        return Promise.resolve({ rows: params[0] === owner ? ownedMessages.filter(m => params[1].includes(m.id)) : [] });
      }
      if (sql.includes('FROM messages')) return Promise.resolve({ rows: knownIds.map(message_id => ({ message_id })) });
      return Promise.resolve({ rows: [] });
    });
    for (const fn of Object.values(imapManager)) fn.mockReset();
    imapManager.listFolderUids.mockResolvedValue([1, 2]);
    imapManager.fetchRawBatch.mockImplementation(async (_a, _f, uids) => [
      { uid: 1, source: MSG_1, internalDate: new Date(Date.UTC(1996, 0, 3, 1, 5, 34)), flags: new Set(['\\Seen', '\\Flagged']) },
      { uid: 2, source: MSG_2, internalDate: new Date(Date.UTC(2001, 1, 15, 12, 0, 0)), flags: new Set() },
    ].filter(m => uids.includes(m.uid)));
    imapManager.appendImportBatch.mockImplementation(async (_a, _f, items) => items.map(() => ({ status: 'imported' })));
    imapManager.syncFolderOnDemand.mockResolvedValue();
  });
  afterEach(() => { delete process.env.MAIL_IMPORT_MAX_MB; });

  describe('export', () => {
    it('streams an mboxrd file whose From lines are escaped and whose dates are the internal dates', async () => {
      const res = await fetch(exportUrl(base));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/mbox');
      expect(res.headers.get('content-disposition')).toContain('.mbox');
      const body = Buffer.from(await res.arrayBuffer());
      const text = body.toString('latin1');
      expect(text.startsWith('From MAILER-DAEMON Wed Jan  3 01:05:34 1996\n')).toBe(true);
      expect(text).toContain('\r\n>From the body\r\n>>From quoted\r\n');
      expect(text).not.toMatch(/\nFrom the body/);
      // What the import reads back is what was exported, with the flags in Status headers.
      const back = [];
      for await (const m of parseMbox(Readable.from([body]))) back.push(m);
      expect(back.map(m => m.raw.toString('latin1'))).toEqual([
        MSG_1.toString().replace('\r\n\r\n', '\r\nStatus: RO\r\nX-Status: F\r\n\r\n'),
        MSG_2.toString().replace('\r\n\r\n', '\r\nStatus: O\r\n\r\n'),
      ]);
      expect(back.map(m => mboxFlagsOf(m.raw))).toEqual([['\\Seen', '\\Flagged'], []]);
      expect(back[1].fromDate.toISOString()).toBe('2001-02-15T12:00:00.000Z');
    });

    it('fetches the messages a few at a time instead of the whole folder', async () => {
      imapManager.listFolderUids.mockResolvedValue(Array.from({ length: 25 }, (_, i) => i + 1));
      imapManager.fetchRawBatch.mockImplementation(async (_a, _f, uids) => uids.map(uid => ({ uid, source: MSG_2, internalDate: new Date(0) })));
      const res = await fetch(exportUrl(base));
      await res.arrayBuffer();
      const sizes = imapManager.fetchRawBatch.mock.calls.map(c => c[2].length);
      expect(sizes.length).toBeGreaterThan(1);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(10);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(25);
    });

    it('streams a zip of .eml files named after the subject', async () => {
      const res = await fetch(exportUrl(base, { format: 'zip' }));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/zip');
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const text = body.toString('latin1');
      expect(text).toContain('000001-First.eml');
      expect(text).toContain('000002-Second.eml');
    });

    it('404s another user\'s account without touching IMAP', async () => {
      owner = 'user-2';
      const res = await fetch(exportUrl(base));
      expect(res.status).toBe(404);
      expect(imapManager.listFolderUids).not.toHaveBeenCalled();
      expect(imapManager.fetchRawBatch).not.toHaveBeenCalled();
    });

    it('404s a folder the account does not have, and an empty one', async () => {
      expect((await fetch(exportUrl(base, { folder: 'Nope' }))).status).toBe(404);
      imapManager.listFolderUids.mockResolvedValue([]);
      expect((await fetch(exportUrl(base))).status).toBe(404);
    });

    it('rejects bad parameters before any query', async () => {
      expect((await fetch(exportUrl(base, { accountId: 'nope' }))).status).toBe(400);
      expect((await fetch(exportUrl(base, { format: 'rar' }))).status).toBe(400);
      expect((await fetch(exportUrl(base, { folder: '' }))).status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('export of a selection', () => {
    const postSel = body => fetch(`${base}/api/mail-transfer/export-selection`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    it('streams the selected messages of every folder as one mbox', async () => {
      const res = await postSel({ ids: [SEL_1, SEL_2] });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('.mbox');
      const back = [];
      for await (const m of parseMbox(Readable.from([Buffer.from(await res.arrayBuffer())]))) back.push(m);
      expect(back.map(m => m.raw.toString()).map(r => /Subject: (\w+)/.exec(r)[1])).toEqual(['Second', 'First']);
      expect(imapManager.fetchRawBatch.mock.calls.map(c => [c[1], c[2]])).toEqual([['INBOX', [2]], ['Archive', [1]]]);
    });

    it('leaves out messages that are not the user\'s, and 404s when none are', async () => {
      owner = 'user-2';
      expect((await postSel({ ids: [SEL_1] })).status).toBe(404);
      expect(imapManager.fetchRawBatch).not.toHaveBeenCalled();
    });

    it('rejects a missing, oversized or malformed id list before any query', async () => {
      expect((await postSel({})).status).toBe(400);
      expect((await postSel({ ids: ['nope'] })).status).toBe(400);
      expect((await postSel({ ids: Array.from({ length: 1001 }, () => SEL_1) })).status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('import', () => {
    const MBOX = [
      'From a@b.c Wed Jan  3 01:05:34 1996', 'Message-ID: <1@x>', 'Subject: one', '', '>From the body', '',
      'From d@e.f Thu Feb 15 12:00:00 2001', 'Message-ID: <2@x>', 'Subject: two', '', 'hello', '',
    ].join('\n');
    const post = (params, body = MBOX, headers = {}) => fetch(importUrl(base, params), {
      method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream', ...headers },
    });

    it('appends each message with the date of its From line, marked read, and reports the counts', async () => {
      const res = await post();
      expect(res.status).toBe(200);
      const report = await res.json();
      expect(report).toMatchObject({ imported: 2, duplicates: 0, failed: 0, failures: [], aborted: null });
      const [, folder, items] = imapManager.appendImportBatch.mock.calls[0];
      expect(folder).toBe('INBOX');
      expect(items.map(i => i.flags)).toEqual([['\\Seen'], ['\\Seen']]);
      expect(items.map(i => i.date.toISOString())).toEqual(['1996-01-03T01:05:34.000Z', '2001-02-15T12:00:00.000Z']);
      expect(items[0].raw.toString()).toContain('\r\nFrom the body\r\n');
      expect(imapManager.syncFolderOnDemand).toHaveBeenCalled();
    });

    it('can leave the messages unread', async () => {
      await post({ markSeen: '0' });
      expect(imapManager.appendImportBatch.mock.calls[0][2][0].flags).toEqual([]);
    });

    it('imports a single .eml, dated by its Date header', async () => {
      const eml = 'Message-ID: <e@x>\r\nDate: Tue, 1 Mar 2022 10:00:00 +0100\r\nSubject: e\r\n\r\nbody\r\n';
      const res = await post({ format: 'eml', label: 'mail.eml' }, eml, { 'Content-Type': 'message/rfc822' });
      expect(await res.json()).toMatchObject({ imported: 1, failed: 0 });
      expect(imapManager.appendImportBatch.mock.calls[0][2][0].date.toISOString()).toBe('2022-03-01T09:00:00.000Z');
    });

    it('skips what the folder already holds, so running the same import again adds nothing', async () => {
      knownIds = ['<1@x>', '<2@x>'];
      const report = await (await post()).json();
      expect(report).toMatchObject({ imported: 0, duplicates: 2, failed: 0 });
      expect(imapManager.appendImportBatch).not.toHaveBeenCalled();
    });

    it('lists each failure with its reason', async () => {
      imapManager.appendImportBatch.mockImplementation(async (_a, _f, items) => items.map((_, i) => (i === 0 ? { status: 'failed', reason: 'Quota exceeded' } : { status: 'imported' })));
      const report = await (await post()).json();
      expect(report).toMatchObject({ imported: 1, failed: 1 });
      expect(report.failures).toEqual([{ label: 'message 1', reason: 'Quota exceeded' }]);
    });

    it('404s another user\'s account without appending anything', async () => {
      owner = 'user-2';
      const res = await post();
      expect(res.status).toBe(404);
      expect(imapManager.appendImportBatch).not.toHaveBeenCalled();
    });

    it('404s a folder the account does not have', async () => {
      expect((await post({ folder: 'Nope' })).status).toBe(404);
      expect(imapManager.appendImportBatch).not.toHaveBeenCalled();
    });

    it('refuses an upload over MAIL_IMPORT_MAX_MB from its Content-Length, before reading it', async () => {
      process.env.MAIL_IMPORT_MAX_MB = '0.0005'; // about 500 bytes
      const res = await post({}, MBOX + 'x'.repeat(2000));
      expect(res.status).toBe(413);
      expect((await res.json()).error).toMatch(/MAIL_IMPORT_MAX_MB|limit/i);
      expect(imapManager.appendImportBatch).not.toHaveBeenCalled();
    });

    it('stops an upload with no Content-Length at the limit and says so in the report', async () => {
      process.env.MAIL_IMPORT_MAX_MB = '0.0005';
      const stream = Readable.from((function* () {
        yield Buffer.from(MBOX);
        for (let i = 0; i < 50; i++) yield Buffer.from('x'.repeat(100) + '\n');
      })());
      const res = await fetch(importUrl(base), { method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Type': 'application/octet-stream' } });
      expect(res.status).toBe(200);
      // The rest of the upload is never read, so the connection cannot be reused.
      expect(res.headers.get('connection')).toBe('close');
      expect((await res.json()).aborted).toBe('too_large');
    });

    it('answers 400 for a file that is not an mbox, and appends nothing', async () => {
      const res = await post({}, 'Subject: not an mbox\n\nbody\n');
      expect(res.status).toBe(400);
      expect(imapManager.appendImportBatch).not.toHaveBeenCalled();
    });

    it('rejects bad parameters before any query', async () => {
      expect((await post({ accountId: 'nope' })).status).toBe(400);
      expect((await post({ format: 'zip' })).status).toBe(400);
      expect((await post({ folder: '' })).status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });

    it('pushes progress over the WebSocket to this user only, and a final event', async () => {
      await post({ importId: 'imp-1' });
      const events = imapManager.broadcast.mock.calls.filter(c => c[0].type === 'mail_import_progress');
      expect(events.length).toBeGreaterThan(0);
      expect(events.every(c => c[1] === 'user-1')).toBe(true);
      expect(events.at(-1)[0]).toMatchObject({ importId: 'imp-1', accountId: ACCOUNT_ID, imported: 2, done: true });
    });

    it('lifts the request time limit while the file is read, and puts it back', async () => {
      const before = server.requestTimeout;
      expect(before).toBeGreaterThan(0);
      let during;
      imapManager.appendImportBatch.mockImplementation(async (_a, _f, items) => { during = server.requestTimeout; return items.map(() => ({ status: 'imported' })); });
      expect((await post()).status).toBe(200);
      expect(during).toBe(0);
      expect(server.requestTimeout).toBe(before);
    });

    it('runs one import per user at a time', async () => {
      let release;
      imapManager.appendImportBatch.mockImplementation(() => new Promise(r => { release = () => r([{ status: 'imported' }, { status: 'imported' }]); }));
      const first = post();
      await vi.waitFor(() => expect(imapManager.appendImportBatch).toHaveBeenCalled());
      const second = await post();
      expect(second.status).toBe(409);
      release();
      expect((await first).status).toBe(200);
      // and the slot is free again afterwards
      imapManager.appendImportBatch.mockImplementation(async (_a, _f, items) => items.map(() => ({ status: 'imported' })));
      expect((await post()).status).toBe(200);
    });
  });
});
