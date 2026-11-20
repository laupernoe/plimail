import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { DEFAULT_FONT_GROUPS, FONT_SIZES, knownFontFamily } from '../utils/composeFont.js';

// The default writing font (Settings > Behavior > Writing): the family and size new messages,
// replies and forwards start in, and that recipients see. Each font is listed in its own face, and
// the sample below the pickers shows the pair together. Default leaves the message as it was.
export default function ComposeFontSetting({ selectStyle }) {
  const { t } = useTranslation();
  const composeFontFamily = useStore(s => s.composeFontFamily);
  const composeFontSize = useStore(s => s.composeFontSize);
  const setComposeFont = useStore(s => s.setComposeFont);
  const family = knownFontFamily(composeFontFamily);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <select
          aria-label={t('admin.messageList.composeFontFamily')}
          value={family}
          onChange={e => setComposeFont({ family: e.target.value })}
          style={{ ...selectStyle, flex: '1 1 200px', maxWidth: 280, ...(family ? { fontFamily: family } : {}) }}
        >
          <option value="" style={{ fontFamily: 'var(--font-sans)' }}>{t('admin.messageList.composeFontDefault')}</option>
          {DEFAULT_FONT_GROUPS.map(g => (
            <optgroup key={g.label} label={g.label}>
              {g.fonts.map(f => <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>{f.label}</option>)}
            </optgroup>
          ))}
        </select>
        <select
          aria-label={t('admin.messageList.composeFontSize')}
          value={composeFontSize}
          onChange={e => setComposeFont({ size: e.target.value })}
          style={{ ...selectStyle, flex: '0 0 auto' }}
        >
          <option value="">{t('admin.messageList.composeFontDefault')}</option>
          {FONT_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      <div
        data-testid="compose-font-sample"
        style={{
          marginTop: 10, padding: '10px 12px', borderRadius: 8,
          border: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)',
          color: 'var(--text-primary)', lineHeight: 1.5,
          fontFamily: family || 'var(--font-sans)', fontSize: composeFontSize || 13,
        }}
      >
        {t('admin.messageList.composeFontSample')}
      </div>
    </div>
  );
}
