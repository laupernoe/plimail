import { describe, expect, it } from 'vitest';
import { bySearchOrder, fold, mayMatch } from './calendarSearch.js';

const ICS = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:standup@example.com', "SUMMARY:Réunion d'équipe",
  'LOCATION:Salle 2\\, bât', ' iment B', 'ATTENDEE;CN=Zoé:mailto:zoe@example.com', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

describe('mayMatch', () => {
  it('looks at the searched properties only', () => {
    expect(mayMatch(ICS, 'vevent')).toBe(false);
    expect(mayMatch(ICS, 'standup')).toBe(false);
    expect(mayMatch(ICS, fold('Réunion'))).toBe(true);
    expect(mayMatch(ICS, fold('zoé'))).toBe(true);
  });

  it('reads folded lines and escaped commas as one text', () => {
    expect(mayMatch(ICS, '2, batiment')).toBe(true);
  });
});

describe('bySearchOrder', () => {
  it('puts upcoming occurrences first, soonest first, then past ones, latest first', () => {
    const at = (start, upcoming) => ({ occ: { start }, upcoming });
    const list = [at('2025-01-01', false), at('2027-01-01T00:00:00Z', true), at('2026-05-01', false), at('2026-12-01T00:00:00Z', true)];
    expect(list.sort(bySearchOrder).map(x => x.occ.start)).toEqual(['2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z', '2026-05-01', '2025-01-01']);
  });
});
