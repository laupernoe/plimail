// Fonts the composer offers, in its toolbar and as the default writing font in Settings. A value
// is the CSS font stack itself, as the toolbar has always stored it; the server takes the same
// stacks (backend/src/services/composeFont.js checks their characters, not this list).
export const FONT_SIZES = [
  { label: '10', value: '10px' },
  { label: '11', value: '11px' },
  { label: '12', value: '12px' },
  { label: '13', value: '13px' },
  { label: '14', value: '14px' },
  { label: '16', value: '16px' },
  { label: '18', value: '18px' },
  { label: '20', value: '20px' },
  { label: '24', value: '24px' },
  { label: '28', value: '28px' },
  { label: '36', value: '36px' },
];

export const FONT_GROUPS = [
  { label: 'Sans-serif', fonts: [
    { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
    { label: 'Calibri', value: 'Calibri, Candara, "Segoe UI", sans-serif' },
    { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
    { label: 'Helvetica Neue', value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
    { label: 'Optima', value: 'Optima, Candara, "Noto Sans", sans-serif' },
    { label: 'Segoe UI', value: '"Segoe UI", system-ui, sans-serif' },
    { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
    { label: 'Trebuchet MS', value: '"Trebuchet MS", Helvetica, sans-serif' },
    { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  ]},
  { label: 'Serif', fonts: [
    { label: 'Garamond', value: 'Garamond, "Times New Roman", serif' },
    { label: 'Georgia', value: 'Georgia, serif' },
    { label: 'Palatino', value: '"Palatino Linotype", "Book Antiqua", Palatino, serif' },
    { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  ]},
  { label: 'Monospace', fonts: [
    { label: 'Consolas', value: 'Consolas, "Courier New", monospace' },
    { label: 'Courier New', value: '"Courier New", Courier, monospace' },
  ]},
  { label: 'Display', display: true, fonts: [
    { label: 'Comic Sans MS', value: '"Comic Sans MS", "Comic Sans", cursive' },
    { label: 'Impact', value: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif' },
  ]},
];

// The default font picker leaves out the display faces: a whole message in Impact is not a default.
export const DEFAULT_FONT_GROUPS = FONT_GROUPS.filter(g => !g.display);

// The server stores a stack with its double quotes made single, so both spellings are known.
const unquote = value => String(value ?? '').replace(/"/g, "'");
const STACKS = new Map(FONT_GROUPS.flatMap(g => g.fonts.map(f => [unquote(f.value), f.value])));
const SIZES = new Set(FONT_SIZES.map(s => s.value));

// The saved preference as the composer uses it: one of the stacks it offers, '' for Default.
export const knownFontFamily = value => STACKS.get(unquote(value)) || '';
export const knownFontSize = value => (SIZES.has(value) ? value : '');

// What a send carries for the server to wrap the body in (outgoingMail.js), or undefined when
// nothing is chosen, so a user on Default sends exactly what was sent before.
export function composeFontPayload(family, size) {
  const f = knownFontFamily(family);
  const s = knownFontSize(size);
  if (!f && !s) return undefined;
  return { ...(f ? { family: f } : {}), ...(s ? { size: s } : {}) };
}

// The same wrapper the server builds, for a message the browser assembles itself (secureSend.js).
// Double quotes become single ones so they cannot close the style attribute.
export function wrapComposeFont(html, font) {
  if (!font || (!font.family && !font.size)) return html;
  const style = [font.family ? `font-family:${font.family.replace(/"/g, "'")}` : '', font.size ? `font-size:${font.size}` : '']
    .filter(Boolean).join(';');
  return `<div style="${style}">${html}</div>`;
}

// CSS variables for the editor's wrapper: index.css sets the editor's font from them.
export function composeFontVars(family, size) {
  const f = knownFontFamily(family);
  const s = knownFontSize(size);
  return { ...(f ? { '--compose-font-family': f } : {}), ...(s ? { '--compose-font-size': s } : {}) };
}
