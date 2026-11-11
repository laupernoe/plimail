import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import { Btn } from './calendarUi.jsx';

// Offered once a mail account is added: also connect its calendars, using the account's own
// credentials on the server side. Optional, and the mail account is already saved by then.
export default function CalendarOffer({ account, onDismiss }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok } | { error }

  const add = async () => {
    setBusy(true);
    try {
      await api.calendar.addFromMail(account.id);
      setResult({ ok: true });
    } catch (err) {
      setResult({ error: err.code === 'no_caldav' ? t('calendarOffer.none', { host: account.imap_host || '' }) : err.message });
    } finally {
      setBusy(false);
    }
  };

  const text = result?.ok ? t('calendarOffer.added') : result?.error || t('calendarOffer.prompt');
  return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', marginBottom: 16, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
      <div style={{ flex: 1, minWidth: 180, fontSize: 13, lineHeight: 1.45, wordBreak: 'break-word', color: result?.error ? 'var(--red, #f87171)' : result?.ok ? 'var(--green)' : 'var(--text-primary)' }}>
        {text}
      </div>
      {!result && <Btn kind="primary" disabled={busy} onClick={add}>{busy ? t('calendarOffer.adding') : t('calendarOffer.add')}</Btn>}
      <Btn kind="plain" onClick={onDismiss}>{t('common.dismiss')}</Btn>
    </div>
  );
}
