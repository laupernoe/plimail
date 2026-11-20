// The user's default writing font (Settings > Behavior > Writing). The composer sends it with
// the message as { family, size }; the HTML part then wraps the body and signature in one block
// carrying it, so recipients see what the composer showed. The quoted original stays outside and
// keeps its own formatting. No font, or an empty one, leaves the HTML exactly as before.
//
// The family is a CSS font stack the composer offers (Arial, Helvetica, sans-serif…). It ends up
// in a style attribute, so only names, commas, spaces, hyphens and quotes are accepted, and double
// quotes become single ones so the attribute cannot be closed early.
const FAMILY_RE = /^[A-Za-z0-9 ,'"-]{1,200}$/;
const SIZE_RE = /^([0-9]{1,2})px$/;
const MIN_SIZE = 8;
const MAX_SIZE = 72;

// '' and absent mean "Default". Returns the normalized value, '' for none, or undefined when it
// is not one we accept.
export function normalizeFontFamily(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v === '') return '';
  if (!FAMILY_RE.test(v) || !/[A-Za-z]/.test(v)) return undefined;
  return v.replace(/"/g, "'");
}

export function normalizeFontSize(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') return undefined;
  const m = SIZE_RE.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= MIN_SIZE && n <= MAX_SIZE ? `${n}px` : undefined;
}

// A send's composeFont: null for none, { family?, size? } when set, undefined when malformed.
export function normalizeComposeFont(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const family = normalizeFontFamily(value.family);
  const size = normalizeFontSize(value.size);
  if (family === undefined || size === undefined) return undefined;
  if (!family && !size) return null;
  return { ...(family ? { family } : {}), ...(size ? { size } : {}) };
}

// `font` is normalizeComposeFont's result.
export function wrapComposeFont(html, font) {
  if (!font || (!font.family && !font.size)) return html;
  const style = [font.family ? `font-family:${font.family}` : '', font.size ? `font-size:${font.size}` : '']
    .filter(Boolean).join(';');
  return `<div style="${style}">${html}</div>`;
}
