// What the signature editor's link dialog turns what the user typed into: a web address, an email
// address or a phone number. Returns the href, or null when it is empty or not one of those. Any
// other scheme (javascript:, data:, vbscript:...) is refused rather than prefixed, because
// "https://javascript:alert(1)" is harmless but "javascript:alert(1)" is not.
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const PHONE = /^\+?[\d\s().-]{5,}$/;

export function signatureLinkHref(input) {
  const value = String(input ?? '').trim();
  if (!value || /[\s<>"]/.test(value) && !PHONE.test(value) && !/^tel:/i.test(value)) return null;
  if (/^mailto:/i.test(value)) return EMAIL.test(value.slice(7).split('?')[0]) ? 'mailto:' + value.slice(7) : null;
  if (/^tel:/i.test(value)) return PHONE.test(value.slice(4)) ? 'tel:' + value.slice(4).replace(/[\s().-]/g, '') : null;
  if (/^https?:\/\//i.test(value)) return value;
  if (EMAIL.test(value)) return 'mailto:' + value;
  if (PHONE.test(value) && /\d{5,}/.test(value.replace(/\D/g, ''))) return 'tel:' + value.replace(/[\s().-]/g, '');
  // Any other scheme: "word:" not followed by a port-like number (host:8080 is a web address).
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:\/|$))/i.test(value)) return null;
  if (/^\/\//.test(value)) return null;
  return 'https://' + value;
}

// The text shown when the link is inserted with nothing selected: the address without its scheme.
export const signatureLinkLabel = href => href.replace(/^(mailto|tel):/i, '');
