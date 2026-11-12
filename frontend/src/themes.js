// Two themes, one design language: neutral greys with no accent hue. The accent is the ink
// colour, so the primary action is light on near-black (selfhostr) and dark on near-white
// (selfhostr-light), and colour is left to status and calendars. `system` follows the OS.
//
// --accent-text is the text colour for anything painted with a --accent background: use it,
// never a hard-coded white, or the dark theme's light accent ends up with white-on-white.
export const THEMES = {
  system: {
    label: 'System',
    description: 'Match OS light/dark setting',
    preview: ['#07080a', '#f6f7f8', '#eceef1', '#101216'],
    vars: null, // resolved per OS preference, see applyTheme
  },

  selfhostr: {
    label: 'selfhostr',
    description: 'Near-black, neutral, no accent colour',
    preview: ['#07080a', '#0b0d10', '#eceef1', '#8a919c'],
    vars: {
      '--bg-primary': '#07080a',
      '--bg-secondary': '#0b0d10',
      '--bg-tertiary': '#111419',
      '--bg-elevated': '#111419',
      '--bg-hover': '#16191e',
      '--border': '#23272e',
      '--border-subtle': '#16191e',
      '--text-primary': '#eceef1',
      '--text-secondary': '#8a919c',
      '--text-tertiary': '#7a818c',
      '--accent': '#eceef1',
      '--accent-text': '#07080a',
      '--accent-dim': '#23272e',
      '--accent-glow': 'rgba(236,238,241,0.08)',
      '--status-text': '#07080a',
      '--green': '#2fd17c',
      '--red': '#ff5c5c',
      '--amber': '#f2b033',
    }
  },

  // The same tokens on a light ground. Text and status colours are picked for WCAG AA (4.5:1)
  // against every surface they sit on (themes.test.js checks it).
  'selfhostr-light': {
    label: 'selfhostr light',
    description: 'Near-white, neutral, no accent colour',
    preview: ['#f6f7f8', '#ffffff', '#101216', '#5f6670'],
    vars: {
      '--bg-primary': '#f6f7f8',
      '--bg-secondary': '#ffffff',
      '--bg-tertiary': '#eef0f2',
      '--bg-elevated': '#ffffff',
      '--bg-hover': '#e6e8eb',
      '--border': '#d0d4d9',
      '--border-subtle': '#e6e8eb',
      '--text-primary': '#101216',
      '--text-secondary': '#4b525c',
      '--text-tertiary': '#5c636d',
      '--accent': '#101216',
      '--accent-text': '#f6f7f8',
      '--accent-dim': '#d0d4d9',
      '--accent-glow': 'rgba(16,18,22,0.06)',
      '--status-text': '#ffffff',
      '--green': '#08733f',
      '--red': '#c62828',
      '--amber': '#8a5700',
    }
  },
};

// The stored value is whatever an older version saved (dark, nord, winxp...). Anything that is
// no longer a theme falls back to following the OS.
export function normalizeTheme(name) {
  return Object.prototype.hasOwnProperty.call(THEMES, name) ? name : 'system';
}

// ── Color helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function lighten(hex, t) {
  return '#' + hexToRgb(hex)
    .map(c => Math.min(255, Math.round(c + (255 - c) * t)).toString(16).padStart(2, '0'))
    .join('');
}

function darken(hex, t) {
  return '#' + hexToRgb(hex)
    .map(c => Math.round(c * (1 - t)).toString(16).padStart(2, '0'))
    .join('');
}

function buildFaviconSvg(accent, count = 0) {
  const light = lighten(accent, 0.25);
  const dark  = darken(accent, 0.30);
  const [dr, dg, db] = hexToRgb(dark);

  let badge = '';
  if (count > 0) {
    const label = count > 99 ? '99+' : String(count);
    const r  = label.length > 2 ? 10 : 11;
    const cx = 32 - r;
    const cy = r;
    const fs = label.length > 2 ? 8 : label.length > 1 ? 12 : 14;
    badge = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ef4444" stroke="white" stroke-width="1.5"/>` +
            `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" ` +
            `fill="white" font-family="system-ui,sans-serif" font-weight="800" font-size="${fs}">${label}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${light}"/>
      <stop offset="100%" stop-color="${dark}"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.14)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
    <clipPath id="ec">
      <rect x="5" y="10.5" width="22" height="15" rx="2.5"/>
    </clipPath>
  </defs>
  <rect width="32" height="32" rx="7.5" fill="url(#bg)"/>
  <rect width="32" height="16" rx="7.5" fill="url(#shine)"/>
  <rect x="5" y="11.5" width="22" height="15" rx="2.5" fill="rgba(0,0,0,0.18)"/>
  <rect x="5" y="10.5" width="22" height="15" rx="2.5" fill="white"/>
  <path d="M5,10.5 L16,20.5 L27,10.5 Z" fill="rgba(${dr},${dg},${db},0.10)" clip-path="url(#ec)"/>
  <path d="M5,10.5 L16,20.5 L27,10.5" fill="none" stroke="rgba(${dr},${dg},${db},0.38)" stroke-width="1.4" stroke-linejoin="round" clip-path="url(#ec)"/>
  <line x1="5" y1="25.5" x2="13" y2="20" stroke="rgba(${dr},${dg},${db},0.16)" stroke-width="1.1"/>
  <line x1="27" y1="25.5" x2="19" y2="20" stroke="rgba(${dr},${dg},${db},0.16)" stroke-width="1.1"/>
  ${badge}
</svg>`;
}

// ── Sender avatar color ───────────────────────────────────────────────────────

const SENDER_PALETTE = [
  '#dc2626', // red
  '#ea580c', // orange
  '#d97706', // amber
  '#65a30d', // lime
  '#16a34a', // green
  '#059669', // emerald
  '#0d9488', // teal
  '#0891b2', // cyan
  '#0284c7', // sky
  '#2563eb', // blue
  '#4f46e5', // indigo
  '#7c3aed', // violet
  '#9333ea', // purple
  '#c026d3', // fuchsia
  '#db2777', // pink
  '#e11d48', // rose
];

function hashIndex(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % SENDER_PALETTE.length;
}

export function senderColor(email) {
  const key = (email || '').toLowerCase().trim();
  return SENDER_PALETTE[key ? hashIndex(key) : 0];
}

// ── Custom CSS injection ───────────────────────────────────────────────────────

const CUSTOM_CSS_ID = 'mailflow-custom-css';

export function applyCustomCss(css) {
  let el = document.getElementById(CUSTOM_CSS_ID);
  if (!css) {
    if (el) el.remove();
    refreshAccentDerived(); // revert favicon/logo if the removed CSS was overriding --accent
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = CUSTOM_CSS_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
  refreshAccentDerived(); // flow a custom --accent override through to favicon/logo
}

// ── Theme application ─────────────────────────────────────────────────────────

let _activeTheme = 'system';
let _mediaQueryListenerAttached = false;

function _onSystemThemeChange() {
  if (_activeTheme === 'system') {
    applyTheme('system');
  }
}

// Returns the concrete theme name ('selfhostr' or 'selfhostr-light') for a stored theme key.
// 'system' inspects the OS light/dark preference; anything unknown counts as 'system'.
export function resolveEffectiveTheme(themeName) {
  const name = normalizeTheme(themeName);
  if (name !== 'system') return name;
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      return 'selfhostr-light';
    }
  } catch { /* matchMedia unavailable — fall through to dark */ }
  return 'selfhostr';
}

// The theme to use before any stored/server preference is known — i.e. on the
// login screen and the very first visit. Honors the OS light/dark setting via 'system'.
export function getInitialTheme() {
  return 'system';
}

// ── Effective accent (theme value, or a custom-CSS override of --accent) ───────

// The accent actually in effect. A custom-CSS override of --accent wins over the
// theme's declared value, so JS-driven chrome (favicon, PWA theme-color, the logo
// mark) reads the *computed* value to match what var(--accent) resolves to in CSS.
export function getEffectiveAccent(fallback = '#eceef1') {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return v || fallback;
  } catch { return fallback; }
}

// Subscribers (e.g. the logo mark) notified when the effective accent changes, so
// they update on a custom-CSS accent override too — not only on a theme switch.
const _accentListeners = new Set();
export function subscribeAccent(fn) {
  _accentListeners.add(fn);
  return () => { _accentListeners.delete(fn); };
}

// Recompute everything derived from the accent (favicon, PWA theme-color, logo)
// from the *effective* accent. Called after both applyTheme and applyCustomCss so
// the accent's source (preset theme or custom override) doesn't matter.
function refreshAccentDerived() {
  const accent = getEffectiveAccent();
  if (!accent.startsWith('#')) return; // favicon rasteriser + meta expect a hex colour
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', accent);
  // Only invalidate the base favicon cache when the accent actually changed — the
  // double applyTheme at startup (localStorage then server prefs) usually repeats it.
  if (_baseAccent !== accent) {
    _baseCanvas = null;
    _baseAccent = null;
  }
  _applyFavicon(accent);
  if (_badgeCount > 0) _warmBase(accent);
  _accentListeners.forEach(fn => {
    try { fn(accent); } catch { /* a listener error must not break theming */ }
  });
}

const cssVars = (vars, indent) => Object.entries(vars).map(([k, v]) => `${indent}${k}: ${v};`).join('\n');

export function applyTheme(themeName) {
  const name = normalizeTheme(themeName);
  _activeTheme = name;

  if (!_mediaQueryListenerAttached && typeof window !== 'undefined' && window.matchMedia) {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      mq.addEventListener?.('change', _onSystemThemeChange);
      _mediaQueryListenerAttached = true;
    } catch { /* matchMedia listener unavailable */ }
  }

  const effectiveKey = resolveEffectiveTheme(name);

  // Expose the active theme as an attribute so index.css can scope per-theme tokens (shadows).
  document.documentElement.setAttribute('data-mailflow-theme', effectiveKey);

  // Inject vars via a <style> element rather than root.style.setProperty so
  // that <style id="mailflow-custom-css"> (appended afterward) can override
  // theme variables at equal specificity using normal cascade source order.
  let themeEl = document.getElementById('mailflow-theme');
  if (!themeEl) {
    themeEl = document.createElement('style');
    themeEl.id = 'mailflow-theme';
    document.head.appendChild(themeEl);
  }

  if (name === 'system') {
    themeEl.textContent = `:root {\n${cssVars(THEMES.selfhostr.vars, '  ')}\n  color-scheme: dark;\n}\n`
      + `@media (prefers-color-scheme: light) {\n  :root {\n${cssVars(THEMES['selfhostr-light'].vars, '    ')}\n    color-scheme: light;\n  }\n}`;
  } else {
    themeEl.textContent = `:root {\n${cssVars(THEMES[name].vars, '  ')}\n  color-scheme: ${effectiveKey === 'selfhostr-light' ? 'light' : 'dark'};\n}`;
  }

  // Recompute favicon + PWA theme-color + logo from the *effective* accent. If a
  // custom-CSS override of --accent is present, getComputedStyle picks it up here;
  // applyCustomCss also re-runs this so an override applied afterwards is reflected.
  refreshAccentDerived();
}

// ── Favicon badge ─────────────────────────────────────────────────────────────

const FAVICON_PX = 32;
let _badgeCount  = 0;
let _renderSeq   = 0;
let _appliedSeq  = 0;

// Cached rasterization of the base favicon (envelope icon, no badge).
// Once populated, badge updates are drawn synchronously with Canvas 2D —
// no SVG → Image → onload round-trip needed.
let _baseCanvas = null;
let _baseAccent = null;

// Persistent <link rel="icon"> element. We update href in-place rather than
// removing/adding the element each time. DOM remove+add causes Chrome to briefly
// show no favicon between the two mutations, making updates appear sluggish.
let _faviconLink = null;

function _setFaviconLink(dataUri) {
  if (!_faviconLink || !_faviconLink.isConnected) {
    // Reuse the existing icon element from index.html on first call so Chrome
    // processes a href change on a known element rather than discovering a new one.
    _faviconLink = document.querySelector("link[rel='icon']") || (() => {
      const el = document.createElement('link');
      el.rel = 'icon';
      document.head.appendChild(el);
      return el;
    })();
    // Remove any competing icon links (e.g. a second link added by HMR or SSR)
    // but leave apple-touch-icon and other non-standard rel values alone.
    document.querySelectorAll("link[rel='icon']").forEach(l => {
      if (l !== _faviconLink) l.remove();
    });
  }
  _faviconLink.type = 'image/png';
  _faviconLink.href = dataUri;
}

function _rasterise(svgStr, onCanvas) {
  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const url  = URL.createObjectURL(blob);
  const img  = new Image(FAVICON_PX, FAVICON_PX);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const canvas = document.createElement('canvas');
    canvas.width  = FAVICON_PX;
    canvas.height = FAVICON_PX;
    canvas.getContext('2d').drawImage(img, 0, 0, FAVICON_PX, FAVICON_PX);
    onCanvas(canvas);
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

function _warmBase(accent) {
  if (_baseCanvas && _baseAccent === accent) return;
  _rasterise(buildFaviconSvg(accent, 0), (canvas) => {
    if (_baseCanvas && _baseAccent === accent) return; // lost the race
    _baseCanvas = canvas;
    _baseAccent = accent;
  });
}

function _applyFavicon(accent) {
  // Rasterise the SVG to a canvas and export as PNG. PNG data URIs go through
  // the browser's image pipeline rather than the document pipeline, which avoids
  // the Chromium quirk where SVG favicons are silently reverted to the cached
  // on-disk file after tab focus changes.
  const isBase = _badgeCount === 0; // capture before any async gap
  const seq    = ++_renderSeq;
  _rasterise(buildFaviconSvg(accent, _badgeCount), (canvas) => {
    // Cache the no-badge render as the base so all future badge updates can
    // skip the async round-trip and draw synchronously via Canvas 2D.
    // Do this before the seq guard so the cache is always populated, even
    // if a later render has already applied its result to the DOM.
    if (isBase && !_baseCanvas) {
      _baseCanvas = canvas;
      _baseAccent = accent;
    }

    // Only skip this render if a *later* render already applied its result.
    if (seq < _appliedSeq) return;
    _appliedSeq = seq;
    _setFaviconLink(canvas.toDataURL('image/png'));
  });
}

export function updateFaviconBadge(count) {
  _badgeCount = count;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  if (!accent || !accent.startsWith('#')) return;

  // Fast synchronous path: base favicon is cached — composite badge directly.
  if (_baseCanvas && _baseAccent === accent) {
    // Advance the sequence counter so any in-flight slow-path renders that
    // complete later are treated as stale and don't overwrite this result.
    _appliedSeq = ++_renderSeq;

    const canvas = document.createElement('canvas');
    canvas.width  = FAVICON_PX;
    canvas.height = FAVICON_PX;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(_baseCanvas, 0, 0);

    if (count > 0) {
      const label = count > 99 ? '99+' : String(count);
      const r  = label.length > 2 ? 10 : 11;
      const cx = FAVICON_PX - r;
      const cy = r;
      const fs = label.length > 2 ? 8 : label.length > 1 ? 12 : 14;
      // White border (filled circle, slightly larger than the badge)
      ctx.beginPath();
      ctx.arc(cx, cy, r + 1.5, 0, 2 * Math.PI);
      ctx.fillStyle = 'white';
      ctx.fill();
      // Red badge
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      // White label
      ctx.fillStyle = 'white';
      ctx.font = `800 ${fs}px system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy + 0.5);
    }

    _setFaviconLink(canvas.toDataURL('image/png'));
    return;
  }

  // Slow path: base not cached yet (first render or theme change) — use async
  // SVG rasterization. Also warm the base cache separately so the next badge
  // update can use the fast synchronous path, even if _badgeCount > 0 now
  // (which would prevent _applyFavicon from auto-caching the base).
  _applyFavicon(accent);
  if (_badgeCount > 0) _warmBase(accent);
}
