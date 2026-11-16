// Text handed to the AI model as data (received mail, the user's sent mail, the learned style
// notes) goes between delimiters the prompt tells the model about. A copy of a delimiter inside
// the text is defused, so the text cannot close its own block and speak as the prompt.

export const UNTRUSTED_TAG = 'untrusted_email';
export const STYLE_TAG = 'style_notes';

// Zero-width, bidi and other invisible characters senders pad text with, and the Unicode tag
// characters (U+E0000 to U+E007F), which spell out ASCII the reader never sees.
export const INVISIBLE_RE = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\u{e0000}-\u{e007f}]/gu;
const INVISIBLE_CHAR = new RegExp(INVISIBLE_RE.source, 'u');

// Without the closing ">": the model reads "</untrusted_email" followed by anything, or nothing, as
// the end of the block too.
const DELIMITER_RE = new RegExp(`<\\s*/?\\s*(?:${UNTRUSTED_TAG}|${STYLE_TAG})\\b`, 'gi');

// Matched on the text's NFKC form, so a full-width "＜／ｕｎｔｒｕｓｔｅｄ＿ｅｍａｉｌ" is caught,
// but the text itself is only stripped of invisible characters: NFKC would also rewrite ordinary
// CJK punctuation and ligatures in mail that is being translated.
export function defuseDelimiters(text) {
  const kept = [];
  const from = [];
  let normalized = '';
  for (const char of String(text ?? '')) {
    if (INVISIBLE_CHAR.test(char)) continue;
    const form = char.normalize('NFKC');
    for (let i = 0; i < form.length; i++) from.push(kept.length);
    normalized += form;
    kept.push(char);
  }
  let out = '';
  let pos = 0;
  for (const match of normalized.matchAll(DELIMITER_RE)) {
    const start = from[match.index];
    if (start < pos) continue;
    out += `${kept.slice(pos, start).join('')}[tag removed]`;
    pos = from[match.index + match[0].length - 1] + 1;
  }
  return out + kept.slice(pos).join('');
}

export function wrapData(text, tag) {
  return `<${tag}>\n${defuseDelimiters(text)}\n</${tag}>`;
}

export function wrapUntrusted(text) {
  return wrapData(text, UNTRUSTED_TAG);
}
