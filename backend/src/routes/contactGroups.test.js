import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// db.js is mocked with a small in-memory store that understands the statements the group
// service issues, and honours the user id parameter they carry. A statement that forgot it, or
// that deleted from contacts, shows up in the assertions below.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: req.headers['x-user'] }; next(); },
}));

import express from 'express';
import router from './contactGroups.js';
import { query } from '../services/db.js';

const flat = sql => sql.replace(/\s+/g, ' ').trim();
let groups, members, contacts, statements;

function fakeQuery(rawSql, params = []) {
  const sql = flat(rawSql);
  statements.push(sql);
  if (sql.startsWith('INSERT INTO address_books')) return { rows: [{ id: `book-${params[0]}` }] };
  if (sql.startsWith('UPDATE address_books')) return { rows: [] };
  if (sql.startsWith('SELECT id, address_book_id, name, source FROM contact_groups')) {
    return { rows: groups.filter(g => g.id === params[0] && g.user_id === params[1]) };
  }
  if (sql.startsWith('INSERT INTO contact_groups')) {
    const g = { id: `g${groups.length + 1}`, user_id: params[0], address_book_id: params[1], uid: params[2], name: params[3], source: 'local' };
    if (groups.some(x => x.user_id === g.user_id && x.name.toLowerCase() === g.name.toLowerCase())) throw Object.assign(new Error('dup'), { code: '23505' });
    groups.push(g);
    return { rows: [{ id: g.id, name: g.name, source: g.source }] };
  }
  if (sql.startsWith('UPDATE contact_groups SET name')) {
    const g = groups.find(x => x.id === params[1] && x.user_id === params[2]);
    if (g) g.name = params[0];
    return { rows: g ? [{ id: g.id, name: g.name }] : [] };
  }
  if (sql.startsWith('UPDATE contact_groups SET updated_at')) return { rows: [] };
  if (sql.startsWith('DELETE FROM contact_groups WHERE id = $1 AND user_id = $2')) {
    const gone = groups.filter(g => g.id === params[0] && g.user_id === params[1]);
    groups = groups.filter(g => !gone.includes(g));
    members = members.filter(m => !gone.some(g => g.id === m.group_id)); // ON DELETE CASCADE
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO contact_group_members')) {
    const [groupId, ids, userId] = params;
    for (const c of contacts.filter(c => ids.includes(c.id) && c.user_id === userId)) members.push({ group_id: groupId, contact_id: c.id });
    return { rows: [] };
  }
  if (sql.startsWith('DELETE FROM contact_group_members WHERE group_id = $1 AND contact_id = $2')) {
    members = members.filter(m => !(m.group_id === params[0] && m.contact_id === params[1]));
    return { rows: [] };
  }
  if (sql.includes('FROM contact_group_members m JOIN contacts c')) {
    return { rows: members.filter(m => m.group_id === params[0]).map(m => contacts.find(c => c.id === m.contact_id)) };
  }
  if (sql.includes('FROM contact_groups g WHERE g.user_id = $1 ORDER BY')) {
    return { rows: groups.filter(g => g.user_id === params[0]).map(g => ({ id: g.id, name: g.name, member_count: members.filter(m => m.group_id === g.id).length })) };
  }
  throw new Error(`unexpected SQL: ${sql}`);
}

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/contact-groups', router);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/contact-groups`;
});
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => {
  groups = [{ id: 'g-a', user_id: 'alice', address_book_id: 'book-alice', uid: 'u-a', name: 'Family', source: 'local' }];
  contacts = [
    { id: 'c-1', user_id: 'alice', display_name: 'Ann', primary_email: 'ann@example.com' },
    { id: 'c-2', user_id: 'bob', display_name: 'Bob', primary_email: 'bob@example.com' },
  ];
  members = [{ group_id: 'g-a', contact_id: 'c-1' }];
  statements = [];
  query.mockReset().mockImplementation(async (sql, params) => fakeQuery(sql, params));
});

const call = (user, method, path = '', body) => fetch(`${base}${path}`, {
  method,
  headers: { 'x-user': user, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const writesTo = table => statements.filter(s => /^(INSERT INTO|UPDATE|DELETE FROM)/.test(s) && s.includes(table));

describe('contact groups: ownership', () => {
  it("does not list another user's groups", async () => {
    const res = await call('bob', 'GET');
    expect((await res.json()).groups).toEqual([]);
    expect((await (await call('alice', 'GET')).json()).groups.map(g => g.name)).toEqual(['Family']);
  });

  it.each([
    ['read', 'GET', '', undefined],
    ['rename', 'PATCH', '', { name: 'Mine now' }],
    ['delete', 'DELETE', '', undefined],
    ['add members to', 'POST', '/members', { contactIds: ['c-2'] }],
    ['remove a member from', 'DELETE', '/members/c-1', undefined],
  ])("refuses to %s another user's group with 404 and changes nothing", async (_what, method, suffix, body) => {
    const res = await call('bob', method, `/g-a${suffix}`, body);
    expect(res.status).toBe(404);
    expect(groups.map(g => g.name)).toEqual(['Family']);
    expect(members).toEqual([{ group_id: 'g-a', contact_id: 'c-1' }]);
  });

  it("adds only the caller's own contacts to a group", async () => {
    groups.push({ id: 'g-b', user_id: 'bob', address_book_id: 'book-bob', uid: 'u-b', name: 'Mates', source: 'local' });
    // Bob names Ann's contact id next to his own: only his own is added.
    const res = await call('bob', 'POST', '/g-b/members', { contactIds: ['c-1', 'c-2'] });
    expect(res.status).toBe(200);
    expect(members.filter(m => m.group_id === 'g-b')).toEqual([{ group_id: 'g-b', contact_id: 'c-2' }]);
  });
});

describe('contact groups: deleting', () => {
  it('removes the group and its memberships but keeps every contact', async () => {
    const res = await call('alice', 'DELETE', '/g-a');
    expect(res.status).toBe(200);
    expect(groups).toEqual([]);
    expect(members).toEqual([]);
    expect(contacts.map(c => c.id)).toEqual(['c-1', 'c-2']);
    expect(writesTo('contacts ')).toEqual([]);
    expect(statements.filter(s => /^DELETE FROM contacts\b/.test(s))).toEqual([]);
  });

  it('removing a member leaves the contact in place', async () => {
    const res = await call('alice', 'DELETE', '/g-a/members/c-1');
    expect(res.status).toBe(200);
    expect(members).toEqual([]);
    expect(contacts.map(c => c.id)).toContain('c-1');
  });
});

describe('contact groups: create and rename', () => {
  it('creates a group, trims its name and refuses a duplicate', async () => {
    const created = await call('alice', 'POST', '', { name: '  Work  ' });
    expect(created.status).toBe(201);
    expect((await created.json()).name).toBe('Work');
    expect((await call('alice', 'POST', '', { name: 'work' })).status).toBe(409);
  });

  it('refuses an empty name', async () => {
    expect((await call('alice', 'POST', '', { name: '   ' })).status).toBe(400);
  });

  it('renames a group', async () => {
    const res = await call('alice', 'PATCH', '/g-a', { name: 'Relatives' });
    expect(res.status).toBe(200);
    expect(groups[0].name).toBe('Relatives');
  });

  it('keeps a category group read-only', async () => {
    groups.push({ id: 'g-cat', user_id: 'alice', address_book_id: 'book-alice', uid: 'u-c', name: 'Club', source: 'category' });
    expect((await call('alice', 'PATCH', '/g-cat', { name: 'x' })).status).toBe(403);
    expect((await call('alice', 'DELETE', '/g-cat')).status).toBe(403);
    expect((await call('alice', 'POST', '/g-cat/members', { contactIds: ['c-1'] })).status).toBe(403);
    expect(groups.map(g => g.name)).toContain('Club');
  });
});
