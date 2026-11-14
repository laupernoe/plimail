// The languages a received message can be translated into: the reader's own first, then the
// common ones. Names are endonyms, so each reads right whatever the interface language. Codes are
// the i18n locale codes, which the server maps to the language it asks the model for.
export const LANGUAGE_ENDONYMS = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  es: 'Español',
  ru: 'Русский',
  zhCN: '简体中文',
  pl: 'Polski',
  cs: 'Čeština',
  ptBR: 'Português (Brasil)',
  ko: '한국어',
};

const COMMON = ['en', 'fr', 'de', 'it', 'es'];

export function translationLanguages(userLanguage) {
  const own = Object.hasOwn(LANGUAGE_ENDONYMS, userLanguage) ? userLanguage : 'en';
  return [own, ...COMMON.filter(code => code !== own)].map(code => ({ code, name: LANGUAGE_ENDONYMS[code] }));
}

// The text of a red flag the server found (backend services/mailSafetyInput.js), in the reader's
// language. An unknown type is left out rather than shown as a key.
export function redFlagText(t, flag) {
  switch (flag?.type) {
    case 'link_mismatch': return t('message.scam.flag.linkMismatch', { shown: flag.shown, actual: flag.actual });
    case 'double_extension': return t('message.scam.flag.doubleExtension', { name: flag.name });
    case 'executable_attachment': return t('message.scam.flag.executable', { name: flag.name });
    case 'macro_attachment': return t('message.scam.flag.macro', { name: flag.name });
    case 'active_attachment': return t('message.scam.flag.active', { name: flag.name });
    case 'archive_attachment': return t('message.scam.flag.archive', { name: flag.name });
    case 'auth_fail': return t('message.scam.flag.authFail', { mechanism: String(flag.mechanism || '').toUpperCase() });
    case 'reply_to_differs': return t('message.scam.flag.replyTo', { address: flag.address });
    case 'display_name_address': return t('message.scam.flag.displayName', { shown: flag.shown, actual: flag.actual });
    default: return null;
  }
}
