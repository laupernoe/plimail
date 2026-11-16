import { occurrenceDays } from '../../utils/calendarDates.js';

// The backend refuses anything shorter or longer (routes/calendar.js).
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 200;

export const searchable = (query) => {
  const q = String(query || '').trim();
  return q.length >= SEARCH_MIN && q.length <= SEARCH_MAX ? q : null;
};

// Results arrive upcoming first, soonest first, then past ones, latest first. This keeps that order
// and puts the rows of one day under one date.
export function groupSearchResults(events) {
  const sections = [];
  for (const occ of events) {
    const kind = occ.upcoming === false ? 'past' : 'upcoming';
    let section = sections.at(-1);
    if (!section || section.kind !== kind) sections.push(section = { kind, days: [] });
    const { startDay } = occurrenceDays(occ);
    let group = section.days.at(-1);
    if (!group || group.day !== startDay) section.days.push(group = { day: startDay, items: [] });
    group.items.push(occ);
  }
  return sections;
}
