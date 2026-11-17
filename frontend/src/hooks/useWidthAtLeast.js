import { useEffect, useState } from 'react';

// Whether an element is at least `min` px wide, kept up to date as it resizes: [ref, wide], where
// ref is a callback ref for the element. A toolbar uses it to drop its text labels when its pane
// gets too narrow for them. A container query would say the same in CSS, but it makes the toolbar
// the containing block of the fixed backdrops its menus close on. Wide until measured, and where
// ResizeObserver is missing.
export function useWidthAtLeast(min) {
  const [el, setEl] = useState(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= min));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, min]);
  return [setEl, wide];
}
