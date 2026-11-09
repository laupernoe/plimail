import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../utils/api.js';
import { buildUpcoming, upcomingRange } from './upcoming.js';

const REFRESH_MS = 5 * 60_000;
const CLOCK_MS = 60_000;

// The data behind the sidebar's Upcoming section. `mailMode` is false while the calendar is open;
// `open` is false while the section is collapsed. The accounts are looked up whenever mail mode
// starts (that is how the section learns an account was added or removed); the events are fetched
// only while the section is open, on focus and every five minutes. A failed request hides the
// section until the next attempt succeeds, and never throws.
export function useUpcoming({ mailMode, open }) {
  const [hasAccounts, setHasAccounts] = useState(false);
  const [calendars, setCalendars] = useState([]);
  const [events, setEvents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const seq = useRef(0);

  useEffect(() => {
    if (!mailMode) return undefined;
    let cancelled = false;
    api.calendar.accounts()
      .then(a => { if (!cancelled) { setHasAccounts(Array.isArray(a) && a.length > 0); setFailed(false); } })
      .catch(() => { if (!cancelled) { setHasAccounts(false); setFailed(true); } });
    return () => { cancelled = true; };
  }, [mailMode]);

  const active = mailMode && open && hasAccounts;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const at = new Date();
    try {
      const { from, to } = upcomingRange(at);
      const [cals, res] = await Promise.all([api.calendar.calendars(), api.calendar.events(from, to)]);
      if (mine !== seq.current) return;
      setCalendars(Array.isArray(cals) ? cals : []);
      setEvents(Array.isArray(res?.events) ? res.events : []);
      setNow(at);
      setLoaded(true);
      setFailed(false);
    } catch {
      if (mine === seq.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!active) { seq.current += 1; return undefined; }
    load();
    const onFocus = () => { if (document.visibilityState !== 'hidden') load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const refresh = setInterval(load, REFRESH_MS);
    // Keeps "in progress" and "already over" honest between fetches.
    const clock = setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      clearInterval(refresh);
      clearInterval(clock);
    };
  }, [active, load]);

  const view = useMemo(() => buildUpcoming({ events, calendars, now }), [events, calendars, now]);
  const colorOf = useCallback((id) => calendars.find(c => c.id === id)?.color || 'var(--accent)', [calendars]);
  return { hasAccounts, loaded, failed, now, colorOf, ...view };
}
