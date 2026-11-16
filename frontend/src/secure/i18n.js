import strings from 'virtual:secure-page-strings';
import { detectLanguage, htmlLang } from '../utils/browserLanguage.js';

// The recipient's page speaks the browser's language, from the securePage part of each locale
// file (vite.config.js hands it over), with English for anything missing. A choice made in the
// app on this browser wins, as it does there.
function chosenLanguage() {
  try {
    const stored = localStorage.getItem('mailflow_language');
    if (stored && strings[stored]) return stored;
  } catch { /* storage blocked */ }
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  return detectLanguage(preferred, Object.keys(strings));
}

export const language = chosenLanguage();
if (typeof document !== 'undefined') document.documentElement.lang = htmlLang(language);

const lookup = (table, key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), table);

// t('securePage.x', { name }) as react-i18next does it, for the keys this page uses.
export function t(key, values = {}) {
  const path = key.replace(/^securePage\./, '');
  const text = lookup(strings[language], path) ?? lookup(strings.en, path) ?? key;
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, name) => (values[name] ?? ''));
}

export function formatDateTime(iso) {
  try {
    return new Intl.DateTimeFormat(htmlLang(language), { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}
