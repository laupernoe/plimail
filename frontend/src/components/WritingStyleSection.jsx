import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDay } from '../utils/formatDate.js';

// Settings → AI actions → My writing style: the AI learns how the user writes from their sent
// mail, and the writing assistant follows it when it writes as them. Shown only while the user
// can use the writing assistant.
export const WRITING_STYLE_MAX_CHARS = 2000;

function errorText(t, err) {
  if (err?.code === 'not_enough_mail') return t('admin.writingStyle.notEnoughMail');
  if (err?.code === 'rate_limited') return t('admin.writingStyle.rateLimited');
  return err?.message || t('common.error');
}

export default function WritingStyleSection({ available }) {
  const { t } = useTranslation();
  const [style, setStyle] = useState(null);
  const [draft, setDraft] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const apply = (next) => {
    setStyle(next);
    setDraft(next?.profile || '');
  };

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    api.ai.writingStyle.get()
      .then((next) => { if (!cancelled) apply(next); })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [available]);

  if (!available) return null;

  const run = async (kind, call, okText) => {
    setBusy(kind);
    setMsg(null);
    try {
      apply(await call());
      if (okText) setMsg({ type: 'ok', text: okText });
    } catch (err) {
      setMsg({ type: 'error', text: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  };

  const profile = style?.profile || '';
  const hasProfile = !!profile;
  const dirty = draft.trim() !== profile;
  const enabled = style?.enabled === true;

  const learn = () => run('learn', () => api.ai.writingStyle.learn(), t('admin.writingStyle.learned'));
  const save = () => run('save', () => api.ai.writingStyle.put({ profile: draft }), t('admin.writingStyle.saved'));
  const clear = () => run('clear', () => api.ai.writingStyle.put({ profile: null }), null);
  const toggle = () => run('toggle', () => api.ai.writingStyle.put({ enabled: !enabled }), null);

  const meta = style?.updatedAt && (style.samples
    ? t('admin.writingStyle.learnedFrom', { n: style.samples, date: formatDay(style.updatedAt) })
    : t('admin.writingStyle.updatedOn', { date: formatDay(style.updatedAt) }));

  const button = (primary) => ({
    padding: '7px 14px', fontSize: 13, fontWeight: 500, borderRadius: 7, cursor: busy ? 'default' : 'pointer',
    background: primary ? 'var(--accent)' : 'var(--bg-tertiary)',
    color: primary ? 'var(--accent-text)' : 'var(--text-primary)',
    border: primary ? 'none' : '1px solid var(--border)',
  });

  return (
    <section style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)' }} aria-labelledby="writing-style-title">
      <h3 id="writing-style-title" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' }}>
        {t('admin.writingStyle.title')}
      </h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
        {t('admin.writingStyle.description')}
      </p>

      {loadFailed ? (
        <div role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{t('admin.writingStyle.loadFailed')}</div>
      ) : style && (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 12,
            padding: '10px 12px', borderRadius: 8, background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{t('admin.writingStyle.useStyle')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>{t('admin.writingStyle.useStyleHint')}</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={t('admin.writingStyle.useStyle')}
              disabled={!hasProfile || !!busy}
              onClick={toggle}
              style={{
                width: 44, height: 24, borderRadius: 12, flexShrink: 0, position: 'relative', transition: 'all 0.2s',
                background: enabled ? 'var(--accent)' : 'var(--bg-elevated)',
                border: `1px solid ${enabled ? 'var(--accent)' : 'var(--border)'}`,
                cursor: !hasProfile || busy ? 'not-allowed' : 'pointer', opacity: hasProfile ? 1 : 0.6,
              }}
            >
              <span style={{
                position: 'absolute', top: 3, left: enabled ? 22 : 3, width: 16, height: 16, borderRadius: '50%',
                background: enabled ? 'var(--accent-text)' : 'var(--text-secondary)', transition: 'left 0.2s',
              }} />
            </button>
          </div>

          <label htmlFor="writing-style-profile" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
            {t('admin.writingStyle.profileLabel')}
          </label>
          <textarea
            id="writing-style-profile"
            value={draft}
            maxLength={WRITING_STYLE_MAX_CHARS}
            placeholder={t('admin.writingStyle.profilePh')}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            style={{
              width: '100%', padding: '8px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
              resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5,
            }}
          />
          {meta && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>{meta}</div>}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <button type="button" onClick={learn} disabled={!!busy} style={{ ...button(true), opacity: busy && busy !== 'learn' ? 0.5 : 1 }}>
              {busy === 'learn' ? t('admin.writingStyle.learning') : hasProfile ? t('admin.writingStyle.learnAgain') : t('admin.writingStyle.learn')}
            </button>
            <button type="button" onClick={save} disabled={!!busy || !dirty || !draft.trim()} style={{ ...button(false), opacity: busy || !dirty || !draft.trim() ? 0.5 : 1 }}>
              {busy === 'save' ? t('common.saving') : t('common.save')}
            </button>
            {hasProfile && (
              <button type="button" onClick={clear} disabled={!!busy} style={{ ...button(false), color: 'var(--red)', opacity: busy ? 0.5 : 1 }}>
                {t('admin.writingStyle.clear')}
              </button>
            )}
          </div>

          {msg && (
            <div role={msg.type === 'error' ? 'alert' : 'status'} style={{ marginTop: 10, fontSize: 12, color: msg.type === 'error' ? 'var(--red)' : 'var(--green)' }}>
              {msg.text}
            </div>
          )}
        </>
      )}
    </section>
  );
}
