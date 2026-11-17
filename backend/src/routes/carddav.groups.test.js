import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Groups travel over CardDAV as RFC 6350 KIND:group cards next to the contacts; CATEGORIES on a
// contact card become read-only groups. db.js is mocked: each test sets what the group queries
// return and reads back what was written.
vi.mock('../services/redis.js', () => ({
  redisClient: { incr: vi.fn(async () => 1), decr: vi.fn(async () => 0), pExpire: vi.fn(async () => true), pTTL: vi.fn(async () => 60000), del: vi.fn(async () => 1) },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 1000, windowMs: 60000 } }));

import express from 'express';
import bcrypt from 'bcryptjs';
import carddavRouter from './carddav.js';
import { query } from '../services/db.js';
import { generateGroupVCard, parseVCard } from '../utils/vcard.js';

const BOOK_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const HASH = bcrypt.hashSync('pw', 4);
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const flat = sql => sql.replace(/\s+/g, ' ').trim();
let log, groupRows, groupDeleteRows;
function fakeQuery(rawSql, params = []) {
  const sql = flat(rawSql);
  log.push({ sql, params });
  if (sql.startsWith('SELECT id, password_hash, totp_enabled FROM users')) {
    return { rows: [{ id: params[0], password_hash: HASH, totp_enabled: false }] };
  }
  if (/^SELECT .+ FROM address_books WHERE id = \$1 AND user_id = \$2$/.test(sql)) {
    return { rows: params[0] === BOOK_ID && params[1] === 'owner' ? [{ id: BOOK_ID, user_id: 'owner', name: 'Contacts', sync_token: 't1' }] : [] };
  }
  if (sql.includes('FROM contact_groups g LEFT JOIN contact_group_members m')) return { rows: groupRows };
  if (sql.startsWith('INSERT INTO contact_groups (user_id, address_book_id, uid, name) VALUES')) return { rows: [{ id: 'g-new' }] };
  if (sql.startsWith('DELETE FROM contact_groups WHERE address_book_id')) return { rows: groupDeleteRows };
  if (sql.startsWith('INSERT INTO contacts')) return { rows: [{ id: 'c-new' }] };
  return { rows: [] };
}

let server, base;
beforeAll(async () => {
  const app = express();
  app.use('/carddav', carddavRouter);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/carddav`;
});
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => {
  log = [];
  groupRows = [];
  groupDeleteRows = [];
  query.mockReset().mockImplementation(async (sql, params) => fakeQuery(sql, params));
});

const dav = (user, method, path, body) => fetch(`${base}/${user}/${BOOK_ID}/${path}`, {
  method,
  headers: { Authorization: `Basic ${Buffer.from(`${user}:pw`).toString('base64')}`, Depth: '1', 'Content-Type': 'text/xml' },
  body,
});
const statements = re => log.filter(e => re.test(e.sql));

describe('CardDAV groups', () => {
  it('lists a group as a KIND:group card whose members are the contacts uids', async () => {
    groupRows = [{ uid: 'g1', name: 'Team', member_uids: [U1, U2] }];
    const res = await dav('owner', 'REPORT', '', '<C:addressbook-query xmlns:C="urn:ietf:params:xml:ns:carddav"/>');
    expect(res.status).toBe(207);
    const body = await res.text();
    expect(body).toContain('/g1.vcf');
    expect(body).toContain('KIND:group');
    expect(body).toContain(`MEMBER:urn:uuid:${U1}`);
    expect(body).toContain(`MEMBER:urn:uuid:${U2}`);
  });

  it('serves a group card on GET and reads back the same group', async () => {
    groupRows = [{ uid: 'g1', name: 'Team', member_uids: [U1] }];
    const res = await dav('owner', 'GET', 'g1.vcf');
    expect(res.status).toBe(200);
    const parsed = parseVCard(await res.text());
    expect(parsed).toMatchObject({ kind: 'group', displayName: 'Team', members: [U1] });
  });

  it('refuses a stranger the group card with a bare 404', async () => {
    groupRows = [{ uid: 'g1', name: 'Team', member_uids: [U1] }];
    const res = await dav('stranger', 'GET', 'g1.vcf');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('PUT of a group card creates the group and its memberships, and writes no contact', async () => {
    const card = generateGroupVCard({ uid: 'g2', name: 'Friends', memberUids: [U1, U2] });
    const res = await dav('owner', 'PUT', 'g2.vcf', card);
    expect(res.status).toBe(201);
    const created = statements(/^INSERT INTO contact_groups/)[0];
    expect(created.params).toEqual(['owner', BOOK_ID, 'g2', 'Friends']);
    const members = statements(/^INSERT INTO contact_group_members/)[0];
    expect(members.params).toEqual(['g-new', 'owner', BOOK_ID, [U1, U2]]);
    expect(statements(/^(INSERT INTO|UPDATE|DELETE FROM) contacts\b/)).toEqual([]);
  });

  it('PUT of a contact card with CATEGORIES makes read-only category groups', async () => {
    const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c9\r\nFN:Ann\r\nEMAIL:ann@example.com\r\nCATEGORIES:Work,Club\r\nEND:VCARD\r\n';
    const res = await dav('owner', 'PUT', 'c9.vcf', card);
    expect(res.status).toBe(201);
    const made = statements(/^INSERT INTO contact_groups .* 'category'/)[0];
    expect(made.params).toEqual(['owner', BOOK_ID, ['Work', 'Club']]);
    expect(statements(/^INSERT INTO contact_group_members/)[0].params).toEqual(['c-new', 'owner', ['work', 'club']]);
  });

  it('DELETE of a group card deletes the group only, never a contact', async () => {
    groupDeleteRows = [{ id: 'g1' }];
    const res = await dav('owner', 'DELETE', 'g1.vcf');
    expect(res.status).toBe(204);
    expect(statements(/^DELETE FROM contact_groups/)[0].params).toEqual([BOOK_ID, 'g1', 'owner']);
    expect(statements(/^DELETE FROM contacts\b/)).toEqual([]);
  });

  it('DELETE of a contact card still deletes the contact', async () => {
    const res = await dav('owner', 'DELETE', 'c1.vcf');
    expect(res.status).toBe(404); // nothing stored under that uid in this fake
    expect(statements(/^DELETE FROM contacts\b/)).toHaveLength(1);
  });
});
