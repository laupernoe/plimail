// What the mail sidebar's "Upcoming" section shows: the events from now through the next week,
// grouped by day, with the ones already over left out. Pure, so node:test can run it.
import { addDays, compareOccurrences, localMidnight, occursOnDay, todayDay } from '../../utils/calendarDates.js';

export const UPCOMING_DAYS = 7;
export const UPCOMING_ROWS = 6;
const DAY_MS = 86_400_000;

// The days the section looks at (today and the next `days`), and the ISO instants to request them with.
export function upcomingRange(now = new Date(), days = UPCOMING_DAYS) {
  const first = todayDay(now);
  const endDay = addDays(first, days + 1);
  return { first, endDay, from: localMidnight(first).toISOString(), to: localMidnight(endDay).toISOString() };
}

// calendars: only to drop the hidden ones, as the calendar page does (a calendar not in the list is kept).
// Returns { groups: [{ day, items }], total, hidden }: `items` are the rows to draw (at most `limit`
// across all groups), `hidden` how many more there are. An item is { key, occ, day, allDay, now,
// continued }: `now` when a timed event is in progress, `continued` on a day after the one it began on.
export function buildUpcoming({ events, calendars = [], now = new Date(), days = UPCOMING_DAYS, limit = UPCOMING_ROWS }) {
  const hiddenCalendars = new Set(calendars.filter(c => c.visible === false).map(c => c.id));
  const nowMs = now.getTime();
  const horizon = nowMs + days * DAY_MS;
  const first = todayDay(now);
  const dayList = Array.from({ length: days + 1 }, (_, i) => addDays(first, i));
  const candidates = (events || []).filter(e => e && !hiddenCalendars.has(e.calendarId) && e.status !== 'CANCELLED');

  const groups = [];
  let total = 0;
  for (const day of dayList) {
    const items = [];
    for (const occ of candidates.filter(e => occursOnDay(e, day)).sort(compareOccurrences)) {
      let inProgress = false;
      if (!occ.allDay) {
        const s = new Date(occ.start).getTime();
        const e = new Date(occ.end).getTime();
        if (!Number.isFinite(s)) continue;
        if (Math.max(s, Number.isFinite(e) ? e : s) <= nowMs || s >= horizon) continue;
        inProgress = s <= nowMs;
      }
      items.push({
        key: `${day}:${occ.id}`, occ, day, allDay: Boolean(occ.allDay), now: inProgress,
        continued: !occ.allDay && todayDay(new Date(occ.start)) !== day,
      });
    }
    total += items.length;
    if (items.length) groups.push({ day, items });
  }

  let room = limit;
  const shown = [];
  for (const g of groups) {
    if (room <= 0) break;
    const items = g.items.slice(0, room);
    room -= items.length;
    shown.push({ day: g.day, items });
  }
  return { groups: shown, total, hidden: total - (limit - room) };
}
