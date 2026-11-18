import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// The demo's own corner: a note that the data is made up, a way back to the site, and a word when a
// message is "sent".
// Bottom center on a wide screen, where the app's own notices (bottom right) stay clear; bottom
// left on a phone, clear of the compose button.
const pill = {
  position: 'fixed', zIndex: 2147483000, bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
  display: 'flex', alignItems: 'center', gap: 10, padding: '6px 6px 6px 12px', borderRadius: 999,
  background: 'var(--bg-secondary, #111)', color: 'var(--text-secondary, #ccc)',
  border: '1px solid var(--border, rgba(127,127,127,.3))', boxShadow: '0 6px 24px rgba(0,0,0,.18)',
  font: '500 12px/1.2 var(--font-sans, system-ui, sans-serif)',
};
const link = {
  padding: '5px 10px', borderRadius: 999, background: 'var(--accent, #3b82f6)', color: 'var(--accent-text, #fff)',
  textDecoration: 'none', fontWeight: 600, whiteSpace: 'nowrap',
};
const toast = {
  position: 'fixed', zIndex: 2147483001, left: '50%', top: 'calc(16px + env(safe-area-inset-top, 0px))', transform: 'translateX(-50%)',
  maxWidth: 'min(420px, calc(100vw - 32px))', padding: '10px 14px', borderRadius: 10,
  background: 'var(--bg-secondary, #111)', color: 'var(--text-primary, #eee)', border: '1px solid var(--border, #333)',
  boxShadow: '0 10px 30px rgba(0,0,0,.25)', font: '13px/1.45 var(--font-sans, system-ui, sans-serif)',
};

const narrowQuery = '(max-width: 760px)';

export default function DemoBanner() {
  const { t } = useTranslation();
  const [sent, setSent] = useState(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowQuery).matches);

  useEffect(() => {
    const media = window.matchMedia(narrowQuery);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let timer;
    const onSent = (e) => {
      setSent(e.detail?.subject || '');
      clearTimeout(timer);
      timer = setTimeout(() => setSent(null), 6000);
    };
    window.addEventListener('plimail-demo:sent', onSent);
    return () => { window.removeEventListener('plimail-demo:sent', onSent); clearTimeout(timer); };
  }, []);

  return (
    <>
      {!hidden && (
        <div style={{ ...pill, ...(narrow ? { left: 12 } : { left: '50%', transform: 'translateX(-50%)' }) }} role="note">
          <span>{narrow ? t('demo.noticeShort') : t('demo.notice')}</span>
          <a href="/" style={link}>{t('demo.get')}</a>
          <button type="button" onClick={() => setHidden(true)} aria-label={t('demo.hide')}
            style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: '0 4px', fontSize: 15, lineHeight: 1 }}>×</button>
        </div>
      )}
      {sent !== null && (
        <div style={toast} role="status">
          <b>{t('demo.sentTitle')}</b> {t('demo.sentBody')}
        </div>
      )}
    </>
  );
}
