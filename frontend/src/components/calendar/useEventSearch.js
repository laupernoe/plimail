import { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api.js';
import { searchable } from './eventSearch.js';

const DEBOUNCE_MS = 250;
const IDLE = { loading: false, events: [], truncated: false, error: null };

// Searches a quarter of a second after the last keystroke. A search for an older query is
// aborted, so the server stops counting it against the user's rate and nothing late lands.
export function useEventSearch(query) {
  const q = searchable(query);
  const [state, setState] = useState(IDLE);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!q) { setState(IDLE); return undefined; }
    let live = true;
    const controller = new AbortController();
    setState(s => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(async () => {
      try {
        const res = await api.calendar.searchEvents(q, { signal: controller.signal });
        if (live) setState({ loading: false, events: res?.events || [], truncated: Boolean(res?.truncated), error: null });
      } catch (err) {
        if (live) setState({ loading: false, events: [], truncated: false, error: err.message });
      }
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); controller.abort(); };
  }, [q, attempt]);

  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { ...state, query: q, retry };
}
