import { describe, expect, it } from 'vitest';
import { invitations } from './calendarInbox.js';

const NOW = Date.parse('2027-03-01T12:00:00Z');
const ME = 'noe@example.com';

const ics = ({ method = 'REQUEST', uid = 'meet-1', seq = 0, stamp = '20270201T100000Z', start = '20270310T090000Z', end = '20270310T100000Z',
  partstat = 'NEEDS-ACTION', organizer = 'boss@example.com', attendee = ME, status = null, rid = null, extra = [] } = {}) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...(method ? [`METHOD:${method}`] : []), 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`,
  ...(rid ? [`RECURRENCE-ID${rid}`] : []),
  `DTSTART:${start}`, `DTEND:${end}`, `SEQUENCE:${seq}`, 'SUMMARY:Budget review', 'LOCATION:Room 4',
  `ORGANIZER;CN=The Boss:mailto:${organizer}`, `ATTENDEE;PARTSTAT=${partstat};RSVP=TRUE:mailto:${attendee}`,
  ...(status ? [`STATUS:${status}`] : []), ...extra, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

let n = 0;
const mail = (ical, extra = {}) => ({
  message_id: `m${++n}`, ical, account_id: 'acc1', account_email: ME, account_name: 'Work', folder: 'INBOX', special_use: null,
  date: '2027-02-01T10:00:00Z', ...extra,
});
const copy = (ical, extra = {}) => ({ id: `e${++n}`, calendar_id: 'cal1', uid: 'meet-1', ical, read_only: false, ...extra });
const list = args => invitations({ myEmails: [ME], nowMs: NOW, ...args });

describe('pending invitations', () => {
  it('lists an invitation received by mail', () => {
    const [inv] = list({ mail: [mail(ics())] });
    expect(inv).toMatchObject({
      uid: 'meet-1', recurrenceId: null, status: 'NEEDS-ACTION', source: 'mail', summary: 'Budget review', location: 'Room 4',
      start: '2027-03-10T09:00:00.000Z', organizer: { email: 'boss@example.com', name: 'The Boss' }, invitedAs: ME, messageId: expect.any(String),
    });
  });

  it('lists a meeting once, however many copies of the mail there are', () => {
    const r = list({ mail: [mail(ics()), mail(ics(), { folder: '[Gmail]/All Mail', special_use: '\\All' })] });
    expect(r).toHaveLength(1);
  });

  it('shows the latest revision of the meeting', () => {
    const r = list({ mail: [
      mail(ics({ seq: 2, start: '20270312T090000Z', end: '20270312T100000Z' })),
      mail(ics({ seq: 1 })),
    ] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ sequence: 2, start: '2027-03-12T09:00:00.000Z' });
  });

  it('drops a meeting the organizer cancelled', () => {
    expect(list({ mail: [mail(ics({ seq: 0 })), mail(ics({ method: 'CANCEL', seq: 1, status: 'CANCELLED' }))] })).toEqual([]);
    // At the same revision too: a cancellation outranks the request it follows.
    expect(list({ mail: [mail(ics({ seq: 0 })), mail(ics({ method: 'CANCEL', seq: 0 }))] })).toEqual([]);
  });

  it('asks again when a newer request follows the cancellation', () => {
    const r = list({ mail: [mail(ics({ method: 'CANCEL', seq: 1 })), mail(ics({ seq: 2 }))] });
    expect(r).toHaveLength(1);
  });

  it('leaves out a meeting that is over', () => {
    expect(list({ mail: [mail(ics({ start: '20270210T090000Z', end: '20270210T100000Z' }))] })).toEqual([]);
  });

  it('keeps a series while occurrences are still to come, at the next one', () => {
    const r = list({ mail: [mail(ics({ start: '20270201T090000Z', end: '20270201T100000Z', extra: ['RRULE:FREQ=WEEKLY;COUNT=10'] }))] });
    expect(r[0]).toMatchObject({ isRecurring: true, start: '2027-03-08T09:00:00.000Z' });
  });

  it('is not an invitation to the user when they organize it or are not invited', () => {
    expect(list({ mail: [mail(ics({ organizer: ME, attendee: 'ana@example.com' }))] })).toEqual([]);
    expect(list({ mail: [mail(ics({ attendee: 'team@example.com' }))] })).toEqual([]);
  });

  it('ignores answers other people sent and messages in the bin', () => {
    expect(list({ mail: [mail(ics({ method: 'REPLY' }))] })).toEqual([]);
    expect(list({ mail: [mail(ics(), { special_use: '\\Trash' })] })).toEqual([]);
  });

  it('knows the answer given to this revision, and asks again for a newer one', () => {
    const replies = [{ uid: 'meet-1', recurrence_id: '', sequence: 1, partstat: 'DECLINED', answered_at: '2027-02-02T00:00:00Z' }];
    expect(list({ mail: [mail(ics({ seq: 1 }))], replies })[0].status).toBe('DECLINED');
    expect(list({ mail: [mail(ics({ seq: 2 }))], replies })[0].status).toBe('NEEDS-ACTION');
  });

  it('lists an invitation the server put in the calendar', () => {
    const [inv] = list({ calendar: [copy(ics({ method: null }))] });
    expect(inv).toMatchObject({ source: 'calendar', status: 'NEEDS-ACTION', eventId: expect.any(String), calendarId: 'cal1', messageId: null });
  });

  it('merges the mail and the calendar copy of one meeting, the calendar answering for the same revision', () => {
    const m = mail(ics());
    const r = list({ mail: [m], calendar: [copy(ics({ method: null, partstat: 'ACCEPTED' }))] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ source: 'calendar', status: 'ACCEPTED', messageId: m.message_id });
  });

  it('takes the mail when it is newer than the calendar copy', () => {
    const r = list({ mail: [mail(ics({ seq: 3 }))], calendar: [copy(ics({ method: null, partstat: 'ACCEPTED', seq: 1 }))] });
    expect(r[0]).toMatchObject({ source: 'mail', status: 'NEEDS-ACTION', eventId: expect.any(String) });
  });

  it('cannot answer in a read-only calendar', () => {
    expect(list({ calendar: [copy(ics({ method: null }), { read_only: true })] })).toEqual([]);
  });

  it('is one occurrence when the mail names one, matched to the calendar copy written in another zone', () => {
    const master = ics({ method: null, start: '20270301T090000Z', end: '20270301T100000Z', partstat: 'ACCEPTED', extra: ['RRULE:FREQ=WEEKLY;COUNT=5'] });
    const zoned = master.replace('END:VCALENDAR', [
      'BEGIN:VEVENT', 'UID:meet-1', 'DTSTAMP:20270201T100000Z', 'RECURRENCE-ID;TZID=Europe/Zurich:20270315T100000',
      'DTSTART;TZID=Europe/Zurich:20270315T110000', 'DTEND;TZID=Europe/Zurich:20270315T120000', 'SEQUENCE:1', 'SUMMARY:Moved',
      'ORGANIZER:mailto:boss@example.com', 'ATTENDEE;PARTSTAT=TENTATIVE:mailto:noe@example.com', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    const occurrence = ics({ seq: 1, rid: ':20270315T090000Z', start: '20270315T100000Z', end: '20270315T110000Z' });
    const r = list({ mail: [mail(occurrence)], calendar: [copy(zoned)] });
    expect(r).toHaveLength(2);
    expect(r.find(i => i.recurrenceId)).toMatchObject({ recurrenceId: '2027-03-15T09:00:00.000Z', source: 'calendar', status: 'TENTATIVE' });
  });
});
