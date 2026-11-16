import { expandResourceAsync } from './icalEvents.js';

const DAY_MS = 86400000;
const HORIZON_MS = 731 * DAY_MS;
// Looking back, a short window first: most series that ended did so recently.
const PAST_WINDOWS_MS = [31 * DAY_MS, 366 * DAY_MS, HORIZON_MS];

// Case and accents do not count: "cafe" finds "Café".
export const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Postgres has no unaccent here, so translate() strips the accents of the Latin letters ical text
// is written in, and drops combining marks outright (the second string is shorter).
const ACCENTED = [];
for (let c = 0xc0; c <= 0x17f; c++) {
  const ch = String.fromCodePoint(c);
  const bare = ch.normalize('NFD').replace(/\p{M}/gu, '');
  if (bare !== ch && /^[A-Za-z]$/.test(bare)) ACCENTED.push([ch, bare]);
}
const COMBINING = Array.from({ length: 0x70 }, (_, i) => String.fromCodePoint(0x300 + i)).join('');
export const TRANSLATE_FROM = ACCENTED.map(([ch]) => ch).join('') + COMBINING;
export const TRANSLATE_TO = ACCENTED.map(([, bare]) => bare).join('');

// Unfolds lines and drops RFC 5545 text escapes, so "Paris, France" finds "Paris\, France".
export const SQL_SEARCHABLE = String.raw`translate(
  regexp_replace(regexp_replace(e.ical, E'\\r?\\n[ \\t]', '', 'g'), E'\\\\([,;:"\\\\])', E'\\1', 'g'),
  $3, $4)`;

export const likePattern = q => `%${fold(q).replace(/[\\%_]/g, m => `\\${m}`)}%`;

export function matches(occ, needle) {
  const people = [occ.organizer, ...(occ.attendees || [])].filter(Boolean);
  return [occ.summary, occ.location, occ.description, ...people.flatMap(p => [p.name, p.email])]
    .some(v => v && fold(v).includes(needle));
}

const SEARCHED = /^(SUMMARY|LOCATION|DESCRIPTION|ORGANIZER|ATTENDEE)(?=[;:])/i;

// A cheap look at the searched properties before expanding: SQL matched anywhere in the resource,
// "event" included, which every VEVENT contains.
export function mayMatch(ical, needle) {
  return ical.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).some(line => {
    const name = SEARCHED.exec(line);
    return name && fold(line.slice(name[0].length).replace(/\\([,;:"\\])/g, '$1')).includes(needle);
  });
}

const startOf = occ => Date.parse(occ.start);
const endOf = occ => Date.parse(occ.end);

// The occurrence of a resource to show for a search: the next one (or the one under way), else the
// latest past one. Only occurrences that match count, as an exception may carry its own title.
export async function searchOccurrence(row, needle, nowMs, { floatingTz }, pause) {
  const rangeStart = row.range_start ? new Date(row.range_start).getTime() : -Infinity;
  const rangeEnd = row.range_end ? new Date(row.range_end).getTime() : Infinity;
  const opts = { floatingTz };

  const from = Math.max(nowMs, rangeStart);
  const to = Math.min(nowMs + HORIZON_MS, rangeEnd);
  if (from < to) {
    // Exceptions come back first, then the series in order, so this many always reaches its next one.
    const overrides = (row.ical.match(/^RECURRENCE-ID[;:]/gim) || []).length;
    const occs = await expandResourceAsync(row.ical, from, to, { ...opts, limit: overrides + 3 }, pause);
    const next = occs.filter(o => endOf(o) > nowMs && matches(o, needle)).sort((a, b) => startOf(a) - startOf(b))[0];
    if (next) return { occ: next, upcoming: true };
  }

  const end = Math.min(nowMs, rangeEnd);
  for (const span of PAST_WINDOWS_MS) {
    const start = Math.max(end - span, rangeStart);
    if (start >= end) break;
    const occs = await expandResourceAsync(row.ical, start, end, opts, pause);
    const last = occs.filter(o => startOf(o) < nowMs && endOf(o) <= nowMs && matches(o, needle))
      .sort((a, b) => startOf(b) - startOf(a))[0];
    if (last) return { occ: last, upcoming: false };
    if (start === rangeStart) break;
  }
  return null;
}

export function bySearchOrder(a, b) {
  if (a.upcoming !== b.upcoming) return a.upcoming ? -1 : 1;
  return a.upcoming ? startOf(a.occ) - startOf(b.occ) : startOf(b.occ) - startOf(a.occ);
}
