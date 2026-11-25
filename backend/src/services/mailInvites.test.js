import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [], updates: [] }));
vi.mock('./db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (/FROM mail_invites i\s+JOIN messages m/.test(sql) && /i.ical IS NULL/.test(sql)) return { rows: state.rows };
    if (/FROM email_accounts WHERE id = ANY/.test(sql)) return { rows: [{ id: 'acc1' }] };
    if (/UPDATE mail_invites/.test(sql)) { state.updates.push(params); return { rowCount: 1 }; }
    return { rows: [] };
  }),
}));

const { describeInvite, readPendingObjects, _resetInviteState } = await import('./mailInvites.js');

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:meet-1', 'DTSTAMP:20270101T000000Z',
  'SEQUENCE:3', 'DTSTART:20270310T090000Z', 'DTEND:20270310T100000Z', 'SUMMARY:Point', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
const ROW = { message_id: 'm1', parts: [{ part: '1.3', type: 'text/calendar', encoding: 'base64', charset: 'utf-8', method: 'REQUEST' }], uid: 7, folder: 'INBOX', account_id: 'acc1' };

beforeEach(() => { Object.assign(state, { rows: [ROW], updates: [] }); _resetInviteState(); });

describe('mail invitations', () => {
  it('reads what an object is about', () => {
    expect(describeInvite(ICS)).toMatchObject({ method: 'REQUEST', uid: 'meet-1', sequence: 3, rangeEnd: expect.any(Date) });
    expect(describeInvite(ICS.replace('METHOD:REQUEST\r\n', ''), 'CANCEL').method).toBe('CANCEL');
    expect(describeInvite('not a calendar')).toBeNull();
  });

  it('stores the object of an unread invitation, fetched from the part sync found', async () => {
    const engine = { fetchMultipleAttachments: vi.fn(async () => new Map([['1.3', Buffer.from(ICS)]])) };
    await readPendingObjects('u1', { engine });
    expect(engine.fetchMultipleAttachments).toHaveBeenCalledWith({ id: 'acc1' }, 7, 'INBOX', [{ part: '1.3', encoding: 'base64' }]);
    expect(state.updates).toEqual([['m1', ICS, 'REQUEST', 'meet-1', 3, expect.any(Date)]]);
  });

  it('marks a part that holds no invitation, and leaves one that could not be fetched for later', async () => {
    await readPendingObjects('u1', { engine: { fetchMultipleAttachments: async () => new Map([['1.3', Buffer.from('hello')]]) } });
    expect(state.updates).toEqual([['m1', '', null, null, null, null]]);
    state.updates = [];
    _resetInviteState();
    await readPendingObjects('u1', { engine: { fetchMultipleAttachments: async () => new Map() } });
    expect(state.updates).toEqual([]);
  });
});
