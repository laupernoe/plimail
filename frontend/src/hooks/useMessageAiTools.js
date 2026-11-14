import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { LANGUAGE_ENDONYMS } from '../utils/translationLanguages.js';

// Translate and "Is this a scam?" on one received message. The server reads the message itself;
// nothing here changes it. Results are kept for the session per message, so going back to a
// message shows them again; a run still going when the message changes is cancelled.
const results = new Map();

export const TRANSLATE_ACTION_ID = '__translate';
export const SCAM_ACTION_ID = '__scam';

function refusalText(t, err) {
  if (err.code === 'ai_user_disabled') return t('message.aiNotAllowed');
  if (err.code === 'ai_feature_disabled') return t('message.aiFeatureOff');
  return err.message;
}

export function useMessageAiTools(messageId) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState(() => results.get(messageId) || {});
  const viewingRef = useRef(messageId);
  const controllers = useRef({});

  useEffect(() => {
    viewingRef.current = messageId;
    setState(results.get(messageId) || {});
    const running = controllers.current;
    return () => {
      for (const ctrl of Object.values(running)) ctrl.abort();
    };
  }, [messageId]);

  const update = useCallback((id, kind, value) => {
    const next = { ...(results.get(id) || {}) };
    if (value === null) delete next[kind];
    else next[kind] = typeof value === 'function' ? value(next[kind]) : value;
    results.set(id, next);
    if (viewingRef.current === id) setState(next);
  }, []);

  const start = (kind) => {
    controllers.current[kind]?.abort();
    const ctrl = new AbortController();
    controllers.current[kind] = ctrl;
    return ctrl;
  };

  const userLanguage = Object.hasOwn(LANGUAGE_ENDONYMS, i18n.language) ? i18n.language : 'en';

  const translate = async (language = userLanguage) => {
    const id = messageId;
    const ctrl = start('translation');
    update(id, 'translation', { status: 'loading', text: '', language, truncated: null, showOriginal: false });
    try {
      const text = await api.ai.translateMessage(id, {
        language,
        signal: ctrl.signal,
        onMeta: meta => update(id, 'translation', r => ({ ...r, truncated: meta?.truncated || null })),
        onDelta: partial => update(id, 'translation', r => ({ ...r, text: partial })),
      });
      update(id, 'translation', r => ({ ...r, status: 'done', text }));
    } catch (err) {
      if (err.name === 'AbortError') {
        // Left by navigating away: a half translation is dropped, to start over next time. One
        // replaced by a new run or dismissed has nothing left to clear.
        if (controllers.current.translation === ctrl) update(id, 'translation', null);
        return;
      }
      update(id, 'translation', r => ({ ...r, status: 'error', text: refusalText(t, err) }));
    }
  };

  // Not cancelled by navigating away: the answer is short and is kept for the message it is about.
  const checkScam = async () => {
    const id = messageId;
    update(id, 'scam', { status: 'loading' });
    try {
      const result = await api.ai.scamCheck(id, { language: userLanguage });
      update(id, 'scam', { status: 'done', ...result });
    } catch (err) {
      update(id, 'scam', { status: 'error', error: refusalText(t, err), flags: [] });
    }
  };

  const toggleOriginal = () => update(messageId, 'translation', r => (r ? { ...r, showOriginal: !r.showOriginal } : r));

  const dismiss = (kind) => {
    controllers.current[kind]?.abort();
    update(messageId, kind, null);
  };

  return { translation: state.translation || null, scam: state.scam || null, userLanguage, translate, checkScam, toggleOriginal, dismiss };
}
