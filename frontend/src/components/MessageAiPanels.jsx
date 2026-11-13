import { useTranslation } from 'react-i18next';
import { redFlagText, translationLanguages } from '../utils/translationLanguages.js';
import { SCAM_ACTION_ID, TRANSLATE_ACTION_ID } from '../hooks/useMessageAiTools.js';

// The results of Translate and "Is this a scam?" on a received message, pinned above it like the
// other AI results (AiResultBox). Neither changes the message: the translation sits beside the
// original, and the scam check only reads.

const panel = accent => ({
  padding: '12px 16px', background: 'var(--bg-secondary)',
  border: '1px solid var(--border)', borderLeft: `3px solid ${accent}`,
  borderRadius: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--text-primary)',
});

const textBtn = {
  background: 'none', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 8px',
  color: 'var(--text-secondary)', fontSize: 11, fontWeight: 500, cursor: 'pointer', font: 'inherit',
};

const closeBtn = {
  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)',
  padding: '2px 4px', fontSize: 14, lineHeight: 1,
};

function percentOf(truncated) {
  return Math.max(1, Math.floor((100 * truncated.shown) / truncated.total));
}

export function TranslationPanel({ result, userLanguage, onLanguage, onToggleOriginal, onDismiss }) {
  const { t } = useTranslation();
  const loading = result.status === 'loading';
  const error = result.status === 'error';
  const collapsed = result.showOriginal && !error;
  const languages = translationLanguages(userLanguage);
  return (
    <section aria-label={t('message.translation')} style={panel('var(--accent)')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: collapsed ? 0 : 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>{t('message.translation')}</span>
        <select
          aria-label={t('message.translateTo')}
          value={result.language}
          disabled={loading}
          onChange={e => onLanguage(e.target.value)}
          style={{
            background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 5,
            color: 'var(--text-primary)', fontSize: 12, padding: '2px 6px', cursor: loading ? 'default' : 'pointer',
          }}
        >
          {languages.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
        </select>
        {loading && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{t('message.translating')}</span>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
          {!error && !loading && (
            <button type="button" onClick={onToggleOriginal} aria-pressed={collapsed} style={textBtn}>
              {collapsed ? t('message.translationShow') : t('message.translationShowOriginal')}
            </button>
          )}
          <button type="button" onClick={onDismiss} aria-label={t('message.summaryDismiss')} style={closeBtn}>×</button>
        </div>
      </div>
      {!collapsed && (error ? (
        <span style={{ color: 'var(--red)' }}>{t('compose.toolbar.aiError', { message: result.text })}</span>
      ) : (
        // Plain text, never HTML: the translation is model output about untrusted mail.
        <div data-testid="translation-text" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflowY: 'auto' }}>
          {result.text || (loading ? '' : t('message.translationEmpty'))}
        </div>
      ))}
      {!collapsed && !error && result.truncated && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
          {t('message.aiTruncated', { percent: percentOf(result.truncated) })}
        </div>
      )}
    </section>
  );
}

const VERDICTS = {
  safe: { color: 'var(--green)', key: 'message.scam.verdictSafe' },
  suspicious: { color: 'var(--amber)', key: 'message.scam.verdictSuspicious' },
  scam: { color: 'var(--red)', key: 'message.scam.verdictScam' },
};

function ShieldIcon({ color }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

// The verdict leads; the red flags the client found itself follow, shown whether or not the AI
// answered, since they need no model.
export function ScamCheckCard({ result, onRetry, onDismiss }) {
  const { t } = useTranslation();
  const loading = result.status === 'loading';
  const analysis = result.analysis || null;
  const verdict = analysis ? VERDICTS[analysis.verdict] : null;
  const flags = (result.flags || []).map(flag => redFlagText(t, flag)).filter(Boolean);
  const accent = verdict ? verdict.color : flags.length ? 'var(--amber)' : 'var(--border)';
  const aiError = result.error || null;
  const confidence = Number.isFinite(analysis?.confidence) ? Math.round(analysis.confidence * 100) : null;

  return (
    <section aria-label={t('message.scam.title')} aria-busy={loading || undefined} style={panel(accent)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ShieldIcon color={verdict ? verdict.color : 'var(--text-secondary)'} />
        {loading ? (
          <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{t('message.scam.checking')}</span>
        ) : verdict ? (
          <span data-verdict={analysis.verdict} style={{ fontSize: 14, fontWeight: 600, color: verdict.color }}>{t(verdict.key)}</span>
        ) : (
          <span style={{ fontWeight: 600 }}>{t('message.scam.title')}</span>
        )}
        {confidence !== null && (
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('message.scam.confidence', { percent: confidence })}</span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
          {!loading && <button type="button" onClick={onRetry} style={textBtn}>{t('message.scam.recheck')}</button>}
          <button type="button" onClick={onDismiss} aria-label={t('message.summaryDismiss')} style={closeBtn}>×</button>
        </div>
      </div>

      {confidence !== null && (
        <div aria-hidden="true" style={{ height: 3, borderRadius: 2, background: 'var(--border-subtle, var(--border))', margin: '8px 0 2px', overflow: 'hidden' }}>
          <div style={{ width: `${confidence}%`, height: '100%', background: verdict.color }} />
        </div>
      )}

      {analysis?.reasons?.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {analysis.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
        </ul>
      )}
      {analysis?.advice && <p style={{ margin: '8px 0 0' }}>{analysis.advice}</p>}

      {!loading && aiError && (
        <p role="alert" style={{ margin: '8px 0 0', color: 'var(--red)' }}>{t('message.scam.aiFailed', { message: aiError })}</p>
      )}

      {!loading && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle, var(--border))' }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: flags.length ? 4 : 0 }}>
            {flags.length ? t('message.scam.redFlags') : t('message.scam.noRedFlags')}
          </div>
          {flags.length > 0 && (
            <ul data-testid="red-flags" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
              {flags.map((text, i) => <li key={i} style={{ overflowWrap: 'anywhere' }}>{text}</li>)}
            </ul>
          )}
        </div>
      )}

      {!loading && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>
          {result.truncated && `${t('message.aiTruncated', { percent: percentOf(result.truncated) })} `}
          {t('message.scam.disclaimer')}
        </div>
      )}
    </section>
  );
}

// The AI menu (MessageTools' `ai`) with Translate and "Is this a scam?" after the built-in summary,
// their results counted with the others. `mailAi` is useMessageAiTools for the same message.
export function withMailActions(aiTools, mailAi, t) {
  if (!aiTools) return null;
  const [first, ...rest] = aiTools.items;
  const results = { ...aiTools.results };
  if (mailAi.translation) results[TRANSLATE_ACTION_ID] = mailAi.translation;
  if (mailAi.scam) results[SCAM_ACTION_ID] = mailAi.scam;
  return {
    ...aiTools,
    items: [
      first,
      { id: TRANSLATE_ACTION_ID, label: t('message.translate') },
      { id: SCAM_ACTION_ID, label: t('message.scamCheck') },
      ...rest,
    ].filter(Boolean),
    results,
    onRun: (action) => {
      if (action.id === TRANSLATE_ACTION_ID) return mailAi.translate();
      if (action.id === SCAM_ACTION_ID) return mailAi.checkScam();
      return aiTools.onRun(action);
    },
  };
}

export function MailAiPanels({ mailAi }) {
  if (!mailAi.translation && !mailAi.scam) return null;
  return (
    <>
      {mailAi.scam && (
        <ScamCheckCard result={mailAi.scam} onRetry={mailAi.checkScam} onDismiss={() => mailAi.dismiss('scam')} />
      )}
      {mailAi.translation && (
        <TranslationPanel
          result={mailAi.translation}
          userLanguage={mailAi.userLanguage}
          onLanguage={mailAi.translate}
          onToggleOriginal={mailAi.toggleOriginal}
          onDismiss={() => mailAi.dismiss('translation')}
        />
      )}
    </>
  );
}
